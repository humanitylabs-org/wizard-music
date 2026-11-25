// @vitest-environment jsdom
import { Readable } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'
import { handleMcp, songPlaylistRequest } from '../server/mcp.mjs'
import { musicRoute } from '../server/music.mjs'
import { SWITCHES } from '../server/switches.mjs'

beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals() })
const ID = 'a'.repeat(24)
const track = (n: number) => ({ id: `yt:song${String(n).padStart(7, '0')}`, title: `Song ${n}`, artist: 'Argy', album: '', durationMs: 1, source: 'youtube', art: '', stream: '', liked: false })
const list = (n: number) => ({ id: ID, name: 'Argy workout', description: '', trackIds: Array.from({ length: n }, (_, i) => track(i).id), count: n, createdAt: 1, updatedAt: 1, tracks: Array.from({ length: n }, (_, i) => track(i)) })
const response = (data: unknown, ok = true, status = ok ? 200 : 502) => ({ ok, status, json: async () => data, text: async () => JSON.stringify(data) })

async function mcp(method: string, params: object) {
  const req = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))]) as Readable & { method: string; headers: object }
  req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
  let result: any
  await handleMcp(req, {}, (_res: unknown, _status: number, body: unknown) => { result = body }, 9205)
  return result
}

it('is on for everyone (no song-playlists switch), with the hub routes proxied', () => {
  expect(SWITCHES.find((s) => s.id === 'song-playlists')).toBeUndefined()
  expect(musicRoute('GET', '/api/song-playlists')).toBe('api')
  expect(musicRoute('GET', `/api/song-playlists/${ID}`)).toBe('api')
  for (const sub of ['', `/${ID}`, `/${ID}/add`, `/${ID}/remove`, `/${ID}/delete`]) expect(musicRoute('POST', '/api/song-playlists' + sub)).toBe('api')
  expect(musicRoute('POST', `/api/song-playlists/${ID}/play`)).toBeNull()
  expect(musicRoute('GET', '/api/song-playlists/../settings')).toBeNull()
})

it('always lists the agent tools', async () => {
  const names = (r: any) => r.result.tools.map((t: { name: string }) => t.name)
  expect(names(await mcp('tools/list', {}))).toEqual(expect.arrayContaining(['playlist_create', 'playlist_add_tracks', 'playlist_remove_tracks', 'playlist_get', 'playlist_update', 'playlist_list']))
})

it('clears a stored song-playlists value and keeps the live switches', async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'wm-sw-'))
  const before = process.env.WIZARD_SWITCHES_DIR
  process.env.WIZARD_SWITCHES_DIR = dir
  try {
    writeFileSync(join(dir, 'switches.json'), JSON.stringify({ 'song-playlists': true, 'navidrome': true }))
    const { pruneSwitches, switchesDoc } = await import('../server/switches.mjs')
    expect(pruneSwitches()).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'switches.json'), 'utf8'))).toEqual({ 'navidrome': true })
    expect(pruneSwitches()).toBe(false)
    expect(switchesDoc().switches.map((s: { id: string }) => s.id)).not.toContain('song-playlists')
  } finally { if (before === undefined) delete process.env.WIZARD_SWITCHES_DIR; else process.env.WIZARD_SWITCHES_DIR = before }
})

it('playlist_create writes once, then reads the playlist back', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ ...list(20), skipped: ['yt:unknown0000'] })).mockResolvedValueOnce(response(list(20)))
  vi.stubGlobal('fetch', fetch)
  const ids = [...list(20).trackIds, 'yt:unknown0000']
  const out = await mcp('tools/call', { name: 'playlist_create', arguments: { name: 'Argy workout', track_ids: ids } })
  expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:9205/wizard-music/api/song-playlists')
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ name: 'Argy workout', trackIds: ids })
  expect(fetch.mock.calls[1][0]).toBe(`http://127.0.0.1:9205/wizard-music/api/song-playlists/${ID}`)
  const body = JSON.parse(out.result.content[0].text)
  expect(body.playlist.tracks.map((t: { id: string }) => t.id)).toEqual(list(20).trackIds)
  expect(body.skipped).toEqual(['yt:unknown0000'])
  expect(out.result.isError).toBe(false)
})

it('playlist_list adds the song playlists next to saved links', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ playlists: [] })).mockResolvedValueOnce(response({ playlists: [list(2)] })))
  const out = await mcp('tools/call', { name: 'playlist_list', arguments: {} })
  expect(JSON.parse(out.result.content[0].text)).toMatchObject({ playlists: [], songPlaylists: [{ id: ID, name: 'Argy workout' }] })
})

it('maps each tool to one bounded hub request and rejects bad arguments', () => {
  expect(songPlaylistRequest('playlist_add_tracks', { id: ID, track_ids: ['lib:abc'], position: 0 })).toEqual({ path: `/${ID}/add`, body: { trackIds: ['lib:abc'], position: 0 } })
  expect(songPlaylistRequest('playlist_remove_tracks', { id: ID, track_ids: ['yt:x'] })).toEqual({ path: `/${ID}/remove`, body: { trackIds: ['yt:x'] } })
  expect(songPlaylistRequest('playlist_get', { id: ID })).toEqual({ path: `/${ID}` })
  expect(songPlaylistRequest('playlist_update', { id: ID, name: 'Gym' })).toEqual({ path: `/${ID}`, body: { name: 'Gym' } })
  for (const [name, args] of [['playlist_get', { id: '../x' }], ['playlist_create', { name: ' ', track_ids: [] }], ['playlist_create', { name: 'x' }], ['playlist_create', { name: 'x', track_ids: ['http://x'] }],
    ['playlist_add_tracks', { id: ID, track_ids: [], position: -1 }], ['playlist_update', { id: ID }], ['playlist_get', { id: ID, url: 'x' }]] as const) expect(songPlaylistRequest(name, args)).toBeNull()
})

it('the page store reads every write back from the hub and ignores a double tap', async () => {
  let release!: (value: unknown) => void
  const fetch = vi.fn().mockImplementationOnce(() => new Promise((r) => { release = r })).mockResolvedValueOnce(response(list(0)))
  vi.stubGlobal('fetch', fetch)
  const { songPlaylistControl: c } = await import('../src/music/songPlaylists')
  const made = c.create('Argy workout')
  expect(await c.create('Again')).toBeNull()
  release(response({ ...list(0), skipped: [] })); expect((await made)?.id).toBe(ID)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(c.snapshot().items.map((p) => p.name)).toEqual(['Argy workout'])
  fetch.mockResolvedValueOnce(response({ ...list(3), skipped: [] }))
  await c.add(ID, track(2))
  expect(c.snapshot().open[ID].tracks?.length).toBe(3)
  fetch.mockResolvedValueOnce(response({ ...list(3), trackIds: [track(1).id, track(0).id, track(2).id], skipped: [] }))
  await c.move(ID, track(0).id, 1)
  expect(JSON.parse(fetch.mock.lastCall![1].body)).toEqual({ trackIds: [track(1).id, track(0).id, track(2).id] })
  fetch.mockResolvedValueOnce(response({ id: ID, deleted: true }))
  await c.remove(ID)
  expect(c.snapshot().items).toEqual([])
  fetch.mockResolvedValueOnce(response({ error: 'Give the playlist a name.' }, false, 400))
  expect(await c.create('x')).toBeNull()
  expect(c.snapshot().error).toBe('Give the playlist a name.')
})
