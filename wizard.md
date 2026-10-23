---
wizard: 0.2
id: wizard-music
name: Music
version: 0.1.0
type: service
category: app
voice_names: [music, songs, music player, wizard music]
summary: Your own music library, with an embedded player and optional online sources.
license: MIT
source: https://github.com/humanitylabs-org/wizard-music
icon: icon.png
runtime:
  kind: runtipi
  config: runtipi/config.json
  compose: runtipi/docker-compose.yml
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
Private test release. Empty library; configure the recipient's backend using SETUP.md.
Requires the host's shared WizardApp client and authenticated same-origin gateway.
Native background playback is not certified by this embedded web package.
