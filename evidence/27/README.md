Evidence for humanitylabs-org/wizard-music#27 (PR #28, head dc82dda).

Isolated in-shell browser checks (qa/identify-browser.mjs) against the PR's Docker image and the wizard-ux main shell (c8cc2d1),
phone (390x844) and desktop (1440x900), skins Nebula and Grove. Synthetic audio and synthetic data only; no owner box was touched.

- playlists/: MUSIC_PLAYLIST_ONLY=1, which adds a link, dedupes it, reloads it, and checks Back/outside close, live skin switch, no autoplay and the offline fallback
- local/: IDENTIFY_LOCAL_DISCARD_ONLY=1, which discards an unsent clip on this device, then Undo restores the same bytes, then a manual Send
- discard/: IDENTIFY_DISCARD_ONLY=1 QA_IDENTIFY_DIRECT_ROUTE=1, which records, sends to Shazam (no_match), Discards, Undoes, discards again and reloads
