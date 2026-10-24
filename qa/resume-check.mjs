// Live check: Music comes back on the same song, at the same spot, on Now Playing, after the page (web player)
// or the phone's native player (simulated empty after an app update) is gone.
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const [port = '9205', shots = '/tmp'] = process.argv.slice(2)
const core = (process.env.WIZARD_CORE_DIR || '').replace(/\/?$/, '/')
if (core === '/') throw new Error('Set WIZARD_CORE_DIR to the installed Wizard web/core directory')
const base = `http://127.0.0.1:${port}/wizard-music/`

// A stand-in for the phone's background player: it remembers nothing across page loads, like after an update.
const fakeNative = () => {
  const s = { queue: [], index: -1, playing: false, wantPlaying: false, positionMs: 0, rev: 0, station: null }
  window.__cmds = []
  const bridge = { onmessage: null, postMessage(raw) {
    const m = JSON.parse(raw); window.__cmds.push(m.method)
    if (m.method === 'load') { s.queue = m.queue; s.index = m.index; s.positionMs = 0; s.playing = s.wantPlaying = true; s.station = m.station; s.rev++ }
    if (m.method === 'pause') s.playing = s.wantPlaying = false
    if (m.method === 'play') s.playing = s.wantPlaying = true
    if (m.method === 'seek') s.positionMs = m.positionMs
    const snap = { sessionId: 'phone', index: s.index, playing: s.playing, wantPlaying: s.wantPlaying, buffering: false, positionMs: s.positionMs, durationMs: 200000, station: s.station, queueRevision: s.rev }
    if (m.knownQueueRevision !== s.rev) snap.queue = s.queue
    setTimeout(() => bridge.onmessage?.({ data: JSON.stringify(snap) }), 30)
    return Promise.resolve()
  } }
  window.WizardNativeMusic = bridge
}

async function run(browser, mode) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true })
  if (mode === 'native') await ctx.addInitScript(fakeNative)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/wizard-os-home/core/*.js', async r => r.fulfill({ contentType: 'text/javascript', body: await readFile(core + new URL(r.request().url()).pathname.split('/').pop()).catch(() => '') }))
  await page.goto(base)
  await page.locator('.music-row').first().waitFor({ timeout: 20000 })
  await page.locator('.music-row').nth(1).click()
  await page.waitForTimeout(1500)
  if (!(await page.locator('.music-now').count())) await page.locator('.music-mini-open').click()
  await page.locator('.music-now .music-deck-slide:not(.side) h2').waitFor({ timeout: 15000 })
  await page.waitForTimeout(3000)
  const title = (await page.locator('.music-now .music-deck-slide:not(.side) h2').textContent()).trim()
  // Jump to 1:13 and pause, as if you'd been listening a while.
  await page.locator('.music-play[aria-label=Pause]').click()
  const slider = page.locator('.music-now input[type=range]')
  if (await slider.count()) await slider.evaluate((el) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '73000'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })) })
  await page.waitForTimeout(5000)
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  const clockBefore = await page.locator('.music-seek-times span').first().textContent()
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('wizard-music.session.v1') || 'null'))
  // The update: the page and (in native mode) the player's memory are gone.
  await page.reload()
  await page.locator('.music-now').waitFor({ timeout: 15000 })
  await page.waitForTimeout(1500)
  const after = await page.evaluate(() => ({ title: document.querySelector('.music-now .music-deck-slide:not(.side) h2')?.textContent, clock: document.querySelector('.music-seek-times span')?.textContent, play: document.querySelector('.music-play')?.getAttribute('aria-label'), cmds: window.__cmds || null }))
  await page.screenshot({ path: `${shots}/music-resume-${mode}.png` })
  await page.goBack()
  await page.waitForTimeout(500)
  const backToLibrary = await page.locator('.music-now').count() === 0 && await page.locator('.music-row').count() > 0
  await ctx.close()
  return { mode, before: { title, clock: clockBefore, savedSpot: saved?.positionMs, savedTrack: saved?.queue?.[saved.index]?.title }, after, backToLibrary, errors }
}

const browser = await chromium.launch({ headless: true })
try {
  for (const mode of ['web', 'native']) console.log(JSON.stringify(await run(browser, mode)))
} finally { await browser.close() }
