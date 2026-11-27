// Subsonic for phone music apps (wizard-music#92, on for everyone).
//
// Navidrome (stock image, runtipi/docker-compose.yml) answers only on Music's own Docker network. A Subsonic app on the
// owner's phone (Symfonium, Substreamer, play:Sub, Amperfy, ...) reaches it here, at <this address>/wizard-music, so it
// is reachable only where Music itself is: on the tailnet, behind the Wizard gateway. Only /rest/* (the Subsonic API)
// is passed on, never Navidrome's own web pages.
//
// Tailscale is the lock, as for Photos: a request carrying the owner's tailnet login is signed in as Music's one
// Navidrome user (Navidrome trusts the user header from Music's network only), whatever name and password the app
// sends. Without the owner's login Navidrome's own sign-in applies, and nobody knows that password.
import { request as httpRequest } from 'node:http'

export const SUBSONIC = /^\/rest\/[A-Za-z0-9]{1,40}(?:\.view)?$/
export const USER_HEADER = 'x-wizard-navidrome-user'
const USER = 'wizard'
const PASS_REQUEST = ['range', 'accept', 'accept-encoding', 'content-type', 'content-length', 'user-agent', 'if-none-match', 'if-modified-since']
const PASS_RESPONSE = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'last-modified', 'etag', 'content-encoding', 'content-disposition', 'x-content-duration']

/** The owner's tailnet login (Tailscale Serve sets it), and in WIZARD_OWNER_LOGINS when that names owners. */
export function tailnetOwner(req, owners = process.env.WIZARD_OWNER_LOGINS || '') {
  const login = req.headers['tailscale-user-login']
  if (typeof login !== 'string' || !login.includes('@') || login.includes(',')) return false
  const allowed = new Set(owners.split(',').map(x => x.trim().toLowerCase()).filter(Boolean))
  return !allowed.size || allowed.has(login.trim().toLowerCase())
}

/** Where a phone app finds this Music: the address this request came in on, plus the app's base. */
export function serverAddress(req, base) {
  const peer = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
  const privatePeer = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(peer) || peer === '::1'
  const host = String((privatePeer && req.headers['x-forwarded-host']) || req.headers.host || '').split(',')[0].trim()
  const fwd = String(req.headers['x-forwarded-proto'] || '')
  const proto = privatePeer && /^(http|https)$/.test(fwd) ? fwd : (req.socket?.encrypted || /\.ts\.net(:\d+)?$/i.test(host) ? 'https' : 'http')
  return host && !/[\s/@\\]/.test(host) ? `${proto}://${host}${base}` : ''
}

/** @param {{ origin?: string, base: string }} options */
export function createSubsonicProxy({ origin = '', base }) {
  const upstream = origin ? new URL(origin) : null   // e.g. http://navidrome:4533/wizard-music (ND_BASEURL = base)
  return async function handleSubsonic(request, response, url, sendJson) {
    if (!upstream) { sendJson(response, 503, { error: 'navidrome_not_bundled' }); return }
    const method = request.method || 'GET'
    if (!['GET', 'HEAD', 'POST'].includes(method)) { sendJson(response, 405, { error: 'method' }); return }
    const headers = {}
    for (const name of PASS_REQUEST) if (request.headers[name]) headers[name] = String(request.headers[name]).slice(0, 1000)
    if (tailnetOwner(request)) headers[USER_HEADER] = USER   // never the client's own copy of this header
    let body
    if (method === 'POST') {
      const chunks = []; let size = 0
      for await (const chunk of request) { size += chunk.length; if (size > 65_536) { sendJson(response, 413, { error: 'body_too_large' }); return } chunks.push(chunk) }
      body = Buffer.concat(chunks)
      headers['content-length'] = String(body.length)
    }
    const path = `${upstream.pathname.replace(/\/$/, '')}${url.pathname.slice(base.length)}${url.search}`
    await new Promise((done) => {
      const up = httpRequest({ host: upstream.hostname, port: upstream.port || 80, method, path, headers }, (res) => {
        const out = { 'X-Content-Type-Options': 'nosniff' }
        for (const name of PASS_RESPONSE) if (res.headers[name]) out[name] = res.headers[name]
        response.writeHead(res.statusCode || 502, out)
        res.pipe(response)
        res.once('end', done)
        res.once('error', () => { response.destroy(); done() })
      })
      up.setTimeout(120_000, () => up.destroy(new Error('navidrome timeout')))
      up.once('error', () => { if (!response.headersSent) sendJson(response, 502, { error: 'navidrome_unavailable' }); else response.destroy(); done() })
      response.once('close', () => { if (!response.writableEnded) up.destroy() })
      up.end(body)
    })
  }
}
