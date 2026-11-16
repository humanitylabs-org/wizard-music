// @vitest-environment jsdom
// wizard-os#654 (16 Nov 2026): tapping a saved mix or playlist under Home > Playlists played nothing and opened
// youtube.com (the YouTube app on Android). The whole row now plays inside Music; there is no link out.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve() }
const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body })
const mix = { id: 'a'.repeat(24), url: 'https://www.youtube.com/watch?v=9TbASs-ZjHA', title: 'Ethereal Mix I', kind: 'video', providerId: '9TbASs-ZjHA', author: 'Xavrinox', authorUrl: '', thumbnail: '', createdAt: 2 }
const list = { id: 'b'.repeat(24), url: 'https://www.youtube.com/playlist?list=PLtest1234567890', title: 'Study', kind: 'playlist', providerId: 'PLtest1234567890', author: '', authorUrl: '', thumbnail: '', createdAt: 1 }
const song = (n: number) => ({ id: `yt:${String(n).repeat(11)}`, title: `Song ${n}`, artist: 'A', album: '', durationMs: 1, source: 'youtube', art: '', stream: '', liked: false })
let root: Root | null, host: HTMLDivElement | null, playResponse: () => ReturnType<typeof res>

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('WzSheet', { open() {}, close() {} })
  playResponse = () => res({ track: song(1), tracks: [song(1), song(2), song(3)] })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/play') && init?.method === 'POST') return playResponse()
    return res({ playlists: [mix, list] })
  }))
})
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.unstubAllGlobals() })

async function mount(onPlay: (tracks: unknown[]) => Promise<void>) {
  const { Playlists } = await import('../src/music/Playlists')
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(<Playlists onPlay={onPlay} />); await flush() })
}
const row = (title: string) => host!.querySelector<HTMLButtonElement>(`button[aria-label="Play ${title}"]`)!

it('has no link to YouTube in any row', async () => {
  await mount(async () => {})
  expect(host!.querySelectorAll('a').length).toBe(0)
  expect(host!.textContent).not.toMatch(/open (it )?on youtube/i)
  expect(row('Ethereal Mix I')).toBeTruthy()
  expect(row('Study')).toBeTruthy()
})

it('a tap on a saved YouTube playlist row plays its songs in Music, in order', async () => {
  const onPlay = vi.fn(async () => {})
  await mount(onPlay)
  await act(async () => { row('Study').click(); await flush() })
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining(`/api/playlists/${list.id}/play`), expect.objectContaining({ method: 'POST' }))
  expect(onPlay).toHaveBeenCalledWith([song(1), song(2), song(3)])
})

it('a long mix row plays its one track (older hub answers with track only)', async () => {
  playResponse = () => res({ track: song(7) })
  const onPlay = vi.fn(async () => {})
  await mount(onPlay)
  await act(async () => { row('Ethereal Mix I').click(); await flush() })
  expect(onPlay).toHaveBeenCalledWith([song(7)])
})

it('a failure shows a plain in-app error with Retry, never a YouTube fallback', async () => {
  playResponse = () => res({ error: 'Online playback is off. Turn on Online sources in Music, then try again.' }, 400)
  const onPlay = vi.fn(async () => {})
  await mount(onPlay)
  await act(async () => { row('Study').click(); await flush() })
  const alert = host!.querySelector('[role="alert"]')!
  expect(alert.textContent).toContain('Online playback is off')
  expect(alert.textContent).not.toMatch(/youtube/i)
  playResponse = () => res({ track: song(1), tracks: [song(1)] })
  const retry = [...alert.querySelectorAll('button')].find(b => b.textContent === 'Retry')!
  await act(async () => { retry.click(); await flush() })
  expect(onPlay).toHaveBeenCalledWith([song(1)])
  expect(host!.querySelector('[role="alert"]')).toBeNull()
})

it('the hub and the skill no longer send anyone to YouTube', () => {
  const hub = readFileSync('hub/hub.py', 'utf8'), skill = readFileSync('skill/SKILL.md', 'utf8')
  expect(hub).not.toMatch(/Open this (playlist|mix) on YouTube/)
  expect(skill).not.toMatch(/opens the original YouTube URL|Open on YouTube/)
})
