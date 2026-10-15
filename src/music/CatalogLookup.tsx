import { useEffect, useRef, useState } from 'react'
import type { MusicTrack } from './engine'

const BASE = new URL('./', document.baseURI).pathname
const ERRORS: Record<string, string> = {
  capability_denied: 'No Music catalog account is bound. Link Google and bind Music in Connectors, then retry.',
  reauth_required: 'Google needs reconnecting in Connectors. Catalog lookup is unavailable.',
  catalog_not_configured: 'Connected catalog lookup is not configured on this Wizard.',
  catalog_auth_failed: 'Catalog connection authorization failed. Ask your administrator to check the Music adapter token.',
}

/** Metadata only: deliberately does not call the player or modify its queue. */
export function CatalogLookup({ track }: { track: MusicTrack }) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => active.current?.abort(), [])
  if (track.source !== 'youtube' || !/^yt:[A-Za-z0-9_-]{11}$/.test(track.id)) return null
  const lookup = async () => {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setMessage('Checking the selected track through your connected Google account…')
    try {
      const response = await fetch(BASE + 'api/catalog', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_id: track.id.slice(3) }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(ERRORS[result.error] || 'Connected catalog lookup is unavailable. Try again later.')
      setMessage(result.items.length
        ? `Connected catalog result: ${result.items[0].title}. Source: YouTube Data API.`
        : 'Connected catalog lookup completed, but no item was returned for this track.')
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error && Object.values(ERRORS).includes(error.message) ? error.message : 'Connected catalog lookup is unavailable. Try again later.')
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <div className="music-catalog">
    <button type="button" className="music-chip" disabled={busy} onClick={() => void lookup()} aria-label={`Check connected catalog: ${track.title}`}>{busy ? 'Checking catalog…' : 'Check connected catalog'}</button>
    {message && <div className="music-status" role="status"><p>{message}</p><p>Metadata only — audio is not verified and no playback entitlement is granted. Existing playback is separate; anonymous playback is not signed in by this lookup.</p></div>}
  </div>
}
