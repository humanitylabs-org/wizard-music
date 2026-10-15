// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebEngine, resetMusicEngineForTests, type MusicTrack } from '../src/music/engine'
import { parseMusicCommand, runMusicCommand } from '../src/music/voice'

const track = (n: number, artist = 'A'): MusicTrack => ({ id: `yt:t${n}`, title: `Track ${n}`, artist, album: '', durationMs: 1000, source: 'youtube', art: `/wizard-music/art/yt:t${n}`, stream: `/wizard-music/stream/yt:t${n}` })

class FakeAudio extends EventTarget {
  src = ''
  paused = true
  ended = false
  currentTime = 0
  duration = 1
  preload = ''
  volume = 1
  play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve() }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
  removeAttribute(name: string) { if (name === 'src') this.src = '' }
}

describe('music voice grammar', () => {
  it.each([
    ['Play music Guy Barato Trap.', { op: 'play', said: 'Play music Guy Barato Trap.' }],
    ['Play music, Guy Barato trap.', { op: 'play', said: 'Play music, Guy Barato trap.' }],
    ['put on some bonobo', { op: 'play', said: 'put on some bonobo' }],
    ['Pause the music.', { op: 'pause' }],
    ['stop', { op: 'pause' }],
    ['Resume', { op: 'resume' }],
    ['Next song.', { op: 'next' }],
    ['skip this', { op: 'next' }],
    ['previous song', { op: 'previous' }],
    ['Turn it up.', { op: 'volume', dir: 'up' }],
    ['louder', { op: 'volume', dir: 'up' }],
    ['turn the music down', { op: 'volume', dir: 'down' }],
    ['volume 30', { op: 'volume', dir: 'set', level: 0.3 }],
    ['mute', { op: 'volume', dir: 'mute' }],
    ['I like this song', { op: 'like' }],
    ['thumbs down', { op: 'dislike' }],
    ["what's this song", { op: 'what' }],
  ])('%s', (said, cmd) => expect(parseMusicCommand(said)).toEqual(cmd))

  it('leaves non-music commands alone outside the music app', () => {
    expect(parseMusicCommand('open the calendar')).toBe(null)
    expect(parseMusicCommand('Guy Barato Trap')).toBe(null)
  })
  it('in front of Wizard Music anything else is a play request', () => {
    expect(parseMusicCommand('Guy Barato Trap', true)).toEqual({ op: 'play', said: 'Guy Barato Trap' })
  })
  // Explicit search requests must list results instead of auto-playing the first hit.
  it('in front of Wizard Music, "search for X" is a search (never a play)', () => {
    expect(parseMusicCommand('Search for Home Tides.', true)).toEqual({ op: 'search', query: 'Home Tides' })
    expect(parseMusicCommand('find bonobo', true)).toEqual({ op: 'search', query: 'bonobo' })
    expect(parseMusicCommand('look up Kerri Chandler', true)).toEqual({ op: 'search', query: 'Kerri Chandler' })
  })
  it.each([
    ['Music search Home Tides.', 'Home Tides'],
    ['Music, search for Home Tides', 'Home Tides'],
    ['search music for Home Tides', 'Home Tides'],
    ['Search Home Tides in music', 'Home Tides'],
    ['Open Wizard Music and search for Home Tides.', 'Home Tides'],
    ['open music, search home tides', 'home tides'],
  ])('spell "%s" searches anywhere', (said, query) => expect(parseMusicCommand(said)).toEqual({ op: 'search', query }))
  it('plain "search for X" outside Wizard Music is not ours', () => {
    expect(parseMusicCommand('search for Home Tides')).toBe(null)
  })
})

describe('music voice commands drive the player', () => {
  afterEach(() => { resetMusicEngineForTests(null); vi.unstubAllGlobals() })

  it('play <what was heard> asks the hub and starts its station', async () => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response(JSON.stringify({ kind: 'song', heard: 'Trap · Gui Boratto', station: { id: '0123456789abcdef', title: 'Trap radio', more: '/wizard-music/api/station/0123456789abcdef/more' }, tracks: [track(1, 'Gui Boratto'), track(2)] }), { status: 200 })
    }))
    const audio = new FakeAudio()
    resetMusicEngineForTests(new WebEngine(audio as unknown as HTMLAudioElement, vi.fn() as unknown as typeof fetch))
    const notes: string[] = []
    const result = await runMusicCommand({ op: 'play', said: 'Play music Guy Barato Trap.' }, (m) => notes.push(m))
    expect(calls[0].url).toMatch(/api\/play$/)
    expect(calls[0].body).toEqual({ said: 'Play music Guy Barato Trap.' })
    expect(result).toEqual({ ok: true, text: 'Playing Trap · Gui Boratto' })
    expect(audio.src).toMatch(/stream\/yt:t1$/)
    expect(audio.paused).toBe(false)
  })

  it('pause, resume, next and volume act on what is playing', async () => {
    const audio = new FakeAudio()
    const engine = new WebEngine(audio as unknown as HTMLAudioElement, vi.fn() as unknown as typeof fetch)
    resetMusicEngineForTests(engine)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ kind: 'song', heard: 'x', station: null, tracks: [track(1), track(2), track(3)] }), { status: 200 })))
    await runMusicCommand({ op: 'play', said: 'play something' }, () => undefined)
    expect((await runMusicCommand({ op: 'pause' }, () => undefined)).text).toBe('Paused')
    expect(audio.paused).toBe(true)
    await runMusicCommand({ op: 'resume' }, () => undefined)
    expect(audio.paused).toBe(false)
    const next = await runMusicCommand({ op: 'next' }, () => undefined)
    expect(next.text).toBe('Next: Track 2 · A')
    expect(audio.src).toMatch(/yt:t2$/)
    await runMusicCommand({ op: 'volume', dir: 'down' }, () => undefined)
    expect(audio.volume).toBeCloseTo(0.8)
    expect((await runMusicCommand({ op: 'volume', dir: 'set', level: 0.3 }, () => undefined)).text).toBe('Music volume 30%')
    expect((await runMusicCommand({ op: 'what' }, () => undefined)).text).toBe('Track 2 · A')
  })

  it('a hub miss is reported, not thrown away', async () => {
    resetMusicEngineForTests(new WebEngine(new FakeAudio() as unknown as HTMLAudioElement, vi.fn() as unknown as typeof fetch))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Couldn’t find “zzzz”.' }), { status: 404 })))
    await expect(runMusicCommand({ op: 'play', said: 'play zzzz' }, () => undefined)).rejects.toThrow('Couldn’t find “zzzz”.')
  })
})
