// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals() })
const entry = { id: 'a'.repeat(24), url: 'https://www.youtube.com/watch?v=9TbASs-ZjHA', title: 'Ethereal Mix I', kind: 'video', providerId: '9TbASs-ZjHA', author: 'Xavrinox', authorUrl: '', thumbnail: '', createdAt: 1 }
const response = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 502, json: async () => data })

it('publishes pending before I/O, saves once despite double-tap, and requires GET verification', async () => {
  let release!: (value: unknown) => void
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(r => release = r)).mockResolvedValueOnce(response({ playlists: [entry] }))
  vi.stubGlobal('fetch', fetch)
  const { playlistControl: c } = await import('../src/music/playlists')
  const save = c.save({ url: entry.url, title: entry.title })
  expect(c.snapshot().pending?.url).toBe(entry.url)
  await c.save({ url: entry.url }); expect(fetch).toHaveBeenCalledTimes(1)
  release(response(entry)); await save
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(c.snapshot()).toMatchObject({ items: [entry], pending: null, error: '', failed: null })
})

it('keeps failed draft and retry action after view subscriptions are removed; stale list cannot hide the pending write', async () => {
  let release!: (value: unknown) => void
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(r => release = r)).mockRejectedValueOnce(Error('Offline'))
  vi.stubGlobal('fetch', fetch)
  const { playlistControl: c } = await import('../src/music/playlists')
  const unsubscribe = c.subscribe(() => undefined), load = c.load()
  const draft = { url: entry.url, title: entry.title }
  const save = c.save(draft); unsubscribe()
  release(response({ playlists: [] })); await load; await save
  expect(c.snapshot()).toMatchObject({ failed: draft, pending: null, error: 'Offline' })
  fetch.mockResolvedValueOnce(response(entry)).mockResolvedValueOnce(response({ playlists: [entry] }))
  await c.save(c.snapshot().failed!)
  expect(c.snapshot()).toMatchObject({ items: [entry], failed: null, error: '', loading: false })
})

it('never announces a save that the list cannot read back', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(entry)).mockResolvedValueOnce(response({ playlists: [] })))
  const { playlistControl: c } = await import('../src/music/playlists')
  await c.save({ url: entry.url })
  expect(c.snapshot().items).toEqual([])
  expect(c.snapshot().error).toContain('could not verify')
  expect(c.snapshot().failed?.url).toBe(entry.url)
})
