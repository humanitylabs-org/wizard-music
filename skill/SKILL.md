---
name: wizard-music
description: Play and search the owner's music library inside Music.
---
Use music_status first. If unconfigured, follow SETUP.md shipped with the app; never borrow another owner's token, library, or tunnel. music_home and music_search are read-only MCP tools. Browser playback is a user-gesture action in the Music view, not an MCP promise. Library scan and feedback use the documented API; use only owner-authorized files. Never claim native background playback from the web package.

## Identify a song
- In Music, tap Identify (or say exactly `music`, `shazam`, `what's this song`, `identify this`). This starts a 30-second shared capture with music processing left off. Stop and identify seals early. A saved clip survives recognition failure, offline upload and navigation.
- Hunts shows saved captures and unsolved audio. Open a hunt to replay the original or normalized recording, compare a candidate preview, play its full song through Music, mark This is it / Not it, add a candidate manually, retry, share/export, or inspect attempts. This is it likes the resolved Music track and counts as an explicit request; Download to library reuses Music's cached full song.
- MCP: `identify_list` and `identify_get {id}` are read-only. `identify_retry {id}` starts recognition of existing saved audio. `identify_confirm {candidate_id}` is a write: only after the owner says that candidate is right. Confirmation is idempotent and survives a hub restart.
- HTTP: `/wizard-music/api/identify/captures`, `/captures/{UUID}`, `/captures/{UUID}/audio?kind=original|normalized|export`, POST `/captures/{UUID}/retry`, POST `/captures/{UUID}/candidates`, POST `/candidates/{integer}/verdict` with `verdict: confirmed|rejected`, `/search?q=...`, `/retention/dry-run`. Capture POST accepts raw audio with a stable UUID `?id=...`, saves/fsyncs first, rejects a different digest at the same UUID and never re-enqueues an identical retry. Acknowledge shared capture only after GET returns the expected raw_sha256.
- Default provider: shazamio (unofficial; no signup), ffmpeg-normalized overlapping windows plus a filtered fallback. AudD and ACRCloud are off, no paid calls. A no-match is an honest outcome, not an excuse to discard audio. No retention operation deletes audio automatically.
- The hub's `hub/import_trackhunt.py SOURCE_DIR HUB_HOME --backup BACKUP_DIR` uses SQLite online backups, copies and hashes audio, maps candidate IDs and refuses conflicting capture IDs. Keep legacy data for at least 30 days after cutover.
