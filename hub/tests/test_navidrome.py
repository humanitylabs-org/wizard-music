"""Navidrome as the library backend (wizard-music#92, on for everyone): a fake Navidrome speaking Subsonic."""
import hashlib
import importlib
import json
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

AUDIO = bytes(range(256)) * 40


class FakeNavidrome:
    def __init__(self):
        self.users = set()
        self.scanning = False
        self.songs = [
            {'id': 'nd1', 'title': 'Song 1', 'artist': 'Test Artist', 'album': 'Album One', 'duration': 20,
             'path': '/music/Test Artist/Album One/01 Song 1.mp3', 'coverArt': 'mf-nd1'},
            {'id': 'nd2', 'title': 'Loose Tune', 'artist': 'Other Band', 'album': '[Unknown Album]', 'duration': 15,
             'path': '/music/loose.mp3'},
        ]
        self.playlists = {}
        self.stars = set()
        self.calls = []
        self.headers = []
        self.down = False


def serve(nd: FakeNavidrome):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype='application/json', extra=None):
            raw = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(raw)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(raw)

        def _ok(self, **extra):
            self._send(200, {'subsonic-response': {'status': 'ok', 'version': '1.16.1', **extra}})

        def do_POST(self):
            assert self.path == '/wizard-music/auth/createAdmin'
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if nd.users:
                return self._send(403, {'error': 'exists'})
            nd.users.add(body['username'])
            self._send(200, {'id': 'u1', 'isAdmin': True})

        def do_GET(self):
            if nd.down:
                return self._send(503, b'down', 'text/plain')
            u = urllib.parse.urlparse(self.path)
            assert u.path.startswith('/wizard-music/rest/')
            view = u.path.rsplit('/', 1)[1].removesuffix('.view')
            q = urllib.parse.parse_qs(u.query)
            nd.calls.append((view, q))
            nd.headers.append(self.headers.get('X-Wizard-Navidrome-User'))
            if self.headers.get('X-Wizard-Navidrome-User') not in nd.users:
                return self._send(200, {'subsonic-response': {'status': 'failed', 'error': {'code': 40, 'message': 'Wrong username or password'}}})
            if view == 'getScanStatus':
                return self._ok(scanStatus={'scanning': nd.scanning})
            if view == 'search3':
                off, n = int(q['songOffset'][0]), int(q['songCount'][0])
                return self._ok(searchResult3={'song': nd.songs[off:off + n]})
            if view == 'getPlaylists':
                return self._ok(playlists={'playlist': [{'id': k, **{x: v[x] for x in ('name', 'comment')}} for k, v in nd.playlists.items()]})
            if view == 'createPlaylist':
                pid = q.get('playlistId', [None])[0] or f'pl{len(nd.playlists) + 1}'
                p = nd.playlists.setdefault(pid, {'name': '', 'comment': ''})
                p['name'] = q.get('name', [p['name']])[0]
                p['songs'] = q.get('songId', [])
                return self._ok(playlist={'id': pid})
            if view == 'updatePlaylist':
                p = nd.playlists[q['playlistId'][0]]
                for k in ('name', 'comment'):
                    if k in q:
                        p[k] = q[k][0]
                return self._ok()
            if view == 'deletePlaylist':
                nd.playlists.pop(q['id'][0], None)
                return self._ok()
            if view in ('star', 'unstar'):
                (nd.stars.update if view == 'star' else nd.stars.difference_update)(q['id'])
                return self._ok()
            if view == 'getCoverArt':
                return self._send(200, b'\xff\xd8cover-' + q['id'][0].encode(), 'image/jpeg')
            if view == 'stream':
                assert q['format'] == ['raw']
                rng = self.headers.get('Range')
                if rng:
                    a, b = rng.removeprefix('bytes=').split('-')
                    a, b = int(a), int(b or len(AUDIO) - 1)
                    return self._send(206, AUDIO[a:b + 1], 'audio/mpeg', {'Content-Range': f'bytes {a}-{b}/{len(AUDIO)}', 'Accept-Ranges': 'bytes'})
                return self._send(200, AUDIO, 'audio/mpeg', {'Accept-Ranges': 'bytes'})
            self._send(404, b'', 'text/plain')

    server = ThreadingHTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@pytest.fixture
