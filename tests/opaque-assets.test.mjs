// Music from a sandboxed (opaque-origin) frame: the shell's browser boundary, wizard-os#133.
// The browser fetches the app's files cross-site, the module script and stylesheet with `Origin: null`. Music lets
// its own public files load that way; the page, API, streams and art keep refusing it (the shell carries those calls).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { publicAsset, requestAllowed } from '../server/request-policy.mjs'

const BASE = '/wizard-music'
const req = (path, headers = {}, method = 'GET', peer = '127.0.0.1') => ({ method, url: path, headers: { host: '127.0.0.1:9205', ...headers }, socket: { remoteAddress: peer } })
const allowed = (r) => requestAllowed(r, { asset: publicAsset(r, new URL(r.url, 'http://x').pathname, BASE) })
const opaque = { origin: 'null', 'sec-fetch-site': 'cross-site' }
const noOrigin = { 'sec-fetch-site': 'cross-site' }

test('the module script, its stylesheet and the other public files load into the sandboxed frame', () => {
  for (const path of ['/wizard-music/assets/index-abc.js', '/wizard-music/assets/index-abc.css']) {
    assert.equal(allowed(req(path, opaque)), true, path)
    assert.equal(allowed(req(path, opaque, 'HEAD')), true, path)
  }
  for (const path of ['/wizard-music/wizard-sheet.js', '/wizard-music/wizard-ui.css', '/wizard-music/icon.svg', '/wizard-music/manifest.webmanifest']) {
    assert.equal(allowed(req(path, noOrigin)), true, path)
  }
})

test('the page, API, streams, art, switches and writes still refuse an opaque page', () => {
  for (const path of ['/wizard-music/', '/wizard-music/index.html', '/wizard-music/api/home', '/wizard-music/api/playlists', '/wizard-music/api/switches',
    '/wizard-music/api/x.js', '/wizard-music/API/x.js', '/wizard-music/stream/1.js', '/wizard-music/art/1.png', '/wizard-music/api%2fhome.js', '/mcp', '/health', '/other/app.js']) {
    assert.equal(allowed(req(path, opaque)), false, path)
    assert.equal(allowed(req(path, noOrigin)), false, path)
  }
  assert.equal(allowed(req('/wizard-music/assets/index-abc.js', opaque, 'POST')), false)
})

test('a real other site is still refused, and the host rule still holds', () => {
  assert.equal(allowed(req('/wizard-music/assets/index-abc.js', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(allowed(req('/wizard-music/assets/index-abc.js', { origin: 'https://evil.example' })), false)
  assert.equal(allowed({ ...req('/wizard-music/assets/index-abc.js', opaque, 'GET', '203.0.113.1'), headers: { host: 'evil.example', ...opaque } }), false)
})

test('nothing changes for the shell page itself', () => {
  assert.equal(allowed(req('/wizard-music/assets/index-abc.js')), true)
  assert.equal(allowed(req('/wizard-music/api/home')), true)
  assert.equal(allowed(req('/wizard-music/api/home', { origin: 'http://127.0.0.1:9205' })), true)
  assert.equal(allowed(req('/wizard-music/api/home', { 'sec-fetch-site': 'same-origin' })), true)
})
