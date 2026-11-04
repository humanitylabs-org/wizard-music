import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// Miguel, 4 Nov 2026: "I basically want every app to be extremely friendly, easy to use, intuitive, and also mobile
// friendly." Thumb-sized controls on touch screens, no double bottom gap inside a Wizard window, one-tap Back.
const music = readFileSync(new URL('../src/music/music.css', import.meta.url), 'utf8')
const appearance = readFileSync(new URL('../src/wizard-appearance.css', import.meta.url), 'utf8')
const source = readFileSync(new URL('../src/music/MusicApp.tsx', import.meta.url), 'utf8')
const coarse = music.slice(music.indexOf('@media (pointer: coarse) {'))

describe('friendly on a phone', () => {
  it('gives every small control a 44px target on touch screens only', () => {
    expect(coarse.length).toBeGreaterThan(50)
    expect(coarse).toMatch(/\.music-pill, \.music-played-toggle \{ min-height: 44px; \}/)
    expect(coarse).toMatch(/\.music-round, \.music-clear \{ width: 44px; height: 44px; \}/)
    expect(coarse).toMatch(/\.music-mini-down, \.music-mini-toggle, \.music-mini-next, \.music-mini-close \{ width: 44px;/)
    // desktop keeps the compact sizes
    expect(music).toMatch(/\.music-mini-close \{ width: 38px;/)
  })
  it('adds no second safe-area gap under the mini player inside a Wizard window (full screen keeps it)', () => {
    expect(appearance).toContain(':root[data-wz-hosted]:not([data-presentation="immersive"]) .music-shell .music-mini { margin-bottom: 8px; }')
    expect(appearance).toContain(':root[data-wz-hosted]:not([data-presentation="immersive"]) .music-now-body { padding-bottom: 24px; }')
  })
  it('lets Back leave search results for Music home through the shared WizardApp back stack', () => {
    expect(source).toMatch(/useLayoutEffect\(\(\) => window\.WizardApp\?\.back\?\.register\?\.\(\{\s*canGoBack: \(\) => resultsRef\.current !== null,/)
    expect(source).toContain('back: () => { if (resultsRef.current === null) return false; clearSearch(); return true }')
    // the phone's Back pops Music's own history entry for the results, never the shell's
    expect(source).toContain("if (showingResults && at !== 'search' && at !== 'now') history.pushState({ wizardMusic: 'search' }, '')")
    expect(source).toContain("if (!showingResults && at === 'search') history.back()")
    expect(source).toContain('aria-label="Clear search" onClick={clearSearch}')
  })
})
