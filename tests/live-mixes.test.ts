// wizard-music#46: progressive play is on for everyone (its live-mixes switch was removed once approved). The app
// server always asks the hub to start a song while it is still downloading, and only for song streams.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createMusicProxy } from '../server/music.mjs'
import { SWITCHES } from '../server/switches.mjs'

async function hubSaw(path: string) {
  const seen: (string | undefined)[] = []
  const hub = createServer((req, res) => { seen.push(req.headers['x-wizard-music-live'] as string | undefined); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve))
  const handle = createMusicProxy({ origin: `http://127.0.0.1:${(hub.address() as AddressInfo).port}`, token: 't' })
  const front = createServer((req, res) => { void handle(req, res, new URL(req.url ?? '/', 'http://x'), (r: import('node:http').ServerResponse, s: number, v: unknown) => { r.writeHead(s); r.end(JSON.stringify(v)) }) })
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve))
  try {
    await (await fetch(`http://127.0.0.1:${(front.address() as AddressInfo).port}/wizard-music${path}`, { headers: { 'X-Wizard-Music-Live': '1' } })).text()
  } finally { hub.close(); front.close() }
  return seen[0]
}

describe('progressive play (wizard-music#46)', () => {
  it('has no switch any more', () => {
    expect(SWITCHES.find(s => s.id === 'live-mixes')).toBeUndefined()
  })

  it('always asks the hub for a live start for songs, never for art or the API', async () => {
    expect(await hubSaw('/stream/yt:HW0otI10RrM')).toBe('1')
    expect(await hubSaw('/stream/lib:0123456789abcdef0123')).toBe('1')
    expect(await hubSaw('/art/yt:HW0otI10RrM')).toBe(undefined)
    expect(await hubSaw('/api/home')).toBe(undefined)
  })
})
