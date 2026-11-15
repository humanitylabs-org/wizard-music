// @vitest-environment jsdom
// Issue 47 (15 Nov 2026): on the phone, Back with search results showing left Music instead of clearing the search.
// Music told the shell it was at its root (main.tsx's useHistory isRoot / canGoBack knew nothing about results).
// These drive the WizardApp.back contract the way wizard-ux core/app-client.js runs it: handlers in registration
// order, asked newest first; the first whose canGoBack() is true answers; false from every one = at root (the shell
// then leaves the app).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MusicApp } from '../src/music/MusicApp'
import { installMusicBack } from '../src/music/back'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve() }
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const track = (n: number) => ({ id: `yt:t${n}`, title: `Song ${n}`, artist: 'Artist', album: '', durationMs: 200000, source: 'youtube', art: '', stream: '' })
const HOME = { sources: [{ id: 'online', name: 'Online sources', status: 'ok', detail: '', ok: true }], vibes: [], liked: [], recent: [], library: [track(3)], taste: { avoid: [] } }

type Handler = { canGoBack: () => boolean; back: () => boolean }
let handlers: Handler[], isRoot: (() => boolean) | null, root: Root | null, host: HTMLDivElement | null
let nowPlaying: boolean, closedNowPlaying: number, uninstall: (() => void) | null
// app-client.js back(): newest handler first.
const shellBack = () => { for (let i = handlers.length - 1; i >= 0; i--) { const h = handlers[i]; if (h.canGoBack()) return h.back() } return false }
const wizardBack = {
  register(h: Handler) { handlers.push(h); return () => { handlers = handlers.filter((x) => x !== h) } },
  useHistory({ isRoot: fn }: { isRoot: () => boolean }) { isRoot = fn; const h = { canGoBack: () => false, back: () => false }; handlers.push(h); return () => { handlers = handlers.filter((x) => x !== h) } },
}

beforeEach(() => {
  handlers = []; isRoot = null; nowPlaying = false; closedNowPlaying = 0; uninstall = null
  history.replaceState({ wizardMusic: 'root' }, '')
  vi.stubGlobal('WizardApp', { back: wizardBack, view: { isVisible: () => true } })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/home')) return ok(HOME)
    if (url.includes('/api/search')) return ok({ tracks: [track(7), track(8)] })
    return ok({})
  }))
})
afterEach(async () => {
  await act(async () => { await flush(); root?.unmount() })
  uninstall?.(); host?.remove(); root = null; host = null
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear()
})

// The app the way main.tsx mounts it: MusicApp inside, then the app-level Back order (registered after MusicApp's
// layout effects, like main.tsx's App, whose layout effect runs after its children's).
async function mountMusic() {
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<MusicApp onOpenNowPlaying={() => undefined} notify={() => undefined} />); await flush() })
  uninstall = installMusicBack(wizardBack, {
    identifyOpen: () => false, identifyBack: () => false,
    nowPlaying: () => nowPlaying, closeNowPlaying: () => { nowPlaying = false; closedNowPlaying++ },
  })
  return host
}
async function search(view: HTMLElement, text: string) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const input = view.querySelector('input[aria-label="Search music"]') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { vi.advanceTimersByTime(300); await flush() })
  vi.useRealTimers()
  return input
}
const resultRows = (view: HTMLElement) => view.textContent!.includes('Song 7')

describe('Back on search results (issue 47)', () => {
  it('is not at root while results show; Back clears the search and keeps Music open', async () => {
    const view = await mountMusic()
    expect(isRoot!()).toBe(true)
    const input = await search(view, 'Milkshake Alex wann')
    expect(resultRows(view)).toBe(true)
    expect(isRoot!()).toBe(false)
    let did = false
    await act(async () => { did = shellBack(); await flush() })
    expect(did).toBe(true) // handled: the shell keeps Music open
    expect(input.value).toBe('')
    expect(resultRows(view)).toBe(false)
    expect(isRoot!()).toBe(true)
    // a second Back at home behaves as before: at root, the shell takes its own next step
    expect(shellBack()).toBe(false)
  })

  it('closes Now Playing over the results first, then a second Back clears the results', async () => {
    const view = await mountMusic()
    const input = await search(view, 'house')
    nowPlaying = true
    await act(async () => { expect(shellBack()).toBe(true); await flush() })
    expect(closedNowPlaying).toBe(1)
    expect(resultRows(view)).toBe(true)
    expect(input.value).toBe('house')
    await act(async () => { expect(shellBack()).toBe(true); await flush() })
    expect(resultRows(view)).toBe(false)
    expect(input.value).toBe('')
  })

  it("steps back over the results' own history entry only when it is Music's, else marks it home", async () => {
    const view = await mountMusic()
    await search(view, 'synthwave')
    expect(history.state?.wizardMusic).toBe('search')
    // jsdom has no Navigation API, so the entry behind counts as Music's (the old behaviour): one step back, not two
    const back = vi.spyOn(history, 'back').mockImplementation(() => undefined)
    await act(async () => { shellBack(); await flush() })
    expect(back).toHaveBeenCalledTimes(1)
    back.mockRestore()
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state })) // the mocked step "lands"
    // With the Navigation API saying nothing of Music's is behind (the shell's guard is), never pop: mark home.
    history.replaceState({ wizardMusic: 'root' }, '')
    await search(view, 'ambient')
    expect(history.state?.wizardMusic).toBe('search')
    vi.stubGlobal('navigation', { currentEntry: { index: 0 }, entries: () => [{ index: 0 }] })
    const back2 = vi.spyOn(history, 'back')
    await act(async () => { shellBack(); await flush() })
    expect(back2).not.toHaveBeenCalled()
    expect(history.state?.wizardMusic).toBe('root')
  })
})
