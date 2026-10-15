// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { NativeEngine } from '../src/music/engine'
import { hostedAudioBridge } from '../src/music/backgroundAudio'

const parent = window.parent
const tick = async () => { for (let i=0;i<5;i++) await Promise.resolve() }
afterEach(() => Object.defineProperty(window,'parent',{configurable:true,value:parent}))

describe('native audio intent and request scheduling', () => {
  it('uses explicit play intention while the player is temporarily suspended', async () => {
    const sent: Record<string,unknown>[] = []
    const bridge = {onmessage:null as null|((e:{data:string})=>void),postMessage(raw:string){sent.push(JSON.parse(raw))}}
    const engine = new NativeEngine(bridge)
    bridge.onmessage?.({data:JSON.stringify({sessionId:'one',playing:false,wantPlaying:true,buffering:true})})
    engine.toggle()
    expect(sent.at(-1)?.method).toBe('pause')
    expect(engine.snapshot().wantPlaying).toBe(true)
    engine.removeUpcoming([])
    expect(sent.at(-1)?.method).toBe('removeUpcoming')
  })

  it('coalesces repeated state polls and puts transport before the next poll', async () => {
    const sent: {id:string;method:string}[]=[]
    const host = {location:window.location,WizBackgroundAudio:{canAttach:()=>true},postMessage(raw:{id:string;method:string}){sent.push(raw)}}
    Object.defineProperty(window,'parent',{configurable:true,value:host})
    const bridge=hostedAudioBridge()!
    const reply=(result:unknown) => {
      const e = new Event('message')
      Object.defineProperties(e,{source:{value:host},origin:{value:location.origin},data:{value:{type:'wizard:background-audio:v1',id:sent.at(-1)!.id,ok:true,result}}})
      window.dispatchEvent(e)
    }
    const first=bridge.postMessage(JSON.stringify({method:'state'})) as Promise<void>
    for(let i=0;i<100;i++) expect(bridge.postMessage(JSON.stringify({method:'state'}))).toBe(first)
    const paused=bridge.postMessage(JSON.stringify({method:'pause'})) as Promise<void>
    expect(sent.map(s=>s.method)).toEqual(['attach'])
    reply({sessionId:'one',wantPlaying:true});await tick()
    expect(sent.map(s=>s.method)).toEqual(['attach','state'])
    reply({sessionId:'one'});await tick()
    expect(sent.map(s=>s.method)).toEqual(['attach','state','pause'])
    reply({sessionId:'one',wantPlaying:false});await first;await paused
  })
})
