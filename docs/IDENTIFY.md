# Identify in Music

Owner approved build: TrackHunt into Music, including whole-utterance `music`, `shazam`, `what's this song`, `identify this` to start recording.

Baseline: app live release a5a0cab (not main); live forum hub separately preserved before extension. Existing Music navigation, native playback, swipe, resume, likes, taste, mixes and library remain.

Reuse:
- capture/recovery: REUSE WizardApp.capture.start / pending / ack; processing disabled, 30 seconds, resumed receipt.
- Back: REUSE WizardApp.back.register / useHistory; detail → Hunts → Music home.
- sheet: REUSE WzSheet.open / close (canonical kit).
- appearance: REUSE Appearance v1 and --wz-* tokens, live skin changes, dark fallback, opaque panels; phone and desktop screenshots on two skins in synthetic shell (never change owner's skin).
- share: REUSE WizardApp.share.file and Music share.ts conventions.
- playback/search: REUSE musicControl and musicApi; candidate Play resolves a full Music track, never uses the preview as the main engine.
- likes/requests/downloads: EXTEND hub identify confirmation to existing likes, record_request and audio/library paths.
- voice: EXTEND src/music/voice.ts; REUSE WizardApp.voice.commands.register priority-stage claims before bare app-open. Package declares provides: voice-commands so the shell's existing cold-provider warmup loads a lean receiver, not another player. On this legacy host Music currently lives only in launcher.json: installed app metadata must carry provides for cold claims to work; do not grow frozen voice-legacy.js grammar.
- pending/errors: REUSE existing app toast; domain saved/upload/recognition state is app owned.
- recognition: NEW domain module hub/identify.py (no system-capability duplication).

Safety: save raw bytes + checksum before enqueue; idempotent UUID/digest upload; never auto-delete unmatched clips; preserve all existing TrackHunt tables/audio; paid providers off. Backups before hub schema/import and cutover; legacy app stops only after parity and audio readback. Real handset known-song recording is the owner's remaining physical test, not claimed by browser tests.

Verification: existing tests plus focused recognition/no-match/audio custody, idempotent upload/restart, confirmation persistence, voice exactness, held capture/I/O and Back/outside-tap. All builds/browser execution queued on forum. Five failed verification runs total ends repair loop.

## Current four-improvement brief (supersedes target/cap and voice policy below)

The newer explicit brief sets a **12-second circular elapsed-audio target**, never auto-send at 12, and **automatic send at the existing 30-second capture hard cap**. Cancel and unsent drafts remain available and retain their existing custody/retry intent. The concurrent live Identifications wording, New marker and navigation-away protections are preserved. Sending opens this local clip before saving/network and never reopens it after leaving. Device-shell `voice_routes` data replaces Music's hidden receiver and priority claims. Search paints pending immediately, debounces 250 ms and aborts/fences stale replies. Recognition timing uses one live migrated-capture retry: 6.13 seconds, explicitly described as one last check, not a guaranteed typical latency.

## Recording/result UX correction (historical; policies superseded above)

Source baseline: actual serving `/home/telos/apps/wizard-music-releases/550ed0f`, byte-equivalent (excluding dist/dependencies) to remote-backed `feat/identify` commit `550ed0f`. The old owner-live repository's main is not this release. Work is isolated on `fix/identify-recording-ux-20261106`; no serving checkout is edited.

Capability decision: **REUSE** `WizardApp.capture` and the existing app visibility/Back/WzSheet/Appearance v1 integration; **EXTEND** the app's recording state, durable outbox, result selection and tests; **NEW** no system capability. No shared voice architecture change is authorized or made.

- Aim for about **15 seconds**, show elapsed-time progress (never confidence), allow early Send. At the unchanged **30-second safety limit**, stop the mic and keep a draft; require explicit Send for identification. Cancel keeps the audio as an unsent draft. Preserve unsent intent across shared recovery and IndexedDB reload.
- Evidence: [ACRCloud Identification API](https://docs.acrcloud.com/reference/identification-api/identification-api) says files less than 15 seconds are generally better for speed/bandwidth, not that a particular duration guarantees recognition. [AudD docs](https://docs.audd.io/) document short clips but give no universal duration-to-accuracy curve. Fifteen seconds is a practical UX target, not a hit-rate claim.
- A submitted capture opens its own detail sheet while sending/identifying only if the owner is still waiting for that capture. Navigating away invalidates that one-shot selection. Completion only updates an already selected detail; it never reopens it. A New marker remains on the list row when automatic opening was intentionally skipped.
- User-facing Hunts wording becomes Identifications; internal identifiers/schema remain unchanged. `qa/recording-ux-renames.txt` records behavior-preserving wording changes for `app-parity-gate` (no feature waivers).
- Regression home: `tests/identify.test.ts` covers target/limit, early send, first-frame saving with held I/O, double-send suppression, cancellation, shared-draft recovery, navigation-away and shell-app focus. Existing `qa/identify-browser.mjs` exercises the real shell with synthetic capture, live skin changes, phone/desktop on Nebula/Grove, elapsed progress screenshots, auto-open, Back, outside-tap and reconnect. Synthetic fixtures do not prove real handset mic quality. Unchanged provider-network recognition may be explicitly skipped via `IDENTIFY_SKIP_RECOGNIZER=1`; existing hub and transport tests still run.
