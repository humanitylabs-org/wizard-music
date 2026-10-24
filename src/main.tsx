import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { lastViewWasNowPlaying, MiniPlayer, MusicApp, musicControl, NowPlaying, rememberView, restoreMusicSession, whenTrackLoaded } from './music/MusicApp'
import { installMusicVoice } from './music/voice'

function musicIsPlaying() {
  const snap = musicControl.engine()?.snapshot()
  return Boolean(snap?.queue[snap.index] && (snap.wantPlaying ?? snap.playing))
}
import './app.css'
import './wizard-appearance.css'

declare global {
  interface Window { WizardApp: {
    ready(options: {name: string; version: string}): unknown
    back: { register(options: {canGoBack: () => boolean; back: () => boolean}): () => void; useHistory(options: {isRoot: () => boolean}): () => void }
    view?: { isVisible(): boolean }
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
    rememberView('now')
  }, [])
  const closeNowPlaying = useCallback(() => {
    if (!nowPlayingRef.current) return
    nowPlayingRef.current = false
    setNowPlayingOpen(false)
    rememberView('home')
    if (history.state?.wizardMusic === 'now') history.back()
  }, [])
  useEffect(() => {
    const onPop = () => { nowPlayingRef.current = history.state?.wizardMusic === 'now'; setNowPlayingOpen(nowPlayingRef.current); rememberView(nowPlayingRef.current ? 'now' : 'home') }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  // Reopen where you were: if Now Playing was up when Music closed (or the app updated), bring it back
  // with the same song once it has loaded. It gets its own history entry, so Back still lands on the library.
  // Coming back to Music while a song is playing always lands on the full-screen player; the library with the
  // mini player is only for when you swiped it down and stayed. Cold opens wait for the restored song.
  useEffect(() => {
    let stopWatch = () => undefined as void
    const stopLoad = whenTrackLoaded(() => {
      if (lastViewWasNowPlaying() || musicIsPlaying()) { openNowPlaying(); return }
      // A restored song can take a moment to actually start; open the player when it does (first few seconds only).
      const engine = musicControl.engine()
      if (!engine) return
      const unsubscribe = engine.subscribe(() => { if (musicIsPlaying()) { stopWatch(); if (!nowPlayingRef.current) openNowPlaying() } })
      const timer = window.setTimeout(() => stopWatch(), 6000)
      stopWatch = () => { unsubscribe(); window.clearTimeout(timer) }
    })
    return () => { stopLoad(); stopWatch() }
  }, [openNowPlaying])
  useEffect(() => {
    const visible = () => { try { return window.WizardApp?.view?.isVisible?.() ?? !document.hidden } catch { return !document.hidden } }
    let was = visible()
    const check = () => {
      const now = visible()
      // Switching Wizard windows/desks too: hide the song while away, ask the player straight away on return.
      const engine = musicControl.engine() as { markStale?: () => void; refresh?: () => void } | null
      if (!now && was) engine?.markStale?.()
      if (now && !was) engine?.refresh?.()
      if (now && !was && !nowPlayingRef.current && musicIsPlaying()) openNowPlaying()
      was = now
    }
    // The page's own visibility covers the phone app; the shell's view state covers switching Wizard windows.
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    const timer = window.setInterval(check, 800)
    return () => { document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check); window.clearInterval(timer) }
  }, [openNowPlaying])
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

// Wizard restarted or the app updated: carry on with the song, spot, queue and station from last time.
restoreMusicSession()
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
