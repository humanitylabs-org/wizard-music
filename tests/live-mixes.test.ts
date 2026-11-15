// wizard-music#46 (switch live-mixes): with the switch on, the app server asks the hub to start a song while it is
// still downloading; with it off, the hub request is exactly as before.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createMusicProxy } from '../server/music.mjs'
import { SWITCHES } from '../server/switches.mjs'

async function hubSaw(live: () => boolean, path: string) {
  const seen: (string | undefined)[] = []
  const hub = createServer((req, res) => { seen.push(req.headers['x-wizard-music-live'] as string | undefined); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve))
  const handle = createMusicProxy({ origin: `http://127.0.0.1:${(hub.address() as AddressInfo).port}`, token: 't', live })
  const front = createServer((req, res) => { void handle(req, res, new URL(req.url ?? '/', 'http://x'), (r: import('node:http').ServerResponse, s: number, v: unknown) => { r.writeHead(s); r.end(JSON.stringify(v)) }) })
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve))
  try {
    await (await fetch(`http://127.0.0.1:${(front.address() as AddressInfo).port}/wizard-music${path}`, { headers: { 'X-Wizard-Music-Live': '1' } })).text()
  } finally { hub.close(); front.close() }
  return seen[0]
}

describe('live-mixes switch', () => {
  it('is declared off by default and linked to its issue', () => {
    const sw = SWITCHES.find(s => s.id === 'live-mixes')
    expect(sw).toMatchObject({ default: false, issues: ['humanitylabs-org/wizard-music#46'] })
  })

  it('asks the hub for a live start only for songs and only while the switch is on', async () => {
    expect(await hubSaw(() => true, '/stream/yt:HW0otI10RrM')).toBe('1')
    expect(await hubSaw(() => false, '/stream/yt:HW0otI10RrM')).toBe(undefined)  // a browser cannot ask for it itself
    expect(await hubSaw(() => true, '/art/yt:HW0otI10RrM')).toBe(undefined)
    expect(await hubSaw(() => true, '/api/home')).toBe(undefined)
  })
})
