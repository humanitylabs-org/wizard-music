import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { playlistControl, playlistJson, type Playlist } from './playlists'
import type { MusicTrack } from './engine'
import './playlists.css'

export function Playlists({ onPlay, notify }: { onPlay(track: MusicTrack): Promise<void>; notify(message: string): void }) {
  const state = useSyncExternalStore(playlistControl.subscribe, playlistControl.snapshot)
  const [expanded, setExpanded] = useState(true), [editing, setEditing] = useState(false)
  const [url, setUrl] = useState(''), [title, setTitle] = useState(''), [playing, setPlaying] = useState('')
  const dialog = useRef<HTMLDialogElement>(null), playBusy = useRef(false)
  useEffect(() => { void playlistControl.load() }, [])
  useEffect(() => {
    if (!editing || !dialog.current) return
    const d = dialog.current
    window.WzSheet.open(d)
    const close = () => setEditing(false)
    d.addEventListener('close', close)
    return () => {
      d.removeEventListener('close', close); window.WzSheet.close(d)
      const sheet = d as HTMLDialogElement & { __wzBack?: { release(): void } | null }
      sheet.__wzBack?.release(); sheet.__wzBack = null
    }
  }, [editing])
  const play = async (item: Playlist) => {
    if (playBusy.current) return
    playBusy.current = true; setPlaying(item.id)
    try {
      const { track } = await playlistJson<{ track: MusicTrack }>('/' + item.id + '/play', {})
      await onPlay(track)
    } catch (e) { notify((e as Error).message + ' You can also open it on YouTube.') }
    finally { playBusy.current = false; setPlaying('') }
  }
  const submit = () => {
    if (state.pending || !url) return
    const draft = { url, title }
    // Leave the sheet and put the pending link in the list on the same tap, before I/O.
    flushSync(() => { setEditing(false); setExpanded(true); void playlistControl.save(draft) })
  }
  return <section className="music-section music-playlists" aria-label="Playlists">
    <div className="music-section-head">
      <button type="button" className="music-playlists-heading" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><h3>Playlists</h3><small>{state.items.length || ''}</small><span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span></button>
      <button type="button" className="music-section-action" onClick={() => { if (state.failed) { setUrl(state.failed.url); setTitle(state.failed.title || '') }; setEditing(true) }}>Add link</button>
    </div>
    {state.pending && <div className="music-playlist-pending" role="status">Saving {state.pending.title || 'your playlist'}…</div>}
    {state.error && <div className="music-playlist-error" role="alert"><p>{state.error}</p><button type="button" className="music-section-action" disabled={!!state.pending} onClick={() => state.failed ? void playlistControl.save(state.failed) : void playlistControl.load()}>Try again</button></div>}
    {expanded && <div className="music-playlists-list">
      {state.loading && <p className="music-status">Loading playlists…</p>}
      {!state.loading && !state.items.length && !state.pending && !state.error && <p className="music-empty">Keep a YouTube playlist or a long mix here.</p>}
      {state.items.map(item => <div className="music-row music-playlist-row" key={item.id}>
        <a className="music-row-main" href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`Open on YouTube: ${item.title}`} title={item.title}>
          <span className="music-art music-art-row music-playlist-mark" aria-hidden="true">♫</span>
          <span className="music-row-text"><strong>{item.title}</strong><small>{item.author ? item.author + ' · ' : ''}{item.kind === 'video' ? 'Long mix' : 'YouTube playlist'}</small></span>
        </a>
        {item.kind === 'video' && <button type="button" className="music-icon-button" disabled={!!playing} aria-label={`Play ${item.title} in Music`} title="Play in Music" onClick={() => void play(item)}>{playing === item.id ? <span className="music-wheel" role="progressbar" aria-label="Starting mix" /> : <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5L7 4.5Z" fill="currentColor" /></svg>}</button>}
      </div>)}
    </div>}
    {editing && createPortal(<dialog ref={dialog} className="wz-sheet music-playlist-sheet" aria-label="Add playlist">
      <h2>Add playlist</h2><p>Paste a YouTube playlist or long-mix link. Saving won’t start playback or download it.</p>
      <form onSubmit={e => { e.preventDefault(); submit() }}>
        <label>YouTube link<input type="url" required maxLength={2048} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" autoFocus /></label>
        <label>Name <small>(optional)</small><input type="text" maxLength={2000} value={title} onChange={e => setTitle(e.target.value)} placeholder="Name this mix or playlist" /></label>
        <button type="submit" className="music-chip" disabled={!!state.pending}>Save playlist</button>
      </form>
    </dialog>, document.body)}
  </section>
}
