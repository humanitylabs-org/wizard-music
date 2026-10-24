import importlib.util
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest


class Fake(BaseHTTPRequestHandler):
    state = 'ok'

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == '/api/status':
            body = {'name': 'YouTube Music', 'playback': {'state': Fake.state, 'message': 'YouTube is blocking this network'}}
        elif self.path.startswith('/api/music/search'):
            body = {'tracks': [{'videoId': 'sWcLccMuCA8', 'title': 'Xtal', 'artists': [{'name': 'Aphex Twin'}]}]}
        elif self.path.startswith('/api/music/audio/'):
            if Fake.state == 'blocked':
                self.send_response(502); self.send_header('Content-Length', '2'); self.end_headers(); self.wfile.write(b'{}'); return
            self.send_response(200); self.send_header('Content-Length', '5'); self.end_headers(); self.wfile.write(b'audio'); return
        else:
            self.send_response(404); self.send_header('Content-Length', '0'); self.end_headers(); return
        raw = json.dumps(body).encode()
        self.send_response(200); self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)


@pytest.fixture
def hub(monkeypatch, tmp_path):
    srv = ThreadingHTTPServer(('127.0.0.1', 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setenv('WIZARD_MUSIC_HUB_HOME', str(tmp_path))
    monkeypatch.setenv('WIZARD_MUSIC_LIBRARY', str(tmp_path / 'library'))
    monkeypatch.setenv('WIZARD_MUSIC_SOURCES', f'wizard-youtube-music=http://127.0.0.1:{srv.server_port},wizard-missing=http://127.0.0.1:9')
    spec = importlib.util.spec_from_file_location('sources_hub', Path(__file__).parents[1] / 'hub.py')
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    mod.set_online(True)
    yield mod
    srv.shutdown()
    mod._db.close()


def test_search_and_audio_go_through_connector(hub):
    Fake.state = 'ok'
    assert [t['id'] for t in hub.search('xtal')] == ['yt:sWcLccMuCA8']
    assert hub.fetch_audio('sWcLccMuCA8').read_bytes() == b'audio'


def test_home_shows_each_connector_honestly(hub):
    Fake.state = 'blocked'
    cards = {c['id']: c for c in hub.home()['sources']}
    assert cards['wizard-youtube-music']['ok'] is False and 'blocking' in cards['wizard-youtube-music']['detail']
    assert cards['wizard-missing']['status'] == 'missing'
    assert cards['library']['ok'] is True
    with pytest.raises(RuntimeError, match='blocked'):
        hub.fetch_audio('aaaaaaaaaaa')


def test_offline_never_calls_connectors(hub, monkeypatch):
    hub.set_online(False)
    monkeypatch.setattr(hub.urllib.request, 'urlopen', lambda *a, **k: (_ for _ in ()).throw(AssertionError('network')))
    hub._source_status.clear()
    assert all(c['status'] in ('off', 'connected') for c in hub.home()['sources'])
