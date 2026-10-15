// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.WizardNativeMusic })

describe('actual Music feedback callback', () => {
  it.each(['like', 'unlike', 'dislike'] as const)('%s fences an in-flight continuation even when the successful drop list is empty', async (action) => {
    let generation = 0
    const commands: {method: string; ids?: string[]}[] = []
    window.WizardNativeMusic = {
      onmessage: null,
      postMessage(raw: string) {
        const command = JSON.parse(raw); commands.push(command)
        if (command.method === 'removeUpcoming') generation++
      },
    }
    const { musicControl } = await import('../src/music/MusicApp')
    musicControl.engine()
    // Model the native generation fence; the device suite separately uses ExoPlayer and HTTP.
    const requestedGeneration = generation
    let release!: () => void
    const appended: string[] = []
    const continuation = new Promise<void>(resolve => { release = resolve }).then(() => {
      if (requestedGeneration === generation) appended.push('stale-recommendation')
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ track: {id:'one'}, drop: [] }) }))
    await musicControl.feedback('one', action)
    release(); await continuation
    expect(commands.filter(c => c.method === 'removeUpcoming')).toEqual([{ method: 'removeUpcoming', knownQueueRevision: -1, ids: [] }])
    expect(appended).toEqual([])
  })

  it('does not invalidate a failed taste write or ordinary played report', async () => {
    const commands: string[] = []
    window.WizardNativeMusic = { onmessage: null, postMessage(raw: string) { commands.push(JSON.parse(raw).method) } }
    const { musicControl } = await import('../src/music/MusicApp')
    musicControl.engine()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({ ok: true, json: async () => ({track:{id:'one'},drop:[]}) }))
    await expect(musicControl.feedback('one', 'like')).rejects.toThrow()
    await musicControl.feedback('one', 'played')
    expect(commands).not.toContain('removeUpcoming')
  })

  it('tolerates a retained older engine without removeUpcoming', async () => {
    const { resetMusicEngineForTests, EMPTY_SNAPSHOT } = await import('../src/music/engine')
    resetMusicEngineForTests({ snapshot: () => EMPTY_SNAPSHOT } as never)
    window.WizardNativeMusic = { onmessage: null, postMessage() {} }
    const { musicControl } = await import('../src/music/MusicApp')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({track:{id:'one'},drop:['two']}) }))
    await expect(musicControl.feedback('one', 'like')).resolves.toMatchObject({drop:['two']})
  })
})
