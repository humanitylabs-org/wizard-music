---
wizard: 0.2
id: wizard-music
name: Music
version: 0.1.0
type: service
category: app
summary: Your own music library, with an embedded player and optional online sources.
license: MIT
source: https://github.com/humanitylabs-org/wizard-music
icon: icon.png
runtime:
  kind: runtipi
  config: runtipi/config.json
  compose: runtipi/docker-compose.yml
  package: image
api:
  path: /wizard-music/api
  port: 9205
  spec: API.md
mcp:
  path: /mcp
  port: 9205
  transport: streamable-http
skill: skill/SKILL.md
view:
  path: /wizard-music/
  port: 9205
  source:
    path: src
    build: npm ci && npm run build
    dist: dist
health: /health
provides: [music]
needs: []
uses: []
---
## Registry packaging

The Runtipi runtime uses `package: image` and the multi-architecture GHCR index pinned in `runtipi/docker-compose.yml`. `.github/workflows/image.yml` builds native linux/amd64 and linux/arm64 images with the shared app-image workflow and runs the existing tests. The compose's `pull_policy: missing` allows an authenticated installer to fetch that exact digest. Package visibility is unchanged; access to a private GHCR package is still required. Historical archive installs in SETUP.md and `compose.yaml` remain separate, unchanged installation paths. Prepare `/data` ownership as documented in SETUP.md before enabling the built-in hub.

Private test release. Empty library; configure the recipient's backend using SETUP.md.
Requires the host's shared WizardApp client and authenticated same-origin gateway.
Native background playback is not certified by this embedded web package.
