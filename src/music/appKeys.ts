/**
 * Wizard app keys (the shared contract): a control marked `data-wz-key="<key>"` (and optionally
 * `data-wz-key-label`) is clicked by a plain keypress. Keys are 'Space', 'Enter', 'ArrowUp/Down/Left/Right'
 * or one lower-case printable character. The shell's WizardApp SDK (`/wizard-os-home/core/app-client.js`,
 * `WizardApp.keys`) does this and draws the keycaps while ⌥ is held. This is the same rule set as a fallback
 * for Wizards whose SDK has no `keys` yet; it stands down whenever `window.WizardApp.keys` exists, so a key
 * never fires twice.
 *
 * Rules: no Alt/Ctrl/Meta; never while typing in a field; the first visible, enabled match wins, looked up
 * inside the topmost open modal when one is open (nothing behind it).
 */

const NAMED: Record<string, string> = { ' ': 'Space', Spacebar: 'Space', Enter: 'Enter', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' }
const NON_TEXT_INPUTS = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'])

/** The contract name of a keypress, or null when it can never be an app key. */
export function appKeyName(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey'>): string | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  if (NAMED[event.key]) return NAMED[event.key]
  return event.key.length === 1 && event.key !== ' ' ? event.key : null
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

/** Press a marked control: fields take focus (the "/ = search" key), everything else is clicked. */
export function pressAppKey(el: HTMLElement) {
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { el.focus(); return }
  el.click()
}

/** Install the fallback handler on `win`. Returns the uninstall function. */
export function installAppKeys(win: Window = window): () => void {
  const onKey = (event: KeyboardEvent) => {
    if ((win as Window & { WizardApp?: { keys?: unknown } }).WizardApp?.keys) return
    if (event.defaultPrevented || event.isComposing) return
    const key = appKeyName(event)
    if (!key || typingIn(event.target)) return
    const el = appKeyTarget(key, win.document)
    if (!el) return
    // Space must neither scroll the page nor also press a focused button; a held key presses once.
    event.preventDefault()
    if (event.repeat) return
    pressAppKey(el)
  }
  win.addEventListener('keydown', onKey)
  return () => win.removeEventListener('keydown', onKey)
}
