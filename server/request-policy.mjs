// The authenticated gateway preserves Host (or sets X-Forwarded-Host/Proto).
// Forwarding headers are accepted only from a private/loopback peer, never a public peer.
// `asset: true` (see publicAsset) lets the app's own public files load into its sandboxed frame.
export function requestAllowed(req, { hosts = new Set(), origins = new Set(), asset = false } = {}) {
  const host = String(req.headers.host || '')
  const peer = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
  const privatePeer = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(peer) || peer === '::1'
  let authority = host, proto = req.socket?.encrypted ? 'https' : 'http'
  if (privatePeer && req.headers['x-forwarded-host']) authority = String(req.headers['x-forwarded-host'])
  if (privatePeer && /^(http|https)$/.test(String(req.headers['x-forwarded-proto']))) proto = String(req.headers['x-forwarded-proto'])
  if (!authority || /[\s,/@\\]/.test(authority)) return false
  let hostname
  try { hostname = new URL(`${proto}://${authority}`).hostname } catch { return false }
  const origin = req.headers.origin
  if (!asset) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    if (origin) return origins.has(origin) || origin === `${proto}://${authority}`
  }
  // Read/navigation and box-only MCP do not send Origin. JSON is still required for writes.
  return privatePeer || hosts.has(hostname)
}

// Under the shell's browser boundary (wizard-os#133) Music runs in a sandboxed frame with an opaque origin. The
// browser then fetches the app's files as cross-site: the module script and its stylesheet with `Origin: null` (CORS),
// the other files with no Origin. Only the app's own public files may load that way: GET/HEAD of a script, style,
// picture, font or manifest under the app's base. Never the page itself, the API, streams or art (the shell carries
// the page's own calls), and never a request from a real other site. The host rule above still applies.
export const ASSET = /\.(js|css|svg|png|webmanifest|woff2?)$/
export function publicAsset(req, pathname, base) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const origin = req.headers.origin
  if (origin !== undefined && origin !== 'null') return false
  if (!pathname.startsWith(`${base}/`)) return false
  const sub = pathname.slice(base.length)
  if (/^\/(api|stream|art)\//i.test(sub) || /%2f|%5c/i.test(sub)) return false
  return ASSET.test(sub)
}
