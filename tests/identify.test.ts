// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { identifyControl } from '../src/music/identify'
import { installMusicRoute, parseMusicCommand, runMusicCommand } from '../src/music/voice'

const flush = async () => { for (let n=0;n<8;n++) await Promise.resolve() }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear(); identifyControl.back() })

describe('song identification phrases', () => {
  it.each(['music', 'Music.', 'shazam', "what's this song?", 'what is this song', 'identify this'])('whole utterance %s starts Identify', said => {
    expect(parseMusicCommand(said)).toEqual({op:'identify'})
  })
  it.each(['I like music', 'music please', 'music is important', 'what is this music like', 'identify this problem'])('does not steal ordinary speech: %s', said => {
    expect(parseMusicCommand(said)?.op).not.toBe('identify')
  })
  it('keeps existing music searches and now-playing question', () => {
    expect(parseMusicCommand('music search Home Tides')?.op).toBe('search')
    expect(parseMusicCommand("what's playing")?.op).toBe('what')
  })
})

describe('held microphone and app-owned shell claims', () => {
  it('paints starting before permission settles, ignores double-tap, and reports denial after navigation', async () => {
    let reject!: (reason: Error) => void
    const capture = vi.fn(() => new Promise((_r, fail) => { reject=fail }))
    const release=vi.fn()
    vi.stubGlobal('WizardApp', { capture:{start:capture}, update:{hold:()=>({release})} })
    const a=identifyControl.start()
    expect(identifyControl.snapshot().open).toBe(true)
    expect(identifyControl.snapshot().phase).toBe('starting')
    expect(capture).toHaveBeenCalledTimes(1)
    await identifyControl.start()
    expect(capture).toHaveBeenCalledTimes(1)
    identifyControl.back()
    reject(new Error('Microphone unavailable'))
    await a
    expect(identifyControl.snapshot().open).toBe(false)
    expect(identifyControl.snapshot().phase).toBe('idle')
    expect(identifyControl.snapshot().error).toBe('Microphone unavailable')
    expect(release).toHaveBeenCalledTimes(1)
  })
  it('voice returns on same frame while capture permission is held', async () => {
    let reject!: (reason: Error) => void
    vi.stubGlobal('WizardApp', {capture:{start:vi.fn(()=>new Promise((_r,fail)=>{reject=fail}))}})
    expect(await runMusicCommand({op:'identify'},()=>undefined)).toEqual({ok:true,text:'Listening for a song · your clip will be kept'})
    expect(identifyControl.snapshot().phase).toBe('starting')
    reject(new Error('Test permission denial'))
    await flush()
    expect(identifyControl.snapshot().phase).toBe('idle')
  })
})

function fakeIndexedDB(rows: Map<string, unknown>) {
  const tx = () => { const t: Record<string, unknown> = {}; queueMicrotask(() => queueMicrotask(() => (t.oncomplete as () => void)?.())); t.objectStore = () => ({
    put: (v: {id: string}) => { rows.set(v.id, v) }, delete: (id: string) => { rows.delete(id) },
    getAll: () => { const q: Record<string, unknown> = { result: [...rows.values()] }; queueMicrotask(() => (q.onsuccess as () => void)?.()); return q } }); return t }
  return { open: () => { const r: Record<string, unknown> = { result: { transaction: tx, close: () => undefined, createObjectStore: () => undefined } }; queueMicrotask(() => (r.onsuccess as () => void)?.()); return r } }
}

describe('sending a saved clip', () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  const clip = { id: '11111111-2222-4333-8444-555555555555', sharedId: 'shared-1', blob: { size: 4, type: 'audio/wav', arrayBuffer: async () => bytes.buffer }, mime: 'audio/wav', client_ts: '2026-11-06T00:00:00Z' }
  // jsdom and Node keep separate ArrayBuffer realms on some Node versions; hash with Node directly so the test is portable.
  const hex = async () => createHash('sha256').update(bytes).digest('hex')
  beforeEach(() => { vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (_alg, data) => { const h = createHash('sha256').update(new Uint8Array(data as ArrayBuffer)).digest(); return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength) }) })

  it('is confirmed from the upload reply itself, with no second read that can race the server', async () => {
    const rows = new Map<string, unknown>([[clip.id, clip]])
    vi.stubGlobal('indexedDB', fakeIndexedDB(rows))
    const digest = await hex()
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ id: clip.id, raw_sha256: digest }) }))
    vi.stubGlobal('fetch', fetchMock)
    const ack = vi.fn(async () => true)
    vi.stubGlobal('WizardApp', { capture: { ack } })
    const { uploadClip } = await import('../src/music/identify')
    await uploadClip(clip as never)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ack).toHaveBeenCalledWith('shared-1')
    expect(rows.has(clip.id)).toBe(false)
  })

  it('keeps the clip and says it is retrying when the server never confirms the audio', async () => {
    const rows = new Map<string, unknown>([[clip.id, clip]])
    vi.stubGlobal('indexedDB', fakeIndexedDB(rows))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('?') ? { ok: true, json: async () => ({ id: clip.id, raw_sha256: 'other' }) } : { ok: false, json: async () => ({ error: 'Unknown hunt' }) }))
    const ack = vi.fn(async () => true)
    vi.stubGlobal('WizardApp', { capture: { ack } })
    const { uploadClip } = await import('../src/music/identify')
    const sent = await uploadClip(clip as never).then(() => 'sent', (e: Error) => e.message)
    expect(sent).toMatch(/Retrying/)
    expect(ack).not.toHaveBeenCalled()
    expect(rows.has(clip.id)).toBe(true)
  }, 15000)


})

