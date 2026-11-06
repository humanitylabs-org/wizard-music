# Unmatched identification discard

## Scope and reuse

- REUSE the accepted Opus Identify screen, WzSheet dismissal and Back ownership, Appearance v1 `--wz-*` roles, existing quiet button and Music toast styling, shared update holds and shell toast for late hidden-view errors. Shared toast has no action slot; the persistent Undo/retry content belongs to this domain view.
- EXTEND the existing capture API, server allowlist, MCP actions and Identify controller overlay. No second recorder, skin implementation, whole-capture fingerprint endpoint or provider route.
- NEW platform capabilities: none.

Discard is explicit and limited to a finished `no_match`, never a local pending upload, recording, queued/running recognition or confirmed/identified capture. The sheet closes and the active list removes the record synchronously in the tap handler, before I/O. Pending state lives in the controller outside the sheet and overlays stale polls. Duplicate taps share the operation. Undo serializes behind an outstanding discard and verifies the restored UUID/state with GET; it never creates another capture. Failures restore the local list state with persistent retry on Music home or its list; if Music is hidden, the existing shell toast additionally announces where to retry.

## Durable contract and retention boundary

POST `captures/{UUID}/discard` or `/restore`, JSON `{}`, changes only `retention_state` and `updated_at`. Both return the stored capture, are idempotent, validate UUID/existence/state, and refuse busy captures. All existing audio, candidates, attempts, metadata and schema stay intact. Active listing excludes discarded captures server-side; detail/audio remain available by UUID. Retry rejects discarded captures until restored. MCP exposes the narrow `identify_discard` and `identify_restore` writes, only on owner intent.

`discarded` is deliberately **not** `archived`: existing `retention_dry_run` marks `archived` rows as eligible for audio deletion based on capture creation time, even if their status is unresolved. Reusing `archived` would silently enroll explicitly hidden audio in that future deletion class. `discarded` matches neither archive nor audio-deletion eligibility; existing dry-run size accounting still reads all captures, including discarded ones. This change installs no pruning executor, changes no age/size policy and performs no file deletion. A no-match alone never discards anything.

## Focused acceptance

Use existing `qa/run-identify-forum.py` and `qa/identify-browser.mjs` with `IDENTIFY_DISCARD_ONLY=1` and `IDENTIFY_SKIP_RECOGNIZER=1`, a fresh `IDENTIFY_OUT`, and the existing shell-web input. The mode uses an empty scratch hub plus generated silent WAV; never real owner captures or paid recognizers.

| Control | Handler | Surface | Held-I/O case |
|---|---|---|---|
| Discard | IdentifyView button → identifyControl.discard | Identification detail; hosted phone/desktop | Existing browser focused mode: hold real POST, double tap, assert sheet closed/list removed synchronously and within 2 frames/100ms; unit stale-list overlay + retry-all |
| Undo | IdentifyView notice → identifyControl.restore | Music home/list | Existing controller tests hold restore, verify no duplicate UUID and GET confirms active; browser performs real API restore/readback |
| Try again | persistent discard notice | home/list, including after navigation | Existing controller/component tests reject write after Back; same record restored, visible error + retry; hidden Music also calls shared shell toast |

`tests/identify.test.ts`, `tests/identify-flow.test.tsx`, `qa/identify-transport.mjs`, and `hub/tests/test_identify.py` cover state guards, idempotency, pending-write dedupe, stale polls, failure/retry/Undo and original audio/candidate/attempt preservation. Browser focused mode captures the changed sheet and Undo on Nebula/Grove, phone touch + desktop, and verifies cold reload stays hidden. Screenshots must be inspected before live promotion. No widget exists for this action. Native handset coverage is not claimed.

## Promotion boundary

The frontend and hub both need activation. The app bundle alone is insufficient. Start from the current effective frontend systemd path and the effective forum hub source, not a remembered checkout. The hub companion must change only its matching identify module; preserve hub taste, library, scoring and playback features. Use a fresh immutable release and guarded reversible pointer, not edits to the serving tree. Before cutover: lock, predecessor/dirty guards, fresh online SQLite backups (all cells), audio/library/config/env copies and hash readback. After focused build/tests/screens: promote immediately; retain rollback and read back assets through app + gateway + shell, GET captures 200, and original records/audio/schema unchanged. Do not mutate owner captures for live acceptance.
