// Live check for wizard-music#115: Music runs hosted in a fake phone shell (the real wizard:background-audio:v1 envelope).
// The phone player moves on while Music is out of sight; coming back must show the current song, or a visible
// "Reconnecting…" state, then the plain error with Try again: never the old song as if it were playing.
// Usage: WIZARD_CORE_DIR=<wizard-ux>/web/core node qa/comeback-check.mjs <app port> <shots dir> [old]
// `old` only reports what it sees (for a Before run on an older build) and asserts nothing.
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const [port = '9205', shots = process.env.TMPDIR || '.', mode = 'new'] = process.argv.slice(2)
const old = mode === 'old'
const core = (process.env.WIZARD_CORE_DIR || '').replace(/\/?$/, '/')
if (core === '/') throw new Error('Set WIZARD_CORE_DIR to the installed Wizard web/core directory')
const base = `http://127.0.0.1:${port}`

const SHELL = `<!doctype html><meta name=viewport content="width=device-width"><style>html,body{margin:0;background:#000}iframe{border:0;width:100vw;height:100vh;display:block}</style>
<iframe class="appframe" src="/wizard-music/"></iframe>
<script>
const s = { queue: [], index: -1, rev: 0, station: null, pos: 0, mode: 'ok', lateMs: 4000, log: [] }
window.__phone = s
window.WizBackgroundAudio = { canAttach: () => true }
setInterval(() => { if (s.index >= 0) s.pos += 1000 }, 1000)
addEventListener('message', (e) => {
  const d = e.data
  if (d?.type !== 'wizard:background-audio:v1' || d.method === 'detach') return
  const p = d.params || {}
  s.log.push({ at: Date.now(), method: d.method, fresh: !!p.fresh })
  const reply = () => {
    if (d.method === 'load') { s.queue = p.queue; s.index = p.index; s.station = p.station; s.rev++; s.pos = 0 }
    if (d.method === 'next') { s.index++; s.pos = 0 }
    const snap = { sessionId: 'phone', index: s.index, playing: true, wantPlaying: true, buffering: false, positionMs: s.pos, durationMs: 200000, station: s.station, queueRevision: s.rev, error: '' }
    if (p.knownQueueRevision !== s.rev) snap.queue = s.queue
    e.source.postMessage({ type: d.type, id: d.id, ok: true, result: snap }, location.origin)
  }
  if (d.method === 'load' || s.mode === 'ok') setTimeout(reply, 80)
  else if (s.mode === 'late') setTimeout(reply, s.lateMs)
})
</script>`

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
const page = await ctx.newPage()
const errors = []; page.on('pageerror', (e) => errors.push(e.message))
await page.route('**/qa-phone-shell/', (r) => r.fulfill({ contentType: 'text/html', body: SHELL }))
await page.route('**/wizard-os-home/core/*.js', async (r) => r.fulfill({ contentType: 'text/javascript', body: await readFile(core + new URL(r.request().url()).pathname.split('/').pop()).catch(() => '') }))
await page.goto(`${base}/qa-phone-shell/`)
let f
for (let i = 0; i < 80 && !f; i++) { f = page.frames().find((x) => x.url().includes('/wizard-music/')); if (!f) await page.waitForTimeout(250) }
await f.evaluate(() => localStorage.clear())
await f.locator('.music-row').first().waitFor({ timeout: 20000 })
// Start the library as a queue through the real hub.
const home = await f.evaluate(() => fetch('/wizard-music/api/home').then((r) => r.json()))
const tracks = home.library.slice(0, 4)
assert.equal(tracks.length, 4, 'needs four library songs')
await ctx.route(/\/wizard-music\/api\/(play|station)$/, (r) => r.fulfill({ json: { tracks, index: 0, station: null } }))
await f.locator('.music-row-main').first().click()
const title = '.music-now .music-deck-slide:not(.side) h2'
await f.locator(title).waitFor({ timeout: 15000 })
await f.waitForFunction(() => document.querySelector('.music-play')?.getAttribute('aria-label') === 'Pause', null, { timeout: 15000 })
console.log('playing', await f.locator(title).textContent())

const setHidden = (h) => f.evaluate((h) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => h ? 'hidden' : 'visible' }); document.dispatchEvent(new Event('visibilitychange')) }, h)
const phone = (patch) => page.evaluate((patch) => Object.assign(window.__phone, patch), patch)
/** What the owner sees right now. */
const look = () => f.evaluate(() => {
  const now = document.querySelector('.music-now'), body = document.querySelector('.music-now-body')
  const play = document.querySelector('.music-now .music-play')
  return { title: document.querySelector('.music-now .music-deck-slide:not(.side) h2')?.textContent,
    visible: body ? Number(getComputedStyle(body).opacity) > 0.05 : false,
    reconnecting: !!now?.classList.contains('music-reconnecting'), playLabel: play?.getAttribute('aria-label'),
    time: document.querySelector('.music-seek-times span')?.textContent,
    status: [...document.querySelectorAll('.music-now .music-status')].map((p) => p.textContent).join(' | '),
    retry: !!document.querySelector('.music-now .music-retry') }
})
/** "Shown as live": visible, not marked reconnecting, and the button claims Pause. */
const live = (v) => v.visible && !v.reconnecting && v.playLabel === 'Pause'
async function hideAndMoveOn() {
  const was = (await look()).title
  await setHidden(true)
  await page.waitForTimeout(400)
  await page.evaluate(() => { window.__phone.index = (window.__phone.index + 1) % window.__phone.queue.length; window.__phone.pos = 12000 })
  return was
}
async function watch(ms, step = 100) {
  const out = []; const t0 = Date.now()
  while (Date.now() - t0 < ms) { out.push({ t: Date.now() - t0, ...(await look()) }); await page.waitForTimeout(step) }
  return out
}
const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(ok ? 'PASS' : 'FAIL', name, detail ? JSON.stringify(detail) : '') }

