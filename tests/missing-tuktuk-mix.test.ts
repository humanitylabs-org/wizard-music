// @vitest-environment jsdom
// Regression: James could not see externally saved Tuktuk music in an already-open Music.
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const song = { id: 'yt:AQLIDPUyrk4', title: 'Sobelo', artist: 'Yilberking', album: '', art: '', source: 'youtube' as const, stream: '', durationMs: 180000 }
const base = { sources: [], vibes: [{ id: 'mix-tea-music', label: 'Tea music' }], liked: [], recent: [], library: [] }
const added = { ...base, vibes: [{ id: 'mix-tuktuk-music', label: 'Tuktuk music' }, ...base.vibes] }
let root: Root, host: HTMLDivElement
let requests: { url: string; signal?: AbortSignal | null; resolve: (data: unknown) => void; reject: (error: Error) => void }[]
let visible = true, hidden = false
const flush = async () => { await act(async () => { await Promise.resolve() }) }
const answer = async (i: number, data: unknown) => { await act(async () => { requests[i].resolve(data) }) }
const tick = async (ms = 15000) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const event = async (target: Window | Document, name: string) => { await act(async () => { target.dispatchEvent(new Event(name)) }) }

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  requests = []; visible = true; hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  window.WizardApp = { view: { isVisible: () => visible } } as typeof window.WizardApp
  window.WizardNativeMusic = { onmessage: null, postMessage() {} }
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => new Promise((resolve, reject) => {
    requests.push({ url: String(url), signal: init?.signal, resolve: data => resolve({ ok: true, json: async () => data }), reject })
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  delete window.WizardNativeMusic
})
async function mount(withPlayer = false) {
  const app = await import('../src/music/MusicApp')
  await act(async () => root.render(createElement(Fragment, null,
    createElement(app.MusicApp, { onOpenNowPlaying: vi.fn(), notify: vi.fn() }),
    withPlayer ? createElement(app.MiniPlayer, { onOpen: vi.fn(), notify: vi.fn() }) : null)))
  return app
}

it('missing Tuktuk mix appears within the visible 15-second refresh without remount', async () => {
  await mount(); await answer(0, base)
  expect(host.textContent).toContain('Tea music'); expect(host.textContent).not.toContain('Tuktuk music')
  const search = host.querySelector('input')
  await tick(14999); expect(requests).toHaveLength(1)
  await tick(1); expect(requests).toHaveLength(2)
  await answer(1, added)
  expect(host.textContent).toContain('Tuktuk music'); expect(host.textContent).toContain('Tea music')
  expect(host.querySelector('input')).toBe(search)
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('api/home'), expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }))
})

it('refresh keeps the search draft/results, paused player, position and queue; playing stays playing too', async () => {
  const engineModule = await import('../src/music/engine')
  let snap = { ...engineModule.EMPTY_SNAPSHOT, queue: [song, { ...song, id: 'next' }], index: 0, positionMs: 42000, durationMs: 180000, engine: 'native' as const }
  const listeners = new Set<() => void>()
  const engine = { snapshot: () => snap, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) }, load: vi.fn(), stop: vi.fn(), toggle: vi.fn(() => { snap = { ...snap, playing: !snap.playing }; listeners.forEach(fn => fn()) }) }
  engineModule.resetMusicEngineForTests(engine as never)
  const app = await mount(true); await answer(0, base)
  let search!: Promise<number>
  await act(async () => { search = app.musicControl.search('Sobelo') })
  await answer(1, { tracks: [song] }); await search
  const input = host.querySelector('input')!, queue = snap.queue
  expect(input.value).toBe('Sobelo'); expect(host.textContent).toContain('Results for “Sobelo”')
  await tick(); await answer(2, added)
  expect(input.value).toBe('Sobelo'); expect(host.textContent).toContain('Results for “Sobelo”')
  expect(snap).toMatchObject({ queue, index: 0, positionMs: 42000, playing: false })
  expect(engine.load).not.toHaveBeenCalled(); expect(engine.stop).not.toHaveBeenCalled()
  const toggle = host.querySelector<HTMLButtonElement>('.music-mini-toggle')!
  expect(toggle.getAttribute('aria-label')).toBe('Play')
  await act(async () => toggle.click()); expect(snap.playing).toBe(true)
  await tick(); await answer(3, added)
  expect(snap.playing).toBe(true); expect(snap.queue).toBe(queue); expect(snap.positionMs).toBe(42000)
  expect(host.querySelector('.music-mini-toggle')?.getAttribute('aria-label')).toBe('Pause')
  await act(async () => host.querySelector<HTMLButtonElement>('.music-clear')!.click())
  expect(host.textContent).toContain('Tuktuk music')
})

it('coalesces focus/visibility overlaps and refreshes on return; hidden views do not poll', async () => {
  await mount(); await answer(0, base)
  visible = false; await tick(45000); expect(requests).toHaveLength(1)
  visible = true; hidden = true; await tick(); expect(requests).toHaveLength(1)
  hidden = false; await event(document, 'visibilitychange'); expect(requests).toHaveLength(2)
  await event(window, 'focus'); await event(document, 'visibilitychange'); expect(requests).toHaveLength(2)
  await answer(1, added); expect(host.textContent).toContain('Tuktuk music')
  await event(window, 'focus'); expect(requests).toHaveLength(3)
  await answer(2, base)
})

it('keeps good data on refresh failure and recovers after a hung request times out', async () => {
  await mount(); await answer(0, base)
  await tick(); await act(async () => requests[1].reject(new Error('Offline')))
  expect(host.textContent).toContain('Tea music'); expect(host.textContent).not.toContain('Offline')
  await tick(); expect(requests).toHaveLength(3)
  await tick(10000); expect(requests[2].signal?.aborted).toBe(true)
  await tick(5000); expect(requests).toHaveLength(4)
  await answer(3, added); expect(host.textContent).toContain('Tuktuk music')
})

it('initial failure is retryable; unmount aborts and fences late completions and removes refresh triggers', async () => {
  await mount(); await act(async () => requests[0].reject(new Error('Offline')))
  expect(host.textContent).toContain('Offline')
  await act(async () => host.querySelector<HTMLButtonElement>('.secondary-action')!.click())
  expect(requests).toHaveLength(2)
  await answer(1, base)
  await event(window, 'focus'); expect(requests).toHaveLength(3)
  await act(async () => root.unmount())
  expect(requests[2].signal?.aborted).toBe(true)
  await answer(2, added); await tick(45000); await event(window, 'focus')
  expect(requests).toHaveLength(3); expect(host.textContent).toBe('')
  // afterEach can safely unmount the already-unmounted root.
  await flush()
})
