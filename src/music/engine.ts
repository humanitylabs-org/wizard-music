import { hostedAudioBridge } from './backgroundAudio'
// Wizard Music playback engine.
//
// One interface, two implementations:
//  - NativeEngine: the Wizard Android shell's Media3 player (background playback,
//    lock screen, Bluetooth/headset buttons, audio focus). Used whenever the
//    `WizardNativeMusic` bridge exists.
//  - WebEngine: an <audio> element plus Media Session metadata, for browsers and
//    older shells.
// The UI is a pure view of `MusicSnapshot`; both engines refill endless stations.

export type MusicTrack = {
  id: string
  title: string
  artist: string
  album: string
  durationMs: number
  source: 'youtube' | 'library' | string
  art: string
  stream: string
  liked?: boolean
}

export type MusicStation = { id: string; title: string; more: string }

export type MusicSnapshot = {
  queue: MusicTrack[]
  index: number
  wantPlaying?: boolean
  playing: boolean
  buffering: boolean
  positionMs: number
  durationMs: number
  station: MusicStation | null
  error: string
  engine: 'native' | 'web'
  /** The phone player may have moved on while Music was out of sight; hide the song until it answers. */
  stale?: boolean
}

export interface MusicEngine {
  readonly kind: 'native' | 'web'
  snapshot(): MusicSnapshot
  subscribe(listener: (snapshot: MusicSnapshot) => void): () => void
  load(queue: MusicTrack[], index: number, station: MusicStation | null): Promise<void>
  play(): void
  pause(): void
  toggle(): void
  seek(ms: number): void
  next(): void
  previous(): void
  jump(index: number): void
  enqueueNext(track: MusicTrack): void
  removeCurrent(): void
  /** Drop upcoming tracks (never the one playing). */
  removeUpcoming(ids: string[]): void
  /** Player gain 0..1 on top of the phone's media volume. */
  volume(): number
  setVolume(value: number): void
}

export const REFILL_THRESHOLD = 5
/** Where the web engine keeps the listening session, so a Wizard restart picks up the same song, spot and station. */
export const SESSION_KEY = 'wizard-music.session.v1'
/** Music that was playing when Wizard closed resumes on its own if you come back within this window; later it waits paused. */
export const RESUME_AUTOPLAY_MS = 30 * 60 * 1000
const SESSION_SAVE_MS = 4000
/** Songs already played stay at the front of the queue (YouTube Music style), so you can see and replay them. */
export const HISTORY_KEEP = 50
const SESSION_KEEP_BEHIND = HISTORY_KEEP
const SESSION_KEEP_AHEAD = 80

export type SavedSession = { v: 1; queue: MusicTrack[]; index: number; station: MusicStation | null; positionMs: number; playing: boolean; savedAt: number }
export type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The saved session, or null when there is nothing usable to resume. */
export function readSession(store: SessionStore | null): SavedSession | null {
  if (!store) return null
  try {
    const value = JSON.parse(store.getItem(SESSION_KEY) || 'null') as SavedSession | null
    if (!value || value.v !== 1 || !Array.isArray(value.queue) || !value.queue.length) return null
    const index = Math.min(Math.max(0, Math.floor(Number(value.index) || 0)), value.queue.length - 1)
    if (!value.queue[index]?.stream) return null
    return { ...value, index, positionMs: Math.max(0, Number(value.positionMs) || 0), savedAt: Number(value.savedAt) || 0 }
  } catch { return null }
}
/** Remembers the listening session in storage: track, queue and station changes at once, the spot every few seconds. */
export class SessionSaver {
  private key = ''
  private at = 0
  constructor(readonly store: SessionStore | null) {}
  save(state: Pick<MusicSnapshot, 'queue' | 'index' | 'station' | 'positionMs'>, playing: boolean, force = false) {
    if (!this.store) return
    const { queue, index, station, positionMs } = state
    const track = queue[index]
    if (!track) return
    const key = `${queue.length}|${index}|${track.id}|${station?.id ?? ''}|${playing}`
    const now = Date.now()
    if (!force && key === this.key && now - this.at < SESSION_SAVE_MS) return
    const from = Math.max(0, index - SESSION_KEEP_BEHIND)
    const session: SavedSession = { v: 1, queue: queue.slice(from, index + 1 + SESSION_KEEP_AHEAD), index: index - from, station, positionMs, playing, savedAt: now }
    try { this.store.setItem(SESSION_KEY, JSON.stringify(session)); this.key = key; this.at = now } catch { /* storage full or blocked */ }
  }
}
/** Whether a saved session should start playing again by itself (it was playing and you're back soon). */
export function resumeAutoplay(session: SavedSession, now = Date.now()) { return session.playing && now - session.savedAt < RESUME_AUTOPLAY_MS }

