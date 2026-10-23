// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { NativeEngine, readSession, RESUME_AUTOPLAY_MS, SESSION_KEY, type MusicTrack } from '../src/music/engine'

const track = (n: number): MusicTrack => ({ id: `yt:t${n}`, title: `Song ${n}`, artist: 'A', album: '', durationMs: 200000, art: `/wizard-music/art/${n}`, stream: `/wizard-music/stream/${n}` } as MusicTrack)
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) } } }
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function fakeBridge() {
  const sent: Record<string, unknown>[] = []
  const bridge = { onmessage: null as null | ((e: { data: string }) => void), postMessage(raw: string) { sent.push(JSON.parse(raw)) } }
  const reply = (v: unknown) => bridge.onmessage?.({ data: JSON.stringify(v) })
  return { sent, bridge, reply }
}

describe('Music resumes after an app update (native player)', () => {
  it('saves the song and spot the native player reports', () => {
    const store = memory(); const { bridge, reply } = fakeBridge()
    new NativeEngine(bridge, store)
    reply({ sessionId: 's1', queueRevision: 1, queue: [track(1), track(2), track(3)], index: 1, playing: true, wantPlaying: true, positionMs: 93000, station: null })
    const saved = readSession(store)!
    expect(saved.queue[saved.index].id).toBe('yt:t2')
    expect(saved.positionMs).toBe(93000)
    expect(saved.playing).toBe(true)
  })

  it('does not overwrite the saved session with the empty player an update leaves behind', () => {
    const store = memory(); const { bridge, reply } = fakeBridge()
    store.setItem(SESSION_KEY, JSON.stringify({ v: 1, queue: [track(1)], index: 0, station: null, positionMs: 5000, playing: false, savedAt: Date.now() }))
    new NativeEngine(bridge, store)
    reply({ sessionId: 'fresh', queueRevision: 0, queue: [], index: -1, playing: false })
    expect(readSession(store)!.positionMs).toBe(5000)
  })

  it('refills an empty player with the saved song, paused, at the saved spot', async () => {
    const store = memory(); const { bridge, reply, sent } = fakeBridge()
    const engine = new NativeEngine(bridge, store)
    const session = { v: 1 as const, queue: [track(1), track(2), track(3)], index: 1, station: { id: 'st', title: 'Radio', more: '/wizard-music/api/more' }, positionMs: 61000, playing: true, savedAt: Date.now() - RESUME_AUTOPLAY_MS - 1 }
    const done = engine.restoreIfEmpty(session)
    reply({ sessionId: 'fresh', queueRevision: 0, queue: [], index: -1 })
    expect(await done).toBe(true)
    await tick()
    const methods = sent.map((m) => m.method)
    expect(methods.slice(-3)).toEqual(['load', 'pause', 'seek'])
    const load = sent.find((m) => m.method === 'load')!
    expect(load.index).toBe(1)
    expect((load.queue as MusicTrack[]).map((t) => t.id)).toEqual(['yt:t1', 'yt:t2', 'yt:t3'])
    expect(sent.at(-1)!.positionMs).toBe(61000)
  })

  it('keeps playing after a quick update if it was playing', async () => {
    const { bridge, reply, sent } = fakeBridge()
    const engine = new NativeEngine(bridge, memory())
    const done = engine.restoreIfEmpty({ v: 1, queue: [track(1)], index: 0, station: null, positionMs: 4000, playing: true, savedAt: Date.now() - 1000 })
    reply({ sessionId: 'fresh', queue: [], index: -1 })
    expect(await done).toBe(true); await tick()
    expect(sent.map((m) => m.method).slice(-2)).toEqual(['load', 'seek'])
  })

  it('leaves a live native session alone', async () => {
    const { bridge, reply, sent } = fakeBridge()
    const engine = new NativeEngine(bridge, memory())
    const done = engine.restoreIfEmpty({ v: 1, queue: [track(9)], index: 0, station: null, positionMs: 4000, playing: false, savedAt: Date.now() })
    reply({ sessionId: 'live', queueRevision: 3, queue: [track(1)], index: 0, playing: true })
    expect(await done).toBe(false)
    expect(sent.some((m) => m.method === 'load')).toBe(false)
  })

  it('caps a long saved queue to what the player accepts, keeping the current song', async () => {
    const { bridge, reply, sent } = fakeBridge()
    const engine = new NativeEngine(bridge, memory())
    const queue = Array.from({ length: 131 }, (_, i) => track(i))
    const done = engine.restoreIfEmpty({ v: 1, queue, index: 50, station: null, positionMs: 0, playing: false, savedAt: Date.now() })
    reply({ sessionId: 'fresh', queue: [], index: -1 })
    await done; await tick()
    const load = sent.find((m) => m.method === 'load')!
    const q = load.queue as MusicTrack[]
    expect(q.length).toBe(100)
    expect(q[load.index as number].id).toBe('yt:t50')
  })
})
