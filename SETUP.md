# Music — first song on a new Wizard

1. In the Wizard App Store, open **Music** in the **Alpha** channel and choose **Get**.
2. Open Music. Your private library starts empty; no account, music, history or credentials are bundled.
3. For online music, turn on **Online sources**, search for a song, and tap it. Use only recordings you are authorized to access. Source availability varies by provider and region.

**Store Get is all the server setup a new user needs.** Music creates its own data folder and random server-only hub token. No environment variables, terminal commands or gateway allowlists are required on a normal Wizard.

Online sources are **off by default**. The switch explains what leaves the box: searches and track details go to YouTube Music, Deezer, Apple and MusicBrainz for catalog results, audio and artwork. The choice is saved on your Wizard. Turning it off stops online listening, cancels active downloads, discards pending enrichment and blocks new provider requests, including connected-catalog lookups. Previously downloaded artwork and metadata may remain on disk. Local files remain available.

## Wizards on a cloud server (VPS)

YouTube blocks most data-center addresses, so online songs fail on a VPS Wizard while search still works. Music now says so instead of skipping tracks. The fix is a **Home connection**: install Wizard Home Relay on any always-on computer at home that is on your Tailscale (`sh install.sh` from `humanitylabs-org/wizard-home-relay`), then paste the address it prints into Music under Online sources, **Add a home connection**. Only YouTube traffic goes through it; the relay listens on Tailscale only, needs its token, and refuses every other site. A Wizard running at home needs none of this.

## Your own music files

Ask your Wizard to add your authorized MP3, M4A, FLAC, OGG, Opus, AAC or WAV files to Music’s library folder. The Store install creates `app-data/<store>/wizard-music/music`, mounted read-only at `/music` in the player. Files appear after the automatic scan (about a minute), or ask your agent to rescan. No cloud permission or online switch is needed for local files. Browser codec support varies.

Tap a track to play. Open Now Playing from the mini player, swipe left/right for next/previous, and pull down or press Back to return to the library without leaving Music. Like a song to save it on this Wizard. Saved mixes, radio and listening preferences stay in the data volume during updates.

## Advanced: installation and security contract

The Alpha Store installs checksum-verified **linux/amd64 and linux/arm64** Docker archives from the public MIT repository’s prerelease. The release includes SHA256SUMS and image identities. This matches the existing Alpha installer, without requiring newer `runtime.package: image` support. A multi-architecture image is also built by the shared Actions image builder. No private registry credential is needed for archive installs.

The web server listens on container port 9205. The gateway preserves `/wizard-music/` and serves the installed Wizard’s approved `/wizard-os-home/core/app-client.js`. It authenticates the owner; the bare container port is not a standalone Wizard. Both supplied Compose recipes bind only `127.0.0.1`. Do not expose it publicly.

The gateway should preserve `Host`; if it rewrites Host it must set `X-Forwarded-Host` and `X-Forwarded-Proto`. Forwarding headers are accepted only from loopback/private-network peers. Browser Origin must match that exact authority and scheme (no wildcard or arbitrary forwarded Origin). Optional `WIZARD_TRUSTED_HOSTS` and `WIZARD_TRUSTED_ORIGINS` support unusual, explicitly trusted deployments; they are not authentication.

Data is mounted at `/data` and initialized to uid/gid 1000, mode 0700. Startup drops root before either server runs. The random token is created at `/data/hub-token` with mode 0600, persisted across restarts, and sent only from the web server to the loopback hub. It never enters browser responses, URLs or JavaScript. Do not copy another installation’s token, database, cache, cookies or library. `/data/settings.json` stores online consent with mode 0600.

The process has only CHOWN/FOWNER/SETUID/SETGID during initialization, no new privileges, a read-only root filesystem and tmpfs for temporary files. The library is mounted read-only. Maintain the same data/library mounts during updates and rollback. Back up the recipient’s database with their normal backup process before future schema-changing upgrades.

For a diagnostic standalone run, use `docker compose -p music-test -f compose.yaml up -d` after loading the verified archive. It creates empty named data and library volumes; it does not provide Wizard core or gateway authentication.

## Advanced: optional integrations

- Connectors catalog lookup: optional server-side `WIZARD_MUSIC_CONNECTORS_URL` and `MUSIC_ADAPTER_TOKEN` fields. The token is the dedicated Music adapter credential, never the owner, MCP, broker or hub token. Connected catalog lookup is gated by the online switch. It is catalog access, not Google/YouTube Music subscription or audio authorization.
- External hub: set `WIZARD_MUSIC_EXTERNAL_HUB=1`, its recipient-owned `WIZARD_MUSIC_HUB_TOKEN`, and an exact loopback HTTP `WIZARD_MUSIC_HUB_ORIGIN`. The hub must share the network namespace. This advanced topology is not required by Store Get.
- Online account auth, if independently authorized and required, belongs only in the recipient’s `/data/ytmusic-browser.json`, mode 0600. No borrowed cookies, accounts or access bypass are included.
- Cache limit: `WIZARD_MUSIC_CACHE_MAX_BYTES` defaults to 3 GiB. Hub, data, library and Python/downloader paths remain environment-configurable for advanced host installations.

## Diagnostics

`GET /health` reports version and configuration, not proof of playback. `GET /wizard-music/api/home` reports library and settings; `GET/POST /wizard-music/api/settings` reads/sets `{ "online": true|false }`; `POST /wizard-music/api/scan` rescans. Stream requests support Range/206. MCP `music_home`, `music_search` and `music_status` are read-only. Hub APIs stay on container loopback behind a bearer token.

For playback verification, the decoded media clock must advance for at least five seconds, then pause/resume. Health, a nonempty queue and downloaded bytes alone do not prove playback. Native Android screen-off, Bluetooth and lock-screen behavior are separate Wizard shell capabilities, not newly certified by this release.

If online sources fail, local files still work. Provider restrictions, unavailable recordings, authentication challenges or codec errors are not fixed by sharing another person’s cookies. A missing shared WizardApp resource is a gateway issue; never copy a private core implementation into Music.
