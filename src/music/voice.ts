// Voice control from the Wizard OS orb.
//
// The shell parses what the listener said on the phone (no router round trip) and posts one command into
// this frame: {type:'wizard-os:music', id, cmd}. We acknowledge at once, act through the same engine
// and feedback paths as the buttons, and answer {type:'wizard-os:music:done', id, ok, text} so the
// orb can say what happened ("Playing Trap · Gui Boratto"). A plain {type:'wizard-os:voice', text}
// (a view-routed utterance) is parsed here with the same grammar.
import { musicApi, musicControl, thumbsDown } from './MusicApp'

export type MusicCommand =
  | { op: 'play'; said: string }
  | { op: 'search'; query: string }
  | { op: 'pause' | 'resume' | 'toggle' | 'next' | 'previous' | 'like' | 'dislike' | 'what' }
  | { op: 'volume'; dir: 'up' | 'down' | 'mute' | 'unmute' | 'set'; level?: number }
export type MusicResult = { ok: boolean; text: string; volume?: number }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9ก-๙ ]+/g, ' ').replace(/\s+/g, ' ').trim()
const MUSIC = '(?: the)?(?: music| song| track| tune| playback| it| this)?'
const FIND = '(?:search|find|look up|look for)(?: for)?(?: me)?'
// The spell, said anywhere: "music search Home Tides" (also "search music for …", "search … in music",
// "open music and search for …"). It opens Wizard Music and lists the results; nothing plays.
const SPELL = [
  new RegExp(`^(?:open )?(?:wizard )?music(?: and| then)? ${FIND} (.+)$`),
  new RegExp(`^(?:search|find|look up|look for) (?:wizard |my )?music(?: for)? (.+)$`),
  new RegExp(`^${FIND} (.+?) (?:in|on) (?:wizard |my )?music$`),
]
const PLAIN_FIND = new RegExp(`^${FIND} (.+)$`)

/** The words as the listener said them (case kept) for the query the normalised grammar found. */
export function asSaid(text: string, found: string): string {
  const words = found.split(' ').filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!words.length) return found
  const m = String(text).match(new RegExp(words.join('[^a-z0-9ก-๙]+'), 'i'))
  return m ? m[0] : found
}

/** "music search X" anywhere; plain "search for X" only in front of Wizard Music. */
export function parseMusicSearch(text: string, inMusic = false): string | null {
  const s = norm(text).replace(/^(?:hey |ok |okay )?(?:wizard|archimedes)\s*/, '').replace(/ (?:please|for me|now)$/, '').replace(/^(?:(?:can|could|would|will) you |please |maybe |just |go ahead and )+/, '')
  for (const rx of SPELL) { const m = s.match(rx); if (m) return asSaid(text, m[1]) }
  const m = inMusic ? s.match(PLAIN_FIND) : null
  return m ? asSaid(text, m[1]) : null
}

