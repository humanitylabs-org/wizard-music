// Missing Tuktuk music regression in the real shell, using qa-tab-order's isolated
// storage/static-routing pattern. All task data is synthetic; no owner APIs run.
// SHELL_ROOT=<shell checkout> QA_OUT=<dir> node qa/missing-tuktuk-mix.mjs
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
const root = path.resolve(process.env.SHELL_ROOT)
const out = path.resolve(process.env.QA_OUT || 'qa-output')
await mkdir(out, { recursive: true })
const origin = 'http://music-qa.test'
const app = { id: 'wizard-music', name: 'Music', url: '/wizard-music/' }
const tea = { id: 'mix-tea-music', label: 'Tea music', count: 25 }
const tuktuk = { id: 'mix-tuktuk-music', label: 'Tuktuk music', count: 1 }
const home = { sources: [{ id: 'youtube', name: 'YouTube Music', detail: 'Connected', ok: true }], vibes: [tea, { id: 'focus', label: 'Deep focus' }], liked: [], recent: [], library: [] }
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' }
const browser = await chromium.launch({ headless: true })
const results = []
try {
  for (const desktop of [false, true]) {
    const profile = desktop ? 'desktop' : 'phone'
    const ctx = await browser.newContext({ viewport: desktop ? { width: 1440, height: 1000 } : { width: 412, height: 892 }, hasTouch: !desktop, isMobile: !desktop, deviceScaleFactor: 1, colorScheme: 'dark', serviceWorkers: 'block' })
    let added = false, reads = 0
    const writes = [], errors = []
    await ctx.route('**/*', async r => {
      const q = r.request(), u = new URL(q.url())
      if (u.origin !== origin) return r.abort()
      if (!['GET', 'HEAD'].includes(q.method())) { writes.push(u.pathname); return r.fulfill({ status: 403, json: {} }) }
      if (u.pathname === '/wizard-music/api/home') { reads++; return r.fulfill({ json: { ...home, vibes: added ? [tuktuk, ...home.vibes] : home.vibes } }) }
      let file
      if (u.pathname.startsWith('/wizard-os-home/')) file = path.join(root, 'web', u.pathname.slice('/wizard-os-home/'.length) || 'index.html')
      if (u.pathname.startsWith('/wizard-music/')) file = path.resolve('dist', u.pathname.slice('/wizard-music/'.length) || 'index.html')
      if (file) {
        try { return await r.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body: await readFile(file) }) }
        catch { return r.fulfill({ status: 404, body: '' }) }
      }
      // Model the real welcome.js boot predicate: done storage alone cannot
      // suppress Connect your AI when model/options says no authenticated AI.
      if (u.pathname === '/wizard/hermes/api/model/options') return r.fulfill({ json: { provider: 'openai', providers: [{ slug: 'openai', authenticated: true }] } })
      if (u.pathname === '/wizard/v1/setup') return r.fulfill({ json: { first_run: false } })
      if (u.pathname === '/wizard/v1/apps') return r.fulfill({ json: { apps: [app] } })
      if (u.pathname.endsWith('/api/sessions')) return r.fulfill({ json: { data: [], has_more: false } })
      if (u.pathname === '/wizard/v1/ui-preferences') return r.fulfill({ json: { spaces: [], pinnedChats: [] } })
      if (u.pathname === '/wizard/v1/agents') return r.fulfill({ json: { agents: [] } })
      return r.fulfill({ json: {} })
    })
    await ctx.addInitScript(({ desktop, app }) => {
      localStorage.setItem('wos.welcome.v1', 'done')
      localStorage.setItem('wos.coached', 'true'); localStorage.setItem('wos.voiceTipSeen', 'true')
      localStorage.setItem('wos.shell', desktop ? 'desktop' : 'phone'); localStorage.setItem('wos.skin', 'nebula')
      localStorage.setItem('wux.apps.v1', JSON.stringify([app]))
      if (sessionStorage.getItem('musicSeeded')) return
      sessionStorage.setItem('musicSeeded', '1')
      const wins = { music: { id: 'music', app: 'frame', appId: app.id, url: app.url, title: app.name } }
      const desk = { id: 'music-desk', wins: ['music'], focus: 'music', full: false, mono: false }
      if (desktop) {
        localStorage.setItem('wux.desk.wins', JSON.stringify(wins)); localStorage.setItem('wux.desk.ws', JSON.stringify([desk])); localStorage.setItem('wux.desk.cur', '0'); localStorage.setItem('wux.desk.homeOpen', 'false')
      } else {
        for (const [key, value] of Object.entries({ wins4: wins, strip: [{ id: 'home', home: true, wins: [], focus: null }, desk], idx4: 1, idxDesk: desk.id, stripSeeded: true })) localStorage.setItem('wos.' + key, JSON.stringify(value))
      }
    }, { desktop, app })
    const p = await ctx.newPage()
    p.on('pageerror', e => errors.push(e.message))
    p.setDefaultTimeout(20000)
    await p.goto(origin + '/wizard-os-home/' + (desktop ? 'desktop.html' : ''))
    await p.waitForFunction(desktop => desktop ? !!window.__wux : !!window.__wos, desktop)
    const iframe = p.locator('.win iframe').first()
    await iframe.waitFor()
    const fr = await iframe.elementHandle().then(e => e.contentFrame())
    await fr.getByRole('button', { name: 'Tea music', exact: true }).waitFor()
    const assertVisibleMusic = async name => {
      assert.equal(await p.evaluate(() => !!window.WosWelcome?.active), false, 'welcome must not cover Music')
      assert.equal(await p.evaluate(desktop => desktop ? !!window.__wux && !window.__wos : !!window.__wos && !window.__wux, desktop), true)
      assert(await fr.evaluate(() => innerWidth > 0 && innerHeight > 0), 'Music viewport must have area')
      const button = fr.getByRole('button', { name, exact: true })
      await button.click({ trial: true }) // Playwright checks visibility, hitbox and overlay interception; no playback/write.
      const box = await button.boundingBox(), frameBox = await iframe.boundingBox()
      assert(box && box.width > 0 && box.height > 0)
      assert(frameBox && frameBox.width > 0 && frameBox.height > 0)
      const viewport = p.viewportSize()
      const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      assert(center.x > 0 && center.x < viewport.width && center.y > 0 && center.y < viewport.height)
      assert.equal(await iframe.evaluate((el, pt) => document.elementFromPoint(pt.x, pt.y) === el, center), true, 'Music iframe must be topmost at button')
      return { box, frameBox, viewport }
    }
    await assertVisibleMusic('Tea music')
    assert.equal(await fr.getByRole('button', { name: 'Tuktuk music', exact: true }).count(), 0)
    await fr.evaluate(() => { window.__musicDocument = 'unchanged' })
    const start = Date.now(); added = true
    // No focus or reload: the app remains visibly open while its external data changes.
    await fr.getByRole('button', { name: 'Tuktuk music', exact: true }).waitFor({ timeout: 18000 })
    const appearedMs = Date.now() - start
    assert.equal(await fr.evaluate(() => window.__musicDocument), 'unchanged')
    assert(appearedMs <= 18000)
    await fr.waitForFunction(() => document.documentElement.dataset.skin === 'nebula')
    await p.waitForTimeout(600)
    const nebulaVisibility = await assertVisibleMusic('Tuktuk music')
    await p.screenshot({ path: path.join(out, profile + '-nebula.png'), animations: 'disabled' })
    await fr.getByRole('searchbox').fill('keep this draft')
    // Actual shared palette application, isolated origin only; never owner look state.
    await p.evaluate(() => window.WosSkin.set('grove'))
    await fr.waitForFunction(() => document.documentElement.dataset.skin === 'grove')
    assert.equal(await fr.getByRole('searchbox').inputValue(), 'keep this draft')
    assert.equal(await fr.evaluate(() => window.__musicDocument), 'unchanged')
    await p.waitForTimeout(600)
    const groveVisibility = await assertVisibleMusic('Tuktuk music')
    await p.screenshot({ path: path.join(out, profile + '-grove.png'), animations: 'disabled' })
    const panels = await fr.locator('.music-search').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, image: getComputedStyle(el).backgroundImage, opacity: getComputedStyle(el).opacity }))
    assert.equal(panels.opacity, '1')
    const info = await fr.evaluate(() => ({ width: innerWidth, skin: document.documentElement.dataset.skin, hosted: document.documentElement.hasAttribute('data-wz-hosted'), accent: getComputedStyle(document.documentElement).getPropertyValue('--wz-accent') }))
    assert(info.hosted); assert(info.accent.trim())
    assert.equal(await p.evaluate(desktop => desktop ? !!window.__wux && !window.__wos : !!window.__wos && !window.__wux, desktop), true)
    // Some shell bootstrap preference writes may be refused. They never hit a backend.
    assert(!writes.some(u => /\/v1\/runs$|\/api\/station$|\/api\/feedback$/.test(u)))
    assert.deepEqual(errors, [])
    results.push({ profile, appearedMs, reads, info, panels, visibility: { nebula: nebulaVisibility, grove: groveVisibility }, refusedWrites: writes, screenshots: ['nebula', 'grove'].map(s => path.join(out, profile + '-' + s + '.png')) })
    await ctx.close()
  }
} finally { await browser.close() }
await import('node:fs/promises').then(fs => fs.writeFile(path.join(out, 'missing-tuktuk-mix.json'), JSON.stringify({ results, coverage: 'Real shell and app, synthetic origin/data; not physical devices or live serving proof' }, null, 2)))
console.log(JSON.stringify(results))
console.log('PASS missing Tuktuk music: bounded visible refresh and live skins, phone + desktop')
