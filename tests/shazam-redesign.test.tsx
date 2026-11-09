// @vitest-environment jsdom
// Owner, 6 Nov 2026: "a really modern sleek, it feels like Shazam … and clean up the UX of these buttons".
// These render the real views and check the composition he asked for plus every control the redesign must keep.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { identifyControl } from '../src/music/identify'
import { IdentifyEntry, IdentifyView } from '../src/music/IdentifyView'
import { MusicApp } from '../src/music/MusicApp'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve() }
let root: Root | null = null, host: HTMLDivElement | null = null
async function render(node: ReactNode) {
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(node); await flush() })
  return host
}
const named = (scope: ParentNode, name: string) => [...scope.querySelectorAll('button')].filter(b => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name)
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); await flush() })
const type = (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

function fakeIndexedDB(rows: Map<string, unknown>) {
  const tx = () => { const t: Record<string, unknown> = {}; queueMicrotask(() => queueMicrotask(() => (t.oncomplete as () => void)?.())); t.objectStore = () => ({
    put: (v: { id: string }) => { rows.set(v.id, v) }, delete: (id: string) => { rows.delete(id) },
    getAll: () => { const q: Record<string, unknown> = { result: [...rows.values()] }; queueMicrotask(() => (q.onsuccess as () => void)?.()); return q } }); return t }
  return { open: () => { const r: Record<string, unknown> = { result: { transaction: tx, close: () => undefined, createObjectStore: () => undefined } }; queueMicrotask(() => (r.onsuccess as () => void)?.()); return r } }
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

const id = '11111111-2222-4333-8444-555555555555'
const bytes = new Uint8Array([1, 2, 3, 4])
const blob = { size: 4, type: 'audio/wav', arrayBuffer: async () => bytes.buffer }
let rows: Map<string, any>, hunts: any[], huntDetail: any, uploads: number, visible: boolean, captureStart: ReturnType<typeof vi.fn>, stop: ReturnType<typeof vi.fn>

beforeEach(() => {
  rows = new Map(); hunts = []; huntDetail = null; uploads = 0; visible = true
  stop = vi.fn(async () => ({ id, blob, mime: 'audio/wav', startedAt: Date.now(), durationMs: 4000, meta: { task: 'music-identify', manualSubmit: true } }))
  captureStart = vi.fn(async () => ({ id, stop, onLevel: (fn: (v: number) => void) => { fn(0.4); return () => undefined } }))
  vi.stubGlobal('indexedDB', fakeIndexedDB(rows))
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (_alg, data) => { const h = createHash('sha256').update(new Uint8Array(data as ArrayBuffer)).digest(); return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength) })
  vi.stubGlobal('WizardApp', { view: { isVisible: () => visible }, capture: { start: captureStart, pending: async () => [], ack: vi.fn(async () => true) }, update: { hold: () => ({ release: () => undefined }) } })
  vi.stubGlobal('WzSheet', { open: (d: HTMLDialogElement) => d.setAttribute('open', ''), close: (d: HTMLDialogElement) => d.removeAttribute('open') })
  ;(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:clip'
  ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/home')) return ok(HOME)
    if (init?.method === 'POST' && url.includes('/captures?')) { uploads++; return ok({ id, raw_sha256: createHash('sha256').update(bytes).digest('hex') }) }
    if (/\/captures$/.test(url)) return ok({ captures: hunts })
    if (/\/captures\/[\w-]+$/.test(url)) return ok(huntDetail)
    return ok({})
  }))
})
afterEach(async () => {
  if (identifyControl.snapshot().phase !== 'idle') identifyControl.cancel()
  await act(async () => { await flush(); root?.unmount() })
  host?.remove(); root = null; host = null
  identifyControl.configure('', false)
  identifyControl.back(); identifyControl.back()
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear()
})

const track = (n: number) => ({ id: `yt:t${n}`, title: `Song ${n}`, artist: 'Artist', album: '', durationMs: 200000, source: 'youtube', art: '', stream: '' })
const VIBES = ['Tuktuk music', 'Tea music', 'Synthwave', 'Downtempo', 'House', 'Deep house', 'Ambient', 'Trip hop', 'Deep focus', 'Late night', 'Warm house', 'Morning lift', 'Dub techno', 'Neo soul']
const HOME = {
  sources: [{ id: 'online', name: 'Online sources', status: 'ok', detail: 'Catalog access enabled; availability varies', ok: true }, { id: 'library', name: 'Wizard Library', status: 'ok', detail: '5 tracks on your Wizard', ok: true }],
  vibes: VIBES.map((label, n) => ({ id: 'v' + n, label })), liked: [track(1)], recent: [track(2)], library: [track(3)], taste: { avoid: ['CORNBOI', 'Pop'] },
}

