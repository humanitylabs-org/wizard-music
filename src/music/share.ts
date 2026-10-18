import type { MusicTrack } from './engine'

export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'unsupported'
export type SongShare = { title: string; text: string; url?: string }

/** A public link for the song, when it has one. Library files on your Wizard have none. */
export function songUrl(track: MusicTrack): string | undefined {
  const yt = /^yt:([A-Za-z0-9_-]{11})$/.exec(track.id)
  return yt ? `https://music.youtube.com/watch?v=${yt[1]}` : undefined
}

/** What the share sheet carries: the same shape as sharing from a chat, signed by Wizard Music. */
export function songShare(track: MusicTrack): SongShare {
  const song = [track.title, track.artist].filter(Boolean).join(' — ')
  const url = songUrl(track)
  return { title: song, text: `From Wizard Music:\n\n${song}`, ...(url ? { url } : {}) }
}

/** Open the platform share sheet. Call straight from the tap so the gesture is still live. */
export async function shareSong(track: MusicTrack, notify: (message: string) => void): Promise<ShareOutcome> {
  const share = typeof window !== 'undefined' ? window.WizardApp?.share : undefined
  let outcome: ShareOutcome = 'unsupported'
  try { outcome = share ? await share.text(songShare(track)) : 'unsupported' } catch { outcome = 'unsupported' }
  if (outcome === 'copied') notify('Copied · sharing isn’t available here')
  else if (outcome === 'unsupported') notify('Couldn’t share this song')
  return outcome
}
