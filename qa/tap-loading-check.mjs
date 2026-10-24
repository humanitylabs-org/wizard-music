// QA: tapping a library song opens Now Playing at once with a loading wheel, then swaps to the real
// player; a failed start closes the sheet again. Station/feedback are mocked so the tester's taste is untouched.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
const port = process.env.PORT || '9205'
const out = process.argv[2] || 'qa-screens'
const lib = Array.from({ length: 3 }, (_, i) => ({ id: `lib${i}`, title: `Library Song ${i}`, artist: `Artist ${i}`, album: 'Album', art: '', durationMs: 180000, source: 'library', stream: `/qa-stream/${i}.wav` }))
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
const page = await ctx.newPage()
const errors = []; page.on('pageerror', (e) => errors.push(e.message))
let release = null, fail = false
await page.route('**/wizard-os-home/core/app-client.js', (r) => r.fulfill({ path: process.env.APP_CLIENT_JS || 'qa/app-client.js', contentType: 'text/javascript' }))
await page.route('**/api/home', (r) => r.fulfill({ json: { sources: [], vibes: [], liked: [], recent: [], library: lib } }))
await page.route('**/api/station', async (r) => {
  await new Promise((resolve) => { release = resolve })
  if (fail) return r.fulfill({ status: 502, json: { error: 'Hub is slow' } })
  r.fulfill({ json: { station: { id: 'qa', title: 'QA station' }, tracks: lib } })
})
await page.route('**/api/feedback', (r) => r.fulfill({ json: { track: lib[0] } }))
await page.route('**/qa-stream/**', (r) => r.fulfill({ path: process.env.SILENT_WAV || 'qa/silent.wav', contentType: 'audio/wav' }))
await page.addInitScript(() => { if (!sessionStorage.getItem('qa-init')) { localStorage.clear(); sessionStorage.setItem('qa-init', '1') } })
await page.goto(`http://127.0.0.1:${port}/wizard-music/`)

// 1. Tap: the sheet is up within one frame-ish, wheel spinning, title shown, before the station answers.
const t0 = Date.now()
await page.getByRole('button', { name: /Library Song 1/ }).first().click()
await page.locator('.music-now-loading .music-wheel').waitFor({ timeout: 1500 })
const openedMs = Date.now() - t0
assert.equal(await page.locator('.music-now-loading h2').textContent(), 'Library Song 1')
assert.equal(await page.locator('.music-wheel').evaluate((el) => getComputedStyle(el).animationName), 'music-spin')
await page.waitForTimeout(400)
await page.screenshot({ path: out + '/music-tap-loading.png' })
console.log(`ok tap opens loading sheet in ${openedMs}ms`)

// 2. Station arrives: same sheet becomes the real player on the tapped song.
release()
await page.locator('.music-now:not(.music-now-loading) .music-now-deck .music-deck-slide:not(.side) h2').waitFor({ timeout: 5000 })
assert.equal(await page.locator('.music-now-deck .music-deck-slide:not(.side) h2').textContent(), 'Library Song 0')
assert.equal(await page.locator('.music-now-loading').count(), 0)
console.log('ok station loaded: loading sheet swapped to the player')

// 3. Back closes the player and stays in Music.
await page.goBack(); await page.waitForTimeout(400)
assert.equal(await page.locator('.music-now').count(), 0)
assert.match(page.url(), /wizard-music/)
console.log('ok Back closes the player, stays in Music')

// 4. A failed start: loading sheet appears, then closes with a toast, no empty layer left behind.
fail = true
await page.getByRole('button', { name: /Library Song 2/ }).first().click()
await page.locator('.music-now-loading').waitFor({ timeout: 1500 })
release()
await page.locator('.music-now').waitFor({ state: 'detached', timeout: 3000 })
console.log('ok failed start closes the loading sheet')
assert.deepEqual(errors, [])
await browser.close()
console.log('PASS tap-loading')
