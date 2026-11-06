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
