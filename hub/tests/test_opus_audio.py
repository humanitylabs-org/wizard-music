"""wizard-os#820 (switch opus-audio): YouTube's Opus stream for players that can play it, AAC for everyone else.

The app server adds X-Wizard-Music-Codec: opus to a song stream only when the switch is on and the player can decode
Opus. The hub then asks the connector for ?codec=opus, keeps the Opus file as <id>.webm beside <id>.m4a and serves it
as audio/webm (also while it is still downloading). Without the header everything is as before.
"""
import importlib.util
import json
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

VID = 'zKmWd8DPrEc'
AAC = b'AAC!' * 40000
OPUS = b'OPUS' * 50000


class Source(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    paths: list[str] = []
    has_opus = True

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == '/api/status':
            raw = json.dumps({'name': 'YouTube Music', 'playback': {'state': 'ok'}}).encode()
            self.send_response(200); self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw); return
        Source.paths.append(self.path)
        opus = 'codec=opus' in self.path and Source.has_opus
        body = OPUS if opus else AAC
        self.send_response(200)
        self.send_header('Content-Type', 'audio/webm' if opus else 'audio/mp4')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def hub(monkeypatch, tmp_path):
    Source.paths = []; Source.has_opus = True
    src = ThreadingHTTPServer(('127.0.0.1', 0), Source)
    threading.Thread(target=src.serve_forever, daemon=True).start()
    monkeypatch.setenv('WIZARD_MUSIC_HUB_HOME', str(tmp_path))
    monkeypatch.setenv('WIZARD_MUSIC_LIBRARY', str(tmp_path / 'library'))
    monkeypatch.setenv('WIZARD_MUSIC_SOURCES', f'wizard-youtube-music=http://127.0.0.1:{src.server_port}')
    monkeypatch.setenv('WIZARD_MUSIC_HUB_TOKEN', 'x')
    spec = importlib.util.spec_from_file_location('opus_hub', Path(__file__).parents[1] / 'hub.py')
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    mod.set_online(True)
    srv = ThreadingHTTPServer(('127.0.0.1', 0), mod.Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    mod.base = f'http://127.0.0.1:{srv.server_port}'
    yield mod
    srv.shutdown(); src.shutdown()
    mod._db.close()


def get(hub, opus=False, live=True):
    headers = {'Authorization': 'Bearer x'}
    if live:
        headers['X-Wizard-Music-Live'] = '1'
    if opus:
        headers['X-Wizard-Music-Codec'] = 'opus'
    with urllib.request.urlopen(urllib.request.Request(f'{hub.base}/stream/yt:{VID}', headers=headers), timeout=10) as r:
        return r.headers['Content-Type'], r.read()


@pytest.mark.parametrize('live', [True, False])
def test_without_the_header_the_hub_asks_for_aac_exactly_as_before(hub, live):
    assert get(hub, live=live) == ('audio/mp4', AAC)
    assert Source.paths == [f'/api/music/audio/{VID}' + ('?live=1' if live else '')]
    assert sorted(p.name for p in hub.CACHE.iterdir()) == [f'{VID}.m4a']


@pytest.mark.parametrize('live', [True, False])
def test_an_opus_player_gets_the_opus_file_and_both_variants_stay_side_by_side(hub, live):
    assert get(hub, live=live) == ('audio/mp4', AAC)  # cached as AAC before the switch went on
    assert get(hub, opus=True, live=live) == ('audio/webm', OPUS)  # a cached AAC song is fetched again as Opus
    assert Source.paths[-1] == f'/api/music/audio/{VID}?' + ('live=1&' if live else '') + 'codec=opus'
    assert sorted(p.name for p in hub.CACHE.iterdir()) == [f'{VID}.m4a', f'{VID}.webm']
    asked = len(Source.paths)
    assert get(hub, opus=True, live=live) == ('audio/webm', OPUS)  # from the cache now
    assert get(hub, live=live) == ('audio/mp4', AAC)  # Safari still gets AAC, never the webm
    assert len(Source.paths) == asked


def test_a_song_without_opus_comes_back_as_aac_and_is_kept_once(hub):
    Source.has_opus = False
    assert get(hub, opus=True) == ('audio/mp4', AAC)
    assert sorted(p.name for p in hub.CACHE.iterdir()) == [f'{VID}.m4a']
    asked = len(Source.paths)
    assert get(hub, opus=True) == ('audio/mp4', AAC)
    assert get(hub) == ('audio/mp4', AAC)
    assert len(Source.paths) == asked


def test_songs_fetched_ahead_match_the_variant_the_player_asked_for(hub):
    assert hub._prefetch_codec == ['aac']
    get(hub, opus=True)
    assert hub._prefetch_codec == ['opus']
    get(hub)
    assert hub._prefetch_codec == ['aac']
