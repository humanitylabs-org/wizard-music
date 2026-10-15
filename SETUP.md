# Oscar: configure the recipient's Music backend

This is an **embedded Music app**, not an Android APK. Install it on the recipient's Wizard. It contains no owner's music, listening history, login, tunnel or private hostname. A fresh install is intentionally empty / setup-required. Do not copy another Wizard's `.env`, SQLite, cookie jar, yt-dlp cache or library.

## 1. Private install and gateway
Use the private test catalog entry and immutable image/archive hash in music-RELEASE.json. The GitHub repository and prerelease assets are private: the tester's authorized installer needs read access. GHCR publication was denied by current credentials; this release distributes Docker image archives as private GitHub prerelease assets instead. Download the archive for the recipient's architecture, verify its SHA256 against the release receipt, then `docker load -i <archive.tar.gz>`. This installs the local tag `ghcr.io/humanitylabs-org/wizard-music:0.1.0-test`; that name does not imply a readable registry package. No public catalog submission is permitted. If the store cannot read private source/assets, ask the release owner to wire the test store; do not make the repository or image public.

The app listens on container port **9205**. Its view path is **/wizard-music/**; preserve that prefix when proxying. `/mcp` and `/health` go to the same container. The Wizard gateway must authenticate the owner, proxy same-origin `/wizard-music/*` unchanged, and serve its approved shared `/wizard-os-home/core/app-client.js`. The app does not ship a private copy of core. The registry view is `/wizard-music/`, API `/wizard-music/api`, MCP `/mcp`. Do not expose the container's direct port to the Internet or LAN.

Set `WIZARD_TRUSTED_HOSTS` to the exact hostname(s), without scheme or port, that the gateway sends in Host. Set `WIZARD_TRUSTED_ORIGINS` to the exact browser origin(s), including scheme and non-default port. Comma-separated, no wildcards. Defaults allow localhost Host and `http://127.0.0.1:9205` Origin only. Reverse proxies may rewrite Host to localhost while retaining the browser Origin; still configure the actual browser Origin. These allowlists are not a substitute for gateway authentication.

## 2. Built-in hub (recommended)
The image includes both the web server and the existing Python hub. The hub stays on **127.0.0.1:8793 inside the container**. No tunnel is needed. Generate a new random **recipient-owned** `WIZARD_MUSIC_HUB_TOKEN` (e.g. `openssl rand -hex 32`), save it in the installer's protected secret field/environment, never in chat, the repository, URL, or browser code. This same token is automatically used by both processes. With no token, only the web view runs and API returns 503 setup-required.

The shipped Runtipi compose mounts:
- `${APP_DATA_DIR}/data` → `/data` writable by **uid/gid 1000:1000** (hub.sqlite3, cache and optional online auth).
- `${APP_DATA_DIR}/music` → `/music` **read-only** (recipient's own audio files).

Create these two directories before first start; set data ownership 1000:1000 and ensure uid1000 can read music. Copy/link only recipient-authorized files into the music folder (or configure a read-only bind of their chosen existing library). Mount/volume identity must stay unchanged during updates. Do not delete `/data`, run a reset, or seed over an existing install. Supported scan suffixes: mp3, m4a, flac, ogg, opus, wav, aac; browser codec support varies. The scan repeats every minute; POST `/wizard-music/api/scan` forces it.

For a standalone container/API rehearsal, from this repository:
1. Load the verified architecture archive, then set `MUSIC_IMAGE` to its **local image ID** from music-RELEASE.json (or the loaded tag), `MUSIC_LIBRARY_DIR` to an absolute recipient-owned folder, and `WIZARD_MUSIC_HUB_TOKEN` in protected environment or a mode-0600 untracked `.env`.
2. `docker compose -p recipient-music -f compose.yaml up -d`
3. The included compose publishes **127.0.0.1:9205 only**, stores hub state in a named volume and mounts the library read-only. This diagnostic port alone lacks Wizard core; use the authenticated Wizard gateway for the UI.

## 3. Verify configuration, scan, bytes and actual playback
Through the authenticated Wizard gateway (or locally on the diagnostic loopback):
- `GET /health` must return `app: wizard-music`, `configured: true`. This proves the proxy has config, **not** that upstream playback works.
- `POST /wizard-music/api/scan`, JSON `{}` → count; then `GET /wizard-music/api/home` → own library track(s), with `stream` under `/wizard-music/stream/lib:...`.
- `GET <returned-stream>` with `Range: bytes=0-4095` → **206**, Content-Range, audio Content-Type, nonzero bytes. No hub bearer token appears in the response or URL.
- Open Music from the Wizard launcher, tap a track, verify Pause is shown and elapsed time advances for at least five seconds. Pause, reload, resume; the same track and saved position should return. Open/close Now Playing with Back and on-screen close: the app must remain open.
- Like the test track, read it in `/api/home`, restart/recreate the container with the **same data mount**, and confirm it is still liked. Remove the test like afterward if unwanted.
- For agents POST `/mcp` JSON-RPC `initialize`, `tools/list`, then `tools/call` with `name: music_home` (or `music_search`, `arguments:{query:...}`). Read-only tools do not start sound.

Do not treat 200 health, a nonempty queue, a synthetic API fixture, or a native bridge name as actual playback evidence. A browser clock/decoded media plus successful stream bytes is the web playback gate; a human listener judges audio quality.

## 4. Optional online sources (not required for local playback)
Default `WIZARD_MUSIC_ONLINE=0` disables YouTube catalog/radio and metadata enrichment. Set **1** only with the recipient's consent: queries/track metadata can reach YouTube Music, Deezer (spoken-query spelling) and Apple/iTunes (genre/taste). ytmusicapi, yt-dlp, mutagen and FFmpeg are installed by the image; exact versions are pinned in hub/requirements.txt and the image digest. Account-specific ytmusicapi auth, if needed, belongs at `/data/ytmusic-browser.json`, mode0600, created using the recipient's authorized account flow. Never transfer another user's cookies/auth. Online provider access can fail or change; no account, subscription, bypass or playback guarantee is bundled. Use only media the recipient is authorized to access. Local library playback is the release-tested baseline.

## 5. Existing external hub (advanced alternative)
Set `WIZARD_MUSIC_EXTERNAL_HUB=1` and `WIZARD_MUSIC_HUB_ORIGIN=http://127.0.0.1:<port>` on the web container, plus the existing recipient hub token. The proxy deliberately accepts **only exact loopback HTTP origins**, no path/query/userinfo. Container loopback is not host loopback. An external hub or authorized forwarding process must share the web container's network namespace, or run web and hub directly on the same host. Do not substitute `host.docker.internal` or a remote URL; this validation is intentional. The hub supports `WIZARD_MUSIC_HUB_HOST` (loopback only), `WIZARD_MUSIC_HUB_PORT`, `WIZARD_MUSIC_HUB_HOME`, `WIZARD_MUSIC_LIBRARY`, `WIZARD_MUSIC_CACHE`, `WIZARD_MUSIC_CACHE_MAX_BYTES` (default 3 GiB), `WIZARD_MUSIC_YTDLP` and `WIZARD_MUSIC_ONLINE`. Keep media/cache on suitable recipient storage.

Direct hub `/health` is unauthenticated; all `/api/*`, `/stream/*`, `/art/*` need the bearer token. The web server adds it, never the browser. See API.md for exact routes and prefix rewriting. This advanced topology is documented, not the tested install path.

## 6. Failure, upgrade and rollback
- 403 Host/Origin: correct exact gateway allowlists; never broaden to wildcard.
- 503 Music not connected: token or proxy origin absent. Recreate with correct protected environment.
- 502: inspect app logs and hub health; missing files/permissions, codec/online source failures are distinct from wiring.
- Empty library: verify read-only bind, uid1000 access, supported suffixes and scan result. No demo songs are silently installed.
- Missing WizardApp/core: repair the gateway's shared-resource route; do not copy platform JS into Music.
- Update by loading the next approved hash-verified archive and recreating **without changing/removing data or library mounts**. Browser localStorage belongs to the same gateway origin; changing origin changes saved session.
- Roll back by loading the previous archive and using its pinned image ID with the same mounts. No destructive migrations are introduced in this release. Back up the recipient database using the owner's normal backup procedure before later schema-changing upgrades.

Native Android screen-off/Bluetooth/lock-screen behavior is the separate Wizard shell background-audio work. Do not install historical APKs or replace the current shell to use this package.
