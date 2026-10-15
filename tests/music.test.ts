// @vitest-environment jsdom
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMusicProxy, musicRoute, rewriteHubPaths } from '../server/music.mjs'
import { playedTracks, readSession, REFILL_THRESHOLD, RESUME_AUTOPLAY_MS, SESSION_KEY, WebEngine, type MusicTrack } from '../src/music/engine'

const track = (n: number): MusicTrack => ({ id: `yt:t${n}`, title: `Track ${n}`, artist: 'A', album: '', durationMs: 1000, source: 'youtube', art: `/wizard-music/art/yt:t${n}`, stream: `/wizard-music/stream/yt:t${n}` })

class FakeAudio extends EventTarget {
  src = ''
  paused = true
  ended = false
  currentTime = 0
  duration = 1
  preload = ''
  play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve() }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
  removeAttribute(name: string) { if (name === 'src') this.src = '' }
}

describe('Wizard Music routes', () => {
  it('allows only the music API and media shapes', () => {
    expect(musicRoute('GET', '/api/home')).toBe('api')
    expect(musicRoute('GET', '/api/station/0123456789abcdef/more')).toBe('api')
    expect(musicRoute('POST', '/api/station')).toBe('api')
    expect(musicRoute('GET', '/stream/yt:sbygyYTKzVE')).toBe('media')
    expect(musicRoute('GET', '/stream/lib:abc123')).toBe('media')
    expect(musicRoute('GET', '/stream/../../etc/passwd')).toBe(null)
    expect(musicRoute('GET', '/stream/http:evil')).toBe(null)
    expect(musicRoute('DELETE', '/api/home')).toBe(null)
    expect(musicRoute('POST', '/stream/yt:abc')).toBe(null)
  })

  it('rewrites hub paths to the app base', () => {
    expect(rewriteHubPaths('{"stream":"/wizard-music/stream/yt%3Aa","more":"/wizard-music/api/station/x/more"}'))
      .toBe('{"stream":"/wizard-music/stream/yt%3Aa","more":"/wizard-music/api/station/x/more"}')
  })

  it('refuses non-loopback hub origins', () => {
    expect(() => createMusicProxy({ origin: 'http://10.0.0.5:8793', token: 't' })).toThrow()
    expect(() => createMusicProxy({ origin: 'https://127.0.0.1:8793', token: 't' })).toThrow()
  })

  it('adds the hub token server-side and never echoes it', async () => {
    const seen: { auth?: string; path?: string; range?: string }[] = []
    const hub = createServer((req, res) => {
      seen.push({ auth: req.headers.authorization, path: req.url, range: req.headers.range })
      res.writeHead(206, { 'content-type': 'audio/mp4', 'content-range': 'bytes 0-1/10', 'set-cookie': 'leak=1', 'x-secret': 'nope' })
      res.end('ab')
    })
    await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve))
    const port = (hub.address() as AddressInfo).port
    const handle = createMusicProxy({ origin: `http://127.0.0.1:${port}`, token: 'hub-secret' })
    const front = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      void handle(req, res, url, (r: import('node:http').ServerResponse, status: number, value: unknown) => { r.writeHead(status, { 'content-type': 'application/json' }); r.end(JSON.stringify(value)) })
    })
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve))
    const frontPort = (front.address() as AddressInfo).port
    try {
      const response = await fetch(`http://127.0.0.1:${frontPort}/wizard-music/stream/yt:abc?evil=1`, { headers: { Range: 'bytes=0-1', Authorization: 'Bearer browser' } })
      expect(response.status).toBe(206)
      expect(response.headers.get('content-range')).toBe('bytes 0-1/10')
      expect(response.headers.get('set-cookie')).toBe(null)
      expect(response.headers.get('x-secret')).toBe(null)
      expect(await response.text()).toBe('ab')
      expect(seen[0]).toEqual({ auth: 'Bearer hub-secret', path: '/stream/yt:abc', range: 'bytes=0-1' })
      const blocked = await fetch(`http://127.0.0.1:${frontPort}/wizard-music/api/../../admin`)
      expect([404]).toContain(blocked.status)
    } finally {
      hub.close(); front.close()
    }
  })

  it('reports music_unavailable when no hub is configured', async () => {
    const handle = createMusicProxy({})
    const sent: unknown[] = []
    await handle({ method: 'GET', headers: {} } as never, {} as never, new URL('http://x/wizard-music/api/home'), (_r: unknown, status: number, value: unknown) => sent.push([status, value]))
    expect(sent).toEqual([[503, { error: 'music_unavailable' }]])
  })
})

