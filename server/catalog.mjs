// Fixed, server-only caller of Connectors' scoped Music capability.
// Never forwards browser credentials, account selectors, URLs or provider tokens.
export function createCatalogLookup({ origin = '', token = '', timeoutMs = 10_000 } = {}) {
  let endpoint = null
  if (origin) {
    const url = new URL(origin)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Music Connectors URL must be an HTTP(S) origin with optional path prefix')
    }
    url.pathname = url.pathname.replace(/\/$/, '') + '/service/music/catalog'
    endpoint = url
  }
  return async (request, response, url, sendJson) => {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'method' })
    if (url.search) return sendJson(response, 400, { error: 'invalid_request' })
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return sendJson(response, 415, { error: 'json_required' })
    }
    let data
    try {
      let size = 0
      const chunks = []
      for await (const chunk of request) {
        size += chunk.length
        if (size > 1024) return sendJson(response, 413, { error: 'body_too_large' })
        chunks.push(chunk)
      }
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!data || Array.isArray(data) || Object.keys(data).length !== 1 ||
          typeof data.video_id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(data.video_id)) throw new Error('invalid')
    } catch { return sendJson(response, 400, { error: 'invalid_request' }) }
    if (!endpoint || !token) return sendJson(response, 503, { error: 'catalog_not_configured' })
    try {
      const upstream = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ video_id: data.video_id }),
      })
      // Bound the body while reading, not after allocating an unbounded response.
      let size = 0
      const chunks = []
      for await (const chunk of upstream.body) {
        size += chunk.length
        if (size > 16_384) throw new Error('oversize')
        chunks.push(chunk)
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (upstream.status === 409 && result.error === 'capability_denied') {
        return sendJson(response, 409, { error: 'capability_denied' })
      }
      if (upstream.status === 401 || upstream.status === 403) {
        return sendJson(response, 502, { error: 'catalog_auth_failed' })
      }
      if (upstream.status === 409 && result.error === 'reauth_required') {
        return sendJson(response, 409, { error: 'reauth_required' })
      }
      if (!upstream.ok || result.provider !== 'youtube-music' || result.catalog_source !== 'youtube-data-api' ||
          result.audio_verified !== false || result.playback_entitlement !== false || !Array.isArray(result.items) || result.items.length > 1 ||
          result.items.some(item => !item || item.id !== data.video_id || typeof item.title !== 'string' || item.title.length > 2000)) {
        throw new Error('invalid_catalog_response')
      }
      // Project only the typed metadata contract; no upstream extras leave this server.
      return sendJson(response, 200, {
        provider: 'youtube-music', catalog_source: 'youtube-data-api',
        items: result.items.map(({ id, title }) => ({ id, title })), audio_verified: false, playback_entitlement: false,
      })
    } catch { return sendJson(response, 502, { error: 'catalog_unavailable' }) }
  }
}
