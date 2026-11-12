// Media tickets for Music in a sandboxed frame (the shell's browser boundary, wizard-os#133).
//
// Under the boundary Music's page has an opaque origin. The shell carries its API calls, but an <img> (album art) or
// <audio> (a song, an Identify clip) loads straight from the frame: cross-site, with no Origin and no Referer, so it
// looks exactly like the same tag on any other site and request-policy refuses it. Music therefore signs every art
// and stream address in the API answers it gives the owner (those calls already passed the owner checks): a short
// HMAC bound to that one path, valid for about a week. A media load that carries a valid ticket for its own path may
// skip the same-site rule; the host rule still applies. Nothing else does: no API, no page, no write, no other path.
// The key comes from the persisted hub token, so tickets survive a restart or an update.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const DAY = 86_400
const MEDIA_PATH = /^\/(?:(?:stream|art)\/(?:yt|lib)(?::|%3A)[A-Za-z0-9_-]{1,40}|api\/identify\/(?:captures\/[a-f0-9-]{36}\/audio|candidates\/[0-9]+\/media))$/

function escape(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** @param {{ secret?: string, base: string, now?: () => number }} options */
export function createMediaTickets({ secret = '', base, now = () => Date.now() }) {
  const key = secret ? createHmac('sha256', secret).update('wizard-music media ticket v1').digest() : randomBytes(32)
  const sign = (path, exp) => createHmac('sha256', key).update(`${exp}\n${path}`).digest('base64url').slice(0, 22)
  const inBody = new RegExp(`(${escape(base)}/(?:(?:stream|art)/(?:yt|lib)(?::|%3A)[A-Za-z0-9_-]{1,40}|api/identify/(?:captures/[a-f0-9-]{36}/audio|candidates/[0-9]+/media)))(["?])`, 'g')

  /** A ticket for one media path; it changes once a day so the browser can keep caching art. */
  function ticket(path) {
    const exp = (Math.floor(now() / 1000 / DAY) + 8) * DAY
    return `${exp.toString(36)}.${sign(path, exp)}`
  }

  return {
    ticket,
    /** Adds `t=<ticket>` to every art and stream address in an API answer (JSON text, paths already on `base`). */
    addTickets(text) {
      return text.replace(inBody, (_, path, next) => `${path}?t=${ticket(path)}${next === '?' ? '&' : next}`)
    },
    /** True for a GET/HEAD media load of one of Music's own art or stream paths with a valid ticket for that path. */
    valid(req, url) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false
      const origin = req.headers.origin
      if (origin !== undefined && origin !== 'null') return false
      if (!url.pathname.startsWith(`${base}/`) || !MEDIA_PATH.test(url.pathname.slice(base.length))) return false
      const all = url.searchParams.getAll('t')
      if (all.length !== 1) return false
      const match = /^([0-9a-z]{1,10})\.([A-Za-z0-9_-]{22})$/.exec(all[0])
      if (!match) return false
      const exp = parseInt(match[1], 36), seconds = now() / 1000
      if (!(exp > seconds) || exp > seconds + 9 * DAY) return false
      const want = Buffer.from(sign(url.pathname, exp)), got = Buffer.from(match[2])
      return want.length === got.length && timingSafeEqual(want, got)
    },
  }
}
