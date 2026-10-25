import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { createMusicProxy, musicRoute } from '../server/music.mjs'

it('proxies account library query and rewrites media without leaking upstream token', async () => {
  const seen: string[] = []
  const upstream = createServer((req, res) => {
    seen.push(req.url ?? '')
    expect(req.headers.authorization).toBe('Bearer fixture')
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ tracks: [{ stream: '/wizard/music/stream/yt%3Aaaaaaaaaaaa' }] }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const proxy = createMusicProxy({ origin: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, token: 'fixture' })
  const app = createServer((req, res) => { void proxy(req, res, new URL(req.url!, 'http://localhost'), (out, status, body) => { out.writeHead(status); out.end(JSON.stringify(body)) }) })
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve))
  try {
    const r = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/wizard-music/api/account-library/playlist?id=PL_one&limit=100`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ tracks: [{ stream: '/wizard-music/stream/yt%3Aaaaaaaaaaaa' }] })
    expect(seen).toEqual(['/api/account-library/playlist?id=PL_one&limit=100'])
    expect(musicRoute('POST', '/api/account-library/likes')).toBeNull()
    expect(musicRoute('GET', '/api/account-library/arbitrary')).toBeNull()
  } finally {
    await Promise.all([new Promise<void>(resolve => app.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))])
  }
})