// 1. Healthy phone: the current song within 1.5 s, and its clock moves.
{
  const was = await hideAndMoveOn(); await setHidden(false)
  const frames = await watch(3000)
  const at15 = frames.filter((x) => x.t <= 1500).at(-1)
  check('healthy: current song within 1.5 s', at15.title !== was && live(at15), at15)
  check('healthy: never the old song as live', !frames.some((x) => x.title === was && live(x)))
  check('healthy: the clock moves', frames.at(-1).time !== at15.time, { from: at15.time, to: frames.at(-1).time })
}
// 2. The phone answers 4 s late.
{
  const was = await hideAndMoveOn(); await phone({ mode: 'late', lateMs: 4000 }); await setHidden(false)
  const frames = await watch(5000)
  const at16 = frames.find((x) => x.t >= 1600)
  check('late: never the old song as live', !frames.some((x) => x.title === was && live(x)), frames.find((x) => x.title === was && live(x)))
  check('late: visible Reconnecting… after 1.5 s, no Play/Pause claim', at16.reconnecting && at16.visible && /Reconnecting/.test(at16.status) && !/^(Play|Pause)$/.test(at16.playLabel || ''), at16)
  const end = frames.at(-1)
  check('late: the real song as soon as the answer lands', end.title !== was && live(end), end)
  await phone({ mode: 'ok' })
}
// 3. A poll lost just before Music went away; the phone is fine again on return.
{
  await phone({ mode: 'drop' }); await page.waitForTimeout(1200)
  const was = await hideAndMoveOn(); await phone({ mode: 'ok' })
  const before = await page.evaluate(() => window.__phone.log.length)
  await setHidden(false)
  await page.waitForTimeout(150)
  const sent = await page.evaluate((n) => window.__phone.log.slice(n), before)
  check('lost poll: the comeback read goes out at once', sent.some((m) => m.method === 'state' && m.fresh), sent)
  const frames = await watch(1500)
  check('lost poll: current song within 1.5 s', frames.at(-1).title !== was && live(frames.at(-1)), frames.at(-1))
  check('lost poll: never the old song as live', !frames.some((x) => x.title === was && live(x)))
}
// 4. The phone never answers: Reconnecting…, then the plain error with Try again within 5 s.
{
  const was = await hideAndMoveOn(); await phone({ mode: 'drop' }); await setHidden(false)
  const frames = await watch(5400, 200)
  const end = frames.at(-1)
  check('no answer: never the old song as live', !frames.some((x) => x.title === was && live(x)), frames.find((x) => x.title === was && live(x)))
  check('no answer: plain error with Try again by 5 s', /did not answer/.test(end.status) && end.retry && end.reconnecting, end)
  await f.locator('.music-now').screenshot({ path: shots + (old ? '/comeback-no-answer-before.png' : '/comeback-no-answer.png') })
  const later = await watch(6000, 1000)
  check('no answer: still not shown as live later', !later.some((x) => live(x)))
  await phone({ mode: 'ok' })
  if (!old && end.retry) {
    await f.locator('.music-now .music-retry').click()
    const back = await watch(1500)
    check('Try again: the real song, error gone', back.at(-1).title !== was && live(back.at(-1)) && !back.at(-1).status, back.at(-1))
  }
}
// 5. Back/forward cache: pagehide, then pageshow(persisted), brings the bridge back.
{
  await f.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
  await page.waitForTimeout(300)
  await page.evaluate(() => { window.__phone.index = (window.__phone.index + 1) % window.__phone.queue.length })
  const want = await page.evaluate(() => window.__phone.queue[window.__phone.index]?.title)
  await f.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
  const frames = await watch(2000)
  check('bfcache: the bridge comes back with the current song', frames.at(-1).title === want && live(frames.at(-1)) && !frames.at(-1).status, { want, got: frames.at(-1) })
}
// Skins: the reconnecting state in a light skin and in the dark fallback.
if (!old) {
  await phone({ mode: 'drop' }); await hideAndMoveOn(); await setHidden(false); await page.waitForTimeout(1700)
  await f.locator('.music-now').screenshot({ path: shots + '/comeback-reconnecting-dark.png' })
  await f.evaluate(() => {
    const r = document.documentElement; r.setAttribute('data-wz-hosted', ''); r.setAttribute('data-color-scheme', 'light')
    for (const [k, v] of Object.entries({ '--wz-base': '#f4efe6', '--wz-canvas': 'transparent', '--wz-surface': '#ffffff', '--wz-surface-raised': '#fbf8f2', '--wz-overlay': 'rgba(250,246,238,.92)', '--wz-border': '#d9d0c0', '--wz-text': '#2a241b', '--wz-text-secondary': '#5f5547', '--wz-text-muted': '#8a7f70' })) r.style.setProperty(k, v)
  })
  await page.waitForTimeout(200)
  await f.locator('.music-now').screenshot({ path: shots + '/comeback-reconnecting-light.png' })
  const c = await f.evaluate(() => getComputedStyle(document.querySelector('.music-reconnecting-note')).color)
  check('light skin: the Reconnecting line uses the skin ink', c === 'rgb(95, 85, 71)', c)
}
check('no page errors', errors.length === 0, errors)
await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `${failed.length} FAILED` : 'ALL PASS')
if (!old) assert.equal(failed.length, 0)
