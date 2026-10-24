import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { browserSessionStore, EMPTY_SNAPSHOT, musicEngine, NativeEngine, playedTracks, readSession, WebEngine, type MusicEngine, type MusicSnapshot, type MusicStation, type MusicTrack } from './engine'
import { hostedAudioBridge } from './backgroundAudio'
if (typeof window !== 'undefined' && !window.WizardNativeMusic) window.WizardNativeMusic = hostedAudioBridge()
import { shareSong } from './share'
import { SwipeDeck, type SwipeDirection } from './swipe'
import './music.css'

const BASE = new URL('./', document.baseURI).pathname

type MusicSource = { id: string; name: string; status: string; detail: string; ok: boolean }
type MusicPlayback = { state: 'off' | 'untested' | 'ok' | 'blocked' | 'failed'; via: string; message: string }
type MusicHome = { settings?: { online: boolean; relay?: boolean }; playback?: MusicPlayback; sources: MusicSource[]; vibes: { id: string; label: string }[]; liked: MusicTrack[]; recent: MusicTrack[]; library: MusicTrack[]; taste?: { avoid: string[] } }
type FeedbackAction = 'like' | 'unlike' | 'dislike' | 'played' | 'skipped'
type FeedbackResult = { track: MusicTrack; drop?: string[]; learned?: { artists: string[]; genre: string; similar: string[] } | null }

async function musicJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'include', ...init, headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } })
  if (!response.ok) throw new Error(response.status === 503 ? 'Music is not connected on this Wizard yet.' : 'Your music hub did not answer. Try again in a moment.')
  return response.json() as Promise<T>
}
export const musicApi = {
  home: () => musicJson<MusicHome>(BASE + 'api/home'),
  settings: (online: boolean) => musicJson<{online: boolean}>(BASE + 'api/settings', { method: 'POST', body: JSON.stringify({online}) }),
  /** Home connection (Wizard Home Relay) address, or '' to remove it. Never read back. */
  relay: (relay: string) => musicJson<{online: boolean; relay: boolean}>(BASE + 'api/settings', { method: 'POST', body: JSON.stringify({relay}) }),
  search: (q: string) => musicJson<{ tracks: MusicTrack[] }>(`${BASE}api/search?q=${encodeURIComponent(q)}`),
  station: (seed: { trackId?: string; query?: string; label?: string }) => musicJson<{ station: MusicStation; tracks: MusicTrack[] }>(BASE + 'api/station', { method: 'POST', body: JSON.stringify(seed) }),
  feedback: (id: string, action: FeedbackAction, upcoming: string[] = []) => musicJson<FeedbackResult>(BASE + 'api/feedback', { method: 'POST', body: JSON.stringify({ id, action, upcoming }) }),
  /** A spoken request as heard ("play music guy barato trap"): the hub fixes misheard names and picks a station. */
  play: (said: string) => fetch(BASE + 'api/play', { method: 'POST', credentials: 'include', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ said }) })
    .then(async (response) => {
      const body = await response.json().catch(() => ({})) as SpokenPlay & { error?: string }
      if (!response.ok) throw new Error(response.status === 404 ? body.error || 'Couldn’t find that.' : response.status === 503 ? 'Music is not connected on this Wizard yet.' : 'Your music hub did not answer. Try again in a moment.')
      return body
    }),
}
export type SpokenPlay = { kind: string; said: string; query: string; heard: string; corrected?: string; station: MusicStation | null; tracks: MusicTrack[] }

/** Tell the hub, and drop anything still queued that no longer fits your taste. */
function sendFeedback(trackId: string, action: FeedbackAction): Promise<FeedbackResult | null> {
  const engine = engineIfStarted()
  const snap = engine?.snapshot()
  const upcoming = snap ? snap.queue.slice(Math.max(0, snap.index + (action === 'dislike' ? 0 : 1))).map((item) => item.id).filter((id) => id !== trackId).slice(0, 60) : []
  return musicApi.feedback(trackId, action, upcoming).then((result) => {
    // A successful taste change invalidates in-flight recommendations even if no
    // currently queued IDs need pruning. Older retained engines may lack this method.
    if (action === 'like' || action === 'unlike' || action === 'dislike' || result.drop?.length) {
      engineIfStarted()?.removeUpcoming?.(result.drop ?? [])
    }
    return result
  })
}

const artistKeys = (artist: string) => artist.split(/\s*(?:,|&|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\bfeaturing\b|\s[x×]\s)\s*/i)
  .map((name) => name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '')).filter((key) => key && key !== 'yourlibrary' && key !== 'variousartists')

