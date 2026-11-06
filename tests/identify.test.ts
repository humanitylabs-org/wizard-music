// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { identifyControl } from '../src/music/identify'
import { installMusicRoute, parseMusicCommand, runMusicCommand } from '../src/music/voice'

const flush = async () => { for (let n=0;n<8;n++) await Promise.resolve() }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); identifyControl.back() })

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
  const tx = () => { const t: Record<string, unknown> = {}; queueMicrotask(() => (t.oncomplete as () => void)?.()); t.objectStore = () => ({
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
