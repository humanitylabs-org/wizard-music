// Your own playlists of single songs (wizard-music#39), on for everyone.
// Stored in the Music hub (song_playlists); every write is read back from the hub before the list shows it.
import type { MusicTrack } from './engine'

export type SongPlaylist = { id: string; name: string; description: string; trackIds: string[]; count: number; createdAt: number; updatedAt: number; tracks?: MusicTrack[] }
type Written = SongPlaylist & { skipped?: string[] }

const BASE = typeof document === 'undefined' ? '/' : new URL('./', document.baseURI).pathname
async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + 'api/song-playlists' + path, { credentials: 'include', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
  const data = await r.json().catch(() => ({})) as T & { error?: string }
  if (!r.ok) throw Error(r.status === 400 && typeof data.error === 'string' && data.error !== 'invalid' ? data.error : r.status === 404 ? 'That playlist is gone.' : 'Couldn’t reach Music. Try again.')
  return data
}

type State = { items: SongPlaylist[]; open: Record<string, SongPlaylist>; loading: boolean; error: string; busy: string; adding: MusicTrack | null }
let state: State = { items: [], open: {}, loading: true, error: '', busy: '', adding: null }
const listeners = new Set<() => void>()
const put = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn()) }
/** One stored playlist in the list and the open detail, from the hub's own answer. */
function stored(p: SongPlaylist) {
  const row: SongPlaylist = { id: p.id, name: p.name, description: p.description, trackIds: p.trackIds, count: p.count, createdAt: p.createdAt, updatedAt: p.updatedAt }
  const items = state.items.some((x) => x.id === p.id) ? state.items.map((x) => x.id === p.id ? row : x) : [row, ...state.items]
  put({ items, open: p.tracks ? { ...state.open, [p.id]: p } : state.open })
}
async function write<T>(key: string, run: () => Promise<T>): Promise<T | null> {
  if (state.busy) return null
  put({ busy: key, error: '' })
  try { return await run() } catch (e) { put({ error: (e as Error).message }); return null } finally { put({ busy: '' }) }
}

export const songPlaylistControl = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
  snapshot: () => state,
  async load(): Promise<void> {
    try { const { playlists } = await call<{ playlists: SongPlaylist[] }>(''); if (!Array.isArray(playlists)) throw Error('Invalid list'); put({ items: playlists, loading: false, error: '' }) }
    catch { put({ loading: false, error: 'Couldn’t load your playlists. Try again.' }) }
  },
  async get(id: string): Promise<SongPlaylist | null> {
    try { const p = await call<SongPlaylist>('/' + id); stored(p); return p } catch (e) { put({ error: (e as Error).message }); return null }
  },
  create(name: string, trackIds: string[] = []) {
    return write('create', async () => { const p = await call<Written>('', { name, trackIds }); return songPlaylistControl.get(p.id) })
  },
  rename(id: string, name: string) { return write(id, async () => { stored(await call<Written>('/' + id, { name })); return true }) },
  reorder(id: string, trackIds: string[]) { return write(id, async () => { stored(await call<Written>('/' + id, { trackIds })); return true }) },
  move(id: string, trackId: string, delta: -1 | 1) {
    const ids = [...(state.open[id]?.trackIds ?? [])], at = ids.indexOf(trackId), to = at + delta
    if (at < 0 || to < 0 || to >= ids.length) return Promise.resolve(null)
    ids.splice(at, 1); ids.splice(to, 0, trackId)
    return songPlaylistControl.reorder(id, ids)
  },
  add(id: string, track: MusicTrack) {
    return write(id, async () => { const p = await call<Written>('/' + id + '/add', { trackIds: [track.id] }); stored(p); if (p.skipped?.length) throw Error('Music doesn’t know that song yet. Play it once, then add it.'); return p })
  },
  removeTrack(id: string, trackId: string) { return write(id, async () => { stored(await call<Written>('/' + id + '/remove', { trackIds: [trackId] })); return true }) },
  remove(id: string) {
    return write(id, async () => {
      await call('/' + id + '/delete', {})
      const open = { ...state.open }; delete open[id]
      put({ items: state.items.filter((x) => x.id !== id), open })
      return true
    })
  },
  /** Add to playlist from search or Now Playing: the shared picker sheet shows for this song. */
  startAdding(track: MusicTrack) { put({ adding: track, error: '' }); void songPlaylistControl.load() },
  stopAdding() { put({ adding: null }) },
}
