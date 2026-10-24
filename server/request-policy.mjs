// The authenticated gateway preserves Host (or sets X-Forwarded-Host/Proto).
// Forwarding headers are accepted only from a private/loopback peer, never a public peer.
export function requestAllowed(req, { hosts = new Set(), origins = new Set() } = {}) {
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
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  if (origin) return origins.has(origin) || origin === `${proto}://${authority}`
  // Read/navigation and box-only MCP do not send Origin. JSON is still required for writes.
  return privatePeer || hosts.has(hostname)
}