describe('Wizard Music web engine', () => {
  afterEach(() => vi.useRealTimers())

  it('refills an endless station before the queue runs dry, without duplicates', async () => {
    const audio = new FakeAudio()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tracks: [track(1), track(100), track(101)] }), { status: 200 }))
    const engine = new WebEngine(audio as unknown as HTMLAudioElement, fetchMock as unknown as typeof fetch)
    await engine.load([track(1), track(2), track(3)], 0, { id: 'abc', title: 'Radio', more: '/wizard-music/api/station/0123456789abcdef/more' })
    await vi.waitFor(() => expect(engine.snapshot().queue.length).toBe(5))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/wizard-music/api/station/0123456789abcdef/more?n=10')
    expect(engine.snapshot().queue.map((item) => item.id)).toEqual(['yt:t1', 'yt:t2', 'yt:t3', 'yt:t100', 'yt:t101'])
    expect(REFILL_THRESHOLD).toBeGreaterThan(0)
  })

  it('advances on ended and auto-starts the refill when the queue was exhausted', async () => {
    const audio = new FakeAudio()
    let calls = 0
    const fetchMock = vi.fn(async () => { calls++; return new Response(JSON.stringify({ tracks: calls === 1 ? [] : [track(9)] }), { status: 200 }) })
    const engine = new WebEngine(audio as unknown as HTMLAudioElement, fetchMock as unknown as typeof fetch)
    await engine.load([track(1)], 0, { id: 's', title: 'Radio', more: '/wizard-music/api/station/0123456789abcdef/more' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    audio.dispatchEvent(new Event('ended'))
    await vi.waitFor(() => expect(engine.snapshot().index).toBe(1))
    expect(engine.snapshot().queue[1].id).toBe('yt:t9')
    expect(audio.src).toContain('/wizard-music/stream/yt:t9')
  })

  it('play next inserts after the current track and remove skips forward', async () => {
    const audio = new FakeAudio()
    const engine = new WebEngine(audio as unknown as HTMLAudioElement, vi.fn() as unknown as typeof fetch)
    await engine.load([track(1), track(2), track(3)], 0, null)
    engine.enqueueNext(track(3))
    expect(engine.snapshot().queue.map((item) => item.id)).toEqual(['yt:t1', 'yt:t3', 'yt:t2'])
    engine.removeCurrent()
    expect(engine.snapshot().queue.map((item) => item.id)).toEqual(['yt:t3', 'yt:t2'])
    expect(audio.src).toContain('yt:t3')
  })

  it('thumbs down silences the song before the next one loads', async () => {
    const audio = new FakeAudio()
    const engine = new WebEngine(audio as unknown as HTMLAudioElement, vi.fn() as unknown as typeof fetch)
    await engine.load([track(1), track(2)], 0, null)
    const order: string[] = []
    audio.addEventListener('pause', () => order.push(`pause:${audio.src.split('/').pop()}`))
    audio.addEventListener('play', () => order.push(`play:${audio.src.split('/').pop()}`))
    engine.removeCurrent()
    expect(order).toEqual(['pause:yt:t1', 'play:yt:t2'])
    expect(engine.snapshot().queue.map((item) => item.id)).toEqual(['yt:t2'])
  })

  it('thumbs down on the last song of an endless station stops it and fetches more', async () => {
    const audio = new FakeAudio()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tracks: [track(7)] }), { status: 200 }))
    const engine = new WebEngine(audio as unknown as HTMLAudioElement, fetchMock as unknown as typeof fetch)
    await engine.load([track(1)], 0, { id: 's', title: 'Radio', more: '/wizard-music/api/station/0123456789abcdef/more' })
    await vi.waitFor(() => expect(engine.snapshot().queue.length).toBe(2))
    engine.jump(1)
    engine.removeCurrent()
    expect(audio.paused).toBe(true)
    await vi.waitFor(() => expect(audio.src).toContain('yt:t7'))
    expect(audio.paused).toBe(false)
  })

  it('drops upcoming tracks the hub ruled out, never the current one', async () => {
    const audio = new FakeAudio()
    const engine = new WebEngine(audio as unknown as HTMLAudioElement, vi.fn() as unknown as typeof fetch)
    await engine.load([track(1), track(2), track(3), track(4)], 1, null)
    engine.removeUpcoming(['yt:t1', 'yt:t2', 'yt:t4'])
    expect(engine.snapshot().queue.map((item) => item.id)).toEqual(['yt:t1', 'yt:t2', 'yt:t3'])
    expect(engine.snapshot().index).toBe(1)
  })
})

