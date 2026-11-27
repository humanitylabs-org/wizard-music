import type { NativeMusicBridge } from './engine'

const TYPE = 'wizard:background-audio:v1'
/** Reads (attach, state) give up after this; a lost one must never freeze the player for long (wizard-music#115). */
const READ_TIMEOUT_MS = 5000
const WRITE_TIMEOUT_MS = 22000
/** One in-flight request; polls coalesce and never queue ahead of transport actions. */
export function hostedAudioBridge(): NativeMusicBridge | undefined {
  try {
    if (window.parent === window || window.parent.location.origin !== location.origin) return undefined
    const host = window.parent as Window & { WizBackgroundAudio?: { canAttach(win: Window): boolean } }
    if (!host.WizBackgroundAudio?.canAttach(window)) return undefined
  } catch { return undefined }
  let seq = 0, sessionId = '', attached = false, busy = false, disposed = false
  type Command = { method: string; [key: string]: unknown }
  type Job = { command: Command; promise: Promise<void>; resolve(): void; reject(error: Error): void }
  const writes: Job[] = []
  let poll: Job | undefined, active: Job | undefined
  const pending = new Map<string, { resolve(value: Record<string, unknown> | null): void; reject(error: Error): void; timer: number }>()
  let activeId = ''
  function request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const id = 'music-' + (++seq)
    if (!fresh(params)) activeId = id
    const wait = method === 'state' || method === 'attach' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { pending.delete(id); reject(new Error('Background music did not answer.')) }, wait)
      pending.set(id, { resolve, reject, timer })
      window.parent.postMessage({ type: TYPE, id, method, params: { ...params, sessionId } }, location.origin)
    })
  }
  window.addEventListener('message', e => {
    if (e.source !== window.parent || e.origin !== location.origin || e.data?.type !== TYPE) return
    const p = pending.get(e.data.id); if (!p) return
    pending.delete(e.data.id); clearTimeout(p.timer)
    if (e.data.ok) p.resolve(e.data.result || {}); else p.reject(new Error(e.data.error || 'Background audio failed.'))
  })
  function fresh(params: Record<string, unknown>) { return params.fresh === true }
  /** A newer answer is in: a poll still waiting on a lost reply is pointless, so let the queue move on. */
  function abandonStuckPoll() {
    if (active?.command.method !== 'state') return
    const p = pending.get(activeId); if (!p) return
    pending.delete(activeId); clearTimeout(p.timer); p.resolve(null)
  }
  function accept(result: Record<string, unknown> | null) {
    if (!result) return
    if (result.sessionId) sessionId = String(result.sessionId)
    bridge.onmessage?.({ data: JSON.stringify(result) })
  }
  async function pump() {
    if (busy || disposed) return
    const job = writes.shift() || poll
    if (!job) return
    if (job === poll) poll = undefined
    busy = true; active = job
    try {
      if (!attached) { accept(await request('attach', { knownQueueRevision: -1 })); attached = true }
      const { method, ...params } = job.command
      accept(await request(method, params)); job.resolve()
    } catch (err) {
      attached = false; const error = err instanceof Error ? err : new Error(String(err))
      bridge.onmessage?.({ data: JSON.stringify({ error: error.message }) }); job.reject(error)
    } finally { busy = false; active = undefined; void pump() }
  }
  /** Coming back into view: read now, beside anything still in flight (wizard-music#115). */
  async function freshRead(command: Command) {
    const { method, ...params } = command
    try {
      if (!attached) { accept(await request('attach', { knownQueueRevision: -1, fresh: true })); attached = true }
      accept(await request(method, params))
      abandonStuckPoll()
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (!disposed) { attached = false; bridge.onmessage?.({ data: JSON.stringify({ error: error.message }) }) }
      throw error
    }
  }
  const bridge: NativeMusicBridge = {
    onmessage: null,
    postMessage(raw: string) {
      let command: Command
      try { command = JSON.parse(raw) } catch { return }
      if (disposed) return Promise.reject(new Error('Music view detached.'))
      if (command.method === 'state') {
        // A fresh read must not ride on, or wait behind, a request that left before Music came back into view.
        if (command.fresh) return freshRead(command)
        if (active?.command.method === 'state') return active.promise
        if (poll) { poll.command = command; return poll.promise }
      }
      if (command.method !== 'state' && writes.length >= 16) return Promise.reject(new Error('Music is busy. Try again.'))
      let resolve!: () => void, reject!: (error: Error) => void
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
      const job = { command, promise, resolve, reject }
      if (command.method === 'state') poll = job; else writes.push(job)
      void pump(); return promise
    },
  }
  window.addEventListener('pagehide', () => {
    disposed = true
    window.parent.postMessage({type:TYPE,id:'detach',method:'detach',params:{sessionId}},location.origin)
    const error = new Error('Music view detached.')
    pending.forEach(p => {clearTimeout(p.timer);p.reject(error)}); pending.clear()
    writes.splice(0).forEach(j => j.reject(error)); poll?.reject(error); poll = undefined
  })
  // Restored from the back/forward cache: the page lives again, so the bridge does too.
  window.addEventListener('pageshow', (e) => {
    if (!disposed || !(e as PageTransitionEvent).persisted) return
    disposed = false; attached = false
    void pump()
  })
  return bridge
}