/** The music grammar, shared with the shell's copy in web/core/music-voice.js. Null = not a music command. */
export function parseMusicCommand(text: string, inMusic = false): MusicCommand | null {
  const s = norm(text).replace(/^(?:hey |ok |okay )?(?:wizard|archimedes)\s*/, '').replace(/ (?:please|for me|now)$/, '').replace(/^(?:(?:can|could|would|will) you |please |maybe |just |go ahead and )+/, '')
  if (!s) return null
  const query = parseMusicSearch(text, inMusic)
  if (query) return { op: 'search', query }
  if (new RegExp(`^(?:pause|stop|hold)${MUSIC}$|^(?:shut up|silence)$`).test(s)) return { op: 'pause' }
  if (new RegExp(`^(?:resume|unpause|continue|keep playing|play again)${MUSIC}$|^play$`).test(s)) return { op: 'resume' }
  if (/^(?:next|skip)(?: song| track| one| this(?: song| track| one)?| it| that)?$|^(?:play )?(?:the )?next (?:song|track|one)$/.test(s)) return { op: 'next' }
  if (/^(?:previous|last)(?: song| track| one)$|^previous$|^go back a (?:song|track)$|^play (?:the )?(?:previous|last) (?:song|track|one)$/.test(s)) return { op: 'previous' }
  if (/^(?:turn (?:it|this|the (?:music|volume|sound)) up|turn up(?: the (?:music|volume|sound))?|volume up|louder|(?:a bit |a little |make it |little )louder|crank it(?: up)?|raise the volume|more volume|pump it up)$/.test(s)) return { op: 'volume', dir: 'up' }
  if (/^(?:turn (?:it|this|the (?:music|volume|sound)) down|turn down(?: the (?:music|volume|sound))?|volume down|quieter|softer|(?:a bit |a little |make it |little )(?:quieter|softer)|lower the volume|less volume)$/.test(s)) return { op: 'volume', dir: 'down' }
  if (new RegExp(`^mute${MUSIC}$`).test(s)) return { op: 'volume', dir: 'mute' }
  if (new RegExp(`^unmute${MUSIC}$`).test(s)) return { op: 'volume', dir: 'unmute' }
  let m = s.match(/^(?:set )?(?:the )?volume (?:to |at )?(\d{1,3})(?: percent)?$/)
  if (m) return { op: 'volume', dir: 'set', level: Math.min(100, Number(m[1])) / 100 }
  if (/^(?:i (?:really )?(?:like|love) (?:this|it|that)(?: song| track| one)?|(?:like|love) (?:this|it)(?: song| track)?|thumbs up|save (?:this|it)(?: song| track)?|more like this)$/.test(s)) return { op: 'like' }
  if (/^(?:i (?:don t|do not|dont) (?:like|want) (?:this|it|that)(?: song| track| one)?|thumbs down|dislike(?: this| it)?(?: song| track)?|i hate (?:this|it)(?: song| track)?|not this(?: song| one)?|no more of this|less like this)$/.test(s)) return { op: 'dislike' }
  if (/^(?:what s|what is|whats) (?:this|playing|this song|the song|this track)$|^what song is (?:this|playing)$|^who (?:is|s) (?:this|singing|playing)$/.test(s)) return { op: 'what' }
  m = s.match(/^(?:play|put on|throw on|queue up|shuffle|blast|spin|listen to|i want to (?:hear|listen to)|i wanna (?:hear|listen to)|let s (?:hear|listen to))\b\s*(.*)$/)
  if (m) return { op: 'play', said: text }
  // In front of Wizard Music a held orb is a music request: "Guy Barato Trap" means play it.
  if (inMusic) return { op: 'play', said: text }
  return null
}

const nowTrack = () => { const snap = musicControl.engine()?.snapshot(); return snap ? snap.queue[snap.index] : undefined }

