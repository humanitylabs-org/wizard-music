// Live check: the phone player moves on while Music is out of sight; coming back must never show the old song.
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const [port = '9205', shots = '/home/telos/.hermes/cache/screenshots'] = process.argv.slice(2)
const core = '/home/telos/apps/wizard-os-home/web/core/'
const fakeNative = () => {
  const s = { queue: [], index: -1, playing: false, wantPlaying: false, positionMs: 0, rev: 0, station: null }
  window.__phone = s
  const bridge = { onmessage: null, postMessage(raw) {
    const m = JSON.parse(raw)
    if (m.method === 'load') { s.queue = m.queue; s.index = m.index; s.playing = s.wantPlaying = true; s.station = m.station; s.rev++ }
    const snap = { sessionId: 'phone', index: s.index, playing: s.playing, wantPlaying: s.wantPlaying, buffering: false, positionMs: 1000, durationMs: 200000, station: s.station, queueRevision: s.rev }
    if (m.knownQueueRevision !== s.rev) snap.queue = s.queue
    setTimeout(() => bridge.onmessage?.({ data: JSON.stringify(snap) }), 120) // a slow-ish phone answer
    return Promise.resolve()
  } }
  window.WizardNativeMusic = bridge
}
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true })
await ctx.addInitScript(fakeNative)
const page = await ctx.newPage()
const errors = []; page.on('pageerror', (e) => errors.push(e.message))
await page.route('**/wizard-os-home/core/*.js', async (r) => r.fulfill({ contentType: 'text/javascript', body: await readFile(core + new URL(r.request().url()).pathname.split('/').pop()).catch(() => '') }))
await page.goto(`http://127.0.0.1:${port}/wizard-music/`)
await page.locator('.music-row').first().waitFor({ timeout: 20000 })
await page.locator('.music-row').nth(0).click()
const title = '.music-now .music-deck-slide:not(.side) h2'
await page.locator(title).waitFor({ timeout: 15000 })
const before = await page.locator(title).textContent()
const queueLen = await page.evaluate(() => window.__phone.queue.length)
assert.ok(queueLen > 1, 'need a next song')
const setHidden = (h) => page.evaluate((h) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => h ? 'hidden' : 'visible' }); document.dispatchEvent(new Event('visibilitychange')) }, h)
for (const where of ['now', 'mini']) {
  if (where === 'mini') { await page.getByRole('button', { name: 'Close player' }).click(); await page.locator('.music-mini').waitFor() }
  const sel = where === 'now' ? '.music-now-body' : '.music-mini > *'
  const shown = where === 'now' ? title : '.music-mini-deck .music-deck-slide:not(.side) strong'
  const old = await page.locator(shown).textContent()
  await setHidden(true)
  // The phone moves to the next song while Music is out of sight.
  await page.evaluate(() => { window.__phone.index += 1 })
  await page.waitForTimeout(1500)
  // Coming back: sample every frame until the right song is visible.
  const frames = await page.evaluate(async ({ sel, shown }) => {
    const out = []
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange'))
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => requestAnimationFrame(r))
      out.push({ text: document.querySelector(shown)?.textContent, opacity: getComputedStyle(document.querySelector(sel)).opacity, stale: !!document.querySelector('.music-stale'), now: !!document.querySelector('.music-now') })
    }
    return out
  }, { sel, shown })
  const flashedOld = frames.filter((f) => f.text === old && Number(f.opacity) > 0)
  const final = frames.at(-1)
  if (flashedOld.length) console.log(JSON.stringify(frames.slice(0, 14)))
  console.log(where, 'old', JSON.stringify(old), 'frames showing old song:', flashedOld.length, 'final', JSON.stringify(final))
  assert.equal(flashedOld.length, 0, `${where}: old song flashed`)
  assert.notEqual(final.text, old); assert.equal(Number(final.opacity) > 0.9, true)
}
// Plain return with no song change: the song comes back promptly (within ~0.3s), not blank.
await setHidden(true); await page.waitForTimeout(300); await setHidden(false); await page.waitForTimeout(350)
assert.equal(await page.locator('.music-mini.music-stale').count(), 0); console.log('ok unchanged song reappears promptly')
await page.screenshot({ path: shots + '/music-stale-after.png' })
assert.deepEqual(errors, [])
console.log('ALL PASS', before)
await browser.close()
