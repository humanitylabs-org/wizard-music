import { musicApi, musicControl } from './MusicApp'
import type { MusicTrack } from './engine'

export type Candidate = { id: number; title: string; artist: string; provider: string; verdict?: string; art_url?: string; compare_url?: string; preview_url?: string; artwork_url?: string }
export type Hunt = { id: string; created_at: string; status: string; best_title?: string; best_artist?: string; note?: string; last_error?: string; raw_sha256?: string; audio_url?: string; original_url?: string; export_url?: string; candidates?: Candidate[]; attempts?: { id: number; provider: string; outcome: string; preprocess?: string; error?: string }[] }
export type CaptureResult = { id: string; blob: Blob; mime: string; startedAt: number; durationMs: number; partial?: boolean; meta?: { task?: string; geo?: Record<string, number>; note?: string; manualSubmit?: boolean } }
export type CaptureHandle = { id: string; stop(): Promise<CaptureResult>; onLevel(fn: (value: number | { me?: number; them?: number }) => void): () => void }
export type CapturePort = { start(options: Record<string, unknown>): Promise<CaptureHandle>; pending(): Promise<CaptureResult[]>; ack(id: string): Promise<unknown> }
type LocalClip = { id: string; sharedId?: string; blob: Blob; mime: string; client_ts: string; duration_s: number; geo?: Record<string, number>; partial?: boolean; note?: string; sendRequested?: boolean }
type State = { open: boolean; selected: string | null; detail: Hunt | null; hunts: Hunt[]; locals: LocalClip[]; phase: 'idle' | 'starting' | 'recording' | 'saving' | 'ready'; freshId: string | null; elapsed: number; level: number; error: string; loading: boolean; note: string; geoEnabled: boolean; sendErrors: Record<string, string>; needsTap: boolean }
const BASE = '/wizard-music/api/identify/'
const ACTIVE = 'wizard-music.identify.active.v1'
let state: State = { open: false, selected: null, detail: null, hunts: [], locals: [], phase: 'idle', freshId: null, elapsed: 0, level: 0, error: '', loading: false, note: '', geoEnabled: false, sendErrors: {}, needsTap: false }
const listeners = new Set<() => void>()
function paint(patch: Partial<State>) { state = { ...state, ...patch }; listeners.forEach(fn => fn()) }
let handle: CaptureHandle | null = null, startedAt = 0, tick = 0, autoStop = 0, offLevel: (() => void) | undefined
let releaseHold: (() => void) | undefined
let draining: Promise<void> | null = null
let detailGeneration = 0, refreshGeneration = 0
let closePlayer: (() => void) | undefined
export const IDENTIFY_TARGET_SECONDS = 12
let recordingId = ''
export const IDENTIFY_LIMIT_SECONDS = 30
// Navigation invalidates the one opportunity to open this submission, never its audio custody.
let navigation = 0, captureNavigation = 0, cancelled = false, readyClip: LocalClip | null = null
function stillWaiting() { return captureNavigation === navigation && state.open && (window.WizardApp.view?.isVisible?.() ?? !document.hidden) }
function leaveWaiting() { ++navigation }
function showSubmission(item: LocalClip) {
  paint({ freshId: item.id })
  // Selection happens in the send event, before saving. Never reopen after navigation or a late reply.
}


