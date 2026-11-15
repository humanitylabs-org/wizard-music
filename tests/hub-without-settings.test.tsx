// @vitest-environment jsdom
// Issue 68 (15 Nov 2026): an older hub (before the Online sources consent switch, e.g. the forum hub 7d648ea) sends
// /api/home without `settings` and has no /api/settings. Music read that as "off": a wrong, broken switch at the top
// and no account library, while the hub really ran online. Now its own online source row decides and the switch hides.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MusicApp } from '../src/music/MusicApp'
import { readFileSync } from 'node:fs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve() }
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const source = (enabled: boolean) => ({ id: 'youtube', name: 'Online sources', status: enabled ? 'enabled' : 'disabled', detail: '', ok: enabled })
const track = { id: 'lib:1', title: 'Song', artist: 'Artist', album: '', durationMs: 200000, source: 'library', art: '', stream: '' }
let home: Record<string, unknown>, urls: string[], root: Root | null, host: HTMLDivElement | null

beforeEach(() => {
  urls = []
  localStorage.clear()
  vi.stubGlobal('WizardApp', { view: { isVisible: () => true } })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(String(url))
    if (url.includes('/api/view/switches')) return ok({ switches: [] })
    if (url.includes('/api/home')) return ok(home)
    return ok({})
  }))
})
afterEach(async () => {
  await act(async () => { await flush(); root?.unmount() })
  host?.remove(); root = null; host = null
  vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear()
})

async function mountMusic() {
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<MusicApp onOpenNowPlaying={() => undefined} notify={() => undefined} />); await flush() })
  return host
}
const base = { vibes: [], liked: [], recent: [], library: [track], taste: { avoid: [] } }
const consentCard = (view: HTMLElement) => view.querySelector('section[aria-label="Online sources"]')

describe('a hub without settings (issue 68)', () => {
  it('online old hub: no Online sources switch; no account library (that hub has none, it would only error)', async () => {
    home = { ...base, sources: [source(true)] }
    const view = await mountMusic()
    expect(view.querySelector('section[aria-label="Your library"]')).not.toBeNull()
    expect(consentCard(view)).toBeNull()
    expect(view.querySelector('input[aria-label="Online sources"]')).toBeNull()
    expect(urls.some((u) => u.includes('/api/account-library'))).toBe(false)
  })

  it('offline old hub: still no broken switch, and no account library', async () => {
    home = { ...base, sources: [source(false)] }
    const view = await mountMusic()
    expect(consentCard(view)).toBeNull()
    expect(urls.some((u) => u.includes('/api/account-library'))).toBe(false)
  })

  it('a current hub with settings on keeps the switch (on) and the account library', async () => {
    home = { ...base, sources: [source(true)], settings: { online: true } }
    const view = await mountMusic()
    expect((view.querySelector('input[aria-label="Online sources"]') as HTMLInputElement).checked).toBe(true)
    expect(urls.some((u) => u.includes('/api/account-library'))).toBe(true)
  })

  it('a current hub with settings keeps the switch exactly as before', async () => {
    home = { ...base, sources: [source(false)], settings: { online: false } }
    const view = await mountMusic()
    const input = view.querySelector('input[aria-label="Online sources"]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.checked).toBe(false)
  })

  it('the server catalog gate falls back to the home source row when the hub has no /api/settings', () => {
    const server = readFileSync('server/index.mjs', 'utf8')
    expect(server).toContain("settings.status === 404")
    expect(server).toContain("hubGet('/api/home')")
  })
})
