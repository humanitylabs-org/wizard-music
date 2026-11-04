/**
 * Wizard app keys (the shared contract, one anchor): a control marked `data-wz-key="<key>"` (and optionally
 * `data-wz-key-label`) is pressed by ⌥ + that key. A key is one lower-case letter or one of '/', ',', '.', ';'.
 * Wizard keeps digits, [ ], arrows, h, w, s, space, d, v and c for itself, so apps never mark those.
 *
 * Inside Wizard the shell routes ⌥+key to the app's marked control and draws the keycaps while ⌥ is held.
 * This file is the app's own fallback for when Music runs on its own (not framed in Wizard) and no
 * `window.WizardApp.keys` exists, so a key never fires twice. Plain keys never do anything.
 *
 * Rules: ⌥ alone (no Ctrl/Meta/Shift); matched by `event.code` (a Mac's ⌥P types "π"); never while typing in
 * a field; a held key presses once; the first visible, enabled match wins, looked up inside the topmost
 * open modal when one is open (nothing behind it).
 */

const RESERVED = new Set(['h', 'w', 's', 'd', 'v', 'c'])
const PUNCT: Record<string, string> = { Slash: '/', Comma: ',', Period: '.', Semicolon: ';' }
const NON_TEXT_INPUTS = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'])

type KeyLike = Pick<KeyboardEvent, 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

/** The contract key an `event.code` stands for ('KeyP' -> 'p', 'Slash' -> '/'), or null. */
export function codeKey(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1].toLowerCase()
  return PUNCT[code] ?? null
}

/** True for a key an app may mark: one lower-case letter or / , . ; and not one Wizard keeps. */
export function allowedAppKey(key: string): boolean {
  return (/^[a-z]$/.test(key) && !RESERVED.has(key)) || key === '/' || key === ',' || key === '.' || key === ';'
}

/** The app key an ⌥ keypress names, or null (plain keys, other modifiers, reserved keys). */
export function appKeyName(event: KeyLike): string | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null
  const key = codeKey(event.code)
  return key && allowedAppKey(key) ? key : null
}

/** True while the owner is typing: a text field, a select, or anything editable has focus. */
export function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  if (el.isContentEditable || el.closest('[contenteditable=""], [contenteditable="true"]')) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  return tag === 'INPUT' && !NON_TEXT_INPUTS.has(((el as HTMLInputElement).type || 'text').toLowerCase())
}

function visible(el: Element): boolean {
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  if (!el.getClientRects().length) return false
  const style = el.ownerDocument.defaultView?.getComputedStyle(el)
  return !style || (style.visibility !== 'hidden' && style.display !== 'none')
}

function enabled(el: Element): boolean {
  return !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true' && !el.closest('fieldset[disabled]')
}

/** The topmost open modal (last in document order), or null. */
export function topModal(doc: Document = document): Element | null {
  const open = [...doc.querySelectorAll('dialog[open], [aria-modal="true"]')].filter(visible)
  return open[open.length - 1] ?? null
}

/** The control a key would press now, or null. */
export function appKeyTarget(key: string, doc: Document = document): HTMLElement | null {
  const scope: ParentNode = topModal(doc) ?? doc
  for (const el of scope.querySelectorAll<HTMLElement>('[data-wz-key]')) {
    if (el.dataset.wzKey === key && visible(el) && enabled(el)) return el
  }
  return null
}

/** Press a marked control: fields take focus (the "⌥/ = search" key), everything else is clicked. */
export function pressAppKey(el: HTMLElement) {
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { el.focus(); return }
  el.click()
}

/** True when this fallback should act: not framed inside Wizard and no shell SDK keys. */
export function fallbackActive(win: Window = window): boolean {
  if (win.parent !== win) return false
  return !(win as Window & { WizardApp?: { keys?: unknown } }).WizardApp?.keys
}

/** Install the fallback handler on `win`. Returns the uninstall function. */
export function installAppKeys(win: Window = window): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (!fallbackActive(win)) return
    if (event.defaultPrevented || event.isComposing) return
    const key = appKeyName(event)
    if (!key || typingIn(event.target)) return
    const el = appKeyTarget(key, win.document)
    if (!el) return
    // ⌥+key must not also type its character (π, ÷); a held key presses once.
    event.preventDefault()
    if (event.repeat) return
    pressAppKey(el)
  }
  win.addEventListener('keydown', onKey)
  return () => win.removeEventListener('keydown', onKey)
}