def env(tmp_path, monkeypatch):
    nd = FakeNavidrome()
    server = serve(nd)
    lib = tmp_path / 'music'
    (lib / 'Test Artist' / 'Album One').mkdir(parents=True)
    (lib / 'Test Artist' / 'Album One' / '01 Song 1.mp3').write_bytes(b'local-file')
    (lib / 'loose.mp3').write_bytes(b'local-file-2')
    monkeypatch.setenv('WIZARD_MUSIC_HUB_HOME', str(tmp_path / 'home'))
    monkeypatch.setenv('WIZARD_MUSIC_LIBRARY', str(lib))
    monkeypatch.setenv('WIZARD_MUSIC_ONLINE', '0')
    monkeypatch.setenv('WIZARD_SWITCHES_DIR', str(tmp_path / 'sw'))
    monkeypatch.setenv('WIZARD_MUSIC_NAVIDROME_URL', f'http://127.0.0.1:{server.server_port}/wizard-music')
    import navidrome as n
    importlib.reload(n)
    import hub as h
    h = importlib.reload(h)
    h.navidrome = n

    url = n.URL

    def bundle(on):   # this install ships Navidrome (WIZARD_MUSIC_NAVIDROME_URL set), or not
        n.URL = url if on else ''
    yield h, n, nd, bundle, lib
    server.shutdown()
    h._db.close()


def lib_id(rel):
    return 'lib:' + hashlib.sha256(rel.encode()).hexdigest()[:20]


def test_on_without_a_switch_and_a_stale_stored_value_changes_nothing(env, tmp_path):
    h, n, nd, bundle, lib = env
    (tmp_path / 'sw').mkdir(exist_ok=True)
    (tmp_path / 'sw' / 'switches.json').write_text(json.dumps({'navidrome': False}))   # left from the old switch
    assert n.active() and not hasattr(n, 'switch_on')
    assert h.refresh_library() == 2
    assert 'search3' in {c[0] for c in nd.calls}
    assert h.home()['sources'][-1]['name'] == 'Wizard Library · Navidrome'


def test_an_install_without_navidrome_scans_the_folder_itself(env):
    h, n, nd, bundle, lib = env
    bundle(False)
    assert not n.active()
    assert h.refresh_library() == 2
    assert nd.calls == []
    card = h.home()['sources'][-1]
    assert card['name'] == 'Wizard Library' and "isn't part of this install" in card['detail']


def test_on_the_library_comes_from_navidrome_with_the_same_ids(env):
    h, n, nd, bundle, lib = env
    bundle(False)
    h.refresh_library()   # the old backend first: a like and a playlist on a library song
    song1 = lib_id('Test Artist/Album One/01 Song 1.mp3')
    assert song1 == f"lib:{h._lib_id(lib / 'Test Artist' / 'Album One' / '01 Song 1.mp3')}"
    h.db('INSERT INTO likes VALUES(?,?,?)', (song1, 1, time.time()))
    h.db('INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?,?)', ('yt:abcdefghijk', 'Online', 'Someone', '', 1000, '', 'youtube', '', time.time()))
    mine = h.create_song_playlist({'name': 'Mix', 'trackIds': ['yt:abcdefghijk', song1, lib_id('loose.mp3')]})
    bundle(True)
    assert n.active()
    assert h.refresh_library() == 2
    assert nd.users == {'wizard'} and set(nd.headers) == {'wizard'}   # its one user, made by Music, trusted by header
    t = h.track(song1)
    assert t['title'] == 'Song 1' and t['album'] == 'Album One' and t['durationMs'] == 20000 and t['liked']
    assert h.track(lib_id('loose.mp3'))['album'] == ''
    # Music's playlist in Navidrome: its library songs, in order; the YouTube song stays only in Music.
    assert list(nd.playlists.values()) == [{'name': 'Mix', 'comment': n.MARK, 'songs': ['nd1', 'nd2']}]
    assert h.song_playlist(mine['id'])['trackIds'] == ['yt:abcdefghijk', song1, lib_id('loose.mp3')]
    assert nd.stars == {'nd1'}
    lib_card = h.home()['sources'][-1]
    assert lib_card['name'] == 'Wizard Library · Navidrome' and lib_card['ok']
    # A change in Music follows; a second pass with nothing changed writes nothing.
    h.update_song_playlist(mine['id'], {'name': 'Gym', 'trackIds': [lib_id('loose.mp3'), song1]})
    h.db('INSERT OR REPLACE INTO likes VALUES(?,?,?)', (song1, 0, time.time()))
    nd.stars.add('nd2')   # starred in a phone app: Music leaves it alone
    h.refresh_library()
    assert list(nd.playlists.values()) == [{'name': 'Gym', 'comment': n.MARK, 'songs': ['nd2', 'nd1']}]
    assert nd.stars == {'nd2'}
    nd.calls.clear()
    h.refresh_library()
    assert {c[0] for c in nd.calls} == {'getScanStatus', 'search3', 'getPlaylists'}
    h.update_song_playlist(mine['id'], {}, 'delete')
    h.refresh_library()
    assert nd.playlists == {}


