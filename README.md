# Music · private Wizard test release

Identify UX: a 12-second "enough audio" ring never sends by itself; Find it is available early and the separate 30-second safety cap sends. Audio custody remains capture-first with the existing durable outbox and acknowledgement checks. Sending opens that clip's detail immediately and polls hunting results every two seconds. Recognition timing copy is based on a live forum retry of migrated capture `6639dc87-a6d4-42ca-8c9b-c6eaecca3b34`: 6.13 seconds to `has_leads` on 6 Nov 2026 (one sample, not a latency guarantee).

REUSE shared capture/outbox, sheets, Back and existing player command parser. EXTEND Music search with immediate pending paint plus 250 ms debounce/abort/stale fencing, and Identify's existing view/state. NEW domain presentation only (progress ring). Voice is routed by the device shell from `voice_routes` data, including launcher-only records; Music has no hidden speech receiver or priority claim. The explicit URL `?view=identify&listen=1` starts listening; `q` goes to the existing Music command parser instead. A permission/gesture failure offers Tap to start listening.
Repackages the existing embedded Music web player and music hub, not a new native app. Supports an owner's mounted audio library, search, playback, queue, liked songs and persisted listening state. Ships no music, credentials, history or account. Online catalogs are opt-in; source availability is not guaranteed.

See **SETUP.md** for exact recipient/backend wiring, **API.md** for endpoint and MCP contracts. Requires a Wizard host serving its approved `/wizard-os-home/core/app-client.js`, same-origin gateway routing and private authorization. A bare container port is an API diagnostic, not a complete Wizard preview.

Runtime dependencies: Node 22, Python 3, FFmpeg, mutagen, ytmusicapi and yt-dlp, all declared in Dockerfile/package-lock/hub requirements. React/Vite/TypeScript build dependencies are declared, no sibling checkout dependency. Docker volumes store only the recipient's database/cache and a read-only mounted library. UI session position/queue is in browser localStorage under `wizard-music.session.v1`.

Source lineage: embedded UI from existing Music ae5c008 plus its existing shared WizardApp adoption; hub from existing 8e5a1ba. Only runtime/source files are extracted: historical APKs, research, media, personal env, old git history and owner data are excluded. Package adds portable runtime, private setup, read-only MCP and offline-first source configuration. Native background playback remains a separate shell capability; no APK is included or changed.

Build: `npm ci && npm test && npm run build`, then `docker build -t wizard-music-test .` on the designated build host. Use the image digest in the release receipt for installation.

License: GPL-3.0-only for this package. React is MIT; Vite/Vitest/Playwright are MIT/Apache-2.0; Python is PSF; mutagen is GPL-2.0-or-later, ytmusicapi MIT, yt-dlp Unlicense, FFmpeg LGPL/GPL as distributed by Debian. No third-party recordings are distributed.

Gestures: swipe left/right on the mini player or the Now Playing art/title for next/previous (src/music/swipe.ts). Touch QA: `node qa/swipe-check.mjs` (mocked station/feedback, live :9205 view).
Player: returning to Music while a song plays opens Now Playing full screen; pull it down (from the top of its scroll) to minimise to the mini player.
Returning to Music: the song hides until the phone player answers (never flashes the old one). QA: `node qa/stale-check.mjs`.
