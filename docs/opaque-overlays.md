# Opaque text overlays

Owner rule: a text-bearing floating panel is fully opaque. Scrims may still dim. Keep the existing tint and geometry.

Reuse:
- overlay panel material: REUSE `--wz-panel`
- existing app overlay selectors and layout: EXTEND with opaque backing only
- NEW: none

## Serving source

- Source: `~/apps/wizard-music-releases/a5a0cab`
- Base commit: `a5a0cabd52196f90bdec6148810c164b06baa124`
- Evidence: wizard-music.service WorkingDirectory points at this release; all src CSS bytes match a5a0cab. The owner-live repo is not the serving baseline.

## Pixel regression

Browser: Chromium / Playwright on forum; synthetic CSS-only fixtures; all network requests aborted. No private API or user data.

Five skins (nebula/grove/tide/ember/signal), hosted (`html.wz-hosted` plus the production `data-wz-hosted` marker) and standalone, plus a token-free standalone fallback. Each panel interior must render identically over loud text versus nothing. Exact screenshot byte equality, no tolerance. `will-change: transform` retains the raster layer to stabilize gradient dithering; no panel fill or visible opacity is replaced by the fixture.

- Same final test against unmodified baseline CSS: **15 failing comparisons / 44** (expected failure).
- Patched CSS: **0 failing comparisons / 44**.
- Baseline leaking selectors: `{".music-mini": 5, ".music-now": 5, ".music-toast": 5}`.

```sh
NODE_PATH=<playwright-modules> TOKENS_CSS=<shell-web/kit/wizard-tokens.css> \
  QA_RESULT=after.json node tests/opaque_overlays_browser.cjs
# Negative control: point SOURCE_ROOT at the original CSS tree.
SOURCE_ROOT=<baseline> NODE_PATH=<playwright-modules> \
  TOKENS_CSS=<shell-web/kit/wizard-tokens.css> QA_RESULT=before.json \
  node tests/opaque_overlays_browser.cjs
```

Raw receipts are retained on forum under `/srv/work/opaque-overlays-apps/music/before.json` and `after.json`. Only CSS, this test, and this note changed.

## Deployment handoff — NOT performed

Apply only src/wizard-appearance.css to a copy of the current release, build its Vite assets on forum (npm ci && npm run build), then promote the rebuilt dist assets to the release serving port 9205. Preserve server, hub and owner-only runtime settings. Editing src alone does not change served dist.

Do not promote the entire branch over live code: the branch deliberately starts at the serving revision. Apply only the CSS delta to preserve later or owner-specific release work.
