#!/usr/bin/env node
// Wizard Music app server: static view + hub proxy, loopback only, behind the private gateway.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { requestAllowed } from './request-policy.mjs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE, createMusicProxy } from './music.mjs'
import { handleMcp } from './mcp.mjs'
import { createCatalogLookup } from './catalog.mjs'

const handleCatalog = createCatalogLookup({ origin: process.env.WIZARD_MUSIC_CONNECTORS_URL || '', token: process.env.MUSIC_ADAPTER_TOKEN || '' })

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.WIZARD_MUSIC_APP_PORT || 9205)
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, ...(process.env.WIZARD_TRUSTED_ORIGINS || '').split(',').filter(Boolean)])
const HOSTS = new Set(['127.0.0.1', 'localhost', ...(process.env.WIZARD_TRUSTED_HOSTS || '').split(',').filter(Boolean)])
const HOST = process.env.WIZARD_MUSIC_APP_HOST || '127.0.0.1'
const configured = Boolean(process.env.WIZARD_MUSIC_HUB_ORIGIN && process.env.WIZARD_MUSIC_HUB_TOKEN)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' }
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"

const handleMusic = createMusicProxy({ origin: process.env.WIZARD_MUSIC_HUB_ORIGIN || '', token: process.env.WIZARD_MUSIC_HUB_TOKEN || '' })

function sendJson(response, status, value) {
  const raw = Buffer.from(JSON.stringify(value))
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': raw.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(raw)
}

async function serveStatic(response, sub, head) {
  let rel = normalize(decodeURIComponent(sub)).replace(/^([/\\])+/, '')
  if (!rel || rel.endsWith('/')) rel += 'index.html'
  const file = resolve(DIST, rel)
  if (!file.startsWith(DIST + '/')) { sendJson(response, 404, { error: 'not_found' }); return }
  let target = file
  try { if (!(await stat(target)).isFile()) throw new Error('dir') } catch { sendJson(response, 404, { error: 'not_found' }); return }
  const raw = await readFile(target)
  const immutable = target.includes(`${DIST}/assets/`)
  response.writeHead(200, {
    'Content-Type': TYPES[extname(target)] || 'application/octet-stream', 'Content-Length': raw.length,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'same-origin',
  })
  response.end(head ? undefined : raw)
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://local')
    if (!requestAllowed(request, { hosts: HOSTS, origins: ORIGINS })) { sendJson(response, 403, { error: 'origin' }); return }
    if (url.pathname === '/health' || url.pathname === `${BASE}/api/status`) { sendJson(response, 200, { ok: true, app: 'wizard-music', version: '0.2.0-test.1', configured, setup: configured ? 'ready' : 'backend-unavailable' }); return }
    if (url.pathname === '/mcp') { await handleMcp(request, response, sendJson, PORT); return }
    if (url.pathname === BASE) { response.writeHead(308, { Location: `${BASE}/` }); response.end(); return }
    if (!url.pathname.startsWith(`${BASE}/`)) { sendJson(response, 404, { error: 'not_found' }); return }
    const sub = url.pathname.slice(BASE.length)

    if (sub === '/api/catalog') {
      const consent = await fetch(`${process.env.WIZARD_MUSIC_HUB_ORIGIN}/api/settings`, { headers: { Authorization: `Bearer ${process.env.WIZARD_MUSIC_HUB_TOKEN}` }, signal: AbortSignal.timeout(3000) }).then(r => r.json())
      if (!consent.online) { sendJson(response, 403, { error: 'online_sources_disabled' }); return }
      await handleCatalog(request, response, url, sendJson); return
    }
    if (/^\/(api|stream|art)\//.test(sub)) { await handleMusic(request, response, url, sendJson); return }
    if (request.method !== 'GET' && request.method !== 'HEAD') { sendJson(response, 405, { error: 'method' }); return }
    await serveStatic(response, sub, request.method === 'HEAD')
  } catch {
    if (!response.headersSent) sendJson(response, 500, { error: 'server' })
    else response.destroy()
  }
})
server.listen(PORT, HOST, () => console.log(`wizard-music on ${HOST}:${PORT}${BASE}/`))
