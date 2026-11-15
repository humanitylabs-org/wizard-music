"""wizard-music#46 (switch live-mixes): a long mix starts while the hub is still downloading it.

The app server sends X-Wizard-Music-Live: 1 only while the switch is on. The hub then answers once the first bytes are
on disk, keeps sending while the rest arrives, serves byte ranges inside the part it has, and leaves the bytes under a
live player alone (no plain-MP4 rewrite while it may still be playing).
"""
import importlib.util
import json
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

VID = 'HW0otI10RrM'
BODY = bytes(range(256)) * 2048  # 512 KiB


class Source(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    go = threading.Event()
    paths: list[str] = []
    length = True

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == '/api/status':
            raw = json.dumps({'name': 'YouTube Music', 'playback': {'state': 'ok'}}).encode()
            self.send_response(200); self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw); return
        Source.paths.append(self.path)
        self.send_response(200)
        if Source.length:
            self.send_header('Content-Length', str(len(BODY)))
        else:
            self.send_header('Connection', 'close'); self.close_connection = True
        self.end_headers()
        self.wfile.write(BODY[:128 * 1024]); self.wfile.flush()
        Source.go.wait(10)  # the rest of the song is still downloading
        self.wfile.write(BODY[128 * 1024:])


@pytest.fixture
def hub(monkeypatch, tmp_path):
    Source.go = threading.Event(); Source.paths = []; Source.length = True
    src = ThreadingHTTPServer(('127.0.0.1', 0), Source)
    threading.Thread(target=src.serve_forever, daemon=True).start()
    monkeypatch.setenv('WIZARD_MUSIC_HUB_HOME', str(tmp_path))
    monkeypatch.setenv('WIZARD_MUSIC_LIBRARY', str(tmp_path / 'library'))
    monkeypatch.setenv('WIZARD_MUSIC_SOURCES', f'wizard-youtube-music=http://127.0.0.1:{src.server_port}')
    monkeypatch.setenv('WIZARD_MUSIC_HUB_TOKEN', 'x')
    spec = importlib.util.spec_from_file_location('live_hub', Path(__file__).parents[1] / 'hub.py')
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    mod.set_online(True)
    mod.remuxed = []
    monkeypatch.setattr(mod, 'remux_plain', lambda p: (mod.remuxed.append(p.name), p)[1])
    srv = ThreadingHTTPServer(('127.0.0.1', 0), mod.Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    mod.base = f'http://127.0.0.1:{srv.server_port}'
    yield mod
    Source.go.set()
    srv.shutdown(); src.shutdown()
    mod._db.close()


def get(hub, live=True, rng=None, timeout=10):
    headers = {'Authorization': 'Bearer x'}
    if live:
        headers['X-Wizard-Music-Live'] = '1'
    if rng:
        headers['Range'] = rng
    return urllib.request.urlopen(urllib.request.Request(f'{hub.base}/stream/yt:{VID}', headers=headers), timeout=timeout)


def test_a_live_player_gets_the_first_bytes_while_the_song_still_downloads(hub):
    with get(hub) as r:
        assert r.status == 200 and r.headers['Content-Length'] == str(len(BODY)) and r.headers['Accept-Ranges'] == 'bytes'
        first = r.read(100 * 1024)
        assert first == BODY[:100 * 1024] and not Source.go.is_set()  # played before the download finished
        Source.go.set()
        assert first + r.read() == BODY
    assert Source.paths == [f'/api/music/audio/{VID}?live=1']
    assert hub._cache_path(VID).read_bytes() == BODY
    assert hub.remuxed == []  # the bytes under the live player stay as they are


def test_seeking_ahead_waits_for_that_part_and_a_range_inside_is_served_at_once(hub):
    with get(hub) as r:
        r.read(1)
        with get(hub, rng='bytes=1000-1999') as inside:
            assert inside.status == 206 and inside.headers['Content-Range'] == f'bytes 1000-1999/{len(BODY)}'
            assert inside.read() == BODY[1000:2000]
        threading.Timer(0.3, Source.go.set).start()
        with get(hub, rng='bytes=400000-') as ahead:
            assert ahead.status == 206 and ahead.read() == BODY[400000:]
        r.read()
    with get(hub, rng='bytes=10-19') as after:  # finished and cached, still the same bytes
        assert after.read() == BODY[10:20]
    assert hub.remuxed == []


def test_without_the_switch_the_song_is_downloaded_whole_first_as_before(hub):
    threading.Timer(0.3, Source.go.set).start()
    started = time.time()
    with get(hub, live=False) as r:
        assert time.time() - started >= 0.25  # nothing until the whole download is in
        assert r.read() == BODY
    assert Source.paths == [f'/api/music/audio/{VID}']
    assert len(hub.remuxed) == 1  # plain-MP4 rewrite as before


def test_a_rewrite_waits_until_live_players_have_left_the_song(hub, monkeypatch):
    Source.go.set()
    with get(hub) as r:
        assert r.read() == BODY
    assert hub.fetch_audio(VID).read_bytes() == BODY and hub.remuxed == []
    monkeypatch.setattr(hub, 'LIVE_KEEP_SECONDS', 0)
    monkeypatch.setattr(hub, 'is_fragmented_mp4', lambda p: True)
    hub.fetch_audio(VID)
    assert len(hub.remuxed) == 1  # a later play gets the plain file


def test_an_unknown_size_falls_back_to_the_whole_file_first(hub):
    Source.length = False
    threading.Timer(0.3, Source.go.set).start()
    with get(hub) as r:
        assert r.headers['Content-Length'] == str(len(BODY)) and r.read() == BODY


def test_a_download_cut_short_breaks_the_live_answer_instead_of_ending_it_cleanly(hub, monkeypatch):
    real = Source.do_GET

    def cut(self):
        if self.path == '/api/status':
            return real(self)
        self.send_response(200); self.send_header('Content-Length', str(len(BODY))); self.end_headers()
        self.wfile.write(BODY[:128 * 1024]); self.wfile.flush()
        Source.go.wait(10)
        self.close_connection = True
    monkeypatch.setattr(Source, 'do_GET', cut)
    with get(hub) as r:
        r.read(1)
        Source.go.set()
        with pytest.raises(Exception):
            got = r.read()
            assert len(got) == len(BODY) - 1
    assert hub._cache_path(VID) is None


def test_cache_lookup_stays_inside_the_audio_cache(hub, tmp_path):
    """Issue 58: the cache lookup checks its real path inside the cache dir (code scanning guard)."""
    vid = 'aBcDeFgHiJk'
    (hub.CACHE / f'{vid}.m4a').write_bytes(b'audio')
    hit = hub._cache_path(vid)
    assert hit is not None and hit.read_bytes() == b'audio'
    outside = tmp_path / 'outside.m4a'
    outside.write_bytes(b'secret')
    (hub.CACHE / 'zZzZzZzZzZz.m4a').symlink_to(outside)
    assert hub._cache_path('zZzZzZzZzZz') is None
    assert hub._cache_path('../outside') is None