/** Thumbs down: stop the song now, skip it, and teach the hub to avoid that kind of music. */
export function thumbsDown(track: MusicTrack, notify: (message: string) => void) {
  const engine = engineIfStarted()
  if (engine) {
    // Same artist queued next? Drop it first so the skip never lands on more of the same.
    const names = new Set(artistKeys(track.artist))
    const snap = engine.snapshot()
    engine.removeUpcoming(snap.queue.slice(snap.index + 1).filter((item) => !item.liked && artistKeys(item.artist).some((key) => names.has(key))).map((item) => item.id))
    engine.removeCurrent()
  }
  notify('Skipped. Noted you don’t like this.')
  sendFeedback(track.id, 'dislike').then((result) => {
    // The hub may also rule out the song that just started (a similar artist or the same genre).
    const now = engineIfStarted()?.snapshot()
    const playing = now?.queue[now.index]
    if (playing && result?.drop?.includes(playing.id)) engineIfStarted()?.removeCurrent()
    const learned = result?.learned
    const who = learned?.artists.length ? learned.artists.slice(0, 2).join(' & ') : ''
    if (who) notify(`Got it — no more ${who}, and less music like it.`)
  }).catch(() => notify('Skipped, but your music hub didn’t save that. Try again later.'))
}

let createdEngine: MusicEngine | null = null
function engineIfStarted(): MusicEngine | null {
  if (!createdEngine && typeof window !== 'undefined' && window.WizardNativeMusic) createdEngine = musicEngine()
  return createdEngine
}
function startEngine(): MusicEngine {
  createdEngine = musicEngine()
  return createdEngine
}
const startListeners = new Set<() => void>()
function noteEngineStarted() { for (const listener of [...startListeners]) listener() }

/** After a Wizard restart or an app update, pick up the last song, spot, queue and station. */
export function restoreMusicSession(): boolean {
  if (typeof window === 'undefined' || createdEngine) return false
  const session = readSession(browserSessionStore())
  const engine = startEngine()
  if (engine instanceof NativeEngine) {
    // The phone's player outlives this page but not an app update; refill it only if it came back empty.
    if (session) void engine.restoreIfEmpty(session)
    noteEngineStarted()
    return Boolean(session)
  }
  if (!session || !(engine instanceof WebEngine)) return false
  engine.resume(session)
  noteEngineStarted()
  return true
}

/** Which screen you were on (Now Playing or the library), so Music reopens there. */
const VIEW_KEY = 'wizard-music.view.v1'
export function rememberView(view: 'now' | 'home') { try { browserSessionStore()?.setItem(VIEW_KEY, view) } catch { /* storage blocked */ } }
export function lastViewWasNowPlaying() { try { return browserSessionStore()?.getItem(VIEW_KEY) === 'now' } catch { return false } }
/** Calls back once a song is loaded (restored or already playing), or never if none arrives in time. */
export function whenTrackLoaded(callback: () => void, waitMs = 10000): () => void {
  const engine = engineIfStarted()
  if (!engine) return () => undefined
  const has = () => { const snap = engine.snapshot(); return Boolean(snap.queue[snap.index]) }
  if (has()) { callback(); return () => undefined }
  let done = false
  const stop = engine.subscribe(() => { if (!done && has()) { done = true; stop(); clearTimeout(timer); callback() } })
  const timer = window.setTimeout(() => { done = true; stop() }, waitMs)
  return () => { done = true; stop(); clearTimeout(timer) }
}

// "Search for Home Tides" by voice shows the results list (it never picks one and plays it).
// MusicApp owns the search box and registers the handler; the shell closes Now Playing so the list shows.
let searchHandler: ((query: string) => Promise<number>) | null = null
const searchShown = new Set<() => void>()

/** What voice commands drive: the same engine and feedback paths as the buttons. */
export const musicControl = {
  engine: engineIfStarted,
  async play(tracks: MusicTrack[], station: MusicStation | null) {
    await startEngine().load(tracks, 0, station)
    noteEngineStarted()
  },
  feedback: sendFeedback,
  /** Fill the search box with `query` and show its results. Resolves to the number of results. */
  async search(query: string): Promise<number> {
    searchShown.forEach((fn) => fn())
    if (searchHandler) return searchHandler(query)
    return (await musicApi.search(query)).tracks.length
  },
  onSearchShown(fn: () => void) { searchShown.add(fn); return () => { searchShown.delete(fn) } },
}

export function useMusicSnapshot(): MusicSnapshot {
  const subscribe = useCallback((listener: () => void) => {
    let stop = engineIfStarted()?.subscribe(listener) ?? (() => undefined)
    const onStart = () => { stop(); stop = engineIfStarted()?.subscribe(listener) ?? (() => undefined); listener() }
    startListeners.add(onStart)
    return () => { stop(); startListeners.delete(onStart) }
  }, [])
  return useSyncExternalStore(subscribe, () => engineIfStarted()?.snapshot() ?? EMPTY_SNAPSHOT, () => EMPTY_SNAPSHOT)
}

