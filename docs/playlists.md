# Saved playlists and long mixes

Scope: compact persistent URL list inside Music, separate from listening-history named mixes. Save never plays, imports a remote playlist, or downloads media. A long-mix video URL does not need `list=`. Original URL and full supplied metadata are preserved; duplicate resource URLs retain the first exact URL and stable identity. Optional name defaults honestly to YouTube mix/playlist plus its ID; there is no credential-bearing URL fetch or metadata wait.

Reuse:
- rows/disclosure: REUSE existing Music row/section styles and native details, styled with Appearance v1 `--wz-*` roles.
- add sheet and Back/outside: REUSE vendored `WzSheet` + `WizardApp.back.push`.
- appearance: REUSE shared client live skin transport, dark standalone fallback and opaque `--wz-panel`.
- playback: REUSE Music engine single-track load, only on an explicit Play tap; retained YouTube link is the fallback. Remote playlists open YouTube, not an invented playlist-import pipeline.
- persistence: EXTEND Music hub SQLite with one additive `saved_playlists` table; no existing cells change on Save.
- agent access: EXTEND Music MCP with `playlist_list` and `playlist_save`.

Controls: add/open sheet and disclosure are local; Save → playlistControl.save → app POST `/api/playlists`, then GET `/api/playlists` readback; pending row paints before I/O and sheet closes immediately. Retry resubmits the same stable resource. Play → existing single-track engine after explicit hub `/api/playlists/{id}/play` (no autoplay on save); YouTube anchor remains accessible with exact full URL/title.

Verification runs on forum using the app's existing isolated Identify runner and real-shell harness extended with a playlist-only mode. No owner captures or production playlist writes in QA. Parent serializes promotion after Discard and seeds the requested entry only after the live UI/API exists. Before activation, back up the serving hub database/audio/config and preserve all original rows; additive table requires no destructive migration.
