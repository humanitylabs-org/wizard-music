import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MiniPlayer, MusicApp, musicControl, NowPlaying, restoreMusicSession } from './music/MusicApp'
import { installMusicVoice } from './music/voice'
import './app.css'
import './wizard-appearance.css'

declare global {
  interface Window { WizardApp: {
    ready(options: {name: string; version: string}): unknown
    back: { register(options: {canGoBack: () => boolean; back: () => boolean}): () => void; useHistory(options: {isRoot: () => boolean}): () => void }
    share?: { text(data: {title?: string; text?: string; url?: string}): Promise<'shared' | 'copied' | 'cancelled' | 'unsupported'> }
  } }
}

function App() {
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false)
  const nowPlayingRef = useRef(false)
  const [toast, setToast] = useState('')
  const toastTimer = useRef(0)
  const notify = useCallback((message: string) => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2600)
  }, [])

  // Now Playing is the only nested layer. It owns one history entry so browser/Android Back closes it
  // and never leaves the app; the Wizard shell can also ask via __wizardCloseOverlay (false = at root).
  const openNowPlaying = useCallback(() => {
    if (!nowPlayingRef.current) history.pushState({ wizardMusic: 'now' }, '')
    nowPlayingRef.current = true
    setNowPlayingOpen(true)
  }, [])
  const closeNowPlaying = useCallback(() => {
    if (!nowPlayingRef.current) return
    nowPlayingRef.current = false
    setNowPlayingOpen(false)
    if (history.state?.wizardMusic === 'now') history.back()
  }, [])
  useEffect(() => {
    const onPop = () => { nowPlayingRef.current = history.state?.wizardMusic === 'now'; setNowPlayingOpen(nowPlayingRef.current) }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  // The Wizard OS orb drives playback: "play …", pause, next, louder (src/music/voice.ts).
  useEffect(() => installMusicVoice(notify), [notify])
  // A voice search shows its results list, so Now Playing steps aside.
  useEffect(() => musicControl.onSearchShown(() => { if (nowPlayingRef.current) closeNowPlaying() }), [closeNowPlaying])
  useLayoutEffect(() => {
    window.WizardApp.ready({ name: 'Music', version: '1' })
    // A cold document opens on Home; consume a stale previous player marker.
    if (!nowPlayingRef.current) history.replaceState({ ...(history.state || {}), wizardMusic: 'root' }, '')
    const detachHistory = window.WizardApp.back.useHistory({ isRoot: () => !nowPlayingRef.current })
    const unregister = window.WizardApp.back.register({
      canGoBack: () => nowPlayingRef.current,
      back: () => { if (!nowPlayingRef.current) return false; closeNowPlaying(); return true }
    })
    return () => { unregister(); if (typeof detachHistory === 'function') detachHistory() }
  }, [closeNowPlaying])

  return <div className="music-shell">
    <header className="music-shell-head"><h1>Music</h1></header>
    <main className="music-shell-main"><MusicApp onOpenNowPlaying={openNowPlaying} notify={notify} /></main>
    <MiniPlayer onOpen={openNowPlaying} notify={notify} />
    {nowPlayingOpen && <NowPlaying onClose={closeNowPlaying} notify={notify} />}
    {toast && <div className="music-toast" role="status">{toast}</div>}
  </div>
}

// Wizard restarted: carry on with the song, queue and station from last time.
restoreMusicSession()
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
