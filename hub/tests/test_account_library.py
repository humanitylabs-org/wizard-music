"""Account connector contract fixtures; never uses an owner's account/network."""
import importlib.util
import json
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock

import pytest


@pytest.fixture
def hub(monkeypatch, tmp_path):
    monkeypatch.setenv('WIZARD_MUSIC_HUB_HOME', str(tmp_path))
    monkeypatch.setenv('WIZARD_MUSIC_LIBRARY', str(tmp_path / 'library'))
    spec = importlib.util.spec_from_file_location('account_hub', Path(__file__).parents[1] / 'hub.py')
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    mod.set_online(True)
    mod.TOKEN = 'fixture-token'
    status = {'id': 'wizard-youtube-music', 'base': 'http://connector.invalid', 'installed': True,
              'account_status': {'state': 'connected'}, 'capabilities': {'library': ['playlists', 'likes', 'playlist']}}
    monkeypatch.setattr(mod, 'sources_status', Mock(return_value=[status]))
    yield mod, status
    mod._db.close()


def test_playlists_and_tracks_are_consumable_without_changing_taste(hub, monkeypatch):
    mod, _ = hub
    get = Mock(return_value={'playlists': [{'playlistId': 'PL_abc-1', 'title': 'Personal <mix>', 'count': 2}, {'playlistId': '../bad'}]})
    monkeypatch.setattr(mod, '_source_get', get)
    assert mod.account_library('playlists')['playlists'] == [{'id': 'PL_abc-1', 'title': 'Personal <mix>', 'count': 2}]
    get.return_value = {'tracks': [{'videoId': 'sWcLccMuCA8', 'title': 'Xtal', 'artists': [{'name': 'Aphex Twin'}]}, {'videoId': '../bad'}]}
    for kind in ['likes', 'playlist']:
        result = mod.account_library(kind, 'PL_abc-1', 999)
        assert result['limit'] == 100
        assert result['tracks'][0]['id'] == 'yt:sWcLccMuCA8'
        assert urllib.parse.unquote(result['tracks'][0]['stream']).endswith('/stream/yt:sWcLccMuCA8')
        assert len(result['tracks']) == 1
    assert 'id=PL_abc-1&limit=100' in get.call_args.args[1]
    assert mod.db('SELECT * FROM likes') == []


@pytest.mark.parametrize('state', ['signed_out', 'needs_attention'])
def test_signed_out_never_reads_library(hub, monkeypatch, state):
    mod, status = hub
    status['account_status']['state'] = state
    get = Mock(side_effect=AssertionError('must not read library'))
    monkeypatch.setattr(mod, '_source_get', get)
    result = mod.account_library('likes')
    assert result['state'] == state and result['connect'] == '/wizard-youtube-music/'
    get.assert_not_called()


def test_offline_missing_old_connector_and_failure(hub, monkeypatch):
    mod, status = hub
    mod.set_online(False)
    mod.sources_status.reset_mock()
    assert mod.account_library()['state'] == 'off'
    mod.sources_status.assert_not_called()
    mod.set_online(True)
    status['installed'] = False
    assert mod.account_library()['state'] == 'unavailable'
    status['installed'] = True
    caps = status.pop('capabilities')
    assert mod.account_library()['state'] == 'unsupported'
    status['capabilities'] = caps
    monkeypatch.setattr(mod, '_source_get', Mock(side_effect=RuntimeError('secret upstream details')))
    result = mod.account_library('likes')
    assert result['state'] == 'unavailable' and 'secret' not in result['error']
    with pytest.raises(ValueError):
        mod.account_library('playlist', '../bad')


def test_real_http_auth_validation_and_errors(hub, monkeypatch):
    mod, status = hub
    monkeypatch.setattr(mod, '_source_get', Mock(return_value={'tracks': []}))
    server = ThreadingHTTPServer(('127.0.0.1', 0), mod.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    def get(path, token='fixture-token'):
        req = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/api/account-library/{path}', headers={'Authorization': f'Bearer {token}'})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)
    try:
        assert get('likes')[1]['tracks'] == []
        assert get('likes', 'wrong')[0] == 401
        assert get('playlist?id=..%2Fbad')[0] == 400
        assert get('likes?limit=no')[0] == 400
        status['account_status']['state'] = 'signed_out'
        assert get('status')[1]['state'] == 'signed_out'
        assert get('likes')[0] == 409
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
