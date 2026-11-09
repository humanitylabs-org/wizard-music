# Wizard Music

Identify UX: a 12-second "enough audio" ring never sends by itself; Find it is available early and the separate 30-second safety cap sends. Audio custody remains capture-first with the existing durable outbox and acknowledgement checks. Sending opens that clip's detail immediately and polls hunting results every two seconds. Recognition timing copy is based on a live forum retry of migrated capture `6639dc87-a6d4-42ca-8c9b-c6eaecca3b34`: 6.13 seconds to `has_leads` on 6 Nov 2026 (one sample, not a latency guarantee).

REUSE shared capture/outbox, sheets, Back and existing player command parser. EXTEND Music search with immediate pending paint plus 250 ms debounce/abort/stale fencing, and Identify's existing view/state. NEW domain presentation only (progress ring). Voice is routed by the device shell from `voice_routes` data, including launcher-only records; Music has no hidden speech receiver or priority claim. The explicit URL `?view=identify&listen=1` starts listening; `q` goes to the existing Music command parser instead. A permission/gesture failure offers Tap to start listening.

Your music library inside Wizard, with a player, search, radio, liked songs and saved mixes. This MIT-licensed test release ships no music, account, history or credentials.

**Install:** in the Wizard App Store’s Alpha channel, choose Music → Get → Open. Turn on Online sources if you want catalog search and radio, or add your own audio files. No manual server configuration is needed. See [SETUP.md](SETUP.md) for first-song instructions and optional advanced integrations, and [API.md](API.md) for the API/MCP contract.

Online sources are off by default; searches and track details leave the box only after consent. Provider availability and region restrictions vary. Use only recordings you are authorized to access.

## Runtime and development

Node 22, Python 3, FFmpeg, tinytag, ytmusicapi and yt-dlp are declared in Dockerfile/package-lock/hub requirements. The image initializes the data mount and a random server-only token, then runs both servers as uid1000 with no effective capabilities. The library is read-only. Wizard provides its shared App client, same-origin authenticated gateway, Appearance v1, Back and sharing.

`npm ci && npm test && npm run build`; hub: `uv run --no-project --with pytest --with-requirements requirements.txt -- python -m pytest -q tests` from `hub/`; offline: `python qa/test_offline.py`. Sustained builds run on the designated worker or GitHub Actions. The shared Actions builder produces native amd64/arm64 images; release smoke jobs export matching Alpha Store archives. The Store checks the prerelease checksums before loading.

Player gestures: swipe left/right for next/previous, pull down Now Playing to minimize it, and press Back to return to the library without leaving Music. Playback position survives reopening. Saved mixes, collections, points, keep-session feedback and radio variety use the existing hub domain implementation.

Browser QA uses the installed approved shared core: set `WIZARD_CORE_DIR`; `qa/swipe-check.mjs` also needs `WIZARD_QA_AUDIO` pointing to a labelled generated WAV. These fixture scripts do not prove real-provider playback. Real clean-install evidence is recorded separately in the release receipt.

## License

MIT for this package (see LICENSE). React, Vite, Vitest and tinytag are MIT; Playwright Apache-2.0; Python PSF; ytmusicapi MIT; yt-dlp Unlicense; FFmpeg LGPL/GPL as distributed by Debian. No third-party recordings are distributed. Native Android screen-off/Bluetooth/lock-screen playback remains a separate Wizard shell capability; this package does not include an APK.