describe('recording duration, explicit send and result focus', () => {
  const id = '11111111-2222-4333-8444-555555555555'
  const bytes = new Uint8Array([1, 2, 3, 4])
  const blob = { size: 4, type: 'audio/wav', arrayBuffer: async () => bytes.buffer }
  let rows: Map<string, any>, result: any, stop: ReturnType<typeof vi.fn>, uploads: number, visible: boolean
  beforeEach(() => {
    rows = new Map(); uploads = 0; visible = true
    result = { id, blob, mime: 'audio/wav', startedAt: Date.now(), durationMs: 30000, meta: { task: 'music-identify', manualSubmit: true } }
    stop = vi.fn(async () => result)
    vi.stubGlobal('indexedDB', fakeIndexedDB(rows))
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (_alg, data) => { const h = createHash('sha256').update(new Uint8Array(data as ArrayBuffer)).digest(); return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength) })
    vi.stubGlobal('WizardApp', { view: { isVisible: () => visible }, capture: { start: vi.fn(async () => ({ id, stop, onLevel: () => () => undefined })), pending: async () => [], ack: vi.fn(async () => true) } })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') { uploads++; return { ok: true, json: async () => ({ id, raw_sha256: createHash('sha256').update(bytes).digest('hex') }) } }
      return { ok: true, json: async () => ({ id, status: 'identified', candidates: [], captures: [] }) }
    }))
  })
  afterEach(async () => { if (identifyControl.snapshot().phase !== 'idle') identifyControl.cancel(); await flush(); await identifyControl.drain() })
  it('uses elapsed duration, never sends at the 12s target, and sends at the 30s hard cap', async () => {
    vi.useFakeTimers()
    await identifyControl.start()
    await vi.advanceTimersByTimeAsync(12000)
    expect(identifyControl.snapshot().phase).toBe('recording')
    expect(identifyControl.snapshot().elapsed).toBe(12)
    expect(stop).not.toHaveBeenCalled(); expect(uploads).toBe(0)
    await vi.advanceTimersByTimeAsync(18000)
    await flush(); await identifyControl.drain()
    expect(identifyControl.snapshot().phase).toBe('idle')
    expect(stop).toHaveBeenCalledTimes(1); expect(uploads).toBe(1)
    expect(identifyControl.snapshot().selected).toBe(id)
  })
  it('sends early, paints saving before held I/O and opens the new submission while waiting', async () => {
    let resolve!: (value: any) => void
    stop.mockImplementation(() => new Promise(r => { resolve = r }))
    await identifyControl.start()
    const saved = identifyControl.stop()
    expect(identifyControl.snapshot().phase).toBe('saving')
    await identifyControl.stop(); expect(stop).toHaveBeenCalledTimes(1)
    resolve({ ...result, durationMs: 2500 }); await saved
    expect(identifyControl.snapshot().selected).toBe(id)
    await identifyControl.drain(); expect(uploads).toBe(1)
  })
  it('does not reopen when the owner navigates away during saving, including after the result completes', async () => {
    let resolve!: (value: any) => void
    stop.mockImplementation(() => new Promise(r => { resolve = r }))
    await identifyControl.start(); const saved = identifyControl.stop()
    identifyControl.back(); resolve(result); await saved; await identifyControl.drain()
    expect(identifyControl.snapshot().open).toBe(false)
    expect(identifyControl.snapshot().selected).toBeNull()
    expect(identifyControl.snapshot().freshId).toBe(id)
    expect(uploads).toBe(1)
  })
  it('does not steal focus from a different shell app', async () => {
    await identifyControl.start(); visible = false
    await identifyControl.stop(); await identifyControl.drain()
    expect(identifyControl.snapshot().selected).toBeNull()
    expect(identifyControl.snapshot().freshId).toBe(id)
  })
  it('keeps cancelled audio as an unsent draft and never opens or uploads it', async () => {
    await identifyControl.start(); identifyControl.cancel(); await flush(); await identifyControl.drain()
    expect(rows.get(id).sendRequested).toBe(false)
    expect(uploads).toBe(0); expect(identifyControl.snapshot().selected).toBeNull()
  })
  it('cancels held permission without resurrecting or submitting the eventual recording', async () => {
    let resolve!: (value: any) => void
    ;((window as any).WizardApp.capture.start as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(r => { resolve = r }))
    const starting = identifyControl.start(); identifyControl.cancel()
    expect(identifyControl.snapshot().phase).toBe('starting')
    resolve({ id, stop, onLevel: () => () => undefined }); await starting; await identifyControl.drain()
    expect(identifyControl.snapshot().phase).toBe('idle')
    expect(rows.get(id).sendRequested).toBe(false)
    expect(uploads).toBe(0); expect(identifyControl.snapshot().selected).toBeNull()
  })
  it('does not upload an unsent shared draft after restart recovery', async () => {
    ;((window as any).WizardApp.capture.pending as any) = async () => [result]
    await identifyControl.drain(); await identifyControl.drain()
    expect(rows.get(id).sendRequested).toBe(false); expect(uploads).toBe(0)
  })
})

describe('Back after the sheet already closed', () => {
  it('leaves the Hunts list instead of spending a press on an invisible sheet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ captures: [] }) })))
    vi.stubGlobal('indexedDB', fakeIndexedDB(new Map()))
    identifyControl.open()
    await identifyControl.detail('11111111-2222-4333-8444-555555555555')
    expect(identifyControl.snapshot().selected).toBeTruthy()
    expect(identifyControl.back()).toBe(true)
    expect(identifyControl.snapshot().selected).toBeNull()
    expect(identifyControl.snapshot().open).toBe(false)
  })
})
