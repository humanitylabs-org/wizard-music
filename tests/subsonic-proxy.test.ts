// Subsonic for phone music apps (wizard-music#92, on for everyone): the app server's pass-through to Navidrome.
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { createSubsonicProxy, serverAddress, SUBSONIC, tailnetOwner } from '../server/subsonic.mjs'

const closers: (() => Promise<void>)[] = []
afterEach(async () => { while (closers.length) await closers.pop()!() })

async function listen(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return (server.address() as AddressInfo).port
}

async function setup(bundled = true) {
  const seen: { url: string; user?: string; range?: string; cookie?: string }[] = []
  const nd = await listen((req, res) => {
    seen.push({ url: req.url ?? '', user: req.headers['x-wizard-navidrome-user'] as string, range: req.headers.range, cookie: req.headers.cookie })
    res.writeHead(req.headers.range ? 206 : 200, { 'Content-Type': 'application/json', 'Set-Cookie': 'nd=1', ...(req.headers.range ? { 'Content-Range': 'bytes 0-1/10' } : {}) })
    res.end('{"subsonic-response":{"status":"ok"}}')
  })
  const proxy = createSubsonicProxy({ origin: bundled ? `http://127.0.0.1:${nd}/wizard-music` : '', base: '/wizard-music' })
  const app = await listen((req, res) => { void proxy(req, res, new URL(req.url!, 'http://localhost'), (out: import('node:http').ServerResponse, status: number, body: unknown) => { out.writeHead(status, { 'Content-Type': 'application/json' }); out.end(JSON.stringify(body)) }) })
  return { seen, base: `http://127.0.0.1:${app}/wizard-music` }
}

it('says so when this install has no Navidrome', async () => {
  const { seen, base } = await setup(false)
  const r = await fetch(`${base}/rest/ping.view?u=a&p=b`, { headers: { 'Tailscale-User-Login': 'owner@example.com' } })
  expect(r.status).toBe(503)
  expect(await r.json()).toEqual({ error: 'navidrome_not_bundled' })
  expect(seen).toEqual([])
})

it("signs the owner's phone app in as Music's user and passes the Subsonic call through unchanged", async () => {
  const { seen, base } = await setup()
  const r = await fetch(`${base}/rest/stream.view?u=any&t=abc&s=salt&id=nd1&c=Symfonium&v=1.16.1`, {
    headers: { 'Tailscale-User-Login': 'owner@example.com', Range: 'bytes=0-1', Cookie: 'shell=secret', 'X-Wizard-Navidrome-User': 'admin' },
  })
  expect(r.status).toBe(206)
  expect(r.headers.get('content-range')).toBe('bytes 0-1/10')
  expect(r.headers.get('set-cookie')).toBeNull()
  expect(seen).toEqual([{ url: '/wizard-music/rest/stream.view?u=any&t=abc&s=salt&id=nd1&c=Symfonium&v=1.16.1', user: 'wizard', range: 'bytes=0-1', cookie: undefined }])
})

it('without the tailnet login Navidrome gets no user header (its own sign-in applies)', async () => {
  const { seen, base } = await setup()
  await fetch(`${base}/rest/ping.view`, { headers: { 'X-Wizard-Navidrome-User': 'wizard' } })
  expect(seen[0].user).toBeUndefined()
})

it('passes only the Subsonic API, and knows the owner and the address to type', () => {
  expect(SUBSONIC.test('/rest/ping.view')).toBe(true)
  expect(SUBSONIC.test('/rest/getCoverArt')).toBe(true)
  expect(SUBSONIC.test('/rest/../app/index.html')).toBe(false)
  expect(SUBSONIC.test('/app/')).toBe(false)
  const req = (headers: Record<string, string>, peer = '127.0.0.1') => ({ headers, socket: { remoteAddress: peer } }) as unknown as IncomingMessage
  expect(tailnetOwner(req({ 'tailscale-user-login': 'owner@example.com' }), 'owner@example.com')).toBe(true)
  expect(tailnetOwner(req({ 'tailscale-user-login': 'guest@example.com' }), 'owner@example.com')).toBe(false)
  expect(tailnetOwner(req({ 'tailscale-user-login': 'a@x.com,b@x.com' }), '')).toBe(false)
  expect(tailnetOwner(req({}), '')).toBe(false)
  expect(serverAddress(req({ host: '127.0.0.1:9205', 'x-forwarded-host': 'box.tail1.ts.net:8444', 'x-forwarded-proto': 'https' }), '/wizard-music')).toBe('https://box.tail1.ts.net:8444/wizard-music')
  expect(serverAddress(req({ host: 'box.tail1.ts.net' }, '100.64.0.9'), '/wizard-music')).toBe('https://box.tail1.ts.net/wizard-music')
})
