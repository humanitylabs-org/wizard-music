# Music HTTP / MCP contract (0.1.0)
The Wizard authenticated gateway is the authorization boundary. Never publish the app port directly; it has no user login. Host/Origin allowlists prevent browser cross-origin access but are not authentication. The hub additionally requires a bearer token; only the server adds it.

- `GET /health`: app process and configuration only, not backend health.
- `GET /wizard-music/api/status`: same status, no secrets.
- `GET /wizard-music/api/home`: `{sources,vibes,liked,recent,library,taste}`.
- `GET /wizard-music/api/search?q=...`: `{tracks:[...]}` (200-character query limit).
- `POST /wizard-music/api/scan` with `{}`: rescan own mounted library, `{tracks:number}`.
- `POST /wizard-music/api/station` with `{trackId:"lib:<id>"}` or `{query:"...",label:"..."}`: `{tracks,station}`. Library stations stay local; online stations require opt-in.
- `GET /wizard-music/api/station/<16-hex-id>/more?n=10`: station continuation.
- `POST /wizard-music/api/play` with `{said:"play ..."}`: resolves a request into tracks, does not start browser sound.
- `POST /wizard-music/api/feedback` with `{id,action,upcoming?:[id]}`: action `like|unlike|dislike|played|skipped`; `{ok,track,drop,learned}`. Likes/history persist in `/data/hub.sqlite3`.
- `GET|HEAD /wizard-music/stream/lib:<20-hex-id>` (or `yt:<video-id>`): audio bytes, Range/206 supported; `art/<id>` for thumbnail.

Track: `{id,title,artist,album,durationMs,source,art,stream,liked}`. All media/continuation URLs are rewritten to `/wizard-music/`; no bearer token is returned. Browser uses same-origin cookies at the gateway. Requests to undeclared API routes return 404. Missing backend configuration returns 503; unreachable source returns 502. A 200 health response never proves playable media.

Hub routes are the same **without `/wizard-music`**: `/api/home`, `/api/search`, `/api/scan`, `/api/station`, `/api/play`, `/api/feedback`, `/stream/<id>`, `/art/<id>`. Hub JSON originally uses `/wizard/music/` URLs; the web proxy rewrites them. `/health` is unauthenticated, all other hub routes require `Authorization: Bearer <recipient token>`.

`POST /mcp`: stateless JSON-RPC streamable HTTP (JSON response mode), initialize, ping, tools/list, tools/call. Read-only tools `music_status`, `music_home`, `music_search({query})`; no hidden playback or mutation. Same gateway security as HTTP. No SSE stream is offered; GET returns 405. Initialization negotiates the baseline 2024-11-05 protocol. Browser playback is not an MCP-side effect.
