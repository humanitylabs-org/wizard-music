// Your playlists (wizard-music#39): playlists you make from single songs, on for everyone.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { songPlaylistControl, type SongPlaylist } from './songPlaylists'
import type { MusicTrack } from './engine'
import './playlists.css'

const useSongPlaylists = () => useSyncExternalStore(songPlaylistControl.subscribe, songPlaylistControl.snapshot, songPlaylistControl.snapshot)

/** A bottom sheet (shared WzSheet + Back), open while mounted. */
function Sheet({ label, onClose, children }: { label: string; onClose(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const d = dialog.current
    if (!d) return
    window.WzSheet?.open(d)
    const closed = () => close.current()
    d.addEventListener('close', closed)
    return () => {
      d.removeEventListener('close', closed); window.WzSheet?.close(d)
      const sheet = d as HTMLDialogElement & { __wzBack?: { release(): void } | null }
      sheet.__wzBack?.release(); sheet.__wzBack = null
    }
  }, [])
  return createPortal(<dialog ref={dialog} className="wz-sheet music-playlist-sheet" aria-label={label}>{children}</dialog>, document.body)
}

function NameForm({ initial = '', action, busy, onSubmit }: { initial?: string; action: string; busy: boolean; onSubmit(name: string): void }) {
  const [name, setName] = useState(initial)
  return <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit(name.trim()) }}>
    <label>Name<input type="text" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Workout, Sunday morning…" autoFocus /></label>
    <button type="submit" className="music-chip" disabled={busy || !name.trim()}>{action}</button>
  </form>
}

const shuffled = <T,>(items: T[]) => { const out = [...items]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]] } return out }

function Detail({ item, onPlay, notify }: { item: SongPlaylist; onPlay(tracks: MusicTrack[], index: number): Promise<void>; notify(message: string): void }) {
  const state = useSongPlaylists()
  const open = state.open[item.id], tracks = open?.tracks ?? []
  const [renaming, setRenaming] = useState(false), [confirmDelete, setConfirmDelete] = useState(false)
  const busy = Boolean(state.busy)
  const play = (list: MusicTrack[], index = 0) => { if (list.length) void onPlay(list, index).catch((e: Error) => notify(e.message || 'Could not start playback.')) }
  if (!open) return <p className="music-status">Loading songs…</p>
  return <div className="music-song-playlist-detail">
    <div className="music-section-actions">
      <button type="button" className="music-pill music-pill-solid" disabled={!tracks.length} onClick={() => play(tracks)}>Play</button>
      <button type="button" className="music-pill" disabled={!tracks.length} onClick={() => play(shuffled(tracks))}>Shuffle</button>
      <button type="button" className="music-pill" disabled={busy} onClick={() => setRenaming(true)}>Rename</button>
      <button type="button" className="music-pill" disabled={busy} aria-label={confirmDelete ? `Tap again to delete ${item.name}` : `Delete ${item.name}`}
        onClick={() => { if (!confirmDelete) { setConfirmDelete(true); return } void songPlaylistControl.remove(item.id).then((ok) => { if (ok) notify(`Deleted ${item.name}`) }) }}>{confirmDelete ? 'Tap again to delete' : 'Delete'}</button>
    </div>
    {open.description && <p className="music-note">{open.description}</p>}
    {!tracks.length && <p className="music-empty">No songs yet. Search for a song and tap ＋ to add it here.</p>}
    <div className="music-list">{tracks.map((track, index) => <div className="music-row" key={track.id}>
      <button type="button" className="music-row-main" onClick={() => play(tracks, index)}>
        <span className="music-art music-art-row"><img src={track.art} alt="" loading="lazy" /></span>
        <span className="music-row-text"><strong>{track.title}</strong><small>{track.artist}</small></span>
      </button>
      <button type="button" className="music-icon-button" disabled={busy || index === 0} aria-label={`Move ${track.title} up`} onClick={() => void songPlaylistControl.move(item.id, track.id, -1)}>↑</button>
      <button type="button" className="music-icon-button" disabled={busy || index === tracks.length - 1} aria-label={`Move ${track.title} down`} onClick={() => void songPlaylistControl.move(item.id, track.id, 1)}>↓</button>
      <button type="button" className="music-icon-button" disabled={busy} aria-label={`Remove ${track.title} from ${item.name}`} onClick={() => void songPlaylistControl.removeTrack(item.id, track.id)}>×</button>
    </div>)}</div>
    {renaming && <Sheet label="Rename playlist" onClose={() => setRenaming(false)}>
      <h2>Rename playlist</h2>
      <NameForm initial={item.name} action="Save name" busy={busy} onSubmit={(name) => { setRenaming(false); void songPlaylistControl.rename(item.id, name) }} />
    </Sheet>}
  </div>
}

