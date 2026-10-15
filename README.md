# Music · private Wizard test release
Repackages the existing embedded Music web player and music hub, not a new native app. Supports an owner's mounted audio library, search, playback, queue, liked songs and persisted listening state. Ships no music, credentials, history or account. Online catalogs are opt-in; source availability is not guaranteed.

See **SETUP.md** for exact recipient/backend wiring, **API.md** for endpoint and MCP contracts. Requires a Wizard host serving its approved `/wizard-os-home/core/app-client.js`, same-origin gateway routing and private authorization. A bare container port is an API diagnostic, not a complete Wizard preview.

Runtime dependencies: Node 22, Python 3, FFmpeg, mutagen, ytmusicapi and yt-dlp, all declared in Dockerfile/package-lock/hub requirements. React/Vite/TypeScript build dependencies are declared, no sibling checkout dependency. Docker volumes store only the recipient's database/cache and a read-only mounted library. UI session position/queue is in browser localStorage under `wizard-music.session.v1`.

Source lineage: embedded UI from existing Music ae5c008 plus its existing shared WizardApp adoption; hub from existing 8e5a1ba. Only runtime/source files are extracted: historical APKs, research, media, personal env, old git history and owner data are excluded. Package adds portable runtime, private setup, read-only MCP and offline-first source configuration. Native background playback remains a separate shell capability; no APK is included or changed.

Build: `npm ci && npm test && npm run build`, then `docker build -t wizard-music-test .` on the designated build host. Use the image digest in the release receipt for installation.

License: GPL-3.0-only for this package. React is MIT; Vite/Vitest/Playwright are MIT/Apache-2.0; Python is PSF; mutagen is GPL-2.0-or-later, ytmusicapi MIT, yt-dlp Unlicense, FFmpeg LGPL/GPL as distributed by Debian. No third-party recordings are distributed.
