// James, 28 Oct 2026: text-bearing overlays are solid; scrims may dim.
// Synthetic CSS-only fixtures. No app scripts, private APIs, recordings or user data.
// Run: NODE_PATH=<playwright modules> TOKENS_CSS=<shell wizard-tokens.css> node tests/opaque_overlays_browser.cjs
// Optional SOURCE_ROOT points at unmodified live CSS for the required negative control.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const config = {
  "files": [
    "src/app.css",
    "src/music/music.css",
    "src/wizard-appearance.css"
  ],
  "panels": [
    {
      "sel": ".music-toast",
      "html": "<section class=\"music-toast\"><h3>Overlay title</h3><p>Synthetic text only</p></section>"
    },
    {
      "sel": ".music-mini",
      "html": "<section class=\"music-mini\"><h3>Overlay title</h3><p>Synthetic text only</p></section>"
    },
    {
      "sel": ".music-now",
      "html": "<section class=\"music-now\"><h3>Overlay title</h3><p>Synthetic text only</p></section>"
    },
    {
      "sel": ".music-search",
      "html": "<section class=\"music-search\"><h3>Overlay title</h3><p>Synthetic text only</p></section>"
    }
  ]
};
const root = process.env.SOURCE_ROOT || path.join(__dirname, '..');
const css = config.files.map(f => {
  const text = fs.readFileSync(path.join(root, f), 'utf8');
  return f.endsWith('.html') ? [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n') : text;
}).join('\n');
const tokens = process.env.TOKENS_CSS ? fs.readFileSync(process.env.TOKENS_CSS, 'utf8') : '';
const skins = tokens ? ['nebula', 'grove', 'tide', 'ember', 'signal', 'fallback'] : ['fallback'];
const loud = Array.from({length: 40}, (_, i) => `<p style="margin:0;font:900 26px/30px sans-serif;color:${i % 2 ? '#fff' : '#ff0'}">BEHIND TEXT ${i} WWWWWWWWWWWWW</p>`).join('');
(async () => {
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
  const results = [];
  try {
    const page = await browser.newPage({viewport: {width: 390, height: 720}, deviceScaleFactor: 1});
    await page.route('**/*', route => route.abort());
    for (const skin of skins) for (const hosted of (skin === 'fallback' ? [false] : [true, false])) for (const fixture of config.panels) {
      await page.setContent(`<!doctype html><html data-skin="${skin}" ${hosted ? 'class="wz-hosted" data-wz-hosted="1"' : ''}><head><style>${skin === 'fallback' ? '' : tokens}\n${css}</style></head><body class="${config.bodyClass || ''}" style="background:#05030c"><div id="behind" style="position:fixed;inset:0;z-index:0">${loud}</div>${fixture.html}</body></html>`);
      const el = page.locator(fixture.sel);
      assert.equal(await el.count(), 1, `exact fixture: ${fixture.sel}`);
      // Normalize geometry/visibility only: never replace fill, backdrop filter or visible alpha.
      await el.evaluate(e => {
        Object.assign(e.style, {position:'fixed', inset:'auto', left:'30px', top:'80px', width:'330px', height:'200px', minWidth:'0', minHeight:'0', maxWidth:'none', maxHeight:'none', margin:'0', boxSizing:'border-box', transform:'none', animation:'none', transition:'none', zIndex:'200', willChange:'transform'});
        if (getComputedStyle(e).display === 'none') e.style.display = 'block';
        if (getComputedStyle(e).visibility === 'hidden') e.style.visibility = 'visible';
        if (Number(getComputedStyle(e).opacity) === 0) e.style.opacity = '1';
      });
      const b = await el.boundingBox(); assert(b && b.width > 100 && b.height > 80, `${fixture.sel} rendered`);
      // Well inside rounded/pill corners. Keep exact equality; never a tolerance.
      const clip = {x: b.x + 48, y: b.y + 48, width: b.width - 96, height: b.height - 96};
      await page.evaluate(() => document.getElementById('behind').style.visibility = 'visible');
      const over = await page.screenshot({clip});
      await page.evaluate(() => document.getElementById('behind').style.visibility = 'hidden');
      const bare = await page.screenshot({clip});
      results.push({skin, hosted, sel: fixture.sel, opaque: over.equals(bare), ...await el.evaluate(e => ({background: getComputedStyle(e).background, opacity: getComputedStyle(e).opacity}))});
    }
  } finally { await browser.close(); }
  const report = {checked: results.length, failures: results.filter(r => !r.opaque), results};
  if (process.env.QA_RESULT) fs.writeFileSync(process.env.QA_RESULT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({checked: report.checked, failures: report.failures}, null, 2));
  assert.equal(report.failures.length, 0, 'text-bearing overlay pixels must not depend on content behind them');
  console.log('PASS opaque overlays');
})().catch(e => { console.error(e); process.exitCode = 1; });
