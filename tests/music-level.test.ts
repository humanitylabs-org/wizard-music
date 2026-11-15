// @vitest-environment jsdom
// Music level (wizard-music#35): a Music-only ceiling under the phone volume, behind the box switch `music-level`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeEngine, WebEngine } from '../src/music/engine'
import { activeLevel, cacheSwitches, clampLevel, fetchSwitches, LEVEL_KEY, LEVEL_SWITCH, readLevel, writeLevel } from '../src/music/level'
import { runMusicCommand } from '../src/music/voice'
import { resetMusicEngineForTests } from '../src/music/engine'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain ESM module without types
import { SWITCHES, switchesDoc } from '../server/switches.mjs'

class FakeAudio extends EventTarget {
  src = ''; paused = true; ended = false; currentTime = 0; duration = 1; preload = ''; volume = 1
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
  removeAttribute(name: string) { if (name === 'src') this.src = '' }
}
function memory() {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
}
function nativeBridge() {
  const sent: Record<string, unknown>[] = []
  const bridge = { onmessage: null as null | ((e: { data: string }) => void), postMessage(raw: string) { sent.push(JSON.parse(raw)) } }
  return { bridge, sent, answer: (v: unknown) => bridge.onmessage?.({ data: JSON.stringify(v) }) }
}
const volumes = (sent: Record<string, unknown>[]) => sent.filter((s) => s.method === 'volume').map((s) => s.value)

afterEach(() => { resetMusicEngineForTests(null); vi.unstubAllGlobals() })

describe('the music-level switch', () => {
  it('is declared off by default and linked to this issue', () => {
    const row = SWITCHES.find((s: { id: string }) => s.id === LEVEL_SWITCH)
    expect(row).toMatchObject({ id: 'music-level', default: false, issues: ['humanitylabs-org/wizard-music#35'] })
    expect(switchesDoc().switches.find((s: { id: string }) => s.id === LEVEL_SWITCH)?.on).toBe(false)
  })

  it('reads the box state the page sees', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ switches: [{ id: 'music-level', on: true }, { id: 'x', on: 'yes' }] }), { status: 200 }))
    expect(await fetchSwitches('/wizard-music/', fetchMock as unknown as typeof fetch)).toEqual({ 'music-level': true })
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/wizard-music/api/view/switches')
    expect(await fetchSwitches('/wizard-music/', (async () => new Response('', { status: 403 })) as unknown as typeof fetch)).toBeNull()
  })
})

describe('the stored level', () => {
  it('stays between 5% and 100% and defaults to 100%', () => {
    const store = memory()
    expect(readLevel(store)).toBe(1)
    expect(writeLevel(store, 0.3)).toBe(0.3)
    expect(store.getItem(LEVEL_KEY)).toBe('0.3')
    expect(clampLevel(0)).toBe(0.05)
    expect(clampLevel(4)).toBe(1)
    expect(clampLevel('junk')).toBe(1)
  })

  it('applies only while the switch is on', () => {
    const store = memory()
    writeLevel(store, 0.3)
    expect(activeLevel(store)).toBe(1)
    cacheSwitches(store, { [LEVEL_SWITCH]: true })
    expect(activeLevel(store)).toBe(0.3)
    cacheSwitches(store, { [LEVEL_SWITCH]: false })
    expect(activeLevel(store)).toBe(1)
  })
})

describe('web player', () => {
  it('scales the real output by the level and keeps voice volume relative to it', async () => {
    const audio = new FakeAudio()
    const engine = new WebEngine(audio as unknown as HTMLAudioElement, vi.fn() as unknown as typeof fetch)
    engine.setLevel(0.3)
    expect(audio.volume).toBeCloseTo(0.3)
    resetMusicEngineForTests(engine)
    const t = { id: 'yt:t1', title: 'Track 1', artist: 'A', album: '', durationMs: 1000, source: 'youtube', art: '/wizard-music/art/yt:t1', stream: '/wizard-music/stream/yt:t1' }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ kind: 'song', heard: 'x', station: null, tracks: [t] }), { status: 200 })))
    await runMusicCommand({ op: 'play', said: 'play something' }, () => undefined)
    expect(audio.volume).toBeCloseTo(0.3)
    expect((await runMusicCommand({ op: 'volume', dir: 'set', level: 0.5 }, () => undefined)).text).toBe('Music volume 50%')
    expect(engine.volume()).toBeCloseTo(0.5)
    expect(audio.volume).toBeCloseTo(0.15)
    await runMusicCommand({ op: 'volume', dir: 'up' }, () => undefined)
    expect(audio.volume).toBeCloseTo(0.21)
    engine.setLevel(1)
    expect(audio.volume).toBeCloseTo(0.7)
  })
})

describe('native player', () => {
  it('holds a fresh full-volume player to the level once it answers', () => {
    const { bridge, sent, answer } = nativeBridge()
    const engine = new NativeEngine(bridge)
    engine.setLevel(0.3)
    expect(volumes(sent)).toEqual([]) // its gain is unknown until it answers
    answer({ sessionId: 's1', queue: [], volume: 1 })
    expect(volumes(sent)).toEqual([0.3])
    expect(engine.volume()).toBe(1)
  })

  it('keeps a player already at the level, and a quieter voice setting inside it', () => {
    const { bridge, sent, answer } = nativeBridge()
    const engine = new NativeEngine(bridge)
    engine.setLevel(0.4)
    answer({ sessionId: 's1', queue: [], volume: 0.2 })
    expect(volumes(sent)).toEqual([])
    expect(engine.volume()).toBeCloseTo(0.5)
    engine.setVolume(1)
    expect(volumes(sent)).toEqual([0.4])
    engine.setLevel(0.1)
    expect(volumes(sent)).toEqual([0.4, 0.1])
  })

  it('changes nothing with the level at 100%', () => {
    const { bridge, sent, answer } = nativeBridge()
    const engine = new NativeEngine(bridge)
    engine.setLevel(1)
    answer({ sessionId: 's1', queue: [], volume: 0.6 })
    expect(volumes(sent)).toEqual([])
    expect(engine.volume()).toBeCloseTo(0.6)
  })
})
