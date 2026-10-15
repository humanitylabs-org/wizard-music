"""Cross-app fixture: actual Music HTTP server -> Connectors Handler -> RPC -> Broker.
Only Google transport and pre-existing hub metadata are fake. No real consent,
accounts, provider network, credential reads, deployment or sibling edits.
Run on the designated worker; pass a read-only Connectors source checkout.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

parser = argparse.ArgumentParser()
parser.add_argument('--connectors-source', type=Path, required=True)
parser.add_argument('--core-dir', type=Path, required=True)
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
args.evidence.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(args.connectors_source / 'tests'))
from test_google_http import BrokerHTTPTests  # Production service harness with explicit FakeGoogle.

checks = []
processes = []
logs = []
fixture = BrokerHTTPTests()


def request(url, data=None, headers=None):
    req = Request(url, data=None if data is None else json.dumps(data).encode(),
                  headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        response = urlopen(req, timeout=15)
    except HTTPError as error:
        response = error
    with response:
        return response.status, json.loads(response.read())


class FakeHub(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        assert self.headers['Authorization'] == 'Bearer FAKE_HUB_ONLY'
        track = {'id': 'yt:W8VdVY8diqs', 'title': 'FAKE selected track', 'artist': 'Fixture artist',
                 'album': '', 'source': 'youtube', 'durationMs': 123000, 'art': '',
                 'stream': '/wizard/music/stream/yt:W8VdVY8diqs', 'liked': True}
        body = json.dumps({'sources': [{'id': 'youtube', 'name': 'YouTube Music', 'status': 'fixture',
                                       'detail': 'FAKE hub metadata; playback not tested', 'ok': True}],
                           'vibes': [], 'recent': [], 'liked': [track], 'library': []}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def music(name, connector_url, token, with_hub=True):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {'PATH': os.environ['PATH'], 'WIZARD_MUSIC_APP_PORT': str(port),
           'WIZARD_MUSIC_HUB_ORIGIN': f'http://127.0.0.1:{hub.server_port}',
           'WIZARD_MUSIC_HUB_TOKEN': 'FAKE_HUB_ONLY',
           'WIZARD_MUSIC_CONNECTORS_URL': connector_url, 'MUSIC_ADAPTER_TOKEN': token}
    if not with_hub:
        env.pop('WIZARD_MUSIC_HUB_ORIGIN')
        env.pop('WIZARD_MUSIC_HUB_TOKEN')
    log = open(args.evidence / f'music-{name}.log', 'w')
    logs.append(log)
    process = subprocess.Popen(['node', 'server/index.mjs'], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
    processes.append(process)
    base = f'http://127.0.0.1:{port}'
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError(f'Music {name} exited; see evidence log')
        try:
            if request(base + '/health')[0] == 200:
                return base
        except OSError:
            time.sleep(.05)
    raise RuntimeError('Music startup timeout')


def browser(base, scenario, expected):
    subprocess.run(['node', 'qa/catalog-browser.mjs', base.rsplit(':', 1)[1], str(args.core_dir),
                    str(args.evidence), scenario, expected], cwd=root, check=True)
    checks.append(f'browser {scenario}: visible outcome, no playback requests or browser bearer')


fixture.setUp()
hub = ThreadingHTTPServer(('127.0.0.1', 0), FakeHub)
threading.Thread(target=hub.serve_forever, daemon=True).start()
try:
    provider_calls = []
    original = fixture.fake.request

    def fake_request(operation, **kwargs):
        result = original(operation, **kwargs)
        if operation == 'token':
            result['access_token'] = 'FAKE_ACCESS_' + fixture.fake.subject
        if operation == 'catalog':
            provider_calls.append(kwargs)
        return result

    fixture.fake.request = fake_request
    connected = music('connected', fixture.base, 's' * 40)
    path = '/wizard-music/api/catalog'
    payload = {'video_id': 'W8VdVY8diqs'}
    assert request(connected + path, payload) == (409, {'error': 'capability_denied'})
    checks.append('no owner binding -> 409 capability_denied through real Music server')

    first = fixture.connect()
    fixture.fake.subject = 'fixture-subject-b'
    pending = fixture.start()
    assert fixture.finish(pending)[0] == 200
    second = next(a['id'] for a in fixture.b.status()['accounts'] if a['id'] != first)
    assert fixture.req('/api/music/bind', {'account': second, 'consent': True})[0] == 200
    assert fixture.req('/api/state')[1]['google']['bindings'][0]['account'] == second
    status, body = request(connected + path, payload, {'Authorization': 'Bearer NOT_THE_ADAPTER', 'Cookie': 'irrelevant=fixture'})
    assert status == 200 and body['items'] == [{'id': payload['video_id'], 'title': 'FAKE catalog fixture'}]
    assert body['provider'] == 'youtube-music' and body['catalog_source'] == 'youtube-data-api'
    assert body['audio_verified'] is False and body['playback_entitlement'] is False
    assert provider_calls[-1]['token'] == 'FAKE_ACCESS_fixture-subject-b'
    assert not any(secret in json.dumps(body) for secret in ['FAKE_ACCESS_', 'FAKE_REFRESH_SECRET', 's' * 40])
    checks.append('two fixture Google accounts: owner-selected second binding used; no credentials returned')
    catalog_only = music('catalog-only', fixture.base, 's' * 40, with_hub=False)
    assert request(catalog_only + path, payload)[0] == 200
    assert request(catalog_only + '/wizard-music/api/home')[0] == 503
    checks.append('catalog works without a configured playback hub; no accidental hub-token dependency')
    for extra in [{'account': first}, {'url': 'https://example.invalid'}, {'operation': 'fetch'}]:
        assert request(connected + path, {**payload, **extra})[0] == 400
    assert request(connected + path, {'video_id': ' W8VdVY8diqs'})[0] == 400
    assert request(connected + path, payload, {'Origin': 'https://evil.invalid'})[0] == 403
    checks.append('account/URL/operation selectors, malformed ID and hostile Origin rejected')
    browser(connected, 'linked', 'Connected catalog result: FAKE catalog fixture. Source: YouTube Data API.')

    for name, token in [('wrong-token', 'wrong' * 8), ('owner-token', 'o' * 40), ('mcp-token', 'm' * 40), ('broker-token', 'b' * 40)]:
        wrong = music(name, fixture.base, token)
        before = len(provider_calls)
        assert request(wrong + path, payload) == (502, {'error': 'catalog_auth_failed'})
        assert len(provider_calls) == before
        checks.append(f'{name}: denied at Connectors, no provider call')
        if name == 'wrong-token':
            browser(wrong, name, 'Catalog connection authorization failed. Ask your administrator to check the Music adapter token.')

    assert fixture.req('/api/music/unlink', {})[0] == 200
    assert fixture.req('/api/state')[1]['google']['bindings'] == []
    before = len(provider_calls)
    assert request(connected + path, payload) == (409, {'error': 'capability_denied'})
    assert len(provider_calls) == before
    checks.append('owner unlink immediately denies next lookup; no cached success or provider call')
    browser(connected, 'unlinked', 'No Music catalog account is bound. Link Google and bind Music in Connectors, then retry.')

    missing = music('unconfigured', '', '')
    assert request(missing + path, payload) == (503, {'error': 'catalog_not_configured'})
    browser(missing, 'unconfigured', 'Connected catalog lookup is not configured on this Wizard.')
    unreachable = music('unavailable', 'http://127.0.0.1:1', 's' * 40)
    assert request(unreachable + path, payload) == (502, {'error': 'catalog_unavailable'})
    browser(unreachable, 'unavailable', 'Connected catalog lookup is unavailable. Try again later.')
    checks.append('configured lookup never depends on hub token for broker authorization; existing hub path still reads home')
    assert request(connected + '/wizard-music/api/home')[0] == 200
    result = {'ok': True, 'scope': 'Real Music/Connectors HTTP/RPC/store with FAKE Google and hub metadata; no real consent or playback proof',
              'connectors_source_sha256': {str(p.relative_to(args.connectors_source)): hashlib.sha256(p.read_bytes()).hexdigest()
                                           for p in sorted((args.connectors_source / 'app').glob('*.py'))
                                           + [args.connectors_source / 'tests/test_google_http.py']},
              'checks': checks}
    (args.evidence / 'integration.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
finally:
    for process in processes:
        process.terminate()
    for process in processes:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    for log in logs:
        log.close()
    hub.shutdown()
    hub.server_close()
    fixture.tearDown()
