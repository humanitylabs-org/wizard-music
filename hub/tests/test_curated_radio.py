"""More like this stations (wizard-music#90, switch curated-radio): station rules, resolve-or-drop, the AI round trip."""
import importlib
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest


@pytest.fixture
def hub(monkeypatch, tmp_path):
    monkeypatch.setenv('WIZARD_MUSIC_HUB_HOME', str(tmp_path))
    monkeypatch.setenv('WIZARD_MUSIC_LIBRARY', str(tmp_path / 'lib'))
    monkeypatch.delenv('WIZARD_MUSIC_ROUTER_URL', raising=False)
    monkeypatch.delenv('WIZARD_GRANTS_FILE', raising=False)
    root = str(Path(__file__).resolve().parents[1])
    sys.path.insert(0, root)
    sys.modules.pop('hub', None)
    module = importlib.import_module('hub')
    monkeypatch.setattr(module, 'queue_info', lambda *a, **k: None)
    monkeypatch.setattr(module, 'related_artists', lambda artist: ['Kompakt Friend'])
    yield module
    module._db.close()
    sys.path.remove(root)


def add(hub, vid, title, artist, genre=None):
    tid = f'yt:{vid}'
    hub.db('INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?,?)', (tid, title, artist, '', 300000, '', 'youtube', '', 0))
    if genre is not None:
        hub.db('INSERT INTO track_info(id,genre,similar,at) VALUES(?,?,?,?)', (tid, genre, None, 0))
    return tid


def vid(n):
    return f'{n:011d}'


def curated(hub, seed, queue):
    sid = 'c' * 16
    state = {'seed': seed, 'queue': queue, 'played': [seed], 'lastSeed': seed, 'curated': True, 'at0': 0, 'picks': 'ai'}
    hub.db('INSERT INTO stations VALUES(?,?,?,?,?)', (sid, 'Like Trap · Gui Boratto', seed, json.dumps(state), 0))
    return sid, state


def test_anime_and_score_tracks_never_join_a_techno_station(hub, monkeypatch):
    seed = add(hub, 'EoJy_GR1Lb0', 'Trap', 'Gui Boratto', 'Electronic')
    anime = add(hub, vid(1), '青い夜 Blue night', 'Yoshiaki Dewa', 'Anime')
    score = add(hub, vid(2), 'Scorched Earth Exploit', 'Kane Parsons', 'Soundtrack')
    lofi = add(hub, vid(3), 'Rainy lo-fi beats to study', 'Chill Kid')
    good = add(hub, vid(4), 'A New Error', 'Moderat', 'Electronic')
    monkeypatch.setattr(hub, '_radio_from', lambda tid: [])
    sid, state = curated(hub, seed, [anime, score, lofi, good])
    assert [t['id'] for t in hub._take(sid, state, 4)] == [good]


def test_an_anime_seed_keeps_anime(hub, monkeypatch):
    seed = add(hub, vid(10), 'Blue night', 'Yoshiaki Dewa', 'Anime')
    other = add(hub, vid(11), 'Opening theme', 'Someone', 'Anime')
    monkeypatch.setattr(hub, '_radio_from', lambda tid: [])
    sid, state = curated(hub, seed, [other])
    assert [t['id'] for t in hub._take(sid, state, 1)] == [other]


def test_seed_artist_at_most_two_in_fifteen_and_never_back_to_back(hub, monkeypatch):
    seed = add(hub, 'EoJy_GR1Lb0', 'Trap', 'Gui Boratto')
    boratto = [add(hub, vid(20 + i), f'Boratto {i}', 'Gui Boratto') for i in range(5)]
    others = [add(hub, vid(40 + i), f'Song {i}', f'Artist {i}') for i in range(13)]
    monkeypatch.setattr(hub, '_radio_from', lambda tid: [])
    sid, state = curated(hub, seed, boratto + others)
    got = hub._take(sid, state, 15)
    artists = [t['artist'] for t in got]
    assert artists.count('Gui Boratto') <= 2
    assert all(a != b for a, b in zip(artists, artists[1:]))
    assert len(got) == 15


def test_liked_songs_at_most_one_in_eight(hub, monkeypatch):
    seed = add(hub, 'EoJy_GR1Lb0', 'Trap', 'Gui Boratto')
    liked = [add(hub, vid(60 + i), f'Liked {i}', f'Liked Artist {i}') for i in range(4)]
    for tid in liked:
        hub.db('INSERT INTO likes VALUES(?,?,?)', (tid, 1, 0))
    hub.taste_changed()
    others = [add(hub, vid(80 + i), f'Song {i}', f'Artist {i}') for i in range(12)]
    monkeypatch.setattr(hub, '_radio_from', lambda tid: [])
    sid, state = curated(hub, seed, liked + others)
    got = hub._take(sid, state, 16)
    flags = [t['liked'] for t in got]
    assert all(sum(flags[i:i + 8]) <= 1 for i in range(len(flags)))


