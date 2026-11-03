import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const appearance = readFileSync(new URL('../src/wizard-appearance.css', import.meta.url), 'utf8')
const music = readFileSync(new URL('../src/music/music.css', import.meta.url), 'utf8')
const rule = (css: string, sel: string) => css.split('\n').find(l => l.startsWith(sel + ' {')) || ''

// Miguel, 3 Nov 2026: on Landscapes Light the library showed through Now Playing (--wz-overlay is 80 % white and the
// blur may not run), with the mini player visible under Up next.
describe('text-bearing panels are opaque in every skin', () => {
  for (const sel of [':root[data-wz-hosted] .music-now', ':root[data-wz-hosted] .music-mini', ':root[data-wz-hosted] .music-toast']) {
    it(`${sel} paints its tint over the opaque skin base`, () => {
      const r = rule(appearance, sel)
      expect(r).toMatch(/var\(--wz-base, var\(--bg\)\); \}$/)
      expect(r).not.toMatch(/backdrop-filter/)
    })
  }
  it('the mini player steps aside while the full player is open', () => {
    expect(music).toContain('.music-shell:has(> .music-now) > .music-mini { visibility: hidden; }')
  })
})
