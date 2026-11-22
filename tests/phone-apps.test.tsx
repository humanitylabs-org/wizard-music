// @vitest-environment jsdom
// Navidrome library (wizard-music#92, switch navidrome): the Phone music apps card under Sources.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PhoneApps, refreshSwitches } from '../src/music/MusicApp'

let host: HTMLDivElement
let root: Root
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); localStorage.clear() })

function stub(on: boolean, server = 'https://box.tail1.ts.net/wizard-music') {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('api/view/switches')) return new Response(JSON.stringify({ switches: [{ id: 'navidrome', on }] }))
    if (url.endsWith('api/view/navidrome')) return new Response(JSON.stringify({ on, bundled: true, server: on ? server : '' }))
    return new Response('{}', { status: 404 })
  }))
}

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await refreshSwitches(); await new Promise((resolve) => setTimeout(resolve, 0)) })
}

it('shows nothing while the switch is off', async () => {
  stub(false)
  act(() => root.render(<PhoneApps />))
  await settle()
  expect(host.querySelector('[aria-label="Phone music apps"]')).toBeNull()
})

it('shows the Subsonic address once the switch is on', async () => {
  stub(true)
  act(() => root.render(<PhoneApps />))
  await settle()
  const card = host.querySelector('[aria-label="Phone music apps"]')
  expect(card).not.toBeNull()
  expect(card!.querySelector('code')!.textContent).toBe('https://box.tail1.ts.net/wizard-music')
  expect(card!.textContent).toContain('your tailnet signs you in')
})