/** The songs played before the current one, oldest first, with their queue positions (for jump). */
export function playedTracks(snapshot: Pick<MusicSnapshot, 'queue' | 'index'>, max = HISTORY_KEEP): { item: MusicTrack; position: number }[] {
  const end = Math.min(snapshot.index, snapshot.queue.length)
  if (end <= 0) return []
  const from = Math.max(0, end - max)
  return snapshot.queue.slice(from, end).map((item, offset) => ({ item, position: from + offset }))
}

export const EMPTY_SNAPSHOT: MusicSnapshot = { queue: [], index: -1, playing: false, buffering: false, positionMs: 0, durationMs: 0, station: null, error: '', engine: 'web' }

export function absoluteMusicUrl(path: string): string {
  return new URL(path, window.location.origin).toString()
}

type FetchLike = typeof fetch

export async function fetchStationMore(station: MusicStation, fetchImpl: FetchLike = fetch, count = 10): Promise<MusicTrack[]> {
  const url = new URL(station.more, window.location.origin)
  url.searchParams.set('n', String(count))
  const response = await fetchImpl(url.toString(), { credentials: 'include', headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`station refill failed (${response.status})`)
  const payload = await response.json() as { tracks?: MusicTrack[] }
  return Array.isArray(payload.tracks) ? payload.tracks : []
}

class Emitter {
  private listeners = new Set<(snapshot: MusicSnapshot) => void>()
  subscribe(listener: (snapshot: MusicSnapshot) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  emit(snapshot: MusicSnapshot) { for (const listener of [...this.listeners]) listener(snapshot) }
}

// ------------------------------------------------------------------ Web engine
export class WebEngine implements MusicEngine {
  readonly kind = 'web' as const
  private audio: HTMLAudioElement
  private state: MusicSnapshot = { ...EMPTY_SNAPSHOT, engine: 'web' }
  private emitter = new Emitter()
  private refilling = false
  private startAfterRefill = false
  private refillAttempts = 0
  private fetchImpl: FetchLike
  private store: SessionStore | null
  private saver: SessionSaver
  /** A restored spot waiting for the track's metadata; the clock shows it until the seek lands. */
  private pendingSeekMs: number | null = null
  /** Whether you want music on. Survives pauses the system causes (Wizard closing, the WebView stopping). */
  private wantPlaying = false

  constructor(audio: HTMLAudioElement = new Audio(), fetchImpl: FetchLike = (...args) => fetch(...args), store: SessionStore | null = null) {
    this.audio = audio
    this.fetchImpl = fetchImpl
    this.store = store
    this.saver = new SessionSaver(store)
    audio.preload = 'auto'
    const sync = () => this.set({
      playing: this.markPlaying(!audio.paused && !audio.ended),
      positionMs: this.pendingSeekMs ?? Math.round(audio.currentTime * 1000),
      durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : this.current()?.durationMs ?? 0,
    })
    audio.addEventListener('timeupdate', sync)
    audio.addEventListener('durationchange', sync)
    audio.addEventListener('play', sync)
    audio.addEventListener('pause', sync)
    audio.addEventListener('waiting', () => this.set({ buffering: true }))
    audio.addEventListener('playing', () => this.set({ buffering: false, error: '' }))
    audio.addEventListener('canplay', () => this.set({ buffering: false }))
    audio.addEventListener('ended', () => this.advance(1, true))
    audio.addEventListener('error', () => {
      if (!audio.src) return
      this.set({ buffering: false, error: 'This track could not be played. Skipping.' })
      window.setTimeout(() => this.advance(1, true), 900)
    })
    this.installMediaSession()
    if (store && typeof window !== 'undefined') {
      // Save the exact spot whenever Wizard hides or closes this app.
      window.addEventListener('pagehide', () => this.saveSession(true))
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.saveSession(true) })
    }
  }

  snapshot() { return this.state }
  subscribe(listener: (snapshot: MusicSnapshot) => void) { return this.emitter.subscribe(listener) }

  private current() { return this.state.queue[this.state.index] }
  private set(patch: Partial<MusicSnapshot>) {
    this.state = { ...this.state, ...patch }
    this.emitter.emit(this.state)
    this.saveSession()
  }

  /** Track changes, queue changes and play/pause save at once; the playing position at most every few seconds. */
  saveSession(force = false) { this.saver.save(this.state, this.wantPlaying, force) }

  /** Pick up where the last session left off: same queue, song, spot and station. Returns whether it is playing. */
  resume(session: SavedSession, now = Date.now()): boolean {
    const autoplay = resumeAutoplay(session, now)
    this.state = { ...this.state, queue: [...session.queue], index: -1, station: session.station, error: '' }
    this.start(session.index, autoplay, session.positionMs)
    return autoplay
  }

  async load(queue: MusicTrack[], index: number, station: MusicStation | null) {
    // A new station or search keeps what you already heard in front of it, so Played and Previous still reach it.
    const { queue: was, index: at } = this.state
    const played = at >= 0 ? was.slice(Math.max(0, at + 1 - HISTORY_KEEP), at + 1) : []
    this.set({ queue: [...played, ...queue], index: -1, station, error: '' })
    this.start(played.length + index)
  }

  private start(index: number, autoplay = true, fromMs = 0) {
    const track = this.state.queue[index]
    if (!track) return
    this.startAfterRefill = false
    this.refillAttempts = 0
    this.pendingSeekMs = fromMs > 0 ? fromMs : null
    this.wantPlaying = autoplay
    this.set({ index, positionMs: fromMs, durationMs: track.durationMs, buffering: autoplay })
    const src = absoluteMusicUrl(track.stream)
    this.audio.src = src
    if (fromMs > 0) {
      this.audio.addEventListener('loadedmetadata', () => {
        if (this.audio.src !== src || this.pendingSeekMs === null) return
        const end = Number.isFinite(this.audio.duration) ? this.audio.duration : Infinity
        this.audio.currentTime = Math.min(this.pendingSeekMs / 1000, Math.max(0, end - 1))
        this.pendingSeekMs = null
      }, { once: true })
    }
    this.updateMediaSession(track)
    if (autoplay) void this.audio.play().catch(() => this.set({ playing: false, buffering: false }))
    void this.maybeRefill()
  }

  private advance(step: number, auto = false) {
    const next = this.state.index + step
    if (next >= 0 && next < this.state.queue.length) { this.start(next); return }
    if (auto && step > 0) void this.maybeRefill(true)
  }

  async maybeRefill(startAfter = false) {
    // A track can end while a refill is in flight; remember to continue then.
    if (startAfter) this.startAfterRefill = true
    const { station, queue, index } = this.state
    if (!station || this.refilling || queue.length - index - 1 > REFILL_THRESHOLD) return
    this.refilling = true
    let added = false
    try {
      const known = new Set(this.state.queue.map((track) => track.id))
      const more = (await fetchStationMore(station, this.fetchImpl)).filter((track) => !known.has(track.id))
      if (more.length && this.state.station?.id === station.id) {
        this.set({ queue: [...this.state.queue, ...more] })
        added = true
      }
    } catch {
      this.set({ error: 'Could not reach your music right now.' })
    } finally { this.refilling = false }
    if (!this.startAfterRefill) return
    if (added) { this.startAfterRefill = false; this.start(this.state.index + 1); return }
    if (this.refillAttempts++ < 3) void this.maybeRefill(true)
    else { this.startAfterRefill = false; this.refillAttempts = 0 }
  }

  play() { if (!this.current()) return; this.wantPlaying = true; void this.audio.play().catch(() => undefined); this.saveSession(true) }
  pause() { this.wantPlaying = false; this.audio.pause(); this.saveSession(true) }
  toggle() { if (this.audio.paused) this.play(); else this.pause() }
  seek(ms: number) { this.pendingSeekMs = null; this.audio.currentTime = Math.max(0, ms / 1000); this.set({ positionMs: ms }) }
  next() { this.advance(1, true) }
  previous() {
    if (this.audio.currentTime > 4 || this.state.index <= 0) { this.seek(0); return }
    this.advance(-1)
  }
  jump(index: number) { this.start(index) }
  enqueueNext(track: MusicTrack) {
    const queue = this.state.queue.filter((item, position) => item.id !== track.id || position <= this.state.index)
    queue.splice(this.state.index + 1, 0, track)
    this.set({ queue })
  }
  removeCurrent() {
    // Silence first: the rejected song must stop now, even if the next one still has to load.
    this.audio.pause()
    const queue = [...this.state.queue]
    queue.splice(this.state.index, 1)
    const index = this.state.index
    if (index < queue.length) { this.set({ queue, index: -1 }); this.start(index); return }
    this.audio.removeAttribute('src')
    this.set({ queue, index: queue.length - 1, playing: false, buffering: Boolean(this.state.station), positionMs: 0 })
    if (this.state.station) void this.maybeRefill(true)
  }
  removeUpcoming(ids: string[]) {
    const drop = new Set(ids)
    if (!drop.size) return
    const queue = this.state.queue.filter((track, position) => position <= this.state.index || !drop.has(track.id))
    if (queue.length === this.state.queue.length) return
    this.set({ queue })
    void this.maybeRefill()
  }
  volume() { return this.audio.volume }
  setVolume(value: number) { this.audio.volume = Math.min(1, Math.max(0, value)) }

  /** Media Session play state: Android's media controls read it, and the Wizard OS shell checks it before reloading. */
  private markPlaying(playing: boolean): boolean {
    const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined
    if (session) { try { session.playbackState = playing ? 'playing' : 'paused' } catch { /* read-only on some shells */ } }
    return playing
  }

  private installMediaSession() {
    const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined
    if (!session) return
    try {
      session.setActionHandler('play', () => this.play())
      session.setActionHandler('pause', () => this.pause())
      session.setActionHandler('nexttrack', () => this.next())
      session.setActionHandler('previoustrack', () => this.previous())
      session.setActionHandler('seekto', (details) => { if (details.seekTime !== undefined) this.seek(details.seekTime * 1000) })
    } catch { /* partial Media Session support */ }
  }

  private updateMediaSession(track: MusicTrack) {
    const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined
    if (!session || typeof MediaMetadata === 'undefined') return
    session.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: track.album, artwork: [{ src: absoluteMusicUrl(track.art), sizes: '544x544', type: 'image/jpeg' }] })
  }
}

