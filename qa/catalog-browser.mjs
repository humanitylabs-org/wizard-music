// Real Music build/server and real Connectors handlers; FAKE Google + hub metadata.
// Uses the designated worker's existing shared Wizard core, not a copied/shimmed client.
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

const [target, coreDir, out, scenario, expected] = process.argv.slice(2)
const server = createServer(async (req, res) => {
  if (['/wizard-os-home/core/app-client.js', '/wizard-os-home/core/app-capture.js'].includes(req.url)) {
    try { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(join(coreDir, req.url.split('/').pop()))) }
    catch { res.writeHead(404); res.end() }
    return
  }
  const up = request({ hostname: '127.0.0.1', port: Number(target), path: req.url, method: req.method,
    headers: { ...req.headers, host: '127.0.0.1:' + target, ...(req.headers.origin ? { origin: 'http://127.0.0.1:' + target } : {}) } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
  up.on('error', () => { res.writeHead(502); res.end() }); req.pipe(up)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined })
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const errors = [], requests = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('request', r => requests.push({ url: r.url(), body: r.postData(), headers: r.headers() }))
  await page.goto(`http://127.0.0.1:${server.address().port}/wizard-music/`)
  await page.locator('.music-row').first().waitFor()
  // Catalog lookup is an agent/API capability; the song list carries no per-track catalog control.
  assert.equal(await page.getByRole('button', { name: /connected catalog/i }).count(), 0)
  const outcome = await page.evaluate(async () => {
    const r = await fetch(new URL('api/catalog', document.baseURI), { method: 'POST', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ video_id: 'W8VdVY8diqs' }) })
    const body = await r.json()
    return r.ok ? (body.items?.[0]?.title || 'empty') : body.error
  })
  assert.equal(outcome, expected)
  assert.equal(await page.getByRole('dialog', { name: 'Now playing' }).count(), 0)
  assert.equal(requests.filter(r => /\/api\/station|\/stream\//.test(r.url)).length, 0)
  const catalog = requests.filter(r => r.url.endsWith('/api/catalog'))
  assert.equal(catalog.length, 1)
  assert.deepEqual(JSON.parse(catalog[0].body), { video_id: 'W8VdVY8diqs' })
  assert.equal(catalog[0].headers.authorization, undefined)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
  await page.screenshot({ path: join(out, `catalog-${scenario}-mobile.png`), fullPage: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.screenshot({ path: join(out, `catalog-${scenario}-desktop.png`), fullPage: true })
  assert.deepEqual(errors, [])
  const result = { ok: true, scenario, scope: 'FAKE Google and hub metadata; real Music UI/server + Connectors handlers. No real consent or audio proof.', expected, noPlaybackRequests: true, noBrowserAuthorization: true, noHorizontalOverflow: true, errors }
  await writeFile(join(out, `browser-${scenario}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally { await browser.close(); await new Promise(r => server.close(r)) }
