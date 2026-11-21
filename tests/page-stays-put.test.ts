import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// Issue 99: .music-sr (position: absolute) had the page as its containing block, so it stretched the document far
// below the fixed-height shell and a swipe outside the list dragged the whole Music page up.
const app = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8')

describe('the Music page never scrolls behind the shell', () => {
  it('makes the scrolling main the containing block of its absolute children', () => {
    const rule = app.match(/\.music-shell-main \{[^}]*\}/)?.[0] ?? ''
    expect(rule).toContain('overflow-y: auto')
    expect(rule).toContain('position: relative')
  })
})