class MemoryStore {
  data = new Map<string, string>()
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
  removeItem(key: string) { this.data.delete(key) }
}
const RADIO = { id: 'r1', title: 'Kerri Chandler radio', more: '/wizard-music/api/station/0123456789abcdef/more' }
const noMore = () => vi.fn(async () => new Response(JSON.stringify({ tracks: [] }), { status: 200 })) as unknown as typeof fetch

describe('Wizard Music resumes after a Wizard restart', () => {
  it('saves song, queue, station, spot and play state', async () => {
    const store = new MemoryStore()
    const audio = new FakeAudio()
    const engine = new WebEngine(audio as unknown as HTMLAudioElement, noMore(), store)
    await engine.load([track(1), track(2), track(3)], 0, RADIO)
    engine.next()
    audio.currentTime = 95.4
    audio.dispatchEvent(new Event('timeupdate'))
    engine.saveSession(true)
    const saved = readSession(store)!
    expect(saved.queue.map((item) => item.id)).toEqual(['yt:t1', 'yt:t2', 'yt:t3'])
    expect(saved.index).toBe(1)
    expect(saved.station).toEqual(RADIO)
    expect(saved.positionMs).toBe(95400)
    expect(saved.playing).toBe(true)
  })

  it('a pause the system causes (Wizard closing) still counts as playing; your pause does not', async () => {
    const store = new MemoryStore()
    const audio = new FakeAudio()
    const engine = new WebEngine(audio as unknown as HTMLAudioElement, noMore(), store)
    await engine.load([track(1), track(2)], 0, null)
    audio.pause() // WebView torn down
    engine.saveSession(true)
    expect(readSession(store)!.playing).toBe(true)
    engine.pause()
    expect(readSession(store)!.playing).toBe(false)
  })

  it('a fresh engine picks up the same song at the same spot and keeps the station going', async () => {
    const store = new MemoryStore()
    const now = Date.now()
    store.setItem(SESSION_KEY, JSON.stringify({ v: 1, queue: [track(1), track(2), track(3)], index: 1, station: RADIO, positionMs: 95400, playing: true, savedAt: now - 60_000 }))
    const audio = new FakeAudio()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tracks: [track(50)] }), { status: 200 }))
    const engine = new WebEngine(audio as unknown as HTMLAudioElement, fetchMock as unknown as typeof fetch, store)
    expect(engine.resume(readSession(store)!, now)).toBe(true)
    expect(audio.src).toContain('yt:t2')
    expect(engine.snapshot().positionMs).toBe(95400)
    expect(audio.paused).toBe(false)
    audio.duration = 300
    audio.dispatchEvent(new Event('loadedmetadata'))
    expect(audio.currentTime).toBeCloseTo(95.4)
    expect(engine.snapshot().station).toEqual(RADIO)
    await vi.waitFor(() => expect(engine.snapshot().queue.map((item) => item.id)).toContain('yt:t50'))
  })

  it('after a long break it comes back paused at the same spot', async () => {
    const store = new MemoryStore()
    const now = Date.now()
    store.setItem(SESSION_KEY, JSON.stringify({ v: 1, queue: [track(1)], index: 0, station: null, positionMs: 30000, playing: true, savedAt: now - RESUME_AUTOPLAY_MS - 1 }))
    const audio = new FakeAudio()
    const engine = new WebEngine(audio as unknown as HTMLAudioElement, noMore(), store)
    expect(engine.resume(readSession(store)!, now)).toBe(false)
    expect(audio.paused).toBe(true)
    expect(engine.snapshot().queue[0].id).toBe('yt:t1')
    engine.play()
    audio.duration = 200
    audio.dispatchEvent(new Event('loadedmetadata'))
    expect(audio.currentTime).toBeCloseTo(30)
  })

  it('ignores missing or broken saved sessions', () => {
    const store = new MemoryStore()
    expect(readSession(store)).toBe(null)
    store.setItem(SESSION_KEY, '{oops')
    expect(readSession(store)).toBe(null)
    store.setItem(SESSION_KEY, JSON.stringify({ v: 1, queue: [], index: 0 }))
    expect(readSession(store)).toBe(null)
  })

  it('keeps the saved queue bounded on long stations', async () => {
    const store = new MemoryStore()
    const audio = new FakeAudio()
    const engine = new WebEngine(audio as unknown as HTMLAudioElement, noMore(), store)
    const many = Array.from({ length: 300 }, (_, n) => track(n))
    await engine.load(many, 150, null)
    engine.saveSession(true)
    const saved = readSession(store)!
    expect(saved.queue.length).toBeLessThanOrEqual(131)
    expect(saved.queue[saved.index].id).toBe('yt:t150')
  })
})

