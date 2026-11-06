// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
let root: Root | undefined
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
