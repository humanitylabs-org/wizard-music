import importlib
import io
import json
from pathlib import Path
import sys
import time

import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture
def hub(tmp_path, monkeypatch):
    monkeypatch.setenv('WIZARD_MUSIC_HUB_HOME', str(tmp_path))
    monkeypatch.setenv('WIZARD_MUSIC_ONLINE', '0')
    import hub as h
    h = importlib.reload(h)
    for i in range(25):
        h.db('INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?,?)', (f'yt:song{i:07d}', f'Song {i}', 'Argy', '', 200000, '', 'youtube', '', time.time()))
    h.db('INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?,?)', ('lib:' + 'a' * 20, 'Own file', 'Me', '', 1000, '', 'library', '/x.mp3', time.time()))
    yield h
    h._db.close()


def ids(n):
    return [f'yt:song{i:07d}' for i in range(n)]


def test_agent_builds_a_playlist_end_to_end_in_order(hub):
    made = hub.create_song_playlist({'name': 'Argy workout', 'trackIds': ids(20) + ['yt:unknown0000', 'yt:song0000003']})
    assert made['name'] == 'Argy workout' and made['count'] == 20 and made['skipped'] == ['yt:unknown0000']
    assert [t['id'] for t in made['tracks']] == ids(20)
    assert hub.song_playlists()[0]['id'] == made['id'] and 'tracks' not in hub.song_playlists()[0]
    added = hub.update_song_playlist(made['id'], {'trackIds': ['lib:' + 'a' * 20, 'yt:song0000000'], 'position': 0}, 'add')
    assert added['trackIds'][:2] == ['lib:' + 'a' * 20, 'yt:song0000000'] and added['count'] == 21
    removed = hub.update_song_playlist(made['id'], {'trackIds': ['yt:song0000000', 'yt:song0000001']}, 'remove')
    assert removed['trackIds'][:2] == ['lib:' + 'a' * 20, 'yt:song0000002']
    order = list(reversed(removed['trackIds']))
    renamed = hub.update_song_playlist(made['id'], {'name': ' Gym ', 'description': 'Loud', 'trackIds': order})
    assert renamed['name'] == 'Gym' and renamed['description'] == 'Loud' and renamed['trackIds'] == order
    assert hub.update_song_playlist(made['id'], {}, 'delete') == {'id': made['id'], 'deleted': True}
    assert hub.song_playlists() == []
    with pytest.raises(LookupError):
        hub.song_playlist(made['id'])


@pytest.mark.parametrize('body', [{}, {'name': '  '}, {'name': 'x\ny'}, {'name': 'x' * 101}, {'name': 'x', 'trackIds': 'yt:song0000000'},
                                  {'name': 'x', 'trackIds': ['../etc']}, {'name': 'x', 'trackIds': [1]}, {'name': 'x', 'url': 'https://x'},
                                  {'name': 'x', 'trackIds': ['yt:a'] * 501}])
def test_rejects_bad_input_without_writes(hub, body):
    with pytest.raises(ValueError):
        hub.create_song_playlist(body)
    assert hub.song_playlists() == []


def test_update_rejects_unknown_fields_and_missing_playlist(hub):
    made = hub.create_song_playlist({'name': 'A'})
    for action, body in [('add', {'name': 'B'}), ('remove', {'trackIds': 'x'}), ('add', {'trackIds': ids(1), 'position': -1}), ('delete', {'x': 1})]:
        with pytest.raises(ValueError):
            hub.update_song_playlist(made['id'], body, action)
    with pytest.raises(LookupError):
        hub.update_song_playlist('f' * 24, {'name': 'B'})


def test_http_routes(hub):
    class Fake(hub.Handler):
        def __init__(self, method, path, body=None):
            raw = json.dumps(body).encode() if body is not None else b''
            self.command, self.path, self.rfile, self.wfile = method, path, io.BytesIO(raw), io.BytesIO()
            self.headers = {'Content-Length': str(len(raw)), 'Authorization': f'Bearer {hub.TOKEN}'}
            self.status = None

        def send_response(self, code, message=None):
            self.status = code

        def send_header(self, *a):
            pass

        def end_headers(self):
            pass

    def call(method, path, body=None):
        h = Fake(method, path, body)
        (h.do_POST if method == 'POST' else h.do_GET)()
        return h.status, json.loads(h.wfile.getvalue() or b'null')

    status, made = call('POST', '/api/song-playlists', {'name': 'Argy workout', 'trackIds': ids(3)})
    assert status == 200 and made['count'] == 3
    assert call('GET', '/api/song-playlists')[1]['playlists'][0]['id'] == made['id']
    status, got = call('GET', f"/api/song-playlists/{made['id']}")
    assert status == 200 and [t['id'] for t in got['tracks']] == ids(3) and got['tracks'][0]['stream'].endswith('yt%3Asong0000000')
    assert call('POST', f"/api/song-playlists/{made['id']}/add", {'trackIds': ids(5)})[1]['count'] == 5
    assert call('POST', f"/api/song-playlists/{made['id']}/remove", {'trackIds': ids(1)})[1]['count'] == 4
    assert call('POST', f"/api/song-playlists/{made['id']}", {'name': 'Gym'})[1]['name'] == 'Gym'
    assert call('POST', '/api/song-playlists', {'name': ''})[0] == 400
    assert call('POST', f"/api/song-playlists/{'f' * 24}/add", {'trackIds': ids(1)})[0] == 404
    assert call('POST', f"/api/song-playlists/{made['id']}/delete", {})[1]['deleted'] is True
    assert call('GET', f"/api/song-playlists/{made['id']}")[0] == 404
