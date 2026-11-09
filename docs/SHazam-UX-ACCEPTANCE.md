# Music design and interaction acceptance

## Owner correction (6 November 2026)

> Oh no, this is on GTPT’s soul. Oh no, terrible. Opus, it didn’t follow the instructions I asked for on design and UX. So please do what I asked for. I asked for a really modern sleek, it feels like Shazam. It should feel just like that. Please really sleek modern UX. And the UX of these buttons in general is looking horrible, so can you clean up the UX here as well?

Opus owns substantive visual design and implementation, not an advisory critique. The accepted experience is a sleek, modern song-identification flow with one obvious central tappable identification control, calm hierarchy, focused listening/send, an elegant waiting/result state, and secondary history. Playback home needs deliberate navigation and button hierarchy rather than a wall of equal-weight pills or implementation-status cards. Desktop is the same product, responsive within its window, not a new sidebar layout.

## Preserve

- Wizard skins through Appearance v1 `--wz-*` roles, live appearance changes without losing state, dark standalone fallback, opaque text-bearing floating panels. Never change built-in skin names or the owner's skin.
- App-only changes. Shell bottom navigation, orb and native controls are out of scope.
- All library, stations, search, recent, likes, queue, playback, mini-player and voice controls remain accessible; data and features are retained. Source connectivity details may be disclosed rather than dominant.
- Only `WizardApp.capture` owns microphone capture. Voice reaches Music only through its declared `voice_routes` (`?view=identify&listen=1`, rest words in `q` to the existing command parser); no hidden receiver or priority claim (current live policy, `docs/IDENTIFY.md`).
- Recording (current live policy, supersedes the earlier 15-second/manual-cap wording): the ring around the central orb fills with elapsed audio toward a 12-second "enough" target with calm, playful encouragement; reaching 12 never sends. Find it is available early at any time. The 30-second capture hard cap sends automatically. Accessible name of the ring: "Audio capture target".
- Send opens that clip's sheet at once, before saving or network, with visible loading (Saving → Sending → Finding your track, polled every two seconds). Timing copy is "About 6 seconds in our last check" from one measured 6.13-second retry, never a guarantee.
- Durable unsent drafts, cancellation safety and original audio retention stay intact. Fresh waiting/results open only while the user is still waiting; after navigating away they do not steal focus. Keep the New fallback and the visible name Identifications.
- Hosted desktop: the app root is an opaque skin-base surface (canvas layered over `--wz-base`); html/body stay transparent per Appearance v1, and the shell's own screen never shows through Music text.
- Optional recording note/location and secondary actions remain discoverable and stateful even when moved into disclosure. No fabricated confidence scores.

## Reuse

- Capture and durable custody: REUSE `WizardApp.capture.start/pending/ack`.
- Back and overlays: REUSE `WizardApp.back` and `WzSheet`.
- Appearance: REUSE `WizardApp` shared appearance and `--wz-*` roles.
- Sharing: REUSE `WizardApp.share`.
- Unsaved work: REUSE `WizardApp.update.hold`.
- Voice, playback and mini-player: REUSE existing app domain controls and shared bridge.
- Press/motion: REUSE shared Wizard motion where needed; respect reduced motion.

## Release acceptance

Focused existing behavior tests and build; preservation backup and readback; inspect actual phone and desktop in-shell captures on Nebula and Grove, including live appearance changes, active capture, home, waiting/result and history. Use the existing isolated browser harness, synthetic capture and synthetic owner data only. Opus must inspect supplied before images and resulting captures. Functional regressions belong in tests; raster judgment is not replaced by source-class assertions. Ship after focused checks pass; long-tail QA does not delay a safe app-local release.
