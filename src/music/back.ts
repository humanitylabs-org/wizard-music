// Music's one Back order (phone Back, Android Back, Escape), issue 47. The shell asks WizardApp.back once per press
// and the app answers "handled" or "at root". Music answers from one place, newest layer first:
//   Identify → Now Playing → search results → all liked songs (#63) → root (the shell's own next step, e.g. leaving Music).
// Search results used to register their own handler inside MusicApp while main.tsx told the shell Music was at its
// root (useHistory isRoot / canGoBack knew nothing about results), and they stepped back over their history entry
// later, in an effect. On the phone that left Music instead of clearing the search. Now the results are part of the
// app-level back state and Back leaves their history entry at once, only over Music's own entry.

/** True when the history entry just behind this one is Music's own (same document), so Back stays in Music. */
export function ownEntryBehind(): boolean {
  try {
    const nav = (window as Window & { navigation?: { currentEntry?: { index: number } | null; entries(): { index: number }[] } }).navigation
    if (!nav?.currentEntry) return true // no Navigation API: keep the old behaviour
    const at = nav.currentEntry.index
    return at > 0 && nav.entries().some((entry) => entry.index === at - 1)
  } catch { return true }
}

/** Leave a layer's own history entry (`wizardMusic: <marker>`): step back over it when the entry behind is Music's,
 * else mark this entry as Music's home so a later Back never pops the shell's guard (which would leave Music). */
export function leaveEntry(marker: string): void {
  // history.back() lands later (popstate): until then this entry is still the marker, and a second step would pop
  // the entry behind it too (or the shell's guard).
  if (history.state?.wizardMusic !== marker || stepping) return
  if (!ownEntryBehind()) { history.replaceState({ ...(history.state || {}), wizardMusic: 'root' }, ''); return }
  stepping = true
  if (!listening) { listening = true; window.addEventListener('popstate', () => { stepping = false }) }
  window.setTimeout(() => { stepping = false }, 1000) // a step that never lands must not block the next one
  history.back()
}
let stepping = false, listening = false

type SearchLayer = { open(): boolean; clear(): void }
let searchLayer: SearchLayer | null = null

/** The search results layer, attached by MusicApp while it is mounted. */
export const searchBack = {
  attach(layer: SearchLayer): () => void { searchLayer = layer; return () => { if (searchLayer === layer) searchLayer = null } },
  /** Results (or a search in flight) are showing. */
  open(): boolean { try { return searchLayer?.open() === true } catch { return false } },
  /** Clear the query and results (like the search box's ×); false when there was nothing to clear. */
  back(): boolean { if (!searchBack.open()) return false; searchLayer!.clear(); return true },
}

/** The full Liked list (wizard-music#63, switch liked-view-all), attached by MusicApp while it is mounted. */
export const likedBack = {
  attach(layer: SearchLayer): () => void { likedLayer = layer; return () => { if (likedLayer === layer) likedLayer = null } },
  open(): boolean { try { return likedLayer?.open() === true } catch { return false } },
  /** Close the full Liked list back to Music's home; false when it was not open. */
  back(): boolean { if (!likedBack.open()) return false; likedLayer!.clear(); return true },
}
let likedLayer: SearchLayer | null = null

type Layers = { identifyOpen(): boolean; identifyBack(): boolean; nowPlaying(): boolean; closeNowPlaying(): void }

/** What Music tells the shell: at its root only when nothing is open, search results included. */
export function musicAtRoot(layers: Pick<Layers, 'identifyOpen' | 'nowPlaying'>): boolean {
  return !layers.nowPlaying() && !layers.identifyOpen() && !searchBack.open() && !likedBack.open()
}

/** One Back press: close the newest open layer. True = handled (Music stays open), false = at root. */
export function musicBack(layers: Layers): boolean {
  if (layers.identifyBack()) return true
  if (layers.nowPlaying()) { layers.closeNowPlaying(); return true }
  return searchBack.back() || likedBack.back()
}

type BackApi = { register(options: { canGoBack: () => boolean; back: () => boolean }): () => void; useHistory(options: { isRoot: () => boolean }): (() => void) | unknown }

/** Wire Music's Back into WizardApp: the history adapter and one handler that owns every layer. Its handler is
 * registered last, so the shell asks it first, whatever MusicApp or the history adapter registered. */
export function installMusicBack(api: BackApi, layers: Layers): () => void {
  const detachHistory = api.useHistory({ isRoot: () => musicAtRoot(layers) })
  const unregister = api.register({
    canGoBack: () => !musicAtRoot(layers),
    back: () => musicBack(layers),
  })
  return () => { unregister(); if (typeof detachHistory === 'function') detachHistory() }
}