describe('Wizard Music played history', () => {
  it('lists songs before the current one, oldest first, with positions to jump back to', async () => {
    const audio = new FakeAudio()
    const engine = new WebEngine(audio as unknown as HTMLAudioElement, vi.fn() as unknown as typeof fetch)
    await engine.load([track(1), track(2), track(3), track(4)], 0, null)
    expect(playedTracks(engine.snapshot())).toEqual([])
    engine.next(); engine.next()
    expect(playedTracks(engine.snapshot()).map(({ item, position }) => `${item.id}@${position}`)).toEqual(['yt:t1@0', 'yt:t2@1'])
    engine.jump(0)
    expect(audio.src).toContain('yt:t1')
    expect(engine.snapshot().queue.slice(1).map((item) => item.id)).toEqual(['yt:t2', 'yt:t3', 'yt:t4'])
  })

  it('a new station keeps what you already heard in front of it', async () => {
    const audio = new FakeAudio()
    const engine = new WebEngine(audio as unknown as HTMLAudioElement, noMore())
    await engine.load([track(1), track(2), track(3)], 0, null)
    engine.next()
    await engine.load([track(10), track(11)], 0, RADIO)
    const snap = engine.snapshot()
    expect(snap.queue[snap.index].id).toBe('yt:t10')
    expect(playedTracks(snap).map(({ item }) => item.id)).toEqual(['yt:t1', 'yt:t2'])
    expect(audio.src).toContain('yt:t10')
    engine.previous()
    expect(audio.src).toContain('yt:t2')
  })

  it('keeps at most the last 50 played', async () => {
    const audio = new FakeAudio()
    const engine = new WebEngine(audio as unknown as HTMLAudioElement, vi.fn() as unknown as typeof fetch)
    await engine.load(Array.from({ length: 120 }, (_, n) => track(n)), 100, null)
    await engine.load([track(500)], 0, null)
    const played = playedTracks(engine.snapshot())
    expect(played.length).toBe(50)
    expect(played[played.length - 1].item.id).toBe('yt:t100')
  })
})
