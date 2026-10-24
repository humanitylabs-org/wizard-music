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

/** This page's build (the hashed bundle name), so an open Music can pick up a new release by itself. */
const BUILD_SCRIPT = typeof document !== 'undefined' ? document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.src ?? '' : ''
const BUILD = BUILD_SCRIPT.match(/\/assets\/index-([\w-]+)\.js/)?.[1] ?? ''
let newerSeen = false
async function newerBuildLive(): Promise<boolean> {
  if (!BUILD) return false
  if (newerSeen) return true
  try {
    const page = await fetch(new URL('../', BUILD_SCRIPT), { cache: 'no-store', credentials: 'include' })
    const live = (await page.text()).match(/\/assets\/index-([\w-]+)\.js/)?.[1]
    newerSeen = Boolean(live && live !== BUILD)
  } catch { /* offline: try next time */ }
  return newerSeen
}

/** True when the history entry just behind this one is Music's own (same document), so Back stays in Music. */
function ownEntryBehind(): boolean {
  try {
    const nav = (window as Window & { navigation?: { currentEntry?: { index: number } | null; entries(): { index: number }[] } }).navigation
    if (!nav?.currentEntry) return true // no Navigation API: keep the old behaviour
    const at = nav.currentEntry.index
    return at > 0 && nav.entries().some((entry) => entry.index === at - 1)
  } catch { return true }
}

function App() {
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false)
  const nowPlayingRef = useRef(false)
  // The listener swiped the player down (or tapped the chevron): no automatic reopen until Music has really been
  // out of view for a moment. A stuck/loading song or a shell visibility blip must never pop it back up.
  const dismissedRef = useRef(false)
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
    if (history.state?.wizardMusic !== 'now') return
    // Step back only over Music's own entry. If the entry before this one is not Music's (or the shell's
    // guard sits above it), history.back() would leave Music and the Wizard shell would treat it as Back
    // and go Home. Then just mark this entry as the library instead.
    if (ownEntryBehind()) history.back()
    else history.replaceState({ ...(history.state || {}), wizardMusic: 'root' }, '')
  }, [])
  const dismissNowPlaying = useCallback(() => { dismissedRef.current = true; closeNowPlaying() }, [closeNowPlaying])
  const autoOpenNowPlaying = useCallback(() => { if (!dismissedRef.current) openNowPlaying() }, [openNowPlaying])
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
      if (lastViewWasNowPlaying() || musicIsPlaying()) { autoOpenNowPlaying(); return }
      // A restored song can take a moment to actually start; open the player when it does (first few seconds only).
      const engine = musicControl.engine()
      if (!engine) return
      const unsubscribe = engine.subscribe(() => { if (musicIsPlaying()) { stopWatch(); if (!nowPlayingRef.current) autoOpenNowPlaying() } })
      const timer = window.setTimeout(() => stopWatch(), 6000)
      stopWatch = () => { unsubscribe(); window.clearTimeout(timer) }
    })
    return () => { stopLoad(); stopWatch() }
  }, [autoOpenNowPlaying])
  useEffect(() => {
    const visible = () => { try { return window.WizardApp?.view?.isVisible?.() ?? !document.hidden } catch { return !document.hidden } }
    let was = visible(), awaySince = 0, phoneAwaySince = 0, phoneWas = !document.hidden
    const check = () => {
      const now = visible()
      if (!now && was) awaySince = Date.now()
      // Only really leaving the Wizard app (the phone page hidden, not a shell sheet or desk switch, not a
      // blip while dragging) lifts a swipe-down and may bring the player back full screen.
      const phoneNow = !document.hidden
      if (!phoneNow && phoneWas) phoneAwaySince = Date.now()
      const phoneReturn = phoneNow && !phoneWas && Date.now() - phoneAwaySince >= 1500
      phoneWas = phoneNow
      if (phoneReturn) dismissedRef.current = false
      const realReturn = now && (phoneReturn || (!was && Date.now() - awaySince >= 1500))
      // Switching Wizard windows/desks too: hide the song while away, ask the player straight away on return.
      const engine = musicControl.engine() as { markStale?: () => void; refresh?: () => void } | null
      if (!now && was) engine?.markStale?.()
      if (now && !was) engine?.refresh?.()
      if (realReturn && !nowPlayingRef.current && musicIsPlaying()) autoOpenNowPlaying()
      // A new Music release: reload while you're away (playback lives in the phone's player and carries on,
      // and Music reopens where you were), so a Music window left open never keeps running old code.
      if (!now && was) {
        const leftAt = awaySince
        void newerBuildLive().then((newer) => { if (newer && !visible() && awaySince === leftAt) window.setTimeout(() => { if (!visible() && awaySince === leftAt) window.location.reload() }, 1000) })
      }
      if (realReturn && !nowPlayingRef.current) void newerBuildLive().then((newer) => { if (newer && visible()) window.location.reload() })
      was = now
    }
    // The page's own visibility covers the phone app; the shell's view state covers switching Wizard windows.
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    const timer = window.setInterval(check, 800)
    return () => { document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check); window.clearInterval(timer) }
  }, [autoOpenNowPlaying])
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
    {nowPlayingOpen && <NowPlaying onClose={dismissNowPlaying} notify={notify} />}
    {toast && <div className="music-toast" role="status">{toast}</div>}
  </div>
}

// Wizard restarted or the app updated: carry on with the song, spot, queue and station from last time.
restoreMusicSession()
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
