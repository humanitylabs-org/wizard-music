// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
let root: Root | undefined
// Regression: the owner's persisted “Saved on this device · Not sent” screen, not remote no_match.
function localOutbox() {
  const id = '11111111-2222-4333-8444-555555555555'
  const blob = {size: 4, type: 'audio/wav', arrayBuffer: async () => new Uint8Array([1,2,3,4]).buffer}
  const clip = {id, sharedId: id, blob, mime: 'audio/wav', client_ts: '2026-11-06T00:00:00Z', duration_s: 7, sendRequested: false}
  const rows = new Map<string, any>([[id, clip]])
  const fixture = {id, clip, rows, hold: false, fail: false, puts: 0, release: undefined as undefined | (() => void)}
  const transaction = () => {
    const t: any = {}; let write: any, deleted: string | undefined
    queueMicrotask(() => queueMicrotask(() => {
      const finish = () => { if (fixture.fail && write) { t.error = new Error('fixture storage failure'); t.onerror?.(); return }; if (write) rows.set(write.id, write); if (deleted) rows.delete(deleted); t.oncomplete?.() }
      if (fixture.hold && write) fixture.release = finish; else finish()
    }))
    t.objectStore = () => ({put: (v: any) => { fixture.puts++; write = v }, delete: (key: string) => { deleted = key }, getAll: () => { const q: any = {result: [...rows.values()]}; queueMicrotask(() => q.onsuccess?.()); return q }})
    return t
  }
  vi.stubGlobal('indexedDB', {open: () => { const r: any = {result: {transaction, close: () => undefined}}; queueMicrotask(() => r.onsuccess?.()); return r }})
  const ack = vi.fn(async () => undefined)
  const toast = vi.fn()
  vi.stubGlobal('WizardApp', {capture: {pending: async () => [{id, blob, mime:'audio/wav', startedAt: Date.now(), durationMs:7000, meta:{task:'music-identify'}}], ack}, view:{isVisible:()=>false}, shell:{toast}})
  vi.stubGlobal('WzSheet', {open:(d:HTMLDialogElement)=>d.setAttribute('open',''), close:(d:HTMLDialogElement)=>d.removeAttribute('open')})
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => { if (options?.method === 'POST') throw Error('No uploads or server writes allowed'); return {ok:true,json:async()=>({captures:[]})} }))
  vi.stubGlobal('URL', Object.assign(URL, {createObjectURL:()=> 'blob:fixture', revokeObjectURL:()=>undefined}))
  return {...fixture, ack, toast, getFixture: () => fixture}
}
it('persisted local unsent Discard is visible and closes/removes on the tap with IndexedDB held and no HTTP', async () => {
  const f = localOutbox(), fixture = f.getFixture()
  const {identifyControl: control} = await import('../src/music/identify')
  const {IdentifyView} = await import('../src/music/IdentifyView')
  await control.refresh(); control.open(); await control.detail(f.id)
  const host=document.createElement('div');document.body.append(host);root=createRoot(host)
  await act(async()=>root!.render(<IdentifyView notify={()=>undefined}/>))
  expect(document.querySelector('dialog')?.textContent).toContain('Saved on this device')
  expect(document.querySelector('dialog')?.textContent).toContain('Not sent. You can review or send it below.')
  expect([...document.querySelectorAll('button')].some(b=>b.textContent==='Send for identification')).toBe(true)
  const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Discard')!
  fixture.hold = true; vi.mocked(fetch).mockClear()
  act(()=> {button.click(); button.click()})
  expect(document.querySelector('dialog[open]')).toBeNull(); expect(control.snapshot().locals).toEqual([])
  await act(async()=>{for(let i=0;i<20;i++)await Promise.resolve()})
  expect(fixture.puts).toBe(1); expect(fetch).not.toHaveBeenCalled(); expect(f.ack).not.toHaveBeenCalled()
  await act(async()=>control.refresh()); expect(control.snapshot().locals).toEqual([])
  await act(async()=>{fixture.hold=false;fixture.release!();await control.discard(f.id)})
  expect(f.rows.get(f.id)).toMatchObject({discardedAt:expect.any(Number),sendRequested:false,blob:f.clip.blob})
  await act(async()=>control.drain()); expect(control.snapshot().locals).toEqual([])
  expect(vi.mocked(fetch).mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(0)
  await act(async()=>root!.unmount()); root=undefined
  vi.resetModules()
  const reloaded=(await import('../src/music/identify')).identifyControl
  await reloaded.drain(); expect(reloaded.snapshot().locals).toEqual([])
  expect(reloaded.snapshot().discardNotice).toMatchObject({id:f.id,action:'undo'})
  await reloaded.restore(f.id); await reloaded.drain()
  expect(reloaded.snapshot().locals).toHaveLength(1)
  expect(f.rows.get(f.id)).toEqual(f.clip); expect(f.ack).not.toHaveBeenCalled()
  expect(vi.mocked(fetch).mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(0)
})
it('local discard failure after leaving restores the same unsent clip and exposes retry; Undo serializes',async()=>{
  const f=localOutbox(), fixture=f.getFixture()
  const {identifyControl:c}=await import('../src/music/identify')
  await c.refresh(); c.open(); await c.detail(f.id); fixture.hold=true;fixture.fail=true
  const removal=c.discard(f.id);expect(c.discard(f.id)).toBe(removal);c.back()
  for(let i=0;i<30;i++)await Promise.resolve()
  fixture.hold=false;fixture.release!();await removal
  expect(c.snapshot()).toMatchObject({open:false,discardNotice:{error:true,action:'discard'}})
  expect(c.snapshot().locals[0]).toEqual(f.clip);expect(f.toast).toHaveBeenCalledOnce()
  fixture.fail=false;fixture.hold=true
  const retry=c.discard(f.id),undo=c.restore(f.id)
  for(let i=0;i<30;i++)await Promise.resolve()
  fixture.hold=false;fixture.release!();await retry;await undo
  expect(f.rows.get(f.id)).toEqual(f.clip); expect(c.snapshot().locals).toHaveLength(1)
  expect(f.ack).not.toHaveBeenCalled()
})
it('a running recording or Send transition refuses local discard without changing custody',async()=>{
  const f=localOutbox()
  let reject!: (e:Error)=>void
  ;(window.WizardApp.capture as any).start=()=>new Promise((_r,j)=>{reject=j})
  const {identifyControl:c}=await import('../src/music/identify')
  await c.refresh(); const starting=c.start(); await c.discard(f.id)
  expect(f.rows.get(f.id)).toEqual(f.clip);expect(c.snapshot().locals).toHaveLength(1)
  expect(c.snapshot().discardNotice?.message).toContain('Wait until')
  reject(new Error('fixture denial'));await starting
  const sending=c.submit(f.id); await c.discard(f.id)
  expect(c.snapshot().discardNotice?.message).toContain('Wait until')
  await sending
})
it('the no-match Discard closes the sheet and removes its row in the click before the held write',async()=>{
  let finish!: (r: unknown)=>void
  const id='c40a2a22-c187-4791-ae34-90c00628b089'
  const record={id,created_at:'2026-11-06T00:00:00Z',status:'no_match',retention_state:'active',candidates:[],attempts:[]}
  vi.stubGlobal('WizardApp',{})
  vi.stubGlobal('WzSheet',{open:(d:HTMLDialogElement)=>d.setAttribute('open',''),close:(d:HTMLDialogElement)=>d.removeAttribute('open')})
  const fetchMock=vi.fn(async(url:string,opts?:RequestInit)=>opts?.method==='POST'?new Promise(r=>{finish=r}):{ok:true,json:async()=>url.endsWith('/captures')?{captures:[record]}:record})
  vi.stubGlobal('fetch',fetchMock)
  const {identifyControl:control}=await import('../src/music/identify')
  const {IdentifyView}=await import('../src/music/IdentifyView')
  await control.refresh(); control.open(); await control.detail(id)
  const host=document.createElement('div');document.body.append(host);root=createRoot(host)
  await act(async()=>root!.render(<IdentifyView notify={()=>undefined}/>))
  const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Discard')!
  expect(button).toBeTruthy(); const before=performance.now()
  act(()=>button.click())
  expect(performance.now()-before).toBeLessThan(100)
  expect(document.querySelector('dialog[open]')).toBeNull()
  expect(document.querySelector('.identify-hunt')).toBeNull()
  expect(document.querySelector('.identify-notice')?.textContent).toContain('Undo')
  act(()=>control.back())
  await act(async()=>{ await Promise.resolve() })
  await act(async()=>finish({ok:false,json:async()=>({error:'fixture refusal'})}))
  expect(document.querySelector('.identify-view')).toBeNull()
  expect(document.querySelector('.identify-notice[role=alert]')?.textContent).toContain('Try again')
})
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); localStorage.clear(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true })
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })
it('paints the search spinner immediately, debounces, and ignores an aborted stale reply', async () => {
  const { resetMusicEngineForTests, EMPTY_SNAPSHOT } = await import('../src/music/engine')
  resetMusicEngineForTests({ snapshot: () => EMPTY_SNAPSHOT, subscribe: () => () => undefined } as never)
  const replies: { url: string; signal: AbortSignal; resolve(value: unknown): void }[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, opts: RequestInit = {}) => new Promise(resolve => { if (url.includes('/search?')) replies.push({url, signal: opts.signal as AbortSignal, resolve}) })))
  const { MusicApp } = await import('../src/music/MusicApp')
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<MusicApp notify={() => undefined} onOpenNowPlaying={() => undefined} />))
  const input = host.querySelector('input')!
  const type = async (text: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', {bubbles:true})) })
  await type('a'); expect(host.querySelector('[aria-label="Searching music"]')).not.toBeNull(); expect(replies).toHaveLength(0)
  await act(async () => { vi.advanceTimersByTime(249) }); expect(replies).toHaveLength(0)
  await act(async () => { vi.advanceTimersByTime(1) }); expect(replies).toHaveLength(1)
  await type('ab'); expect(replies[0].signal.aborted).toBe(true)
  await act(async () => replies[0].resolve({ok:true,json:async()=>({tracks:[]})}))
  expect(host.querySelector('[aria-label="Searching music"]')).not.toBeNull()
  await act(async () => { vi.advanceTimersByTime(250) }); expect(replies).toHaveLength(2)
  await act(async () => replies[1].resolve({ok:true,json:async()=>({tracks:[]})}))
  expect(host.querySelector('[aria-label="Searching music"]')).toBeNull()
  await type('abc'); await type(''); expect(host.querySelector('[aria-label="Searching music"]')).toBeNull()
  await act(async () => { vi.advanceTimersByTime(300) }); expect(replies).toHaveLength(2)
})
it('fills the ring at 12 seconds without sending, and sends only at the 30 second hard cap', async () => {
  const stop = vi.fn(() => new Promise(() => undefined))
  vi.stubGlobal('WizardApp', {capture:{start:async()=>({id:'11111111-2222-4333-8444-555555555555',stop,onLevel:()=>()=>undefined})}})
  const { identifyControl } = await import('../src/music/identify')
  const { CaptureProgress } = await import('../src/music/IdentifyView')
  await identifyControl.start(); vi.advanceTimersByTime(12000)
  expect(identifyControl.snapshot().elapsed).toBe(12); expect(stop).not.toHaveBeenCalled()
  const html = renderToStaticMarkup(<CaptureProgress elapsed={12} />)
  expect(html).toContain('stroke-dashoffset="0"'); expect(html).toContain('That should be enough')
  vi.advanceTimersByTime(17999); expect(stop).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1); expect(stop).toHaveBeenCalledTimes(1)
})
it('send opens this local clip immediately, before saving or server confirmation; Back returns to Hunts', async () => {
  const id = '11111111-2222-4333-8444-555555555555'
  const stop = vi.fn(() => new Promise(() => undefined))
  vi.stubGlobal('WizardApp', {capture:{start:async()=>({id,stop,onLevel:()=>()=>undefined})}})
  const { identifyControl } = await import('../src/music/identify')
  await identifyControl.start(); vi.advanceTimersByTime(1000); void identifyControl.stop()
  expect(identifyControl.snapshot()).toMatchObject({selected:id,detail:null,open:true,phase:'saving'})
  document.body.innerHTML = '<dialog class="identify-sheet" open></dialog>'
  expect(identifyControl.back()).toBe(true)
  expect(identifyControl.snapshot()).toMatchObject({selected:null,open:true})
})
it('an explicit listen URL starts capture and denial exposes the tap-to-start fallback', async () => {
  history.replaceState({}, '', '/wizard-music/?view=identify&listen=1')
  vi.stubGlobal('WizardApp', {capture:{start:vi.fn(async()=>{throw new Error('Gesture required')})}})
  const { installMusicRoute } = await import('../src/music/voice')
  const { identifyControl } = await import('../src/music/identify')
  const off = installMusicRoute(() => undefined)
  for (let i=0;i<10;i++) await Promise.resolve()
  expect(window.WizardApp.capture.start).toHaveBeenCalledTimes(1)
  expect(identifyControl.snapshot()).toMatchObject({phase:'idle',open:true,needsTap:true})
  off(); history.replaceState({}, '', '/')
})
