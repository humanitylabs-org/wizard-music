import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// Miguel, 3 Nov 2026: "when the player is open it looks really clean ... I need [browsing] to look equally clean."
// Browse wears Now Playing's material and type, takes colours only from the skin's roles and lays out by window width.
const appearance = readFileSync(new URL('../src/wizard-appearance.css', import.meta.url), 'utf8')
const music = readFileSync(new URL('../src/music/music.css', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8')
const source = readFileSync(new URL('../src/music/MusicApp.tsx', import.meta.url), 'utf8')
const browse = music.slice(music.indexOf('/* Browse (the library'), music.indexOf('.music-art { flex: none;'))

describe('browse view looks like the player', () => {
  it('paints the Now Playing material (overlay over the opaque skin base) behind the library when hosted', () => {
    const rule = appearance.split('\n').find((line) => line.startsWith(':root[data-wz-hosted] .music-shell {')) || ''
    expect(rule).toContain('var(--wz-overlay)')
    expect(rule).toMatch(/var\(--wz-base, var\(--bg\)\); \}$/)
  })
  it('keeps the sticky search on its own opaque band', () => {
    expect(music).toMatch(/\.music-searchbar \{ position: sticky; top: 0;[^}]*background: var\(--top-material/)
    expect(source).toContain('<div className="music-searchbar"><form className="music-search" role="search"')
  })
  it('uses no colour literals in the browse styles', () => {
    expect(browse.length).toBeGreaterThan(2000)
    expect(browse).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  })
  it('lays out by the window width (named container), not the device', () => {
    expect(app).toMatch(/\.music-shell-main \{[^}]*container: musicmain \/ inline-size/)
    expect(music).toContain('@container musicmain (min-width: 640px)')
  })
  it('keeps every browse feature: search, stations, recent, liked, library, account, sources and the online switch', () => {
    for (const label of ['Search music', 'Start a station', 'Recently played', 'Liked songs', 'Your library', 'Music sources', 'Online sources', 'Music you turned down']) expect(source).toContain(label)
    expect(source).toContain('<AccountLibrarySection onOpenNowPlaying={onOpenNowPlaying} notify={notify} />')
  })
})
