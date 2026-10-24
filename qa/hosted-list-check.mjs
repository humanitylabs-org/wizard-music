// Live check: hosted (Nebula tokens) Music home at phone size. No per-song catalog buttons; sticky search opaque over the shelf.
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const [port = '9205', out = '/tmp/music-hosted.png'] = process.argv.slice(2)
const core = (process.env.WIZARD_CORE_DIR || '').replace(/\/?$/, '/')
if (core === '/') throw new Error('Set WIZARD_CORE_DIR to the installed Wizard web/core directory')
const tokens = (await readFile(process.env.WIZARD_TOKENS_CSS || new URL('../style-review/tokens.css', 'file://' + core).pathname, 'utf8')).split('}')[0] + '}'
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/wizard-os-home/core/*.js', async r => r.fulfill({ contentType: 'text/javascript', body: await readFile(core + new URL(r.request().url()).pathname.split('/').pop()).catch(() => '') }))
  await page.goto(`http://127.0.0.1:${port}/wizard-music/`)
  await page.addStyleTag({ content: tokens + ' html{background:radial-gradient(120% 80% at 20% 0%,#3a1f7a,#05030c 70%) !important}' })
  await page.evaluate(() => document.documentElement.setAttribute('data-wz-hosted', ''))
  await page.locator('.music-row').first().waitFor({ timeout: 20000 })
  const rows = await page.locator('.music-row').count()
  const catalogButtons = await page.getByRole('button', { name: /connected catalog/i }).count()
  const search = await page.locator('.music-search').evaluate(el => { const s = getComputedStyle(el); return { bg: s.backgroundColor, blur: s.backdropFilter || s.webkitBackdropFilter } })
  await page.locator('.music-shell-main').evaluate(el => { el.scrollTop = 120 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: out })
  console.log(JSON.stringify({ rows, catalogButtons, search, errors }))
} finally { await browser.close() }
