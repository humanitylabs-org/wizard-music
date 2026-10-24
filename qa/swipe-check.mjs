// Touch QA for swipe next/previous. Mocks station/feedback so James's taste is untouched.
import { chromium } from '/home/telos/apps/wizard-mobile/node_modules/playwright/index.mjs'
import assert from 'node:assert/strict'
const out = process.argv[2] || '/home/telos/.hermes/cache/screenshots'
const tracks = Array.from({ length: 6 }, (_, i) => ({ id: `qa${i}`, title: `QA Song ${i}`, artist: `Artist ${i}`, album: '', art: '', durationMs: 180000, source: 'youtube', stream: `/qa-stream/${i}.wav` }))
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
const page = await ctx.newPage()
const errors = []; page.on('pageerror', (e) => errors.push(e.message))
const feedback = []
await page.route('**/wizard-os-home/core/app-client.js', (r) => r.fulfill({ path: '/home/telos/workspace/wizard-ux/web/core/app-client.js', contentType: 'text/javascript' }))
await page.route('**/api/station', (r) => r.fulfill({ json: { station: { id: 'qa', title: 'QA station' }, tracks } }))
await page.route('**/api/feedback', (r) => { feedback.push(JSON.parse(r.request().postData())); r.fulfill({ json: { track: tracks[0] } }) })
await page.route('**/qa-stream/**', (r) => r.fulfill({ path: '/home/telos/.hermes/cache/scratch/silent.wav', contentType: 'audio/wav' }))
await page.addInitScript(() => { if (!sessionStorage.getItem('qa-init')) { localStorage.clear(); sessionStorage.setItem('qa-init', '1') } })
await page.goto('http://127.0.0.1:9205/wizard-music/')
try { await page.getByRole('button', { name: 'Deep focus' }).click({ timeout: 15000 }) } catch (e) { await page.screenshot({ path: out + '/music-swipe-fail.png' }); console.log('errors', errors, await page.content().then((h) => h.slice(0, 1500))); throw e }
const cdp = await ctx.newCDPSession(page)
async function drag(sel, dx, dy, steps = 8, ms = 240) {
  const box = await page.locator(sel).first().boundingBox()
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let i = 1; i <= steps; i++) { await page.waitForTimeout(ms / steps); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / steps, y: y + dy * i / steps }] }) }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(700)
}
const nowTitle = () => page.locator('.music-now-deck .music-deck-slide:not(.side) h2').textContent()
await page.locator('.music-now').waitFor()
assert.equal(await nowTitle(), 'QA Song 0')
await drag('.music-now-deck .music-deck-slide:not(.side) .music-art-hero', 160, 0)
assert.equal(await nowTitle(), 'QA Song 0'); console.log('ok first song: right swipe bounces back')
// Mid-drag: the current song follows the finger and the next one is visibly sliding in.
{
  const box = await page.locator('.music-now-deck').boundingBox()
  const x = box.x + box.width / 2, y = box.y + 150
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let i = 1; i <= 8; i++) { await page.waitForTimeout(30); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 20 * i, y }] }) }
  const rail = await page.locator('.music-now-deck .music-deck-rail').evaluate((el) => el.style.transform)
  assert.match(rail, /translate3d\(-1[4-6]\dpx/, rail)
  const nextBox = await page.locator('.music-now-deck .music-deck-slide.side').last().boundingBox()
  assert.ok(nextBox.x < 390, 'next song is on screen mid-drag'); console.log('ok mid-drag: rail', rail, 'next slide at x', Math.round(nextBox.x))
  await page.screenshot({ path: out + '/music-swipe-middrag.png' })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(700)
}
const settled = await page.locator('.music-now-deck .music-deck-rail').evaluate((el) => el.style.transform)
assert.equal(settled, 'translate3d(0px, 0px, 0px)', 'recentres after the slide'); console.log('ok recentred after commit')
assert.equal(await nowTitle(), 'QA Song 1'); console.log('ok now-playing swipe left -> next')
await drag('.music-now-deck .music-deck-slide:not(.side) .music-art-hero', -160, -4)
assert.equal(await nowTitle(), 'QA Song 2')
await drag('.music-now-deck .music-deck-slide:not(.side) .music-art-hero', 160, 3)
assert.equal(await nowTitle(), 'QA Song 1'); console.log('ok now-playing swipe right -> previous')
await drag('.music-now-deck .music-deck-slide:not(.side) .music-art-hero', -20, -220)
assert.equal(await nowTitle(), 'QA Song 1'); console.log('ok vertical drag does not change track')
await drag('.music-now-deck .music-deck-slide:not(.side) .music-art-hero', -30, 0, 4, 400)
assert.equal(await nowTitle(), 'QA Song 1'); console.log('ok short slow drag ignored')
await page.screenshot({ path: out + '/music-swipe-now.png' })
await page.getByRole('button', { name: 'Close player' }).click()
const miniTitle = () => page.locator('.music-mini-deck .music-deck-slide:not(.side) strong').textContent()
await page.locator('.music-mini').waitFor()
await drag('.music-mini-deck .music-deck-slide:not(.side)', -150, 2)
assert.equal(await miniTitle(), 'QA Song 2'); console.log('ok mini swipe left -> next')
assert.equal(await page.locator('.music-now').count(), 0, 'swipe must not open player'); console.log('ok swipe did not tap-open the player')
await drag('.music-mini-deck .music-deck-slide:not(.side)', 150, 2)
assert.equal(await miniTitle(), 'QA Song 1'); console.log('ok mini swipe right -> previous')
await page.locator('.music-mini-open').tap()
await page.locator('.music-now').waitFor(); console.log('ok tap still opens player')
// Pull the player down to minimise it.
async function pullDown(dy, steps = 10, ms = 300) {
  const x = 195, y = 260
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let i = 1; i <= steps; i++) { await page.waitForTimeout(ms / steps); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + dy * i / steps }] }) }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(600)
}
await pullDown(60, 10, 600)
assert.equal(await page.locator('.music-now').count(), 1, 'small slow pull springs back'); console.log('ok small pull springs back')
await pullDown(260)
assert.equal(await page.locator('.music-now').count(), 0, 'pull down closes'); console.log('ok swipe down minimises the player')
assert.equal(await page.locator('.music-mini').count(), 1); console.log('ok mini player shows after minimise')
// Leave Music and come back while it plays: full-screen player again.
const playing = await page.evaluate(() => !window.__qaAudio || !window.__qaAudio.paused)
console.log('audio playing', playing)
const setHidden = (h) => page.evaluate((h) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => h ? 'hidden' : 'visible' }); document.dispatchEvent(new Event('visibilitychange')) }, h)
await setHidden(true); await page.waitForTimeout(300); await setHidden(false); await page.waitForTimeout(300)
assert.equal(await page.locator('.music-now').count(), 1, 'returning while playing opens Now Playing'); console.log('ok return while playing -> full screen')
await pullDown(260)
await page.locator('.music-mini-toggle').tap(); await page.waitForTimeout(300)
await setHidden(true); await page.waitForTimeout(300); await setHidden(false); await page.waitForTimeout(300)
assert.equal(await page.locator('.music-now').count(), 0, 'paused + minimised stays on library'); console.log('ok paused & minimised stays on library')
await page.locator('.music-mini-toggle').tap(); await page.waitForTimeout(300)
console.log('before reload', await page.evaluate(() => ({ s: localStorage.getItem('wizard-music.session.v1')?.slice(-120), paused: window.__qaAudio?.paused })))
await page.reload(); await page.waitForTimeout(3000)
console.log('after reload', await page.evaluate(() => ({ mini: !!document.querySelector('.music-mini'), now: !!document.querySelector('.music-now'), paused: window.__qaAudio?.paused, src: window.__qaAudio?.src, native: !!window.WizardNativeMusic })))
await page.locator('.music-now').waitFor({ timeout: 10000 }); console.log('ok cold open while playing -> full screen')
await page.screenshot({ path: out + '/music-now-handle.png' })
const skipped = feedback.filter((f) => f.action === 'skipped').map((f) => f.id)
console.log('skipped feedback', skipped)
assert.deepEqual(skipped, ['qa0', 'qa1', 'qa1'])
assert.deepEqual(errors, [])
console.log('ALL PASS')
await browser.close()
