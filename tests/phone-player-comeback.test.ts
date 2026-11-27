// @vitest-environment jsdom
// wizard-music#115: coming back to Music on the phone must never show an earlier song as if it were playing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeEngine, type MusicTrack } from '../src/music/engine'
import { hostedAudioBridge } from '../src/music/backgroundAudio'

const TYPE = 'wizard:background-audio:v1'
const parent = window.parent
const song = (n: number): MusicTrack => ({ id: 'yt:' + n, title: 'Song ' + n, artist: 'Ben Böhmer', album: 'Bloom', durationMs: 205000, stream: '/s/' + n, art: '/a/' + n, source: 'youtube' } as MusicTrack)
const QUEUE = [song(1), song(2), song(3)]

type Sent = { id: string; method: string; params: Record<string, unknown> }
/** A fake phone shell: the native player keeps going on its own; `mode` decides how the shell answers. */
function fakeShell() {
  const sent: Sent[] = []
  const player = { index: 0, positionMs: 38000 }
  const shell = { mode: 'ok' as 'ok' | 'drop' | 'late', lateMs: 4000, sent, player,
    answer(id: string) {
      const result = { sessionId: 'phone', queue: QUEUE, queueRevision: 1, index: player.index, playing: true, wantPlaying: true, buffering: false, positionMs: player.positionMs, durationMs: 205000, error: '' }
      const e = new Event('message')
      Object.defineProperties(e, { source: { value: host }, origin: { value: location.origin }, data: { value: { type: TYPE, id, ok: true, result } } })
      window.dispatchEvent(e)
    } }
  const host = { location: window.location, WizBackgroundAudio: { canAttach: () => true }, postMessage(msg: Sent) {
    if (msg.method === 'detach') return
    sent.push(msg)
    if (shell.mode === 'ok') setTimeout(() => shell.answer(msg.id), 30)
    else if (shell.mode === 'late') setTimeout(() => shell.answer(msg.id), shell.lateMs)
  } }
  Object.defineProperty(window, 'parent', { configurable: true, value: host })
  return shell
}
let visible = 'visible'
function setVisible(v: 'visible' | 'hidden') { visible = v; document.dispatchEvent(new Event('visibilitychange')) }
/** What the owner sees: the song, whether it is shown as live, and the clock. */
function view(engine: NativeEngine) {
  const s = engine.snapshot()
  const shownAsLive = !s.stale && !s.reconnecting && Boolean(s.queue[s.index]) && Boolean(s.wantPlaying ?? s.playing)
  return { title: s.queue[s.index]?.title, shownAsLive, reconnecting: Boolean(s.reconnecting), hidden: Boolean(s.stale), error: s.error, positionMs: s.positionMs }
}

async function playing() {
  const shell = fakeShell()
  const engine = new NativeEngine(hostedAudioBridge()!)
  const stop = engine.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(1200)
  expect(view(engine)).toMatchObject({ title: 'Song 1', shownAsLive: true })
  return { shell, engine, stop }
}
/** Music goes out of view; meanwhile the phone player moves on to the next song. */
async function hideAndMoveOn(shell: ReturnType<typeof fakeShell>) {
  setVisible('hidden')
  await vi.advanceTimersByTimeAsync(3 * 60_000)
  shell.player.index = 1; shell.player.positionMs = 12000
}

beforeEach(() => {
  vi.useFakeTimers()
  visible = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible })
})
afterEach(() => { vi.useRealTimers(); Object.defineProperty(window, 'parent', { configurable: true, value: parent }) })

describe('coming back to Music on the phone (wizard-music#115)', () => {
  it('a healthy phone: the current song shows within 1.5 s and its clock moves', async () => {
    const { shell, engine } = await playing()
    await hideAndMoveOn(shell)
    setVisible('visible')
    await vi.advanceTimersByTimeAsync(1500)
    expect(view(engine)).toMatchObject({ title: 'Song 2', shownAsLive: true })
    shell.player.positionMs = 14000
    await vi.advanceTimersByTimeAsync(2100)
    expect(view(engine).positionMs).toBe(14000)
  })

  it('A: the phone answers 4 s late: never the old song as live, the real song as soon as the answer lands', async () => {
    const { shell, engine } = await playing()
    await hideAndMoveOn(shell)
    shell.mode = 'late'
    setVisible('visible')
    for (let t = 0; t < 3900; t += 100) {
      await vi.advanceTimersByTimeAsync(100)
      const v = view(engine)
      expect(v.title === 'Song 1' && v.shownAsLive, `old song shown as live at ${t + 100} ms`).toBe(false)
    }
    await vi.advanceTimersByTimeAsync(1600)
    expect(view(engine)).toMatchObject({ title: 'Song 2', shownAsLive: true, reconnecting: false, error: '' })
  })

  it('A: after 1.5 s without an answer it shows a visible reconnecting state', async () => {
    const { shell, engine } = await playing()
    await hideAndMoveOn(shell)
    shell.mode = 'late'
    setVisible('visible')
    await vi.advanceTimersByTimeAsync(1600)
    expect(view(engine)).toMatchObject({ reconnecting: true, hidden: false, shownAsLive: false })
  })

  it('B: a poll lost just before Music went away does not hold up the comeback read', async () => {
    const { shell, engine } = await playing()
    shell.mode = 'drop'
    await vi.advanceTimersByTimeAsync(1000) // one poll leaves and its reply is lost
    await hideAndMoveOn(shell)
    shell.mode = 'ok'
    const before = shell.sent.length
    setVisible('visible')
    await vi.advanceTimersByTimeAsync(10)
    expect(shell.sent.slice(before).some(m => m.method === 'state' && m.params.fresh), 'the comeback read goes out at once').toBe(true)
    await vi.advanceTimersByTimeAsync(1490)
    expect(view(engine)).toMatchObject({ title: 'Song 2', shownAsLive: true })
  })

  it('C: the phone never answers: reconnecting, then the plain error with Try again within 5 s, never the old song as live', async () => {
    const { shell, engine } = await playing()
    await hideAndMoveOn(shell)
    shell.mode = 'drop'
    setVisible('visible')
    for (let t = 0; t < 5000; t += 250) {
      await vi.advanceTimersByTimeAsync(250)
      expect(view(engine).shownAsLive, `shown as live at ${t + 250} ms`).toBe(false)
    }
    expect(view(engine)).toMatchObject({ reconnecting: true, error: 'Background music did not answer.' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(view(engine).shownAsLive).toBe(false)
    // Try again once the phone is back: the real song.
    shell.mode = 'ok'
    engine.reconnect()
    expect(view(engine)).toMatchObject({ reconnecting: true, error: '' })
    await vi.advanceTimersByTimeAsync(1500)
    expect(view(engine)).toMatchObject({ title: 'Song 2', shownAsLive: true, error: '' })
  })

  it('D: back/forward cache (pagehide, then pageshow) brings the bridge back', async () => {
    const { shell, engine } = await playing()
    window.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(100)
    shell.player.index = 2
    const e = new Event('pageshow'); Object.defineProperty(e, 'persisted', { value: true })
    window.dispatchEvent(e)
    await vi.advanceTimersByTimeAsync(1500)
    expect(view(engine)).toMatchObject({ title: 'Song 3', shownAsLive: true, error: '' })
  })
})
