// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { MusicTrack } from '../src/music/engine'

let root: Root | undefined
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); document.body.innerHTML = ''; delete window.WizardNativeMusic })
const track = (id: string): MusicTrack => ({ id, title: id, artist: 'Fixture artist', album: '', durationMs: 1000, source: 'youtube', art: '/art/' + id, stream: '/stream/' + id })
const connected = { state: 'connected', limit: 100, connect: '/wizard-youtube-music/' }
async function mount() {
  const { AccountLibrarySection } = await import('../src/music/MusicApp')
  const node = document.createElement('div'); document.body.append(node); root = createRoot(node)
  const open = vi.fn(), notify = vi.fn()
  await act(async () => root!.render(createElement(AccountLibrarySection, { onOpenNowPlaying: open, notify })))
  return { open, notify }
}
async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text)
  expect(button, text).toBeTruthy()
  await act(async () => button!.click())
}
it('browses personal playlists and likes; plays exact queue, no radio or feedback sync', async () => {
  const commands: Record<string, unknown>[] = []
  window.WizardNativeMusic = { onmessage: null, postMessage(raw) { commands.push(JSON.parse(raw)) } }
  const tracks = [track('yt:aaaaaaaaaaa'), track('yt:bbbbbbbbbbb')]
  const fetcher = vi.fn(async (path: string) => ({ ok: true, json: async () => path.includes('/playlists?') ? { ...connected, playlists: [{ id: 'PL_one', title: '<Personal mix>' }] } : path.includes('/playlist?') || path.includes('/likes?') ? { ...connected, tracks } : connected }))
  vi.stubGlobal('fetch', fetcher)
  const { open } = await mount()
  await click('Playlists'); await click('<Personal mix>')
  expect(document.querySelector('Personal')).toBeNull()
  await click('Play all')
  expect(open).toHaveBeenCalledOnce()
  expect(commands.find(c => c.method === 'load')).toMatchObject({ index: 0, station: null, queue: tracks.map(t => ({ ...t, stream: new URL(t.stream, document.baseURI).href, art: new URL(t.art, document.baseURI).href })) })
  await click('yt:bbbbbbbbbbbFixture artist0:01')
  expect(commands.filter(c => c.method === 'load').at(-1)).toMatchObject({ index: 1, queue: tracks.map(t => ({ ...t, stream: new URL(t.stream, document.baseURI).href, art: new URL(t.art, document.baseURI).href })) })
  await click('Back to playlists'); await click('Liked songs')
  expect(fetcher.mock.calls.some(([url]) => url.includes('/playlist?id=PL_one&limit=100'))).toBe(true)
  expect(fetcher.mock.calls.some(([url]) => url.includes('/likes?'))).toBe(true)
  expect(fetcher.mock.calls.some(([url]) => /station|feedback/.test(url))).toBe(false)
})
it('signed out links to connector and never shows personal browse controls', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ...connected, state: 'signed_out', error: 'Connect and verify your YouTube account.' }) })))
  await mount()
  expect(document.querySelector('a')?.getAttribute('href')).toBe('/wizard-youtube-music/')
  expect(document.querySelector('a')?.textContent).toBe('Connect YouTube Music')
  expect(document.body.textContent).not.toContain('Play all')
  expect(document.querySelector('[role=alert]')?.textContent).toContain('Connect and verify')
})
it('failed library read clears old tracks and offers refresh with honest error', async () => {
  let failed = false
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: !failed, json: async () => failed ? { error: 'Account library unavailable. Verify connection.' } : { ...connected, tracks: [track('yt:aaaaaaaaaaa')] } })))
  await mount(); failed = true
  await click('Refresh')
  expect(document.querySelector('[role=alert]')?.textContent).toContain('Account library unavailable')
  expect(document.body.textContent).not.toContain('yt:aaaaaaaaaaa')
  failed = false; await click('Refresh')
  expect(document.body.textContent).toContain('yt:aaaaaaaaaaa')
})
