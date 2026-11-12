// The switch owner check: an app with a platform owner-proof key takes only a valid signed proof (wizard-os#133).
// Host, Origin, Tailscale-User-Login and X-Wizard-Switch are client-set, so any process on the box that reaches the
// app port could set them. With WIZARD_OWNER_PROOF_KEY_FILE named, only an hmac-v1 proof (wizard-os
// spec/OWNER_PROOF.md, bound to app id, method and target, +-30 s, each nonce once) is accepted.
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM module without types
import { SWITCHES, handleSwitches, switchOn } from '../server/switches.mjs'

const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const APP = 'wizard-music'
const FORGED = { 'x-wizard-switch': '1', host: 'wizard.example.com', origin: 'https://wizard.example.com', 'tailscale-user-login': 'owner@example.com' }
const ENV = ['WIZARD_OWNER_PROOF_KEY_FILE', 'WIZARD_OWNER_PROOF_APP', 'WIZARD_OWNER_LOGINS', 'WIZARD_TRUSTED_ORIGINS', 'WIZARD_SWITCHES_DIR']

function sign(method: string, target: string, { key = KEY, app = APP, ts = Math.floor(Date.now() / 1000) } = {}) {
  const nonce = randomBytes(24).toString('hex')
  const msg = ['wizard-app-owner-v1', app, String(ts), nonce, method, target].join('\n')
  return `${ts}.${nonce}.${createHmac('sha256', key).update(msg).digest('hex')}`
}

let server: Server, port = 0, dir = ''
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  SWITCHES.push({ id: 'demo', name: 'Demo', default: false, issues: [] })
  server = createServer(async (req, res) => { if (!(await handleSwitches(req, res))) { res.writeHead(404); res.end() } })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
})
afterAll(() => { SWITCHES.length = 0; server.close() })
beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k] }
  dir = mkdtempSync(join(tmpdir(), 'music-switch-'))
  process.env.WIZARD_SWITCHES_DIR = dir
})
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

function keyed(key = KEY) {
  const f = join(dir, 'proof'); writeFileSync(f, key)
  process.env.WIZARD_OWNER_PROOF_KEY_FILE = f
  process.env.WIZARD_OWNER_PROOF_APP = APP
}

function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : JSON.stringify(body)
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers, ...(raw ? { 'content-type': 'application/json' } : {}) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode || 0)) })
    req.on('error', reject); req.end(raw)
  })
}
const flip = (headers: Record<string, string>, on = true) => call('POST', '/api/switches', headers, { id: 'demo', on })

describe('app switch owner proof', () => {
  it('keeps the Serve-login check for a keyless app', async () => {
    expect(await call('GET', '/api/switches', FORGED)).toBe(200)
    expect(await call('GET', '/api/switches', { ...FORGED, host: '127.0.0.1:1' })).toBe(403)
  })

  it('refuses the forgeable headers once the app has a key', async () => {
    keyed()
    expect(await call('GET', '/api/switches', FORGED)).toBe(403)
    expect(await flip(FORGED)).toBe(403)
    expect(switchOn('demo')).toBe(false)
  })

  it('takes a valid proof once, bound to the target as received', async () => {
    keyed()
    const h = { 'x-wizard-switch': '1', 'x-wizard-app-owner-proof': sign('POST', '/api/switches') }
    expect(await flip(h)).toBe(200)
    expect(switchOn('demo')).toBe(true)
    expect(await flip(h, false)).toBe(403) // replay
    expect(switchOn('demo')).toBe(true)
    expect(await call('GET', '/api/switches?x=1', { 'x-wizard-switch': '1', 'x-wizard-app-owner-proof': sign('GET', '/api/switches?x=1') })).toBe(200)
  })

  it.each([
    ['wrong method', () => sign('GET', '/api/switches')],
    ['wrong target', () => sign('POST', '/other/api/switches')],
    ['wrong app', () => sign('POST', '/api/switches', { app: 'wizard-notes' })],
    ['wrong key', () => sign('POST', '/api/switches', { key: Buffer.alloc(32) })],
    ['stale', () => sign('POST', '/api/switches', { ts: Math.floor(Date.now() / 1000) - 31 })],
    ['garbage', () => 'not-a-proof'],
  ])('refuses a bad proof: %s', async (_name, proof) => {
    keyed()
    expect(await flip({ ...FORGED, 'x-wizard-app-owner-proof': proof() })).toBe(403)
    expect(switchOn('demo')).toBe(false)
  })

  it('needs the switch header and no bearer', async () => {
    keyed()
    expect(await call('GET', '/api/switches', { 'x-wizard-app-owner-proof': sign('GET', '/api/switches') })).toBe(403)
    expect(await call('GET', '/api/switches', { 'x-wizard-switch': '1', authorization: 'Bearer x', 'x-wizard-app-owner-proof': sign('GET', '/api/switches') })).toBe(403)
  })

  it('refuses when the named key is unreadable and never falls back', async () => {
    process.env.WIZARD_OWNER_PROOF_KEY_FILE = join(dir, 'missing')
    process.env.WIZARD_OWNER_PROOF_APP = APP
    expect(await call('GET', '/api/switches', FORGED)).toBe(403)
    expect(await call('GET', '/api/switches', { 'x-wizard-switch': '1', 'x-wizard-app-owner-proof': sign('GET', '/api/switches') })).toBe(403)
  })
})
