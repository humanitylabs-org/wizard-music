// Music's art and songs in a sandboxed (opaque-origin) frame: the shell's browser boundary, wizard-os#133.
// <img> and <audio> load straight from the frame, cross-site with no Origin, so Music signs each art and stream
// address it gives the owner. A load with a valid ticket for its own path may skip the same-site rule; nothing else.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createMediaTickets } from '../server/media-ticket.mjs'
import { requestAllowed } from '../server/request-policy.mjs'

const BASE = '/wizard-music'
let clock = Date.UTC(2026, 10, 12, 22, 0)
const tickets = createMediaTickets({ secret: 'hub-secret', base: BASE, now: () => clock })
const req = (path, headers = {}, method = 'GET', peer = '127.0.0.1') => ({ method, url: path, headers: { host: '127.0.0.1:9205', ...headers }, socket: { remoteAddress: peer } })
const frame = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'audio' }
const allowed = (r) => requestAllowed(r, { asset: tickets.valid(r, new URL(r.url, 'http://x')) })
const signed = (path) => JSON.parse(tickets.addTickets(JSON.stringify({ u: path }))).u

test('API answers get a ticket on every art and stream address, and nowhere else', () => {
  const body = JSON.stringify({
    stream: '/wizard-music/stream/yt:abc', art: '/wizard-music/art/lib%3Ax_1', more: '/wizard-music/api/station/0123456789abcdef/more',
    audio_url: '/wizard-music/api/identify/captures/0f0e0d0c-0b0a-0908-0706-050403020100/audio',
    original_url: '/wizard-music/api/identify/captures/0f0e0d0c-0b0a-0908-0706-050403020100/audio?kind=original',
    compare_url: '/wizard-music/api/identify/candidates/7/media?kind=preview', other: '/elsewhere/stream/yt:abc',
  })
  const out = JSON.parse(tickets.addTickets(body))
  assert.match(out.stream, /^\/wizard-music\/stream\/yt:abc\?t=[0-9a-z]+\.[A-Za-z0-9_-]{22}$/)
  assert.match(out.art, /^\/wizard-music\/art\/lib%3Ax_1\?t=/)
  assert.match(out.audio_url, /\/audio\?t=[^&]+$/)
  assert.match(out.original_url, /\/audio\?t=[^&]+&kind=original$/)
  assert.match(out.compare_url, /\/media\?t=[^&]+&kind=preview$/)
  assert.equal(out.more, '/wizard-music/api/station/0123456789abcdef/more')
  assert.equal(out.other, '/elsewhere/stream/yt:abc')
})

test('a sandboxed frame loads its art and songs with the ticket', () => {
  for (const path of ['/wizard-music/stream/yt:abc', '/wizard-music/art/lib%3Ax_1', '/wizard-music/api/identify/candidates/7/media']) {
    const url = signed(path)
    assert.equal(allowed(req(url, frame)), true, url)
    assert.equal(allowed(req(url, { ...frame, origin: 'null' })), true, url)
    assert.equal(allowed(req(url, frame, 'HEAD')), true, url)
    assert.equal(allowed(req(path, frame)), false, `${path} without a ticket`)
  }
  const kind = signed('/wizard-music/api/identify/captures/0f0e0d0c-0b0a-0908-0706-050403020100/audio?kind=export')
  assert.equal(allowed(req(kind, frame)), true)
})

test('a ticket opens only its own path, only for reads, only while fresh, and never for another site', () => {
  const url = signed('/wizard-music/stream/yt:abc'), t = new URL(url, 'http://x').searchParams.get('t')
  assert.equal(allowed(req(`/wizard-music/stream/yt:other?t=${t}`, frame)), false)
  assert.equal(allowed(req(`/wizard-music/api/home?t=${t}`, frame)), false)
  assert.equal(allowed(req(`/wizard-music/?t=${t}`, frame)), false)
  assert.equal(allowed(req(`${url}&t=${t}`, frame)), false)
  assert.equal(allowed(req(url.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), frame)), false)
  assert.equal(allowed(req(url, frame, 'POST')), false)
  assert.equal(allowed(req(url, { ...frame, origin: 'https://evil.example' })), false)
  assert.equal(allowed({ ...req(url, frame, 'GET', '203.0.113.1'), headers: { host: 'evil.example', ...frame } }), false)
  const other = createMediaTickets({ secret: 'another-box', base: BASE, now: () => clock })
  assert.equal(other.valid(req(url, frame), new URL(url, 'http://x')), false)
  const saved = clock
  clock += 7 * 86_400_000
  assert.equal(allowed(req(url, frame)), true, 'still good a week later')
  clock += 2 * 86_400_000
  assert.equal(allowed(req(url, frame)), false, 'expired')
  clock = saved
})

test('the same box gives the same ticket after a restart', () => {
  const again = createMediaTickets({ secret: 'hub-secret', base: BASE, now: () => clock })
  assert.equal(again.ticket('/wizard-music/stream/yt:abc'), tickets.ticket('/wizard-music/stream/yt:abc'))
  assert.equal(again.valid(req(signed('/wizard-music/art/yt:abc'), frame), new URL(signed('/wizard-music/art/yt:abc'), 'http://x')), true)
})
