// Live check: Now Playing has a Share button that hands the song to the shared WizardApp share sheet,
// signed "From Wizard Music:". Taste/history stays untouched: station, feedback and streams are stubbed.
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const [port = '9205', out = '/tmp/music-share.png'] = process.argv.slice(2)
const core = (process.env.WIZARD_CORE_DIR || '').replace(/\/?$/, '/')
if (core === '/') throw new Error('Set WIZARD_CORE_DIR to the installed Wizard web/core directory')
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => {
    window.__shared = []
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => { window.__shared.push(data) } })
  })
  await page.route('**/wizard-os-home/core/*.js', async r => r.fulfill({ contentType: 'text/javascript', body: await readFile(core + new URL(r.request().url()).pathname.split('/').pop()).catch(() => '') }))
  let home = null
  await page.route('**/wizard-music/api/home', async r => { const res = await r.fetch(); home = await res.json(); await r.fulfill({ response: res, json: home }) })
  await page.route('**/wizard-music/api/station', r => { const tracks = [...(home?.recent ?? []), ...(home?.liked ?? [])].slice(0, 5); r.fulfill({ json: { station: null, tracks } }) })
  await page.route('**/wizard-music/api/feedback', r => r.fulfill({ json: { track: {} } }))
  await page.route('**/wizard-music/stream/**', r => r.abort())
  await page.goto(`http://127.0.0.1:${port}/wizard-music/`)
  await page.locator('.music-tile, .music-row-main').first().waitFor({ timeout: 20000 })
  await page.locator('.music-tile, .music-row-main').first().click()
  const share = page.locator('.music-now-head .music-share')
  await share.waitFor({ timeout: 10000 })
  const label = await share.getAttribute('aria-label')
  const title = await page.locator('.music-now-meta h2').innerText()
  await page.screenshot({ path: out })
  await share.click()
  await page.waitForTimeout(300)
  const shared = await page.evaluate(() => window.__shared)
  const toast = await page.locator('[role=status], .toast').allInnerTexts().catch(() => [])
  const ok = shared.length === 1 && shared[0].text.startsWith('From Wizard Music:\n\n' + title) && (!shared[0].url || /^https:\/\/music\.youtube\.com\/watch\?v=/.test(shared[0].url))
  console.log(JSON.stringify({ ok, label, title, shared, toast, errors }, null, 1))
  if (!ok) process.exitCode = 1
} finally { await browser.close() }
