# Synthetic overlay pixel regression

This preserves the browser guard from #15 after #20 replaced its material CSS.
It does not copy the old CSS, rebuild the app, change the selected image, or
claim that the current app has passed this browser guard.

On the admitted Linux worker, install the repository's pinned dependencies and
Playwright Chromium, then run:

```sh
TOKENS_CSS=<absolute path to pinned shell wizard-tokens.css> \
  QA_RESULT=opacity-current.json npm run test:opaque-overlays
SOURCE_ROOT=<unchanged pre-fix source checkout> \
  TOKENS_CSS=<same pinned shell wizard-tokens.css> \
  QA_RESULT=opacity-baseline.json npm run test:opaque-overlays
```

Keep the exact source revisions and token stylesheet identity with both results.
The baseline is expected to fail; the candidate must pass the identical test.
The harness compares panel interiors over loud background text and over nothing,
with exact screenshot equality. It loads app CSS only, blocks network requests,
and never loads an app script or private data. Missing or empty token input is
an error, rather than an accidental fallback-only pass.

The fixed inventory is four panels, five original palette names, hosted and
standalone, plus four token-free standalone cases: 44 fixture comparisons. This
is a preserved synthetic fixture inventory, not proof that every current skin
package was actually loaded. Modern package skins (including the light skin in
the newer report), live skin switching, real app geometry, phone/desktop shell
integration and native WebKit remain separate acceptance. The fixtures normalize
geometry and visibility; they do not test the mini player's hide/show behavior.

This separate command is not called by `npm test` or image CI. Wiring an admitted
browser run into normal automation, pinning actual skin-package styles, and
retaining the failing-first/current CSS results are unfinished work. The current
source changes are test preservation only. Do not merge on syntax checks alone.
