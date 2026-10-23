# Scoped catalog consumer QA

This is a focused fixture gate, **not live Google consent or audio verification**.
Run all builds/tests/browser QA on the designated worker, with working data,
browser scratch and evidence on its external work volume. Do not deploy, read
personal credentials, or touch existing container workloads.

```sh
npm ci
npm run build
npm test
# Use the Connectors test venv (cryptography + PyJWT), not the user's runtime.
# TMPDIR, HOME/browser cache if needed, source and evidence must use the work volume.
CHROME_PATH="<installed Chrome executable>" \
  <connectors-test-venv>/bin/python qa/catalog-integration.py \
    --connectors-source <read-only-connectors-source> \
    --core-dir <approved-shared-core-directory> \
    --evidence <dedicated-music-evidence-directory>
```

Prerequisites: Node 22+, the current Connectors `tests/test_google_http.py`
fixture harness exposing `BrokerHTTPTests`, and the actual shared
`app-client.js` (plus `app-capture.js` if present). The source can be an rsync
snapshot with no `.git`; `integration.json` records SHA256 of the actual
Connectors Python sources and fixture used rather than inventing a revision.
The runner does not modify that source tree or any existing account store.

Coverage:
- Real Music HTTP server -> Connectors service endpoint -> authenticated RPC ->
  broker binding and encrypted fixture store, with only Google transport fake.
- Two fake Google accounts; the owner's second binding must supply the access
  token used by the fake catalog provider. Browser credentials are irrelevant.
- No binding and owner unlink both deny lookup; no cached/anonymous fallback.
- Wrong, owner, MCP and internal broker tokens cannot act as Music adapter token.
- Account/URL/operation selectors, malformed IDs and hostile Origin rejected.
- Catalog remains functional independently of playback hub configuration.
- Browser UI: linked, unlinked, wrong-token, absent-config and unavailable states,
  mobile/desktop screenshots, no audio/station side effects, no browser bearer,
  no uncaught page errors or mobile overflow. Hub track metadata is explicitly
  fake; it is not evidence of functioning streaming or real YouTube availability.
- Transport unit tests use synthetic HTTP upstreams for configured path prefixes,
  typed request/response projection, empty results, provider errors, reauth,
  size/time bounds and redirect credential containment.

`integration.json`, `browser-*.json`, `catalog-*.png` and process logs are the
readback evidence. The fixture cleans up only its own ephemeral servers, child
processes and temporary state. No Docker context or production deployment is
needed for this gate. Parent release owner separately reviews package/install
wiring and performs any authorized real consent or playback acceptance.