function useFeedbackReporter(snapshot: MusicSnapshot) {
  const reported = useRef('')
  const current = snapshot.queue[snapshot.index]
  useEffect(() => {
    if (snapshot.engine === 'native' || !current || reported.current === current.id || !snapshot.playing) return
    reported.current = current.id
    void sendFeedback(current.id, 'played').catch(() => undefined)
  }, [current, snapshot.playing])
}

const time = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
const sourceLabel = (source: string) => source === 'library' ? 'Library' : source === 'youtube' ? 'YouTube Music' : source

const PlayGlyph = ({ size = 22 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5L7 4.5Z" fill="currentColor" /></svg>
const PauseGlyph = ({ size = 22 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h3.6v16H7zM13.4 4H17v16h-3.6z" fill="currentColor" /></svg>
const NextGlyph = () => <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14l10-7L5 5Zm11 0h2.5v14H16z" fill="currentColor" /></svg>
const PrevGlyph = () => <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v14L9 12l10-7ZM5.5 5H8v14H5.5z" fill="currentColor" /></svg>
const THUMB_PATH = 'M7.5 10.5 11 3.6c.3-.6 1-.9 1.6-.6 1.2.5 1.9 1.8 1.6 3.1L13.6 9h5.2c1.3 0 2.3 1.2 2 2.5l-1.5 7c-.2.9-1 1.5-1.9 1.5H7.5m0-9.5v9.5m0-9.5H4.2c-.4 0-.7.3-.7.7v8.1c0 .4.3.7.7.7h3.3'
const ThumbUpGlyph = ({ filled = false, size = 24 }: { filled?: boolean; size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d={THUMB_PATH} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" /></svg>
const ThumbDownGlyph = ({ size = 24 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ transform: 'rotate(180deg)' }}><path d={THUMB_PATH} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" /></svg>
const SearchGlyph = () => <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="m15.5 15.5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
const PlayNextGlyph = () => <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h11M4 11h11M4 16h6M17 13v8m-4-4h8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
// The same share glyph as Copy · Share under a chat reply.
const ShareGlyph = () => <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
const CloseGlyph = ({ size = 22 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>
/** The X: end this song and session (YouTube Music style). Minimising keeps it; this does not. */
export function endListening() {
  engineIfStarted()?.stop()
  rememberView('home')
}
const ChevronDown = () => <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>

function Art({ track, size }: { track?: MusicTrack; size: 'row' | 'card' | 'hero' | 'mini' }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [track?.id])
  return <span className={`music-art music-art-${size}`}>{track && !failed ? <img src={track.art} alt="" loading="lazy" onError={() => setFailed(true)} /> : <span className="music-art-fallback">♪</span>}</span>
}

function TrackRow({ track, active, played, onPlay, onPlayNext }: { track: MusicTrack; active?: boolean; played?: boolean; onPlay: () => void; onPlayNext?: () => void }) {
  return <div className={`music-row${active ? ' active' : ''}${played ? ' played' : ''}`} aria-current={active ? 'true' : undefined}>
    <button type="button" className="music-row-main" onClick={onPlay}>
      <Art track={track} size="row" />
      <span className="music-row-text"><strong>{track.title}</strong><small>{track.artist}{track.source === 'library' ? <em className="music-source-badge">Library</em> : null}</small></span>
      {track.durationMs > 0 && <span className="music-row-time">{time(track.durationMs)}</span>}
    </button>
    {onPlayNext && <button type="button" className="music-icon-button" aria-label={`Play ${track.title} next`} onClick={onPlayNext}><PlayNextGlyph /></button>}
  </div>
}

// A tapped song opens Now Playing at once with a loading wheel while its station is fetched and the
// audio starts; the sheet swaps to the real player the moment the engine has it.
let pendingStart: MusicTrack | null = null
let pendingFailed = false
const pendingListeners = new Set<() => void>()
function setPendingStart(track: MusicTrack | null) { pendingStart = track; pendingListeners.forEach((listener) => listener()) }
export function usePendingStart(): MusicTrack | null {
  return useSyncExternalStore((listener) => { pendingListeners.add(listener); return () => { pendingListeners.delete(listener) } }, () => pendingStart, () => null)
}
const LoadingWheel = ({ label }: { label: string }) => <span className="music-wheel" role="progressbar" aria-label={label} />

export function MusicApp({ onOpenNowPlaying, notify }: { onOpenNowPlaying: () => void; notify: (message: string) => void }) {
  const snapshot = useMusicSnapshot()
  useFeedbackReporter(snapshot)
  const [home, setHome] = useState<MusicHome | null>(null)
  const [savingConsent, setSavingConsent] = useState(false)
  const [homeError, setHomeError] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MusicTrack[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [starting, setStarting] = useState('')
  const searchSeq = useRef(0)
  const current = snapshot.queue[snapshot.index]

  const loadHome = useCallback(() => {
    setHomeError('')
    musicApi.home().then(setHome).catch((error: Error) => setHomeError(error.message))
  }, [])
  useEffect(() => { loadHome() }, [loadHome])

  const runSearch = useCallback(async (text: string, quiet = false): Promise<number> => {
    const q = text.trim()
    const seq = ++searchSeq.current
    if (!q) { setResults(null); return 0 }
    setSearching(true)
    if (quiet) setResults((was) => was ?? [])
    try {
      const payload = await musicApi.search(q)
      if (seq === searchSeq.current) setResults(payload.tracks)
      return payload.tracks.length
    } catch (error) {
      if (seq !== searchSeq.current) return 0
      if (quiet) throw error
      notify((error as Error).message)
      return 0
    } finally { if (seq === searchSeq.current) setSearching(false) }
  }, [notify])
  // Voice: "search for X" fills the box and lists the results, top of the page.
  useEffect(() => {
    searchHandler = (q) => { setQuery(q); window.scrollTo?.(0, 0); return runSearch(q, true) }
    return () => { searchHandler = null }
  }, [runSearch])

  const startSeq = useRef(0)
  const startStation = useCallback(async (seed: { trackId?: string; query?: string; label?: string }, key: string, tapped?: MusicTrack) => {
    const seq = ++startSeq.current
    setStarting(key)
    if (tapped) { pendingFailed = false; setPendingStart(tapped); onOpenNowPlaying() }
    try {
      const { station, tracks } = await musicApi.station(seed)
      if (seq !== startSeq.current) return // a newer tap won
      await startEngine().load(tracks, 0, station)
      noteEngineStarted()
      if (!tapped) onOpenNowPlaying()
    } catch (error) {
      if (seq === startSeq.current) { pendingFailed = Boolean(tapped); notify((error as Error).message || 'Could not start that station.') }
    } finally {
      if (seq === startSeq.current) { setStarting(''); if (tapped) setPendingStart(null) }
    }
  }, [notify, onOpenNowPlaying])

  const playNext = useCallback((track: MusicTrack) => {
    const engine = engineIfStarted()
    if (!engine || !snapshot.queue.length) { void startStation({ trackId: track.id }, track.id, track); return }
    engine.enqueueNext(track)
    notify(`${track.title} plays next`)
  }, [notify, snapshot.queue.length, startStation])

  const playRow = (track: MusicTrack) => void startStation({ trackId: track.id }, track.id, track)

  return <section className="music-workspace" aria-label="Wizard Music">
    <form className="music-search" role="search" onSubmit={(event) => { event.preventDefault(); void runSearch(query) }}>
      <SearchGlyph />
      <input type="search" value={query} placeholder="Song, artist, or vibe" aria-label="Search music" enterKeyHint="search" onChange={(event) => { setQuery(event.target.value); if (!event.target.value) setResults(null) }} />
      {query && <button type="button" className="music-clear" aria-label="Clear search" onClick={() => { setQuery(''); setResults(null) }}>×</button>}
    </form>

    {home && <section className="music-card music-consent" aria-label="Online sources">
      <label><input type="checkbox" role="switch" aria-label="Online sources" checked={Boolean(home.settings?.online)} disabled={savingConsent} onChange={async (event) => {
        const enabled = event.target.checked
        setSavingConsent(true)
        try {
          await musicApi.settings(enabled)
          if (!enabled) { ++searchSeq.current; setResults(null); setQuery(''); endListening() }
          setHome(await musicApi.home())
        } catch (error) { notify((error as Error).message) }
        finally { setSavingConsent(false) }
      }} /> Online sources</label>
      <p>When on, searches and track details go to YouTube Music, Deezer, Apple and MusicBrainz to find songs, audio and artwork.</p>
      {home.playback?.message && <p className="music-warning" role="alert">{home.playback.message}</p>}
      {home.settings?.online && <HomeConnection connected={Boolean(home.settings.relay)} onSaved={async () => setHome(await musicApi.home())} notify={notify} />}
    </section>}

    {starting && <p className="music-status" role="status">Starting your station…</p>}

    {results !== null ? <div className="music-results">
      <div className="music-section-head"><h3>{searching ? 'Searching…' : `Results for “${query.trim()}”`}</h3>{query.trim() && <button type="button" className="music-chip" onClick={() => void startStation({ query: query.trim(), label: query.trim() }, 'vibe:query')}>Station from this</button>}</div>
      {!searching && !results.length && <p className="music-empty">Nothing matched. Try an artist, a song, or a mood.</p>}
      {results.map((track) => <TrackRow key={track.id} track={track} active={track.id === current?.id} onPlay={() => playRow(track)} onPlayNext={() => playNext(track)} />)}
    </div> : <>
      {homeError && <div className="music-card music-error"><p>{homeError}</p><button type="button" className="secondary-action" onClick={loadHome}>Try again</button></div>}

      {home && <div className="music-sources" aria-label="Music sources">
        {home.sources.map((source) => <span key={source.id} className={`music-source${source.ok ? ' ok' : ''}`}><b>{source.name}</b><small>{source.detail}</small></span>)}
      </div>}

      {home && Boolean(home.taste?.avoid.length) && <p className="music-taste" aria-label="Music you turned down">Playing less: {home.taste!.avoid.join(' · ')}</p>}

      {home && home.vibes.length > 0 && <section className="music-section" aria-label="Start a station">
        <div className="music-section-head"><h3>Start a station</h3></div>
        <div className="music-chips">
          {home.vibes.map((vibe) => <button key={vibe.id} type="button" className="music-chip" disabled={Boolean(starting)} onClick={() => void startStation({ query: vibe.label, label: vibe.label }, `vibe:${vibe.id}`)}>{vibe.label}</button>)}
        </div>
      </section>}

      {home && home.recent.length > 0 && <section className="music-section" aria-label="Recently played">
        <div className="music-section-head"><h3>Recently played</h3></div>
        <div className="music-shelf">
          {home.recent.map((track) => <button type="button" key={track.id} className="music-tile" onClick={() => playRow(track)}><Art track={track} size="card" /><strong>{track.title}</strong><small>{track.artist}</small></button>)}
        </div>
      </section>}

      {home && home.liked.length > 0 && <section className="music-section" aria-label="Liked songs">
        <div className="music-section-head"><h3>Liked</h3><button type="button" className="music-chip" onClick={async () => { const station: MusicStation | null = null; await startEngine().load(home.liked, 0, station); noteEngineStarted(); onOpenNowPlaying() }}>Play all</button></div>
        {home.liked.slice(0, 8).map((track) => <TrackRow key={track.id} track={track} active={track.id === current?.id} onPlay={() => playRow(track)} onPlayNext={() => playNext(track)} />)}
      </section>}

      {home && home.library.length > 0 && <section className="music-section" aria-label="Your library">
        <div className="music-section-head"><h3>On your Wizard</h3><button type="button" className="music-chip" onClick={async () => { await startEngine().load([...home.library].sort(() => Math.random() - 0.5), 0, null); noteEngineStarted(); onOpenNowPlaying() }}>Shuffle</button></div>
        {home.library.slice(0, 12).map((track) => <TrackRow key={track.id} track={track} active={track.id === current?.id} onPlay={() => playRow(track)} onPlayNext={() => playNext(track)} />)}
      </section>}

      {home && home.library.length === 0 && home.liked.length === 0 && <p className="music-empty">Your music starts here. Turn on Online sources above, search for a song and tap it to play. Or ask your Wizard to add your own MP3, M4A, FLAC, OGG or WAV files to Music’s library folder; they appear automatically. No music or account is bundled.</p>}
      {!home && !homeError && <p className="music-status">Loading your music…</p>}
    </>}
  </section>
}

export function MiniPlayer({ onOpen, notify }: { onOpen: () => void; notify: (message: string) => void }) {
  const snapshot = useMusicSnapshot()
  const track = snapshot.queue[snapshot.index]
  if (!track) return null
  const progress = snapshot.durationMs ? Math.min(1, snapshot.positionMs / snapshot.durationMs) : 0
  return <div className={`music-mini${snapshot.stale ? ' music-stale' : ''}`} role="region" aria-label="Now playing">
    <button type="button" className="music-mini-open" onClick={onOpen} aria-label={`Open player: ${track.title} by ${track.artist}`}>
      <SwipeDeck className="music-mini-deck" gap={24} {...neighbours(snapshot)} onCommit={(direction, to) => swipeTo(direction, to, track, snapshot)}
        render={(item) => <><Art track={item} size="mini" /><span className="music-row-text"><strong>{item.title}</strong><small>{item.artist}</small></span></>} />
    </button>
    <button type="button" className="music-mini-down" aria-label="Thumbs down: stop this song" onClick={() => thumbsDown(track, notify)}><ThumbDownGlyph size={22} /></button>
    <button type="button" className="music-mini-toggle" aria-label={(snapshot.wantPlaying ?? snapshot.playing) ? 'Pause' : 'Play'} onClick={() => engineIfStarted()?.toggle()}>{(snapshot.wantPlaying ?? snapshot.playing) ? <PauseGlyph /> : <PlayGlyph />}</button>
    <button type="button" className="music-mini-next" aria-label="Next song" onClick={() => changeTrack('next', track, snapshot)}><NextGlyph /></button>
    <button type="button" className="music-mini-close" aria-label="Close: stop this song and end the session" onClick={endListening}><CloseGlyph size={20} /></button>
    <span className="music-mini-progress" style={{ transform: `scaleX(${progress})` }} />
  </div>
}

/** Next / previous buttons: next also tells the hub the song was skipped. */
function changeTrack(direction: SwipeDirection, track: MusicTrack, snapshot: MusicSnapshot) {
  const engine = engineIfStarted()
  if (!engine) return
  if (direction === 'previous') { engine.previous(); return }
  if (snapshot.engine !== 'native') void sendFeedback(track.id, 'skipped').catch(() => undefined)
  engine.next()
}

/** A swipe lands on exactly the song it slid in (previous never just restarts the current one). */
function swipeTo(direction: SwipeDirection, to: number, track: MusicTrack, snapshot: MusicSnapshot) {
  const engine = engineIfStarted()
  if (!engine) return
  if (direction === 'previous') { engine.jump(to); return }
  if (snapshot.engine !== 'native') void sendFeedback(track.id, 'skipped').catch(() => undefined)
  engine.next()
}

function neighbours(snapshot: MusicSnapshot) {
  const at = snapshot.index, q = snapshot.queue
  return {
    prev: at > 0 && q[at - 1] ? { track: q[at - 1], at: at - 1 } : undefined,
    current: { track: q[at], at },
    next: q[at + 1] ? { track: q[at + 1], at: at + 1 } : undefined,
  }
}

/**
 * Pull the player down to minimise it (YouTube Music style): drag down from anywhere while the page is
 * scrolled to the top; past ~110px or a quick flick it slides away, otherwise it springs back.
 * Touch events (not pointer) so we can stop the page from scrolling while you pull.
 */
function useSwipeDownToClose(ref: { current: HTMLDivElement | null }, onClose: () => void) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let start: { x: number; y: number; t: number; mode: 'pending' | 'down' | 'off' } | null = null
    let dy = 0
    const body = () => el.querySelector<HTMLElement>('.music-now-body')
    const place = (y: number, animate: boolean) => {
      el.style.transition = animate ? 'transform 220ms cubic-bezier(.2,.7,.3,1)' : 'none'
      el.style.transform = y ? `translate3d(0,${Math.round(y)}px,0)` : ''
    }
    const down = (event: TouchEvent) => {
      if (event.touches.length !== 1 || (event.target as HTMLElement).closest('input,textarea,[data-no-swipe]')) { start = null; return }
      const touch = event.touches[0]
      start = { x: touch.clientX, y: touch.clientY, t: event.timeStamp, mode: 'pending' }
      dy = 0
    }
    const move = (event: TouchEvent) => {
      if (!start || start.mode === 'off') return
      const touch = event.touches[0]
      const x = touch.clientX - start.x, y = touch.clientY - start.y
      if (start.mode === 'pending') {
        if (Math.abs(x) < 10 && Math.abs(y) < 10) return
        const atTop = (body()?.scrollTop ?? 0) <= 0
        start.mode = y > 0 && y > Math.abs(x) * 1.2 && atTop && event.cancelable ? 'down' : 'off'
        if (start.mode === 'off') return
      }
      event.preventDefault()
      dy = Math.max(0, y)
      place(dy, false)
    }
    const up = (event: TouchEvent) => {
      if (!start) return
      const s = start
      start = null
      if (s.mode !== 'down') return
      const speed = dy / Math.max(1, event.timeStamp - s.t)
      if (dy > 110 || (dy > 40 && speed > 0.5)) {
        navigator.vibrate?.(8)
        place(el.clientHeight || window.innerHeight, true)
        window.setTimeout(() => close.current(), 200)
      } else place(0, true)
    }
    // Android may cancel a long drag (the system or WebView claims it). Past the threshold it still closes.
    const cancel = () => {
      const s = start; start = null
      if (s?.mode !== 'down') return
      if (dy > 110) { place(el.clientHeight || window.innerHeight, true); window.setTimeout(() => close.current(), 200) } else place(0, true)
    }
    el.addEventListener('touchstart', down, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', up)
    el.addEventListener('touchcancel', cancel)
    return () => { el.removeEventListener('touchstart', down); el.removeEventListener('touchmove', move); el.removeEventListener('touchend', up); el.removeEventListener('touchcancel', cancel) }
  }, [ref])
}

const SHOW_PLAYED_KEY = 'wizard-music.show-played'

export function NowPlaying({ onClose, notify }: { onClose: () => void; notify: (message: string) => void }) {
  const snapshot = useMusicSnapshot()
  useFeedbackReporter(snapshot)
  const engine = engineIfStarted()
  const track = snapshot.queue[snapshot.index]
  const pending = usePendingStart()
  const [likes, setLikes] = useState<Record<string, boolean>>({})
  const [scrub, setScrub] = useState<number | null>(null)
  const upNext = useMemo(() => snapshot.queue.slice(snapshot.index + 1, snapshot.index + 40).map((item, offset) => ({ item, position: snapshot.index + 1 + offset })), [snapshot.queue, snapshot.index])
  const played = useMemo(() => playedTracks(snapshot), [snapshot.queue, snapshot.index]) // eslint-disable-line react-hooks/exhaustive-deps
  const [showPlayed, setShowPlayedState] = useState(() => { try { return localStorage.getItem(SHOW_PLAYED_KEY) === '1' } catch { return false } })
  const sheet = useRef<HTMLDivElement>(null)
  useSwipeDownToClose(sheet, onClose)
  // Opened for a tap whose start then failed: close back to the library rather than leave an empty layer.
  // Only the tap → failure transition closes; restores and stale native snapshots keep their old behaviour.
  // A started song can reach the snapshot a beat after the station loads (the phone's native player answers
  // asynchronously), so the wheel stays up until the song is really there.
  const lastTapped = useRef<MusicTrack | null>(null)
  if (pending) lastTapped.current = pending
  else if (track && engine && !pendingFailed) lastTapped.current = null
  useEffect(() => {
    if (pending || !pendingFailed) return
    pendingFailed = false
    if (!lastTapped.current) return // a later open (mini player) after a failure in a closed sheet
    lastTapped.current = null
    onClose()
  }, [pending]) // eslint-disable-line react-hooks/exhaustive-deps
  const loading = pending ?? (pendingFailed ? null : lastTapped.current)
  const setShowPlayed = (open: boolean) => { setShowPlayedState(open); try { localStorage.setItem(SHOW_PLAYED_KEY, open ? '1' : '0') } catch { /* storage blocked */ } }
  const loadingView = (pending: MusicTrack) => <>
    <header className="music-now-head">
      <button type="button" className="icon-button" aria-label="Close player" onClick={onClose}><ChevronDown /></button>
      <div><small>Starting</small><strong>{sourceLabel(pending.source)}</strong></div>
      <span className="music-now-spacer" />
    </header>
    <div className="music-now-body">
      <span className="music-now-pending-art"><Art track={pending} size="hero" /><LoadingWheel label={`Loading ${pending.title}`} /></span>
      <div className="music-now-meta"><div><h2>{pending.title}</h2><p>{pending.artist}{pending.album ? ` · ${pending.album}` : ''}</p></div></div>
      <p className="music-now-loading-note" role="status">Loading…</p>
    </div>
  </>
  if (loading) return <div ref={sheet} className="music-now music-now-loading" role="dialog" aria-modal="true" aria-label="Now playing" aria-busy="true">{loadingView(loading)}</div>
  if (!track || !engine) return null
  const liked = likes[track.id] ?? Boolean(track.liked)
  const duration = snapshot.durationMs || track.durationMs
  const position = scrub ?? snapshot.positionMs

  const like = () => {
    const next = !liked
    setLikes((value) => ({ ...value, [track.id]: next }))
    if (next) notify('Liked. More like this.')
    void sendFeedback(track.id, next ? 'like' : 'unlike').catch(() => notify('Could not save that like.'))
  }

  return <div ref={sheet} className={`music-now${snapshot.stale ? ' music-stale' : ''}`} role="dialog" aria-modal="true" aria-label="Now playing">
    <header className="music-now-head">
      <button type="button" className="icon-button" aria-label="Close player" onClick={onClose}><ChevronDown /></button>
      <div><small>{snapshot.station ? 'Station' : 'Playing'}</small><strong>{snapshot.station?.title ?? sourceLabel(track.source)}</strong></div>
      <button type="button" className="icon-button music-share" aria-label={`Share ${track.title}`} title="Share" onClick={() => void shareSong(track, notify)}><ShareGlyph /></button>
      <button type="button" className="icon-button music-end" aria-label="Close: stop this song and end the session" title="Stop and close" onClick={() => { onClose(); endListening() }}><CloseGlyph /></button>
    </header>
    <div className="music-now-body">
      <SwipeDeck className="music-now-deck" label="Swipe left for next song, right for previous" {...neighbours(snapshot)} onCommit={(direction, to) => swipeTo(direction, to, track, snapshot)}
        render={(item) => <>
          <Art track={item} size="hero" />
          <div className="music-now-meta">
            <div><h2>{item.title}</h2><p>{item.artist}{item.album ? ` · ${item.album}` : ''}</p></div>
          </div>
        </>} />
      <div className="music-seek">
        <input type="range" min={0} max={Math.max(1, duration)} step={1000} value={Math.min(position, duration || position)} aria-label="Seek"
          onChange={(event) => setScrub(Number(event.target.value))}
          onPointerUp={() => { if (scrub !== null) { engine.seek(scrub); setScrub(null) } }}
          onKeyUp={() => { if (scrub !== null) { engine.seek(scrub); setScrub(null) } }} />
        <div className="music-seek-times"><span>{time(position)}</span><span>{snapshot.buffering ? 'Loading…' : sourceLabel(track.source)}</span><span>{time(duration)}</span></div>
      </div>
      <div className="music-controls">
        <button type="button" className="music-icon-button music-thumb music-thumb-down" aria-label="Thumbs down: stop this song" onClick={() => thumbsDown(track, notify)}><ThumbDownGlyph /></button>
        <button type="button" className="music-icon-button big" aria-label="Previous" onClick={() => engine.previous()}><PrevGlyph /></button>
        <button type="button" className="music-play" aria-label={(snapshot.wantPlaying ?? snapshot.playing) ? 'Pause' : 'Play'} onClick={() => engine.toggle()}>{snapshot.buffering && (snapshot.wantPlaying ?? true) ? <LoadingWheel label="Loading" /> : (snapshot.wantPlaying ?? snapshot.playing) ? <PauseGlyph size={30} /> : <PlayGlyph size={30} />}</button>
        <button type="button" className="music-icon-button big" aria-label="Next" onClick={() => changeTrack('next', track, snapshot)}><NextGlyph /></button>
        <button type="button" className={`music-icon-button music-thumb music-like${liked ? ' on' : ''}`} aria-pressed={liked} aria-label={liked ? 'Thumbs up (on)' : 'Thumbs up'} onClick={like}><ThumbUpGlyph filled={liked} /></button>
      </div>
      {snapshot.error && <p className="music-status" role="status">{snapshot.error}</p>}
      <section className="music-upnext" aria-label="Queue">
        {played.length > 0 && <button type="button" className={`music-played-toggle${showPlayed ? ' open' : ''}`} aria-expanded={showPlayed} onClick={() => setShowPlayed(!showPlayed)}>
          <span>{showPlayed ? 'Hide played' : `Played · ${played.length}`}</span><ChevronDown />
        </button>}
        {showPlayed && played.length > 0 && <div className="music-played" aria-label="Played">
          {played.map(({ item, position: at }) => <TrackRow key={`${item.id}-${at}`} track={item} played onPlay={() => engine.jump(at)} />)}
          <TrackRow track={track} active onPlay={() => undefined} />
        </div>}
        <div className="music-section-head"><h3>Up next</h3>{snapshot.station && <small>Endless · keeps going</small>}</div>
        {upNext.map(({ item, position: at }) => <TrackRow key={`${item.id}-${at}`} track={item} onPlay={() => engine.jump(at)} />)}
        {!upNext.length && <p className="music-empty">{snapshot.station ? 'Finding more…' : 'End of queue.'}</p>}
      </section>
    </div>
  </div>
}

/** Optional home-network exit for a Wizard on a data-center server (YouTube blocks those). */
function HomeConnection({ connected, onSaved, notify }: { connected: boolean; onSaved: () => Promise<void>; notify: (message: string) => void }) {
  const [open, setOpen] = useState(false)
  const [address, setAddress] = useState('')
  const [saving, setSaving] = useState(false)
  const save = async (value: string) => {
    setSaving(true)
    try { await musicApi.relay(value); setAddress(''); setOpen(false); await onSaved() }
    catch { notify('That address didn\u2019t work. It looks like socks5h://wizard:\u2026@100.x.x.x:18765') }
    finally { setSaving(false) }
  }
  if (connected && !open) return <p className="music-home-link">Home connection on \u00b7 <button type="button" className="music-link" onClick={() => void save('')} disabled={saving}>Remove</button></p>
  if (!open) return <p className="music-home-link">On a cloud server? <button type="button" className="music-link" onClick={() => setOpen(true)}>Add a home connection</button></p>
  return <form className="music-home-form" onSubmit={(event) => { event.preventDefault(); void save(address) }}>
    <p>Install Wizard Home Relay on a computer at home that\u2019s on your Tailscale, then paste the address it prints.</p>
    <input type="password" autoComplete="off" value={address} placeholder="socks5h://wizard:\u2026@100.x.x.x:18765" aria-label="Home connection address" onChange={(event) => setAddress(event.target.value)} />
    <div><button type="submit" className="secondary-action" disabled={saving || !address.trim()}>Save</button><button type="button" className="music-link" onClick={() => setOpen(false)}>Cancel</button></div>
  </form>
}