/** Home → Your playlists: make, open, play, shuffle, rename, reorder and delete your own playlists. */
export function SongPlaylists({ onPlay, notify }: { onPlay(tracks: MusicTrack[], index: number): Promise<void>; notify(message: string): void }) {
  const state = useSongPlaylists()
  const [openId, setOpenId] = useState(''), [creating, setCreating] = useState(false)
  useEffect(() => { void songPlaylistControl.load() }, [])
  const toggle = (id: string) => { const next = openId === id ? '' : id; setOpenId(next); if (next) void songPlaylistControl.get(next) }
  return <section className="music-section music-song-playlists" aria-label="Your playlists">
    <div className="music-section-head"><h3>Your playlists</h3><button type="button" className="music-pill" disabled={Boolean(state.busy)} onClick={() => setCreating(true)}>New playlist</button></div>
    {state.error && <div className="music-playlist-error" role="alert"><p>{state.error}</p><button type="button" className="music-pill" onClick={() => void songPlaylistControl.load()}>Try again</button></div>}
    {state.loading && <p className="music-status">Loading playlists…</p>}
    {!state.loading && !state.items.length && !state.error && <p className="music-empty">Make a playlist, then add songs from search or the player. Your Wizard can also build one for you.</p>}
    <div className="music-list">{state.items.map((item) => <div key={item.id}>
      <div className="music-row music-playlist-row">
        <button type="button" className="music-row-main" aria-expanded={openId === item.id} onClick={() => toggle(item.id)}>
          <span className="music-art music-art-row music-playlist-mark" aria-hidden="true">♫</span>
          <span className="music-row-text"><strong>{item.name}</strong><small>{item.count === 1 ? '1 song' : `${item.count} songs`}</small></span>
          <span aria-hidden="true">{openId === item.id ? '⌃' : '⌄'}</span>
        </button>
      </div>
      {openId === item.id && <Detail item={item} onPlay={onPlay} notify={notify} />}
    </div>)}</div>
    {creating && <Sheet label="New playlist" onClose={() => setCreating(false)}>
      <h2>New playlist</h2>
      <NameForm action="Create playlist" busy={Boolean(state.busy)} onSubmit={(name) => { setCreating(false); void songPlaylistControl.create(name).then((p) => { if (p) { setOpenId(p.id); notify(`Made ${p.name}`) } }) }} />
    </Sheet>}
  </section>
}

/** The Add to playlist picker for search results and Now Playing (one for the whole app). */
export function AddToPlaylistSheet({ notify }: { notify(message: string): void }) {
  const state = useSongPlaylists()
  const track = state.adding
  if (!track) return null
  const done = (p: SongPlaylist | null | undefined) => { if (p) { notify(`Added to ${p.name}`); songPlaylistControl.stopAdding() } }
  return <Sheet label="Add to playlist" onClose={() => songPlaylistControl.stopAdding()}>
    <h2>Add to playlist</h2>
    <p>{track.title} · {track.artist}</p>
    {state.error && <p role="alert">{state.error}</p>}
    <div className="music-list">{state.items.map((item) => <div className="music-row" key={item.id}>
      <button type="button" className="music-row-main" disabled={Boolean(state.busy)} onClick={() => void songPlaylistControl.add(item.id, track).then(done)}>
        <span className="music-art music-art-row music-playlist-mark" aria-hidden="true">♫</span>
        <span className="music-row-text"><strong>{item.name}</strong><small>{item.trackIds.includes(track.id) ? 'Already in it' : item.count === 1 ? '1 song' : `${item.count} songs`}</small></span>
      </button>
    </div>)}</div>
    <h3>New playlist</h3>
    <NameForm action="Create and add" busy={Boolean(state.busy)} onSubmit={(name) => void songPlaylistControl.create(name).then((p) => p && songPlaylistControl.add(p.id, track)).then(done)} />
  </Sheet>
}

export const AddGlyph = () => <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
