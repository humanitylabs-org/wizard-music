// @vitest-environment jsdom
// Issue 63 (15 Nov 2026): Liked header gets "View all" (far right) next to "Play all"; it opens every liked song,
// each playable with the play-next button, and Back returns to the Music home (never leaves Music). Behind the
// app switch liked-view-all at first; on for everyone since issue 72 (switch removed, /api/liked always served).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MusicApp } from '../src/music/MusicApp'
import { installMusicBack } from '../src/music/back'
import { SWITCHES } from '../server/switches.mjs'
import { musicRoute } from '../server/music.mjs'
import { readFileSync } from 'node:fs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve() }
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const track = (n: number) => ({ id: `yt:t${n}`, title: `Song ${n}`, artist: 'Artist', album: '', durationMs: 200000, source: 'youtube', art: '', stream: '', liked: true })
const ALL = Array.from({ length: 40 }, (_, n) => track(n))
const HOME = { sources: [], vibes: [], liked: ALL.slice(0, 30), recent: [], library: [], taste: { avoid: [] } }

type Handler = { canGoBack: () => boolean; back: () => boolean }
let handlers: Handler[], isRoot: (() => boolean) | null, root: Root | null, host: HTMLDivElement | null
let uninstall: (() => void) | null, likedCalls: number
const shellBack = () => { for (let i = handlers.length - 1; i >= 0; i--) { const h = handlers[i]; if (h.canGoBack()) return h.back() } return false }
const wizardBack = {
  register(h: Handler) { handlers.push(h); return () => { handlers = handlers.filter((x) => x !== h) } },
  useHistory({ isRoot: fn }: { isRoot: () => boolean }) { isRoot = fn; const h = { canGoBack: () => false, back: () => false }; handlers.push(h); return () => { handlers = handlers.filter((x) => x !== h) } },
}

beforeEach(() => {
  handlers = []; isRoot = null; uninstall = null; likedCalls = 0
  history.replaceState({ wizardMusic: 'root' }, '')
  localStorage.clear()
  vi.stubGlobal('WizardApp', { back: wizardBack, view: { isVisible: () => true } })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/view/switches')) return ok({ switches: [] })
    if (url.includes('/api/home')) return ok(HOME)
    if (url.includes('/api/liked')) { likedCalls++; return ok({ tracks: ALL }) }
    return ok({})
  }))
})
afterEach(async () => {
  await act(async () => { await flush(); root?.unmount() })
  uninstall?.(); host?.remove(); root = null; host = null
  vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear()
})

async function mountMusic() {
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<MusicApp onOpenNowPlaying={() => undefined} notify={() => undefined} />); await flush() })
  uninstall = installMusicBack(wizardBack, { identifyOpen: () => false, identifyBack: () => false, nowPlaying: () => false, closeNowPlaying: () => undefined })
  return host
}
const likedHead = (view: HTMLElement) => view.querySelector('section[aria-label="Liked songs"] .music-section-head') as HTMLElement | null
const buttons = (el: Element) => [...el.querySelectorAll('button')].map((b) => b.textContent)

describe('Liked > View all (issue 63)', () => {
  it('has no switch any more (issue 72): /api/liked is always proxied, never gated', () => {
    expect(SWITCHES.find((x) => x.id === 'liked-view-all')).toBeUndefined()
    expect(musicRoute('GET', '/api/liked')).toBe('api')
    expect(readFileSync('server/index.mjs', 'utf8')).not.toContain('liked-view-all')
    expect(readFileSync('src/music/MusicApp.tsx', 'utf8')).not.toContain('liked-view-all')
  })

  it('with no switches saved: Play all then View all (far right); View all lists every liked song; Back returns home', async () => {
    const view = await mountMusic()
    expect(buttons(likedHead(view)!)).toEqual(['Play all', 'View all'])
    expect(view.querySelectorAll('section[aria-label="Liked songs"] .music-row').length).toBe(8) // preview unchanged
    expect(isRoot!()).toBe(true)
    const viewAll = [...likedHead(view)!.querySelectorAll('button')].find((b) => b.textContent === 'View all')!
    await act(async () => { viewAll.click(); await flush() })
    const all = view.querySelector('section[aria-label="All liked songs"]')!
    expect(all).not.toBeNull()
    expect(all.querySelectorAll('.music-row').length).toBe(40)
    expect(all.querySelectorAll('.music-row button[aria-label]').length).toBeGreaterThanOrEqual(40) // play-next per row
    expect(all.textContent).toContain('40 songs')
    expect(view.querySelector('section[aria-label="Liked songs"]')).toBeNull()
    expect(history.state?.wizardMusic).toBe('liked')
    expect(isRoot!()).toBe(false)
    const back = vi.spyOn(history, 'back').mockImplementation(() => undefined)
    let did = false
    await act(async () => { did = shellBack(); await flush() })
    expect(did).toBe(true) // handled: Music stays open
    expect(back).toHaveBeenCalledTimes(1)
    expect(view.querySelector('section[aria-label="All liked songs"]')).toBeNull()
    expect(view.querySelector('section[aria-label="Liked songs"]')).not.toBeNull()
    expect(isRoot!()).toBe(true)
    expect(shellBack()).toBe(false)
  })

  it('the browser Back (popstate away from the liked entry) also closes the list', async () => {
    const view = await mountMusic()
    const viewAll = [...likedHead(view)!.querySelectorAll('button')].find((b) => b.textContent === 'View all')!
    await act(async () => { viewAll.click(); await flush() })
    history.replaceState({ wizardMusic: 'root' }, '')
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate', { state: history.state })); await flush() })
    expect(view.querySelector('section[aria-label="All liked songs"]')).toBeNull()
    expect(isRoot!()).toBe(true)
  })
})
