// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appKeyName, appKeyTarget, installAppKeys, typingIn } from '../src/music/appKeys'

// Wizard app keys: Space play/pause, k next, j previous, / search, on the real visible buttons
// (data-wz-key contract shared with the shell's WizardApp.keys).
const source = readFileSync('src/music/MusicApp.tsx', 'utf8')
const main = readFileSync('src/main.tsx', 'utf8')

let uninstall = () => {}
beforeEach(() => {
  // jsdom lays nothing out: count an element as on screen unless it (or a parent) is display:none.
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    let el: Element | null = this
    while (el) { if ((el as HTMLElement).style?.display === 'none') return [] as unknown as DOMRectList; el = el.parentElement }
    return [{}] as unknown as DOMRectList
  })
  uninstall = installAppKeys(window)
})
afterEach(() => { uninstall(); vi.restoreAllMocks(); document.body.innerHTML = ''; delete (window as { WizardApp?: unknown }).WizardApp })

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}
const counter = (html: string) => {
  document.body.innerHTML = html
  const hits: string[] = []
  document.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => hits.push(b.id)))
  return hits
}

describe('app keys contract', () => {
  it('names keys the way the contract does', () => {
    expect(appKeyName({ key: ' ', altKey: false, ctrlKey: false, metaKey: false })).toBe('Space')
    expect(appKeyName({ key: 'k', altKey: false, ctrlKey: false, metaKey: false })).toBe('k')
    expect(appKeyName({ key: 'ArrowUp', altKey: false, ctrlKey: false, metaKey: false })).toBe('ArrowUp')
    expect(appKeyName({ key: 'k', altKey: true, ctrlKey: false, metaKey: false })).toBeNull()
    expect(appKeyName({ key: 'k', altKey: false, ctrlKey: false, metaKey: true })).toBeNull()
    expect(appKeyName({ key: 'Shift', altKey: false, ctrlKey: false, metaKey: false })).toBeNull()
  })
  it('Space clicks play once and does not scroll the page', () => {
    const hits = counter('<button id="play" data-wz-key="Space">Play</button>')
    const event = press(' ')
    expect(hits).toEqual(['play'])
    expect(event.defaultPrevented).toBe(true)
    press(' ', { repeat: true })
    expect(hits).toEqual(['play'])
  })
  it('ignores modified keys and typing in a field', () => {
    const hits = counter('<input id="q" type="search"><button id="next" data-wz-key="k">Next</button>')
    press('k', { metaKey: true }); press('k', { altKey: true }); press('k', { ctrlKey: true })
    const input = document.getElementById('q')!
    expect(typingIn(input)).toBe(true)
    press('k', {}, input)
    expect(hits).toEqual([])
    press('k')
    expect(hits).toEqual(['next'])
  })
  it('skips hidden and disabled controls and takes the first visible enabled one', () => {
    const hits = counter('<button id="a" data-wz-key="k" disabled>A</button><div style="display:none"><button id="b" data-wz-key="k">B</button></div><button id="c" data-wz-key="k">C</button>')
    press('k')
    expect(hits).toEqual(['c'])
  })
  it('looks only inside the topmost open modal', () => {
    const hits = counter('<button id="mini" data-wz-key="Space">Mini</button><div role="dialog" aria-modal="true"><button id="sheet" data-wz-key="Space">Sheet</button></div>')
    press(' ')
    expect(hits).toEqual(['sheet'])
    // a key the modal does not carry never reaches the page behind it
    counter('<button id="search" data-wz-key="/">S</button><div role="dialog" aria-modal="true"><p>x</p></div>')
    expect(appKeyTarget('/')).toBeNull()
  })
  it('/ focuses the search field', () => {
    document.body.innerHTML = '<input id="q" type="search" data-wz-key="/">'
    const event = press('/')
    expect(document.activeElement?.id).toBe('q')
    expect(event.defaultPrevented).toBe(true)
  })
  it('stands down when the shell SDK provides WizardApp.keys (never fires twice)', () => {
    const hits = counter('<button id="play" data-wz-key="Space">Play</button>')
    ;(window as { WizardApp?: unknown }).WizardApp = { keys: {} }
    const event = press(' ')
    expect(hits).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('Music marks its real controls', () => {
  it('mini player: Space play/pause, k next', () => {
    expect(source).toMatch(/className="music-mini-toggle" data-wz-key="Space" data-wz-key-label="Play \/ pause"/)
    expect(source).toMatch(/className="music-mini-next" data-wz-key="k" data-wz-key-label="Next"/)
  })
  it('Now Playing: Space play/pause, j previous, k next', () => {
    expect(source).toMatch(/className="music-play" data-wz-key="Space"/)
    expect(source).toMatch(/data-wz-key="j" data-wz-key-label="Previous" aria-label="Previous" onClick=\{\(\) => engine\.previous\(\)\}/)
    expect(source).toMatch(/data-wz-key="k" data-wz-key-label="Next" aria-label="Next" onClick/)
  })
  it('search box: / (a click from the SDK focuses it too)', () => {
    expect(source).toContain('aria-label="Search music" enterKeyHint="search" data-wz-key="/" data-wz-key-label="Search" onClick={(event) => event.currentTarget.focus()}')
  })
  it('installs the fallback handler', () => {
    expect(main).toContain('useEffect(() => installAppKeys(), [])')
  })
})