def test_plain_stations_keep_todays_rules(hub, monkeypatch):
    seed = add(hub, 'EoJy_GR1Lb0', 'Trap', 'Gui Boratto')
    anime = add(hub, vid(1), 'Blue night', 'Yoshiaki Dewa', 'Anime')
    monkeypatch.setattr(hub, '_radio_from', lambda tid: [])
    sid, state = curated(hub, seed, [anime])
    state.pop('curated')
    assert [t['id'] for t in hub._take(sid, state, 1)] == [anime]


def test_model_picks_resolve_or_drop(hub, monkeypatch):
    found = add(hub, vid(90), 'Lost Highway (Original Mix)', 'Stephan Bodzin')
    wrong = add(hub, vid(91), 'Lost Highway', 'Bon Jovi')
    cand = hub.track(add(hub, vid(92), 'Arquipélago', 'Gui Boratto'))
    asked = []

    def fake_search(q):
        asked.append(q)
        return [hub.track(wrong), hub.track(found)] if 'Bodzin' in q else [hub.track(wrong)]
    monkeypatch.setattr(hub, 'search', fake_search)
    answer = {'profile': ' Hypnotic  melodic techno ', 'songs': [
        {'ref': 'c0'}, {'artist': 'Stephan Bodzin', 'title': 'Lost Highway'},
        {'artist': 'Made Up Artist', 'title': 'Lost Highway'}, {'ref': 'c9'}, 'junk']}
    profile, ids, missed = hub.curated_list(answer, [cand])
    assert profile == 'Hypnotic melodic techno'
    assert ids == [cand['id'], found]  # the invented artist (found only as Bon Jovi) and the unknown ref are dropped
    assert missed == 1
    assert sorted(asked) == ['Lost Highway', 'Made Up Artist Lost Highway', 'Stephan Bodzin Lost Highway']  # then the title alone