def test_a_scan_in_progress_never_drops_songs_and_navidrome_down_falls_back_to_the_folder(env):
    h, n, nd, bundle, lib = env
    bundle(False)
    h.refresh_library()
    bundle(True)
    nd.songs = nd.songs[:1]
    nd.scanning = True
    h.refresh_library()
    assert h.track(lib_id('loose.mp3'))   # still scanning: kept
    nd.scanning = False
    h.refresh_library()
    assert h.track(lib_id('loose.mp3')) is None   # a finished scan says it is gone
    nd.down = True
    assert h.refresh_library() == 2   # Navidrome not answering: Music reads the folder itself
    card = h.home()['sources'][-1]
    assert not card['ok'] and 'reads the folder itself' in card['detail']


def test_without_navidrome_again_nothing_is_lost(env):
    h, n, nd, bundle, lib = env
    bundle(True)
    h.refresh_library()
    song1 = lib_id('Test Artist/Album One/01 Song 1.mp3')
    h.db('INSERT INTO likes VALUES(?,?,?)', (song1, 1, time.time()))
    p = h.create_song_playlist({'name': 'Keep', 'trackIds': [song1]})
    bundle(False)
    assert h.refresh_library() == 2
    assert h.track(song1)['liked'] and h.song_playlist(p['id'])['trackIds'] == [song1]
    assert h.track(song1)['title'] == '01 Song 1'   # the folder scan's own name again (no tags in the fake file)


def test_stream_and_art_come_from_navidrome(env):
    h, n, nd, bundle, lib = env
    bundle(True)
    h.refresh_library()
    song1 = lib_id('Test Artist/Album One/01 Song 1.mp3')
    server = ThreadingHTTPServer(('127.0.0.1', 0), h.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        import urllib.request
        h.TOKEN = 'x'
        req = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/stream/{song1}', headers={'Authorization': 'Bearer x', 'Range': 'bytes=10-19'})
        with urllib.request.urlopen(req) as r:
            assert r.status == 206 and r.read() == AUDIO[10:20] and r.headers['Content-Range'] == f'bytes 10-19/{len(AUDIO)}'
        assert ('stream', {'id': ['nd1'], 'format': ['raw'], 'c': ['wizard-music'], 'v': ['1.16.1'], 'f': ['json']}) in nd.calls
        nd.down = True   # Navidrome gone: the file itself plays
        req = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/stream/{song1}', headers={'Authorization': 'Bearer x'})
        with urllib.request.urlopen(req) as r:
            assert r.read() == b'local-file'
        nd.down = False
        assert h.art_bytes(song1)[0] == b'\xff\xd8cover-mf-nd1'
        assert h.art_bytes(lib_id('loose.mp3')) is None   # no cover in Navidrome: no placeholder, Music shows its own
        assert not [c for c in nd.calls if c[0] == 'getCoverArt' and c[1]['id'] != ['mf-nd1']]
    finally:
        server.shutdown()
