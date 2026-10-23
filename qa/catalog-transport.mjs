// Synthetic HTTP upstreams; production catalog caller. No Google or user credentials.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createCatalogLookup } from '../server/catalog.mjs'

const video_id = 'W8VdVY8diqs'
const good = { provider: 'youtube-music', catalog_source: 'youtube-data-api', items: [{ id: video_id, title: 'Fixture title' }], audio_verified: false, playback_entitlement: false }
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
async function listen(handler) {
  const server = createServer(handler)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections(); server.close(r) }) }
}
async function fixture(fn, options = {}) {
  let calls = []
  const upstream = await listen(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    calls.push({ path: req.url, headers: req.headers, body })
    fn(req, res)
  })
  const handle = createCatalogLookup({ origin: upstream.origin + '/connectors/', token: 'fixture-adapter-only', ...options })
  const app = await listen((req, res) => handle(req, res, new URL(req.url, 'http://local'), json))
  return { calls, post: async (body = { video_id }, extra = {}) => {
    const r = await fetch(app.origin + (extra.path || '/api/catalog'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer browser-must-not-forward', Cookie: 'owner=must-not-forward' }, body: JSON.stringify(body), ...extra })
    return { status: r.status, body: await r.json() }
  }, close: async () => { await app.close(); await upstream.close() } }
}

test('fixed prefixed URL, typed payload, separate token, sanitized response', async () => {
  const f = await fixture((req, res) => json(res, 200, { ...good, access_token: 'must-not-escape' }))
  try {
    assert.deepEqual(await f.post(), { status: 200, body: good })
    assert.equal(f.calls[0].path, '/connectors/service/music/catalog')
    assert.equal(f.calls[0].headers.authorization, 'Bearer fixture-adapter-only')
    assert.equal(f.calls[0].headers.cookie, undefined)
    assert.deepEqual(JSON.parse(f.calls[0].body), { video_id })
  } finally { await f.close() }
})

test('rejects account, URL, operation, malformed IDs, query and oversized bodies before upstream', async () => {
  const f = await fixture((req, res) => json(res, 200, good))
  try {
    for (const body of [{ video_id, account: 'other' }, { video_id, url: 'https://evil.invalid' }, { video_id, operation: 'fetch' }, { video_id: ' W8VdVY8diqs' }, { video_id: 'https://youtu.be/W8VdVY8diqs' }, { video_id: 12345678901 }, [], null]) {
      assert.equal((await f.post(body)).status, 400)
    }
    assert.equal((await f.post({ video_id }, { path: '/api/catalog?account=other' })).status, 400)
    assert.equal((await f.post({ video_id: 'x'.repeat(2000) })).status, 413)
    assert.equal(f.calls.length, 0)
  } finally { await f.close() }
})

test('preserves denial, reauth and honest unavailable states without forwarding provider details', async () => {
  for (const [status, payload, expected] of [
    [409, { error: 'capability_denied' }, { status: 409, body: { error: 'capability_denied' } }],
    [409, { error: 'reauth_required' }, { status: 409, body: { error: 'reauth_required' } }],
    [401, { error: 'secret-detail' }, { status: 502, body: { error: 'catalog_auth_failed' } }],
    [503, { error: 'secret-detail' }, { status: 502, body: { error: 'catalog_unavailable' } }],
  ]) {
    const f = await fixture((req, res) => json(res, status, payload))
    try { assert.deepEqual(await f.post(), expected) } finally { await f.close() }
  }
})

test('rejects deceptive metadata, mismatched IDs, oversized and stalled upstream bodies', async () => {
  for (const payload of [{ ...good, provider: 'other' }, { ...good, audio_verified: true }, { ...good, playback_entitlement: true }, { ...good, items: [{ id: 'abcdefghijk', title: 'Other' }] }, { ...good, items: null }, { ...good, extra: 'x'.repeat(20000) }]) {
    const f = await fixture((req, res) => json(res, 200, payload))
    try { assert.deepEqual(await f.post(), { status: 502, body: { error: 'catalog_unavailable' } }) } finally { await f.close() }
  }
  const f = await fixture((req, res) => { res.writeHead(200); res.write('{') }, { timeoutMs: 50 })
  try { assert.equal((await f.post()).status, 502) } finally { await f.close() }
})

test('refuses redirects so adapter credentials cannot escape to a second endpoint', async () => {
  let leaks = 0
  const target = await listen((req, res) => { leaks++; json(res, 200, good) })
  const f = await fixture((req, res) => { res.writeHead(307, { Location: target.origin }); res.end() })
  try { assert.equal((await f.post()).status, 502); assert.equal(leaks, 0) } finally { await f.close(); await target.close() }
})

test('empty catalog is not fabricated success and absent configuration is explicit', async () => {
  const f = await fixture((req, res) => json(res, 200, { ...good, items: [] }))
  try { assert.deepEqual((await f.post()).body.items, []) } finally { await f.close() }
  const missing = await fixture((req, res) => json(res, 200, good), { token: '' })
  try { assert.deepEqual(await missing.post(), { status: 503, body: { error: 'catalog_not_configured' } }); assert.equal(missing.calls.length, 0) } finally { await missing.close() }
})