export async function identifyJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'include', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || 'Your hunt is saved. Try again when connected.')
  return value as T
}
function db(): Promise<IDBDatabase> {
  // The old app's same-origin outbox is deliberately reused, so an offline clip is not stranded.
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('trackhunt-offline-v1', 1)
    r.onupgradeneeded = () => { r.result.createObjectStore('captures', { keyPath: 'id' }) }
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error)
  })
}
async function localStore(op: 'put' | 'delete' | 'all', value?: LocalClip | string): Promise<LocalClip[]> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const tx = d.transaction('captures', op === 'all' ? 'readonly' : 'readwrite'), store = tx.objectStore('captures')
    let rows: LocalClip[] = []
    if (op === 'all') { const q = store.getAll(); q.onsuccess = () => { rows = q.result } }
    else if (op === 'put') store.put(value)
    else store.delete(value as string)
    tx.oncomplete = () => { d.close(); resolve(rows) }; tx.onerror = () => { d.close(); reject(tx.error) }; tx.onabort = tx.onerror
  })
}
export async function backendCaptureId(id: string): Promise<string> {
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) return id.toLowerCase()
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))).slice(0, 16)
  b[6] = (b[6] & 15) | 80; b[8] = (b[8] & 63) | 128
  const h = Array.from(b, n => n.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
async function persist(result: CaptureResult, sendRequested = !result.meta?.manualSubmit): Promise<LocalClip> {
  if (!result.blob?.size) throw new Error('No audio returned. Recovery remains in shared capture.')
  const item: LocalClip = { id: await backendCaptureId(result.id), sharedId: result.id, blob: result.blob, mime: result.mime, client_ts: new Date(result.startedAt).toISOString(), duration_s: result.durationMs / 1000, partial: result.partial, geo: result.meta?.geo, note: result.meta?.note, sendRequested }
  await localStore('put', item)
  paint({ locals: await localStore('all') })
  return item
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
export async function uploadClip(item: LocalClip) {
  const q = new URLSearchParams({ id: item.id, client_ts: item.client_ts, note: item.note || '' })
  if (item.geo) for (const k of ['lat', 'lon', 'accuracy_m']) if (item.geo[k] != null) q.set(k, String(item.geo[k]))
  const response = await fetch(BASE + 'captures?' + q, { method: 'POST', credentials: 'include', headers: { 'Content-Type': item.mime || item.blob.type || 'audio/webm' }, body: item.blob })
  if (!response.ok) throw new Error('Not sent yet. Retrying.')
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await item.blob.arrayBuffer())), n => n.toString(16).padStart(2, '0')).join('')
  // The upload reply already describes the stored clip; a separate read is only a fallback.
  let saved: Partial<Hunt> | null = await response.json().catch(() => null)
  for (let i = 0; !(saved?.id === item.id && saved.raw_sha256 === digest) && i < 4; i++) {
    await wait(500 * 2 ** i)
    saved = await identifyJson<Hunt>('captures/' + item.id).catch(() => null)
  }
  if (saved?.id !== item.id || saved.raw_sha256 !== digest) throw new Error('Sent, but the server has not confirmed the audio yet. Retrying.')
  if (item.sharedId) await window.WizardApp.capture.ack(item.sharedId)
  await localStore('delete', item.id)
}
async function refresh() {
  const gen = ++refreshGeneration
  try {
    const [value, locals] = await Promise.all([identifyJson<{ captures: Hunt[] }>('captures'), localStore('all')])
    if (gen === refreshGeneration) paint({ hunts: value.captures, locals, loading: false })
    if (state.selected) await detail(state.selected, false)
  } catch (e) { if (gen === refreshGeneration) paint({ locals: await localStore('all').catch(() => state.locals), loading: false, error: (e as Error).message }) }
}
async function detail(id: string, selecting = true) {
  const gen = ++detailGeneration
  if (selecting) { leaveWaiting(); paint({ selected: id, detail: null, error: '', freshId: state.freshId === id ? null : state.freshId }) }
  const local = state.locals.find(c => c.id === id)
  if (local) return
  try {
    const value = await identifyJson<Hunt>('captures/' + id)
    if (gen === detailGeneration && state.selected === id) paint({ detail: value })
  } catch (e) { if (gen === detailGeneration && state.selected === id) paint({ error: (e as Error).message }) }
}
let drainAgain = false, retryTimer = 0, retryDelay = 5000
function scheduleRetry() {
  if (retryTimer) return
  retryTimer = window.setTimeout(() => { retryTimer = 0; void drain() }, retryDelay)
  retryDelay = Math.min(retryDelay * 2, 120000)
}
async function drain(): Promise<void> {
  // A clip saved while a drain is running gets its own pass; it is never left waiting for the next trigger.
  if (draining) { drainAgain = true; return draining }
  draining = (async () => {
    try {
      do {
        drainAgain = false
        const known = await localStore('all')
        for (const r of await window.WizardApp.capture.pending()) {
          if (r.blob?.size && r.meta?.task === 'music-identify' && r.id !== handle?.id && !known.some(c => c.sharedId === r.id)) await persist(r)
        }
        let failed = false
        for (const item of await localStore('all')) {
          if (!item.blob?.size || item.sendRequested === false || (item.partial && !item.sharedId)) continue
          try {
            await uploadClip(item)
            const { [item.id]: _sent, ...rest } = state.sendErrors; paint({ sendErrors: rest })
          } catch (e) { failed = true; paint({ sendErrors: { ...state.sendErrors, [item.id]: (e as Error).message || 'Not sent yet. Retrying.' } }); break }
        }
        if (failed) scheduleRetry(); else retryDelay = 5000
      } while (drainAgain)
    } finally { await refresh() }
  })().finally(() => { draining = null })
  return draining
}
async function start(resume?: { id: string; startedAt: number }) {
  if (state.phase !== 'idle') { paint({ open: true }); return }
  // This is before capture/permissions, storage, geolocation or any network request.
  captureNavigation = ++navigation; cancelled = false; readyClip = null
  paint({ open: true, selected: null, detail: null, phase: 'starting', elapsed: 0, error: '', needsTap: false })
  closePlayer?.()
  const hold = window.WizardApp.update?.hold('Saving a song identification clip')
  releaseHold = () => hold?.release()
  musicControl.engine()?.pause()
  let geo: Record<string, number> | undefined
  if (state.geoEnabled) navigator.geolocation?.getCurrentPosition(p => { geo = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy_m: p.coords.accuracy } }, () => undefined, { timeout: 10000, maximumAge: 60000 })
  try {
    startedAt = resume?.startedAt || Date.now()
    const captured = await window.WizardApp.capture.start({ kind: 'audio', resumeId: resume?.id, chunkMs: 1000, maxMs: Math.max(1000, IDENTIFY_LIMIT_SECONDS * 1000 - (resume ? Date.now() - resume.startedAt : 0)), audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, meta: { task: 'music-identify', manualSubmit: true, geo, note: state.note } })
    handle = { id: captured.id, onLevel: fn => captured.onLevel(fn), stop: async () => { const result = await captured.stop(); return { ...result, meta: { ...result.meta, geo: geo || result.meta?.geo } } } }
    startedAt = resume?.startedAt || Date.now()
    recordingId = await backendCaptureId(handle.id)
    localStorage.setItem(ACTIVE, JSON.stringify({ id: handle.id, startedAt }))
    if (cancelled) { await finish(false); return }
    offLevel = handle.onLevel(v => paint({ level: Math.max(0, Math.min(1, typeof v === 'number' ? v : Math.max(v.me || 0, v.them || 0))) }))
    paint({ phase: 'recording' })
    tick = window.setInterval(() => {
      if (!(window.WizardApp.view?.isVisible?.() ?? !document.hidden)) leaveWaiting()
      if (state.phase === 'recording') paint({ elapsed: Math.min(IDENTIFY_LIMIT_SECONDS, (Date.now() - startedAt) / 1000) })
    }, 200)
    // Twelve seconds is guidance, not send. The unchanged 30 s hard cap sends when capture stops.
    autoStop = window.setTimeout(() => { void finish(true) }, Math.max(0, IDENTIFY_LIMIT_SECONDS * 1000 - (Date.now() - startedAt)))
  } catch (e) {
    paint({ phase: 'idle', needsTap: true, error: (e as Error).message || 'Microphone unavailable. Tap to try again.' })
    releaseHold?.(); releaseHold = undefined
    if ((e as { code?: string }).code === 'not_recoverable') localStorage.removeItem(ACTIVE)
  }
}
async function stop() {
  if (state.phase === 'ready' && readyClip) { await submit(readyClip.id); return }
  await finish(true)
}
async function submit(id: string) {
  if (state.phase === 'saving') return
  paint({ phase: 'saving', selected: id, detail: null, error: '' })
  try {
    const item = (await localStore('all')).find(c => c.id === id)
    if (!item) throw new Error('Clip unavailable on this device.')
    await localStore('put', { ...item, sendRequested: true })
    paint({ locals: await localStore('all'), phase: 'idle' }); readyClip = null
    showSubmission(item); void drain()
  } catch (e) { paint({ phase: 'idle', error: (e as Error).message }) }
}
async function finish(send: boolean, atLimit = false) {
  if (!handle || state.phase === 'saving') return
  if (!stillWaiting()) leaveWaiting()
  // Paint this local clip immediately; saving still precedes recognition and late replies cannot reopen it.
  paint({ phase: 'saving', ...(send && !cancelled && stillWaiting() ? { selected: recordingId, detail: null } : {}) })
  window.clearTimeout(autoStop); offLevel?.()
  try {
    const result = await handle.stop()
    const item = await persist(result, send && !cancelled)
    window.clearInterval(tick); handle = null; localStorage.removeItem(ACTIVE)
    readyClip = atLimit && !cancelled ? item : null
    paint({ phase: readyClip ? 'ready' : 'idle', level: 0, elapsed: result.durationMs / 1000 })
    releaseHold?.(); releaseHold = undefined
    if (send && !cancelled) { showSubmission(item); void drain() }
  } catch (e) { paint({ phase: 'idle', error: (e as Error).message || 'Audio remains recoverable in shared capture.' }); window.clearInterval(tick); handle = null; releaseHold?.(); releaseHold = undefined }
}
export const identifyControl = {
  snapshot: () => state,
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
  start, stop, refresh, drain, detail, submit,
  leftView: leaveWaiting,
  cancel() {
    cancelled = true; leaveWaiting()
    if (state.phase === 'ready') { readyClip = null; paint({ phase: 'idle' }); return }
    if (handle) void finish(false)
  },
  configure(note: string, geoEnabled: boolean) { paint({ note, geoEnabled }) },
  open() { leaveWaiting(); paint({ open: true, error: '', loading: !state.hunts.length }); closePlayer?.(); void refresh() },
  closeDetail() { leaveWaiting(); ++detailGeneration; paint({ selected: null, detail: null, error: '' }) },
  back() {
    leaveWaiting()
    // The sheet's own Back step may already have closed the dialog while its async 'close' event is still pending;
    // then this Back belongs to the list, not to a sheet the owner can no longer see.
    if (state.selected) { const visible = !!document.querySelector('dialog.identify-sheet[open]'); this.closeDetail(); if (visible) return true }
    if (state.open) { paint({ open: false }); return true }
    return false
  },
  busy: () => state.phase !== 'idle',
  async retry(id: string) { paint({ error: '' }); await identifyJson('captures/' + id + '/retry', {}); await refresh() },
  async retryUnsolved() { for (const h of state.hunts.filter(h => ['no_match', 'error', 'uploaded'].includes(h.status))) await this.retry(h.id) },
  async play(c: Candidate) { const { track } = await identifyJson<{ track: MusicTrack }>(`candidates/${c.id}/resolve`, {}); const station = await musicApi.station({ trackId: track.id }); await musicControl.play(station.tracks, station.station) },
  async verdict(c: Candidate, verdict: string) { const result = await identifyJson<{ track?: MusicTrack }>(`candidates/${c.id}/verdict`, { verdict }); if (verdict === 'confirmed') { this.closeDetail() }; await refresh(); return result },
  async add(id: string, c: unknown) { await identifyJson(`captures/${id}/candidates`, c); await detail(id, false) },
  async init(onIdentify: () => void) {
    closePlayer = onIdentify
    const hidden = () => { if (!(window.WizardApp.view?.isVisible?.() ?? !document.hidden)) leaveWaiting() }; document.addEventListener('visibilitychange', hidden)
    const online = () => { retryDelay = 5000; window.clearTimeout(retryTimer); retryTimer = 0; void drain() }
    window.addEventListener('online', online)
    let polls = 0
    const poll = window.setInterval(() => {
      if (!(window.WizardApp.view?.isVisible?.() ?? !document.hidden)) leaveWaiting()
      if (!state.open || this.busy()) return
      if (state.selected && (!state.detail || ['pending', 'uploaded', 'hunting'].includes(state.detail.status))) void detail(state.selected, false)
      if (++polls % 3 === 0) void refresh()
    }, 2000)
    try {
      const active = JSON.parse(localStorage.getItem(ACTIVE) || 'null')
      const pending = await window.WizardApp.capture.pending()
      if (active?.id && !pending.some(r => r.id === active.id && r.blob?.size && !r.partial)) await start(active)
      else if (active?.id) localStorage.removeItem(ACTIVE)
      await drain()
    } catch (e) { paint({ error: (e as Error).message }) }
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('online', online); window.clearInterval(poll) }
  },
}
