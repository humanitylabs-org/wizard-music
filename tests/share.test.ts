// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MusicTrack } from '../src/music/engine'
import { shareSong, songShare } from '../src/music/share'

const yt: MusicTrack = { id: 'yt:2R-GE9jbss0', title: 'Innocence', artist: 'A.L.I.S.O.N', album: 'Tape #5', durationMs: 154000, source: 'youtube', art: '', stream: '' }
const lib: MusicTrack = { ...yt, id: 'lib:abc123', source: 'library' }

describe('song share', () => {
  afterEach(() => { delete (window as { WizardApp?: unknown }).WizardApp })

  it('is signed by Wizard Music and carries the YouTube Music link', () => {
    expect(songShare(yt)).toEqual({ title: 'Innocence — A.L.I.S.O.N', text: 'From Wizard Music:\n\nInnocence — A.L.I.S.O.N', url: 'https://music.youtube.com/watch?v=2R-GE9jbss0' })
  })

  it('shares a library song as text only (no private stream link)', () => {
    const share = songShare(lib)
    expect(share.url).toBeUndefined()
    expect(share.text).toBe('From Wizard Music:\n\nInnocence — A.L.I.S.O.N')
  })

  it('uses the shared WizardApp share sheet and stays quiet on success or cancel', async () => {
    const text = vi.fn().mockResolvedValue('shared')
    ;(window as unknown as { WizardApp: unknown }).WizardApp = { share: { text } }
    const notify = vi.fn()
    expect(await shareSong(yt, notify)).toBe('shared')
    expect(text).toHaveBeenCalledWith(songShare(yt))
    text.mockResolvedValue('cancelled')
    expect(await shareSong(yt, notify)).toBe('cancelled')
    expect(notify).not.toHaveBeenCalled()
  })

  it('tells you when it copied instead, or could not share', async () => {
    const notify = vi.fn()
    ;(window as unknown as { WizardApp: unknown }).WizardApp = { share: { text: vi.fn().mockResolvedValue('copied') } }
    await shareSong(yt, notify)
    expect(notify).toHaveBeenLastCalledWith('Copied · sharing isn’t available here')
    ;(window as unknown as { WizardApp: unknown }).WizardApp = {}
    expect(await shareSong(yt, notify)).toBe('unsupported')
    expect(notify).toHaveBeenLastCalledWith('Couldn’t share this song')
  })
})