describe("the owner's Shazam-like Music: home", () => {
  it('has one Identify entry and one Identifications link, no duplicated top button row', async () => {
    const view = await render(<MusicApp lead={<IdentifyEntry />} onOpenNowPlaying={() => undefined} notify={() => undefined} />)
    expect(named(view, 'Identify song')).toHaveLength(1)
    expect(named(view, 'Identifications')).toHaveLength(1)
    expect(named(view, 'Identify')).toHaveLength(0)
    expect(view.textContent).not.toContain('←')
    // Identify leads the page, ahead of playback sections.
    const entry = view.querySelector('.identify-entry')!
    expect(follows(entry, view.querySelector('[aria-label="Start a station"]')!)).toBe(true)
  })

  it('keeps sources and taste disclosed instead of status cards stealing focus', async () => {
    const view = await render(<MusicApp lead={<IdentifyEntry />} onOpenNowPlaying={() => undefined} notify={() => undefined} />)
    const sources = view.querySelector('[aria-label="Music sources"]')!
    expect(sources.textContent).toContain('Online sources')
    expect((sources.closest('details') as HTMLDetailsElement).open).toBe(false)
    expect(view.querySelector('[aria-label="Music you turned down"]')!.closest('details')).toBe(sources.closest('details'))
    expect(view.querySelector('details.music-about summary')!.textContent).toContain('2 of 2 connected')
  })

  it('shows stations as one scrolling row, not a wall, and keeps every playback control', async () => {
    const view = await render(<MusicApp lead={<IdentifyEntry />} onOpenNowPlaying={() => undefined} notify={() => undefined} />)
    const stations = view.querySelector('[aria-label="Start a station"] .music-stations')!
    // Main's station cards (0.2.0-test.5) scroll in one two-row band on a phone; every station stays one tap away.
    expect(stations.querySelectorAll('button.music-station')).toHaveLength(VIBES.length)
    expect(view.querySelector('input[aria-label="Search music"]')).toBeTruthy()
    for (const name of ['Play all', 'Shuffle', 'Play Song 1 next', 'Play Song 3 next']) expect(named(view, name)).toHaveLength(1)
    expect(view.querySelector('[aria-label="Recently played"] .music-tile')).toBeTruthy()
  })

  it('tapping Identify starts shared capture at once, once, and the entry then returns to listening', async () => {
    let reject!: (e: Error) => void
    captureStart.mockImplementation(() => new Promise((_r, fail) => { reject = fail }))
    const view = await render(<IdentifyEntry />)
    await click(named(view, 'Identify song')[0])
    expect(captureStart).toHaveBeenCalledTimes(1)
    expect(identifyControl.snapshot()).toMatchObject({ open: true, phase: 'starting' })
    await click(named(view, 'Return to listening')[0])
    expect(captureStart).toHaveBeenCalledTimes(1)
    await act(async () => { reject(new Error('Microphone unavailable')); await flush() })
    expect(identifyControl.snapshot()).toMatchObject({ phase: 'idle', needsTap: true })
    // A gesture/permission failure offers Tap to start listening on the same central orb.
    await act(async () => { root!.unmount() }); host!.remove()
    const stage = await render(<IdentifyView notify={() => undefined} />)
    expect(stage.querySelector('.identify-stage .identify-phase')!.textContent).toBe('Tap to start listening')
    expect(named(stage, 'Identify song')).toEqual([stage.querySelector('.identify-stage button.identify-orb')])
  })
})