// --------------------------------------------------------------- Native engine
type NativeMessage = { data: string }
export type NativeMusicBridge = { postMessage(value: string): void | Promise<void>; onmessage: ((event: NativeMessage) => void) | null }
type NativeSnapshot = Partial<Omit<MusicSnapshot, 'queue' | 'station' | 'engine'>> & { queue?: MusicTrack[]; queueRevision?: number; station?: MusicStation | null }

declare global {
  interface Window { WizardNativeMusic?: NativeMusicBridge }
}

export class NativeEngine implements MusicEngine {
  readonly kind = 'native' as const
  private state: MusicSnapshot = { ...EMPTY_SNAPSHOT, engine: 'native' }
  private emitter = new Emitter()
  private queueRevision = -1
  private sessionId = ""
  private subscribers = 0
  private poll = 0
  private bridge: NativeMusicBridge
  private saver: SessionSaver
  /** Set once the player has answered, so a restore knows whether it came back empty. */
  private answered: Promise<void>
  private markAnswered!: () => void
  /** Anything you start yourself wins over an in-flight restore. */
  private userLoaded = false

  constructor(bridge: NativeMusicBridge, store: SessionStore | null = null) {
    this.bridge = bridge
    this.saver = new SessionSaver(store)
    this.answered = new Promise((resolve) => { this.markAnswered = resolve })
    bridge.onmessage = (event) => {
      try { this.accept(JSON.parse(String(event.data)) as NativeSnapshot) } catch { /* ignore malformed */ }
    }
    if (store && typeof window !== 'undefined') {
      // An app update or a killed phone app drops the native player's memory; keep our own copy.
      const flush = () => this.saveSession(true)
      window.addEventListener('pagehide', flush)
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
    }
    if (typeof document !== 'undefined') {
      // Out of sight the player keeps going but nobody asks it; coming back must never flash the old song.
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.markStale(); else if (this.state.stale) this.refresh() })
      window.addEventListener('pageshow', () => this.refresh())
      window.addEventListener('focus', () => { if (this.state.stale) this.refresh() })
    }
    this.send('state')
  }

  private acceptCount = 0
  private freshTicket = 0
  private clearOnNextAccept = 0
  markStale() {
    if (this.state.stale || !this.state.queue[this.state.index]) return
    this.freshTicket++ // an earlier return's timers must not reveal this one early
    this.clearOnNextAccept = 0
    this.state = { ...this.state, stale: true }
    this.emitter.emit(this.state)
  }
  private unstale(ticket: number) {
    if (ticket !== this.freshTicket || !this.state.stale) return
    this.clearOnNextAccept = 0
    this.state = { ...this.state, stale: false }
    this.emitter.emit(this.state)
  }
  /** Ask the player right now (not at the next poll) and show the song once its answer is in. */
  refresh() {
    if (!this.state.stale) { this.send('state'); return }
    const ticket = ++this.freshTicket, before = this.acceptCount
    void this.send('state', { fresh: true }).then(() => {
      if (this.acceptCount > before) this.unstale(ticket)
      else this.clearOnNextAccept = ticket // bridges that answer later via onmessage
    })
    window.setTimeout(() => this.unstale(ticket), 1500) // never leave the player blank
  }

  private saveSession(force = false) { this.saver.save(this.state, this.state.wantPlaying ?? this.state.playing, force) }

  /**
   * After an app update the native player starts empty. Put the saved song back at the saved spot,
   * playing only if it was playing a moment ago. Leaves a live native session alone.
   */
  async restoreIfEmpty(session: SavedSession, now = Date.now(), waitMs = 6000): Promise<boolean> {
    const answered = await Promise.race([this.answered.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), waitMs))])
    if (!answered || this.userLoaded || (this.state.queue.length > 0 && this.state.index >= 0)) return false
    // The player takes at most 100 songs: keep the ones just played and what comes next.
    const from = Math.max(0, session.index - 40)
    const queue = session.queue.slice(from, from + 100)
    const autoplay = resumeAutoplay(session, now)
    try { await this.sendLoad(queue, session.index - from, session.station) } catch { return false }
    if (this.userLoaded) return true
    if (!autoplay) this.pause()
    if (session.positionMs > 0) this.seek(session.positionMs)
    return true
  }

  private send(method: string, params: Record<string, unknown> = {}) {
    return Promise.resolve(this.bridge.postMessage(JSON.stringify({ method, knownQueueRevision: this.queueRevision, ...params }))).catch((error: Error) => {
      this.state = { ...this.state, error: error.message }; this.emitter.emit(this.state)
      if (method === "load") throw error
    })
  }

  private accept(value: NativeSnapshot) {
    const identity = value as NativeSnapshot & { sessionId?: string; volume?: number }
    if (identity.sessionId && identity.sessionId !== this.sessionId) { this.sessionId = identity.sessionId; this.queueRevision = -1; this.state = { ...EMPTY_SNAPSHOT, engine: "native" } }
    if (typeof identity.volume === "number") this.gain = identity.volume
    const patch: Partial<MusicSnapshot> = {}
    if (Array.isArray(value.queue)) { patch.queue = value.queue; this.queueRevision = value.queueRevision ?? this.queueRevision }
    for (const key of ['index', 'playing', 'wantPlaying', 'buffering', 'positionMs', 'durationMs', 'error'] as const) {
      if (value[key] !== undefined) (patch as Record<string, unknown>)[key] = value[key]
    }
    if (value.station !== undefined) patch.station = value.station
    if (this.clearOnNextAccept && this.clearOnNextAccept === this.freshTicket) { this.clearOnNextAccept = 0; patch.stale = false }
    this.acceptCount++
    this.state = { ...this.state, ...patch }
    if (identity.sessionId || Array.isArray(value.queue)) this.markAnswered()
    this.emitter.emit(this.state)
    this.saveSession()
  }

  snapshot() { return this.state }
  subscribe(listener: (snapshot: MusicSnapshot) => void) {
    const stop = this.emitter.subscribe(listener)
    this.subscribers++
    this.send('state')
    if (!this.poll) this.poll = window.setInterval(() => { if (document.visibilityState === 'visible') this.send('state') }, 1000)
    return () => {
      stop()
      if (--this.subscribers === 0) { clearInterval(this.poll); this.poll = 0 }
    }
  }

  async load(queue: MusicTrack[], index: number, station: MusicStation | null) {
    this.userLoaded = true
    await this.sendLoad(queue, index, station)
  }
  private async sendLoad(queue: MusicTrack[], index: number, station: MusicStation | null) {
    await this.send('load', {
      index,
      queue: queue.map((track) => ({ ...track, stream: absoluteMusicUrl(track.stream), art: absoluteMusicUrl(track.art) })),
      station: station ? { ...station, more: absoluteMusicUrl(station.more) } : null,
    })
  }
  play() { this.send('play') }
  pause() { this.send('pause') }
  toggle() { this.send((this.state.wantPlaying ?? this.state.playing) ? 'pause' : 'play') }
  seek(ms: number) { this.send('seek', { positionMs: Math.max(0, Math.round(ms)) }); this.state = { ...this.state, positionMs: ms }; this.emitter.emit(this.state) }
  next() { this.send('next') }
  previous() { this.send('previous') }
  jump(index: number) { this.send('jump', { index }) }
  enqueueNext(track: MusicTrack) { this.send('enqueueNext', { track: { ...track, stream: absoluteMusicUrl(track.stream), art: absoluteMusicUrl(track.art) } }) }
  removeCurrent() { this.send('removeCurrent') }
  removeUpcoming(ids: string[]) { this.send('removeUpcoming', { ids }) }
  private gain = 1
  volume() { return this.gain }
  setVolume(value: number) { this.gain = Math.min(1, Math.max(0, value)); this.send('volume', { value: this.gain }) }
}

let engine: MusicEngine | null = null
export function musicEngine(): MusicEngine {
  if (engine) return engine
  const bridge = typeof window !== 'undefined' ? (window.WizardNativeMusic ||= hostedAudioBridge()) : undefined
  engine = bridge && typeof bridge.postMessage === 'function' ? new NativeEngine(bridge, browserSessionStore()) : new WebEngine(undefined, undefined, browserSessionStore())
  return engine
}
export function browserSessionStore(): SessionStore | null {
  try { return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null } catch { return null }
}
export function resetMusicEngineForTests(next: MusicEngine | null = null) { engine = next }