export async function runMusicCommand(cmd: MusicCommand, notify: (message: string) => void): Promise<MusicResult> {
  const engine = musicControl.engine()
  const current = nowTrack()
  switch (cmd.op) {
    case 'play': {
      // "play" / "play music" with something already loaded carries on; anything named is searched.
      if (current && !norm(cmd.said).replace(/^(?:play|put on|resume)\b/, '').replace(/\b(?:the |some |my )?(?:music|songs?|tunes?)\b/g, '').trim()) {
        engine?.play()
        return { ok: true, text: `Playing ${current.title}` }
      }
      notify(`Finding “${cmd.said.replace(/^\s*(?:play|put on)\s+/i, '').replace(/[.!?]+$/, '')}”…`)
      const found = await musicApi.play(cmd.said)
      if (!found.tracks?.length) return { ok: false, text: 'Couldn’t find that.' }
      await musicControl.play(found.tracks, found.station)
      const text = `Playing ${found.heard}`
      notify(text)
      return { ok: true, text }
    }
    case 'search': {
      // Show the list and let the listener pick; never play the first hit.
      const n = await musicControl.search(cmd.query)
      return n ? { ok: true, text: `${n} result${n === 1 ? '' : 's'} for “${cmd.query}”` } : { ok: false, text: `Nothing matched “${cmd.query}”` }
    }
    case 'pause':
      if (!current) return { ok: false, text: 'Nothing is playing.' }
      engine?.pause(); return { ok: true, text: 'Paused' }
    case 'resume':
    case 'toggle':
      if (!current) return runMusicCommand({ op: 'play', said: 'play music' }, notify)
      if (cmd.op === 'toggle' && engine?.snapshot().playing) { engine.pause(); return { ok: true, text: 'Paused' } }
      engine?.play(); return { ok: true, text: `Playing ${current.title}` }
    case 'next': {
      if (!current || !engine) return { ok: false, text: 'Nothing is playing.' }
      void musicControl.feedback(current.id, 'skipped').catch(() => undefined)
      engine.next()
      const next = nowTrack()
      return { ok: true, text: next && next.id !== current.id ? `Next: ${next.title} · ${next.artist}` : 'Skipped' }
    }
    case 'previous': {
      if (!current || !engine) return { ok: false, text: 'Nothing is playing.' }
      engine.previous()
      const back = nowTrack()
      return { ok: true, text: back && back.id !== current.id ? `Back to ${back.title}` : `Restarted ${current.title}` }
    }
    case 'volume': {
      if (!engine) return { ok: false, text: 'Nothing is playing.' }
      const was = engine.volume()
      const to = cmd.dir === 'up' ? was + 0.2 : cmd.dir === 'down' ? was - 0.2 : cmd.dir === 'mute' ? 0 : cmd.dir === 'unmute' ? Math.max(was, 0.6) : cmd.level ?? was
      engine.setVolume(to)
      const pct = Math.round(engine.volume() * 100)
      return { ok: true, text: pct === 0 ? 'Muted' : `Music volume ${pct}%`, volume: engine.volume() }
    }
    case 'like':
      if (!current) return { ok: false, text: 'Nothing is playing.' }
      if (!current.liked) await musicControl.feedback(current.id, 'like')
      return { ok: true, text: `Liked ${current.title}` }
    case 'dislike':
      if (!current) return { ok: false, text: 'Nothing is playing.' }
      thumbsDown(current, notify)
      return { ok: true, text: `Skipped. No more like ${current.artist}` }
    case 'what':
      return current ? { ok: true, text: `${current.title} · ${current.artist}` } : { ok: false, text: 'Nothing is playing.' }
  }
}

type Incoming = { type?: string; id?: string; cmd?: MusicCommand; text?: string }

/** Listen for orb commands from the Wizard OS shell (same origin only). */
export function installMusicVoice(notify: (message: string) => void): () => void {
  if (typeof window === 'undefined' || window.parent === window) return () => undefined
  const reply = (value: Record<string, unknown>) => { try { window.parent.postMessage(value, window.location.origin) } catch { /* shell gone */ } }
  const onMessage = (event: MessageEvent<Incoming>) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return
    const data = event.data || {}
    let cmd: MusicCommand | null = null
    if (data.type === 'wizard-os:music' && data.cmd && typeof data.cmd.op === 'string') cmd = data.cmd
    else if (data.type === 'wizard-os:voice' && typeof data.text === 'string') cmd = parseMusicCommand(data.text, true)
    if (!cmd) return
    if (data.id) reply({ type: 'wizard-os:music:ack', id: data.id })
    // The orb shows the outcome; the app stays quiet until then (a late "Got it — no more …" still shows here).
    let settled = false
    const quiet = (message: string) => { if (settled || !data.id) notify(message) }
    runMusicCommand(cmd, quiet)
      .then((result) => { settled = true; reply({ type: 'wizard-os:music:done', id: data.id || '', ...result }) })
      .catch((error: Error) => { settled = true; reply({ type: 'wizard-os:music:done', id: data.id || '', ok: false, text: error.message || 'Your music hub did not answer.' }) })
  }
  window.addEventListener('message', onMessage)
  reply({ type: 'wizard-os:music:ready' })
  return () => window.removeEventListener('message', onMessage)
}