describe("the owner's Shazam-like Music: Identify screen", () => {
  it('has one large central control, history below it, and no Back/heading/Refresh clutter', async () => {
    hunts = [{ id: 'h1', created_at: '2026-11-06T13:35:00Z', status: 'has_leads', best_title: 'Stillness', best_artist: 'supwel' }]
    rows.set('local-1', { id: 'local-1', blob, mime: 'audio/wav', client_ts: '2026-11-06T14:33:00Z', duration_s: 4, sendRequested: false })
    const view = await render(<IdentifyView notify={() => undefined} />)
    await act(async () => { identifyControl.open(); await flush() })
    const orb = view.querySelector('.identify-stage button.identify-orb')!
    expect(named(view, 'Identify song')).toEqual([orb])
    expect(named(view, 'Identify a song')).toHaveLength(0)
    expect(named(view, '← Music')).toHaveLength(0)
    expect(named(view, 'Refresh')).toHaveLength(0)
    expect(named(view, 'Back to Music')).toHaveLength(1)
    expect(named(view, 'Refresh identifications')).toHaveLength(1)
    const headings = [...view.querySelectorAll('h2')].filter(h => h.textContent === 'Identifications')
    expect(headings).toHaveLength(1)
    expect(follows(orb, headings[0])).toBe(true)
    const list = [...view.querySelectorAll('.identify-hunt')].map(r => r.textContent)
    expect(list).toHaveLength(2)
    expect(list[0]).toContain('Not sent · tap to review')
    expect(list[1]).toContain('Stillness')
    for (const name of ['Retry all unsolved', 'Retention dry-run']) expect(named(view, name)).toHaveLength(1)
    await click(named(view, 'Back to Music')[0])
    expect(identifyControl.snapshot().open).toBe(false)
  })

  it('keeps the optional note and location discoverable and stateful behind one quiet control', async () => {
    const view = await render(<IdentifyView notify={() => undefined} />)
    await act(async () => { identifyControl.open(); await flush() })
    const toggle = view.querySelector<HTMLButtonElement>('.identify-option-toggle')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.querySelector('input[aria-label="Note for next recording"]')).toBeNull()
    await click(toggle)
    await type(view.querySelector<HTMLInputElement>('input[aria-label="Note for next recording"]')!, 'Fabric, room 2')
    const geo = [...view.querySelectorAll('label')].find(l => l.textContent?.includes('Save approximate location for the next identification'))!.querySelector('input')!
    await click(geo)
    expect(identifyControl.snapshot()).toMatchObject({ note: 'Fabric, room 2', geoEnabled: true })
    await click(toggle)
    expect(toggle.textContent).toContain('Fabric, room 2')
    expect(toggle.textContent).toContain('Location on')
    await click(toggle)
    expect(view.querySelector<HTMLInputElement>('input[aria-label="Note for next recording"]')!.value).toBe('Fabric, room 2')
    expect(view.querySelector<HTMLInputElement>('.identify-geo input')!.checked).toBe(true)
  })

  it('focuses listening: the orb ring fills to 12s with calm encouragement, Find it any time, Cancel keeps the draft', async () => {
    vi.useFakeTimers()
    const view = await render(<IdentifyView notify={() => undefined} />)
    await act(async () => { await identifyControl.start(); await flush() })
    const stage = view.querySelector('.identify-recording')!
    expect(stage.textContent).toContain('Listening…')
    expect(stage.textContent).toContain('Hold it up to the music…')
    const ring = view.querySelector('[role="progressbar"][aria-label="Audio capture target"]')!
    expect(ring.getAttribute('aria-valuemax')).toBe('12')
    expect(ring.closest('.identify-orb-wrap')!.querySelector('.identify-orb.phase-recording')).toBeTruthy() // one central orb inside the ring
    expect(view.querySelector('meter[aria-label="Microphone level"]')).toBeTruthy()
    expect(named(view, 'Find it now · early')[0].disabled).toBe(false)
    expect(named(view, 'Cancel')).toHaveLength(1)
    expect(named(view, 'Identify song')).toHaveLength(0)
    expect(view.querySelector('h2')).toBeNull() // history steps aside while listening
    await act(async () => { await vi.advanceTimersByTimeAsync(12000) })
    expect(view.querySelector('.identify-recording')!.textContent).toContain('That should be enough to find it.')
    expect(view.querySelector('.identify-ring-value')!.getAttribute('stroke-dashoffset')).toBe('0')
    expect(view.querySelector('.identify-orb-wrap.reached')).toBeTruthy()
    expect(identifyControl.snapshot().phase).toBe('recording')
    expect(stop).not.toHaveBeenCalled(); expect(uploads).toBe(0)
    expect(named(view, 'Find it')[0].disabled).toBe(false)
    await click(named(view, 'Cancel')[0])
    expect(identifyControl.snapshot().phase).toBe('idle')
    expect(rows.get(id).sendRequested).toBe(false)
    expect(uploads).toBe(0)
    expect(view.querySelector('.identify-hunt')!.textContent).toContain('Not sent · tap to review')
  })

  it('early Find it opens the clip sheet on the tap with loading, before saving or upload, then shows Finding your track', async () => {
    let resolve!: (v: unknown) => void
    stop.mockImplementation(() => new Promise(r => { resolve = r }))
    huntDetail = { id, created_at: '2026-11-06T14:40:00Z', status: 'hunting', candidates: [], attempts: [] }
    const view = await render(<IdentifyView notify={() => undefined} />)
    await act(async () => { await identifyControl.start(); await flush() })
    act(() => { named(view, 'Find it now · early')[0].click() })
    expect(identifyControl.snapshot()).toMatchObject({ phase: 'saving', selected: id })
    expect(view.querySelector('.identify-recording')!.textContent).toContain('Saving your clip…')
    expect(named(view, 'Find it now · early')[0].disabled).toBe(true)
    const sheet = document.querySelector('dialog.identify-sheet')!
    expect(sheet.hasAttribute('open')).toBe(true)
    expect(sheet.querySelector('.identify-result-title')!.textContent).toBe('Saving your clip…')
    expect(sheet.querySelector('.identify-result-status .music-wheel')).toBeTruthy()
    expect(uploads).toBe(0)
    await act(async () => { resolve({ id, blob, mime: 'audio/wav', startedAt: Date.now(), durationMs: 2500, meta: { task: 'music-identify', manualSubmit: true } }); await flush() })
    await act(async () => { await identifyControl.drain(); await flush() })
    expect(uploads).toBe(1)
    expect(identifyControl.snapshot().selected).toBe(id)
    expect(sheet.querySelector('h2')!.textContent).toMatch(/^Identification/)
    const status = sheet.querySelector('.identify-result [role=status]')!.textContent
    expect(status).toContain('Finding your track…')
    expect(status).toContain('About 6 seconds in our last check')
    expect(status).not.toMatch(/guarantee|\d\s*%|confidence/i)
    expect(sheet.querySelector('audio')).toBeTruthy()
  })

  it('a result navigated away from never steals focus and shows New on home and in history', async () => {
    let resolve!: (v: unknown) => void
    stop.mockImplementation(() => new Promise(r => { resolve = r }))
    await identifyControl.start()
    const saved = identifyControl.stop()
    identifyControl.back()
    resolve({ id, blob, mime: 'audio/wav', startedAt: Date.now(), durationMs: 5000, meta: { task: 'music-identify', manualSubmit: true } })
    await saved; await identifyControl.drain()
    expect(identifyControl.snapshot()).toMatchObject({ open: false, selected: null, freshId: id })
    hunts = [{ id, created_at: '2026-11-06T14:40:00Z', status: 'hunting' }]
    const view = await render(<><IdentifyEntry /><IdentifyView notify={() => undefined} /></>)
    expect(view.querySelector('.identify-entry-history')!.textContent).toContain('New')
    await act(async () => { identifyControl.open(); await flush() })
    expect(view.querySelector('.identify-hunt.identify-fresh')!.textContent).toContain('New')
  })

  it('shows a result with every candidate action, search, manual add and clip tools, and no invented confidence', async () => {
    huntDetail = { id: 'h1', created_at: '2026-11-06T13:35:00Z', status: 'has_leads', best_title: 'Stillness', best_artist: 'supwel', note: 'Rooftop', raw_sha256: 'abc', audio_url: '/a.mp3', original_url: '/o.wav', export_url: '/e.mp3',
      candidates: [{ id: 7, title: 'Stillness', artist: 'supwel', provider: 'acoustid', art_url: '/art.jpg' }, { id: 8, title: 'Stiller', artist: 'Other', provider: 'shazam' }], attempts: [{ id: 1, provider: 'acoustid', outcome: 'lead' }] }
    await render(<IdentifyView notify={() => undefined} />)
    await act(async () => { identifyControl.open(); await identifyControl.detail('h1'); await flush() })
    const sheet = document.querySelector('dialog.identify-sheet')!
    expect(sheet.querySelector('.identify-result-title')!.textContent).toBe('Stillness')
    expect(sheet.querySelector('.identify-result')!.textContent).toContain('Possible matches')
    expect(sheet.querySelector('.identify-result')!.textContent).toContain('Rooftop')
    expect(sheet.querySelectorAll('.identify-candidate')).toHaveLength(2)
    for (const name of ['This is it', 'Play', 'Not it', 'Download to library']) expect(named(sheet, name)).toHaveLength(2)
    for (const name of ['Add manually', 'Try again', 'Export clip']) expect(named(sheet, name)).toHaveLength(1)
    expect(sheet.querySelector('input[aria-label="Search title or artist"]')).toBeTruthy()
    expect(sheet.querySelector('a[download]')!.textContent).toBe('Download clip')
    const summaries = [...sheet.querySelectorAll('summary')].map(s => s.textContent)
    for (const s of ['Capture details', 'Original recording', 'Attempts (1)']) expect(summaries).toContain(s)
    expect(sheet.textContent).not.toMatch(/\d\s*%|confidence/i)
  })
})
