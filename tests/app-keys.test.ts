// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { allowedAppKey, appKeyName, appKeyTarget, codeKey, installAppKeys, typingIn } from '../src/music/appKeys'

// Wizard app keys, one anchor: ⌥P play/pause, ⌥K next, ⌥J previous, ⌥/ search, on the real visible buttons
// (data-wz-key contract shared with the shell's WizardApp.keys; Music's own handler only acts outside Wizard).
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

const CODES: Record<string, string> = { '/': 'Slash', ',': 'Comma', '.': 'Period', ';': 'Semicolon', ' ': 'Space' }
const codeOf = (k: string) => CODES[k] ?? `Key${k.toUpperCase()}`
// ⌥ by default; a Mac's ⌥P reports key "π", so the handler must read the code.
const press = (k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { key: init.altKey === false ? k : 'π', code: codeOf(k), altKey: true, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}
const counter = (html: string) => {
  document.body.innerHTML = html
  const hits: string[] = []
  document.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => hits.push(b.id)))
  return hits
}
const ev = (code: string, mods: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) =>
  ({ code, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...mods })

describe('app keys contract (⌥ anchor)', () => {
  it('maps event.code to the contract key', () => {
    expect(codeKey('KeyP')).toBe('p')
    expect(codeKey('Slash')).toBe('/')
    expect(codeKey('Comma')).toBe(',')
    expect(codeKey('Period')).toBe('.')
    expect(codeKey('Semicolon')).toBe(';')
    expect(codeKey('Digit1')).toBeNull()
    expect(codeKey('Space')).toBeNull()
    expect(codeKey('ArrowUp')).toBeNull()
    expect(codeKey('BracketLeft')).toBeNull()
  })
  it('allows letters and / , . ; but never the keys Wizard keeps', () => {
    for (const k of ['p', 'k', 'j', '/', ',', '.', ';']) expect(allowedAppKey(k)).toBe(true)
    for (const k of ['h', 'w', 's', 'd', 'v', 'c', '1', '[', ']', 'Space', 'ArrowUp', 'P']) expect(allowedAppKey(k)).toBe(false)
  })
  it('names only ⌥ alone', () => {
    expect(appKeyName(ev('KeyP'))).toBe('p')
    expect(appKeyName(ev('Slash'))).toBe('/')
    expect(appKeyName(ev('KeyP', { altKey: false }))).toBeNull()
    expect(appKeyName(ev('KeyP', { metaKey: true }))).toBeNull()
    expect(appKeyName(ev('KeyP', { ctrlKey: true }))).toBeNull()
    expect(appKeyName(ev('KeyP', { shiftKey: true }))).toBeNull()
    expect(appKeyName(ev('KeyH'))).toBeNull()
  })
  it('⌥P clicks play once (matched by code, not the typed π) and the π is not typed', () => {
    const hits = counter('<button id="play" data-wz-key="p">Play</button>')
    const event = press('p')
    expect(hits).toEqual(['play'])
    expect(event.defaultPrevented).toBe(true)
    press('p', { repeat: true })
    expect(hits).toEqual(['play'])
  })
  it('plain keys never act, nor Space', () => {
    const hits = counter('<button id="play" data-wz-key="p">Play</button><button id="old" data-wz-key="Space">Old</button>')
    const plain = press('p', { altKey: false })
    press(' ', { altKey: false }); press(' ')
    expect(hits).toEqual([])
    expect(plain.defaultPrevented).toBe(false)
  })
  it('ignores other modifiers and typing in a field', () => {
    const hits = counter('<input id="q" type="search"><button id="next" data-wz-key="k">Next</button>')
    press('k', { metaKey: true }); press('k', { ctrlKey: true }); press('k', { shiftKey: true })
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
    const hits = counter('<button id="mini" data-wz-key="p">Mini</button><div role="dialog" aria-modal="true"><button id="sheet" data-wz-key="p">Sheet</button></div>')
    press('p')
    expect(hits).toEqual(['sheet'])
    counter('<button id="search" data-wz-key="/">S</button><div role="dialog" aria-modal="true"><p>x</p></div>')
    expect(appKeyTarget('/')).toBeNull()
  })
  it('⌥/ focuses the search field', () => {
    document.body.innerHTML = '<input id="q" type="search" data-wz-key="/">'
    const event = press('/', { key: '÷' })
    expect(document.activeElement?.id).toBe('q')
    expect(event.defaultPrevented).toBe(true)
  })
  it('stands down when the shell SDK provides WizardApp.keys (never fires twice)', () => {
    const hits = counter('<button id="play" data-wz-key="p">Play</button>')
    ;(window as { WizardApp?: unknown }).WizardApp = { keys: {} }
    const event = press('p')
    expect(hits).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })
  it('stands down when framed inside Wizard (the shell routes ⌥ keys)', () => {
    const hits = counter('<button id="play" data-wz-key="p">Play</button>')
    const parent = vi.spyOn(window, 'parent', 'get').mockReturnValue({} as Window)
    const event = press('p')
    parent.mockRestore()
    expect(hits).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('Music marks its real controls', () => {
  it('no Space mark and only allowed keys anywhere', () => {
    expect(source).not.toContain('data-wz-key="Space"')
    const keys = [...source.matchAll(/data-wz-key="([^"]+)"/g)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) expect(allowedAppKey(k)).toBe(true)
  })
  it('mini player: p play/pause, k next', () => {
    expect(source).toMatch(/className="music-mini-toggle" data-wz-key="p" data-wz-key-label="Play \/ pause"/)
    expect(source).toMatch(/className="music-mini-next" data-wz-key="k" data-wz-key-label="Next"/)
  })
  it('Now Playing: p play/pause, j previous, k next', () => {
    expect(source).toMatch(/className="music-play" data-wz-key="p" data-wz-key-label="Play \/ pause"/)
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
