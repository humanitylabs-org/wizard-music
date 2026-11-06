// App-domain state outlives Home's component, including late write errors.
export type Playlist = { id: string; url: string; title: string; author: string; authorUrl: string; thumbnail: string; kind: 'video' | 'playlist'; providerId: string; createdAt: number }
export type PlaylistDraft = { url: string; title?: string; author?: string; authorUrl?: string; thumbnail?: string }
const BASE = new URL('./', document.baseURI).pathname
export async function playlistJson<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + 'api/playlists' + path, { credentials: 'include', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  const data = await r.json()
  if (!r.ok) throw Error(r.status === 400 && typeof data.error === 'string' && data.error !== 'invalid' ? data.error : 'Couldn’t reach Music. Your link is kept; try again.')
  return data as T
}
type State = { items: Playlist[]; pending: PlaylistDraft | null; failed: PlaylistDraft | null; error: string; loading: boolean }
let state: State = { items: [], pending: null, failed: null, error: '', loading: true }
const listeners = new Set<() => void>()
const put = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()) }
let generation = 0, loading: Promise<void> | null = null
export const playlistControl = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
  snapshot: () => state,
  load(): Promise<void> {
    if (loading) return loading
    const seq = generation
    loading = playlistJson<{ playlists: Playlist[] }>('').then(data => { if (!Array.isArray(data.playlists)) throw Error('Invalid playlist list'); if (seq === generation) put({ items: data.playlists, loading: false, error: state.failed ? state.error : '' }) }).catch(() => { if (seq === generation) put({ loading: false, error: 'Couldn’t load your playlists. Try again.' }) }).finally(() => { loading = null })
    return loading
  },
  async save(draft: PlaylistDraft): Promise<void> {
    if (state.pending) return
    ++generation
    put({ pending: draft, failed: null, error: '' }) // paint before request, never call this Saved yet
    try {
      const saved = await playlistJson<Playlist>('', draft)
      const { playlists } = await playlistJson<{ playlists: Playlist[] }>('')
      if (!playlists.some(p => p.id === saved.id && p.url === saved.url && p.title === saved.title)) throw Error('Music could not verify that save. Try again.')
      put({ items: playlists, pending: null, loading: false })
    } catch (e) { put({ pending: null, failed: draft, loading: false, error: (e as Error).message }) }
  },
}
