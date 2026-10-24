// Wizard Music: same-origin proxy from the Music app to the owner's music hub.
//
// The hub (Wizard Home / Mac mini) aggregates every music source — YouTube Music,
// the owner's file library, later more — and is reached over a loopback tunnel.
// This server adds the hub bearer token; the browser and APK never see it.
// The hub speaks in /wizard/music/... paths; API responses are rewritten to this
// app's own base so streams, art and station refills stay same-origin.
import { request as httpRequest } from 'node:http'

export const BASE = '/wizard-music'
const HUB_PREFIX = '/wizard/music/'
const API_GET = /^\/api\/(home|settings|scores|search|station\/[a-f0-9]{16}\/more)$/
const API_POST = /^\/api\/(settings|station|feedback|scan|play|keep|mixes)$/
const MEDIA = /^\/(stream|art)\/((?:yt|lib)(?::|%3A)[A-Za-z0-9_-]{1,40})$/
const FORWARD_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'last-modified']

/** Path inside the app (after BASE), or null when the request is not a music API/media path. */
export function musicRoute(method, sub) {
  if ((method === 'GET' || method === 'HEAD') && API_GET.test(sub)) return 'api'
  if (method === 'POST' && API_POST.test(sub)) return 'api'
  if ((method === 'GET' || method === 'HEAD') && MEDIA.test(sub)) return 'media'
  return null
}

export function rewriteHubPaths(text, base = BASE) {
  return text.split(JSON.stringify(HUB_PREFIX).slice(1, -1)).join(`${base}/`).split(HUB_PREFIX).join(`${base}/`)
}

/** @param {{ origin?: string, token?: string, timeoutMs?: number, base?: string }} [options] */
export function createMusicProxy({ origin = '', token = '', timeoutMs = 150_000, base: appBase = BASE } = {}) {
  const hub = origin ? new URL(origin) : null
  if (hub && (hub.protocol !== 'http:' || hub.hostname !== '127.0.0.1' || hub.pathname !== '/' || hub.search || hub.username)) {
    throw new Error('Wizard Music hub must be an exact loopback HTTP origin')
  }
  const configured = Boolean(hub && token)

  return async function handleMusic(request, response, url, sendJson) {
    if (!configured) { sendJson(response, 503, { error: 'music_unavailable' }); return }
    const sub = url.pathname.slice(appBase.length)
    const route = musicRoute(request.method ?? 'GET', sub)
    if (!route) { sendJson(response, 404, { error: 'not_found' }); return }
    const upstreamPath = sub + (sub === '/api/search' || sub.endsWith('/more') ? url.search : '')
    const headers = { Authorization: `Bearer ${token}`, Accept: route === 'api' ? 'application/json' : '*/*' }
    if (request.headers.range && route === 'media') headers.Range = String(request.headers.range).slice(0, 100)
    let body = null
    if (request.method === 'POST') {
      const type = String(request.headers['content-type'] ?? '').toLowerCase()
      if (!type.startsWith('application/json')) { sendJson(response, 415, { error: 'json_required' }); return }
      headers['Content-Type'] = 'application/json'
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 65_536) { sendJson(response, 413, { error: 'body_too_large' }); return }
        chunks.push(chunk)
      }
      body = Buffer.concat(chunks)
      headers['Content-Length'] = String(body.length)
    }
    await new Promise((done) => {
      const upstream = httpRequest({ host: hub.hostname, port: hub.port, method: request.method, path: upstreamPath, headers }, (up) => {
        const out = { 'X-Content-Type-Options': 'nosniff' }
        for (const name of FORWARD_HEADERS) if (up.headers[name]) out[name] = up.headers[name]
        if (route === 'media') {
          response.writeHead(up.statusCode ?? 502, out)
          up.pipe(response)
          up.once('end', done)
          up.once('error', () => { response.destroy(); done() })
          return
        }
        const chunks = []
        up.on('data', (chunk) => chunks.push(chunk))
        up.once('error', () => { response.destroy(); done() })
        up.once('end', () => {
          const text = rewriteHubPaths(Buffer.concat(chunks).toString('utf8'), appBase)
          const raw = Buffer.from(text)
          delete out['content-length']
          out['content-type'] = up.headers['content-type'] || 'application/json'
          out['cache-control'] = 'no-store'
          out['content-length'] = String(raw.length)
          response.writeHead(up.statusCode ?? 502, out)
          response.end(request.method === 'HEAD' ? undefined : raw)
          done()
        })
      })
      upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error('music hub timeout')))
      upstream.once('error', () => {
        if (!response.headersSent) sendJson(response, 502, { error: 'music_unavailable' })
        else response.destroy()
        done()
      })
      response.once('close', () => { if (!response.writableEnded) upstream.destroy() })
      upstream.end(body ?? undefined)
    })
  }
}
