// @vitest-environment jsdom
// More like this stations (wizard-music#90, switch curated-radio): the switch, the server gates, the agent tool and
// the Now Playing header ("Like <song>" with the sound profile, "Picking songs like this…" while the AI answers).
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MusicApp, NowPlaying, stationLine, CURATED_SWITCH } from '../src/music/MusicApp'
import { resetMusicEngineForTests, WebEngine } from '../src/music/engine'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain ESM module without types
import { createMusicProxy, musicRoute } from '../server/music.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain ESM module without types
import { SWITCHES, switchesDoc } from '../server/switches.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain ESM module without types
import { curateRequest, handleMcp } from '../server/mcp.mjs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve() }

async function throughProxy(curated: boolean, method: string, path: string) {
  const seen: { path?: string; curated?: string }[] = []
  const hub = createServer((req, res) => { seen.push({ path: req.url, curated: req.headers['x-wizard-music-curated'] as string | undefined }); req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve))
  const handle = createMusicProxy({ origin: `http://127.0.0.1:${(hub.address() as AddressInfo).port}`, token: 't', curated: () => curated })
  const front = createServer((req, res) => { void handle(req, res, new URL(req.url ?? '/', 'http://x'), (r: import('node:http').ServerResponse, s: number, v: unknown) => { r.writeHead(s); r.end(JSON.stringify(v)) }) })
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve))
  let status = 0
  try {
    const r = await fetch(`http://127.0.0.1:${(front.address() as AddressInfo).port}/wizard-music${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Wizard-Music-Curated': '1' }, ...(method === 'POST' ? { body: '{"trackId":"yt:EoJy_GR1Lb0"}' } : {}) })
    status = r.status; await r.text()
  } finally { hub.close(); front.close() }
  return { status, hub: seen[0] }
}

describe('the curated-radio switch', () => {
  it('is declared off by default and linked to this issue', () => {
    expect(SWITCHES.find((s: { id: string }) => s.id === CURATED_SWITCH)).toMatchObject({ id: 'curated-radio', default: false, issues: ['humanitylabs-org/wizard-music#90'] })
    expect(switchesDoc().switches.find((s: { id: string }) => s.id === CURATED_SWITCH)?.on).toBe(false)
  })

  it('off: stations start as today and the station view is not reachable', async () => {
    expect(await throughProxy(false, 'POST', '/api/station')).toMatchObject({ status: 200, hub: { curated: undefined } })
    expect(await throughProxy(false, 'GET', '/api/station/0123456789abcdef?wait=1')).toMatchObject({ status: 404, hub: undefined })
  })

  it('on: the hub is told to curate, and the station view reaches the hub with its query', async () => {
    expect(await throughProxy(true, 'POST', '/api/station')).toMatchObject({ status: 200, hub: { curated: '1' } })
    expect(await throughProxy(true, 'GET', '/api/station/0123456789abcdef?wait=1&peek=0')).toMatchObject({ status: 200, hub: { path: '/api/station/0123456789abcdef?wait=1&peek=0' } })
    expect(musicRoute('GET', '/api/station/0123456789abcdef')).toBe('api')
    expect(musicRoute('GET', '/api/station/xyz')).toBe(null)
  })
})

describe('station_curate (agent route)', () => {
  async function list(curated: boolean) {
    let out: { result?: { tools: { name: string }[] } } = {}
    const req = Object.assign((async function* () { yield Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) })(), { method: 'POST', headers: { 'content-type': 'application/json' } })
    await handleMcp(req, {}, (_res: unknown, _code: number, value: typeof out) => { out = value }, 1, { curated })
    return (out.result?.tools ?? []).map((t) => t.name)
  }
  it('is listed only while the switch is on', async () => {
    expect(await list(false)).not.toContain('station_curate')
    expect(await list(true)).toContain('station_curate')
  })
  it('takes a track id or a query (one of them) and the owner\'s note', () => {
    expect(curateRequest({ query: 'Trap Gui Boratto', note: 'unique sound' })).toEqual({ curate: true, query: 'Trap Gui Boratto', note: 'unique sound' })
    expect(curateRequest({ track_id: 'yt:EoJy_GR1Lb0' })).toEqual({ curate: true, trackId: 'yt:EoJy_GR1Lb0' })
    expect(curateRequest({})).toBeNull()
    expect(curateRequest({ track_id: 'yt:EoJy_GR1Lb0', query: 'x' })).toBeNull()
    expect(curateRequest({ track_id: 'nope' })).toBeNull()
    expect(curateRequest({ query: 'x', model: 'gpt' })).toBeNull()
  })
})

describe('the Now Playing header', () => {
  it('says what the station is doing', () => {
    expect(stationLine({ picks: 'pending' })).toBe('Picking songs like this…')
    expect(stationLine({ picks: 'radio' })).toBe('Radio (no AI picks)')
    expect(stationLine({ picks: 'ai', profile: 'Hypnotic melodic techno' })).toBe('Hypnotic melodic techno')
    expect(stationLine(null)).toBe('')
  })

  class FakeAudio extends EventTarget {
    src = ''; paused = true; ended = false; currentTime = 0; duration = 1; preload = ''; volume = 1
    play() { this.paused = false; return Promise.resolve() }
    pause() { this.paused = true }
    removeAttribute(name: string) { if (name === 'src') this.src = '' }
  }
  const seed = { id: 'yt:EoJy_GR1Lb0', title: 'Trap', artist: 'Gui Boratto', album: '', durationMs: 300000, source: 'youtube', art: '', stream: '/s', liked: false }
  const pick = { ...seed, id: 'yt:PqnMY3YU6hg', title: 'Bad Kingdom', artist: 'Moderat' }
  const station = { id: 'abcdef0123456789', title: 'Like Trap · Gui Boratto', more: '/wizard-music/api/station/abcdef0123456789/more' }
  let roots: Root[] = [], hosts: HTMLElement[] = [], release: () => void = () => undefined
  beforeEach(() => {
    localStorage.clear()
    history.replaceState({}, '', `/wizard-music/?station=${station.id}`)
    vi.stubGlobal('WizardApp', { back: { register: () => () => undefined, useHistory: () => () => undefined }, view: { isVisible: () => true } })
    const picked = new Promise<void>((resolve) => { release = resolve })
    const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/api/view/switches')) return answer({ switches: [{ id: 'curated-radio', on: true }] })
      if (url.includes('/api/home')) return answer({ sources: [], vibes: [], liked: [], recent: [], library: [], taste: { avoid: [] } })
      if (url.includes(`/api/station/${station.id}/more`)) { await picked; return answer({ tracks: [pick] }) }
      if (url.includes(`/api/station/${station.id}?wait=1`)) { await picked; return answer({ station: { ...station, picks: 'ai', profile: 'Hypnotic melodic techno: warm arpeggios, slow builds' }, seed, tracks: [] }) }
      if (url.includes(`/api/station/${station.id}?wait=0`)) return answer({ station: { ...station, picks: 'pending', profile: '' }, seed, tracks: [] })
      return answer({})
    })
    vi.stubGlobal('fetch', fetchMock)
    resetMusicEngineForTests(new WebEngine(new FakeAudio() as unknown as HTMLAudioElement, fetchMock as unknown as typeof fetch))
  })
  afterEach(async () => {
    release()
    await act(async () => { await flush(); roots.forEach((r) => r.unmount()) })
    hosts.forEach((h) => h.remove()); roots = []; hosts = []
    resetMusicEngineForTests(null); vi.unstubAllGlobals(); history.replaceState({}, '', '/')
  })
  const mount = async (node: React.ReactNode) => {
    const host = document.createElement('div'); document.body.append(host); hosts.push(host)
    const root = createRoot(host); roots.push(root)
    await act(async () => { root.render(node); await flush() })
    return host
  }

  it('an agent-started station (?station=) plays its seed at once, says it is picking, then shows the profile', async () => {
    let opened = 0
    await mount(<MusicApp onOpenNowPlaying={() => { opened++ }} notify={() => undefined} />)
    expect(opened).toBe(1)
    const now = await mount(<NowPlaying onClose={() => undefined} notify={() => undefined} />)
    const head = now.querySelector('.music-now-head')!
    expect(head.textContent).toContain('Like Trap · Gui Boratto')
    expect(head.querySelector('.music-now-profile')?.textContent).toBe('Picking songs like this…')
    expect(now.querySelector('.music-upnext .music-empty')?.textContent).toBe('Picking songs like this…')
    expect([...now.querySelectorAll('.music-upnext button')].map((b) => b.textContent)).toContain('More like this')
    await act(async () => { release(); await flush(); await new Promise((r) => setTimeout(r, 0)); await flush() })
    expect(head.querySelector('.music-now-profile')?.textContent).toBe('Hypnotic melodic techno: warm arpeggios, slow builds')
    expect(now.querySelector('.music-upnext')?.textContent).toContain('Bad Kingdom')
  })
})