class FakeRouter(BaseHTTPRequestHandler):
    reply = {}
    seen = []

    def log_message(self, format, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        FakeRouter.seen.append((self.path, dict(self.headers), body))
        text = json.dumps(FakeRouter.reply)
        events = [{'type': 'delta', 'text': text[:20]}, {'type': 'delta', 'text': text[20:]},
                  {'type': 'done', 'provider': 'claude', 'model': 'claude-haiku-4-5'}]
        raw = ''.join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


@pytest.fixture
def router(monkeypatch, tmp_path):
    server = ThreadingHTTPServer(('127.0.0.1', 0), FakeRouter)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    grants = tmp_path / 'grants.json'
    grants.write_text(json.dumps({'outgoing': {'slot:connection-router': 'k' * 64},
                                  'provider_endpoints': {'slot:connection-router': f'http://127.0.0.1:{server.server_port}'}}))
    monkeypatch.setenv('WIZARD_GRANTS_FILE', str(grants))
    FakeRouter.seen = []
    yield FakeRouter
    server.shutdown()


def test_curated_station_plays_the_seed_at_once_then_queues_the_ais_picks(hub, router, monkeypatch):
    seed = add(hub, 'EoJy_GR1Lb0', 'Trap', 'Gui Boratto', 'Electronic')
    radio = [add(hub, vid(1), 'Blue night', 'Yoshiaki Dewa', 'Anime'), add(hub, vid(2), 'Telecaster', 'Gui Boratto'),
             add(hub, vid(3), 'Bad Kingdom', 'Moderat')]
    pick = add(hub, vid(4), 'Rej', 'Âme')
    monkeypatch.setattr(hub, '_radio_from', lambda tid: list(radio))
    monkeypatch.setattr(hub, 'search', lambda q: [hub.track(pick)] if 'Âme' in q else [])
    router.reply = {'profile': 'Hypnotic melodic techno: warm arpeggios, slow builds',
                    'songs': [{'ref': 'c2'}, {'artist': 'Âme', 'title': 'Rej'}, {'ref': 'c1'}, {'artist': 'Nobody', 'title': 'Nothing'}]}
    started = hub.curated_station(hub.track(seed), note='it has a really unique sound')
    assert [t['id'] for t in started['tracks']] == [seed]  # the seed plays at once
    assert started['station']['title'] == 'Like Trap · Gui Boratto'
    assert started['station']['picks'] == 'pending'
    sid = started['station']['id']
    more = hub.station_more(sid, 10)  # waits for the picks
    assert [t['id'] for t in more] == [radio[2], pick, radio[1]]
    view = hub.station_view(sid, peek=0)
    assert view['station']['picks'] == 'ai'
    assert view['station']['profile'].startswith('Hypnotic melodic techno')
    path, headers, body = router.seen[0]
    assert path == '/v1/models/curated-radio/run'
    assert headers['X-Wizard-Grant'] == 'k' * 64
    assert set(body) == {'system', 'messages', 'max_tokens', 'stream'}  # model and provider are the router's
    prompt = body['messages'][0]['content']
    assert 'Trap' in prompt and 'it has a really unique sound' in prompt
    monkeypatch.setattr(hub, 'ONLINE', True)  # related artists come from the music source only when online
    assert 'Kompakt Friend' in hub.curate_prompt(hub.track(seed), [], {'played': [seed], 'seed': seed}, 5)
    assert '"at"' not in prompt and 'played_at' not in prompt  # no play-history timestamps


def test_no_ai_connection_falls_back_to_radio_with_the_rules(hub, monkeypatch):
    seed = add(hub, 'EoJy_GR1Lb0', 'Trap', 'Gui Boratto', 'Electronic')
    anime = add(hub, vid(1), 'Blue night', 'Yoshiaki Dewa', 'Anime')
    good = add(hub, vid(2), 'Bad Kingdom', 'Moderat')
    calls = []
    monkeypatch.setattr(hub, '_radio_from', lambda tid: calls.append(tid) or ([anime, good] if len(calls) == 1 else []))
    started = hub.curated_station(hub.track(seed))
    assert started['station']['picks'] == 'radio'
    assert [t['id'] for t in started['tracks']] == [seed, good]


def test_ai_error_falls_back_to_radio(hub, router, monkeypatch):
    seed = add(hub, 'EoJy_GR1Lb0', 'Trap', 'Gui Boratto', 'Electronic')
    good = add(hub, vid(2), 'Bad Kingdom', 'Moderat')
    monkeypatch.setattr(hub, '_radio_from', lambda tid: [good])

    def boom(*a, **k):
        raise hub.CurateUnavailable('signed_out')
    monkeypatch.setattr(hub, 'ask_model', boom)
    sid = hub.curated_station(hub.track(seed))['station']['id']
    assert [t['id'] for t in hub.station_more(sid, 5)] == [good]
    assert hub.station_view(sid, peek=0)['station']['picks'] == 'radio'


def test_refill_asks_again_with_what_was_kept_and_skipped(hub, router, monkeypatch):
    seed = add(hub, 'EoJy_GR1Lb0', 'Trap', 'Gui Boratto', 'Electronic')
    kept = add(hub, vid(3), 'Bad Kingdom', 'Moderat')
    skipped = add(hub, vid(4), 'Some Trance', 'Trance Guy')
    nxt = add(hub, vid(5), 'Rej', 'Âme')
    monkeypatch.setattr(hub, '_radio_from', lambda tid: [nxt])
    sid, state = curated(hub, seed, [])
    state['played'] += [kept, skipped]
    state['profile'] = 'Hypnotic melodic techno'
    hub.db('UPDATE stations SET state=? WHERE id=?', (json.dumps(state), sid))
    hub.db('INSERT INTO plays VALUES(?,?,?)', (kept, 10, 'played'))
    hub.db('INSERT INTO plays VALUES(?,?,?)', (skipped, 11, 'skipped'))
    router.reply = {'profile': 'something else', 'songs': [{'ref': 'c0'}]}
    hub.curate(sid, first=False)
    prompt = json.loads(router.seen[0][2]['messages'][0]['content'].split('\n\n', 1)[1])
    assert prompt['played_through_on_this_station'][0]['title'] == 'Bad Kingdom'
    assert prompt['skipped_on_this_station'][0]['title'] == 'Some Trance'
    assert prompt['profile_so_far'] == 'Hypnotic melodic techno'
    _, after = hub._load_station(sid)
    assert after['queue'][0] == nxt and after['profile'] == 'Hypnotic melodic techno'


def test_station_route_needs_the_curated_header(hub, monkeypatch):
    seed = add(hub, 'EoJy_GR1Lb0', 'Trap', 'Gui Boratto')
    monkeypatch.setattr(hub, '_radio_from', lambda tid: [])
    plain = hub.create_station({'trackId': seed})
    assert 'picks' not in plain['station']
    assert hub.create_station({'trackId': seed, 'curate': True})['station']['picks'] == 'radio'
