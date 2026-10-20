import importlib
import json
import sys
from pathlib import Path

import pytest


@pytest.fixture
def hub(monkeypatch, tmp_path):
    monkeypatch.setenv('WIZARD_MUSIC_HUB_HOME', str(tmp_path))
    monkeypatch.setenv('WIZARD_MUSIC_LIBRARY', str(tmp_path / 'lib'))
    monkeypatch.setenv('WIZARD_MUSIC_ONLINE', '1')
    root = str(Path(__file__).resolve().parents[1])
    sys.path.insert(0, root)
    sys.modules.pop('hub', None)
    module = importlib.import_module('hub')
    for name in ('queue_info', 'prefetch', 'queue_style'):
        monkeypatch.setattr(module, name, lambda *a, **k: None)
    monkeypatch.setattr(module, 'genre_seed', lambda *a: None)
    yield module
    module._db.close()
    sys.path.remove(root)


def add(hub, n, title, artist, liked=0, plays=0, skips=0):
    tid = f'yt:{n:0>11}'
    hub.db('INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?,?)', (tid, title, artist, '', 300000, '', 'youtube', '', 0))
    if liked:
        hub.db('INSERT INTO likes VALUES(?,?,?)', (tid, liked, 0))
    base = n * 100000  # each song's listens sit in their own stretch of time, 5 minutes apart
    for i in range(plays):
        hub.db('INSERT INTO plays VALUES(?,?,?)', (tid, base + i * 300, 'played'))
    for j in range(skips):  # a skip lands right after one of the plays
        hub.db('INSERT INTO plays VALUES(?,?,?)', (tid, base + j * 300 + 10, 'skipped'))
    return tid


def styles(hub, artist, tags):
    hub.db('INSERT INTO artist_styles VALUES(?,?,?,?,?)', (hub._key(artist), artist, json.dumps(tags), 'musicbrainz', 0))


@pytest.mark.parametrize('said,style', [
    ('synthwave', 'synthwave'), ('synthwave i like', 'synthwave'), ('synth wave', 'synthwave'),
    ('deep house playlist', 'deep house'), ('deep house that i like', 'deep house'), ('my favourite techno', 'techno'),
    ('retrowave', 'synthwave'), ('gui boratto trap', ''), ('home tides', ''), ('bonobo', ''),
])
def test_style_request(hub, said, style):
    assert hub.style_request(said) == style


def seed_library(hub):
    styles(hub, 'Home', {'synthwave': 1, 'chillwave': .5})
    styles(hub, 'Hotel Pools', {'chillsynth': 1, 'synthwave': .4})
    styles(hub, 'Windows 96', {'vaporwave': 1, 'synthwave': .63})
    styles(hub, 'Gui Boratto', {'house': 1, 'tech house': 1})
    styles(hub, 'Kerri Chandler', {'deep house': 1, 'house': .5})
    styles(hub, 'Lane 8', {'deep house': 1, 'melodic house': .7})
    styles(hub, 'Synthwave Nation', {})
    return {
        'tides': add(hub, 1, 'Tides', 'Home', liked=1),
        'coast': add(hub, 2, 'Coast', 'Hotel Pools', plays=5),
        'snooker': add(hub, 3, 'Snooker', 'Windows 96, Gavriel', plays=3),
        'trap': add(hub, 4, 'Trap', 'Gui Boratto', liked=1, plays=40, skips=18),
        'rain': add(hub, 5, 'Rain', 'Kerri Chandler', plays=13),
        'wait': add(hub, 6, "I'll Wait", 'Lane 8', plays=1),  # played once: not yours yet
        'filler': add(hub, 7, 'Downtempo Synthwave (Vaporwave Radio)', 'Synthwave Nation', plays=1),
        'skipped': add(hub, 8, 'Hold', 'Home', plays=2, skips=2),  # mostly skipped
        'xxx': add(hub, 9, 'XXXDrug (Dark Vaporwave/Synthwave)', 'Zane Alexander', plays=12),
    }


def test_collection_is_your_tracks_in_that_style(hub):
    ids = seed_library(hub)
    syn = {t['id'] for t in hub.collection('synthwave')}
    assert syn == {ids['tides'], ids['coast'], ids['snooker'], ids['xxx']}
    deep = {t['id'] for t in hub.collection('deep house')}
    assert deep == {ids['trap'], ids['rain']}
    labels = {c['label']: c['count'] for c in hub.collections()}
    assert labels['Synthwave'] == 4


def test_spoken_synthwave_plays_your_synthwave(hub, monkeypatch):
    ids = seed_library(hub)
    radio = [add(hub, 100 + i, f'New {i}', f'Synth Artist {i}') for i in range(12)]
    monkeypatch.setattr(hub, '_radio_from', lambda tid: list(radio))
    monkeypatch.setattr(hub, 'search', lambda q: pytest.fail('a collection request must not search'))
    out = hub.play_spoken('Play me some synthwave')
    assert out['kind'] == 'collection' and out['station']['title'] == 'Synthwave'
    played = [t['id'] for t in out['tracks']]
    mine = {ids['tides'], ids['coast'], ids['snooker'], ids['xxx']}
    assert set(played[:1]) <= mine and mine <= set(played)
    assert ids['filler'] not in played and ids['trap'] not in played
    assert set(played) - mine <= set(radio)


def test_home_chips_and_chip_start_collection(hub, monkeypatch):
    seed_library(hub)
    monkeypatch.setattr(hub, '_radio_from', lambda tid: [])
    chips = hub.home()['vibes']
    assert chips[0]['label'] == 'Synthwave'
    out = hub.create_station({'query': 'Synthwave', 'label': 'Synthwave'})
    assert out['station']['title'] == 'Synthwave' and len(out['tracks']) == 4


def test_vibe_chip_seeds_from_its_track_not_its_label(hub, monkeypatch):
    asked = []
    seed = add(hub, 50, 'Rain', 'Kerri Chandler')
    monkeypatch.setattr(hub, 'search', lambda q: asked.append(q) or [hub.track(seed)])
    monkeypatch.setattr(hub, '_radio_from', lambda tid: [])
    hub.create_station({'query': 'Warm house', 'label': 'Warm house'})
    assert asked == ['Kerri Chandler Rain']


def test_collection_station_keeps_returning_to_your_tracks(hub, monkeypatch):
    ids = seed_library(hub)
    counter = iter(range(1000, 5000))
    monkeypatch.setattr(hub, '_radio_from', lambda tid: [add(hub, next(counter), 'R', f'Radio {i}') for i in range(6)])
    out = hub.play_spoken('play my synthwave')
    sid = out['station']['id']
    mine = {ids['tides'], ids['coast'], ids['snooker'], ids['xxx']}
    later = [t['id'] for batch in range(12) for t in hub.station_more(sid, 10)]
    assert mine & set(later[60:]), 'your tracks come back on a long station'


def test_related_artists_lend_styles_when_musicbrainz_has_none(hub, monkeypatch):
    monkeypatch.setattr(hub, 'mb_artist_tags', lambda name, title='': {'Lane 8': {'deep house': 1}, 'RÜFÜS DU SOL': {'deep house': .5, 'melodic house': 1}}.get(name, {}))
    monkeypatch.setattr(hub, 'related_artists', lambda name: ['Lane 8', 'RÜFÜS DU SOL'])
    tags = hub.tag_artist('ELEZO', 'We are one')
    assert hub.style_match(tags, 'deep house') >= hub.STYLE_AT
    assert hub.artist_styles(hub._key('ELEZO')) == tags


def test_untagged_neighbour_probe_still_gets_its_own_lookup(hub, monkeypatch):
    monkeypatch.setattr(hub, 'mb_artist_tags', lambda name, title='': {'Lane 8': {'deep house': 1}}.get(name, {}))
    monkeypatch.setattr(hub, 'related_artists', lambda name: {'Lynnic': ['ELEZO', 'Lane 8'], 'ELEZO': ['Lane 8']}.get(name, []))
    hub.tag_artist('Lynnic')  # probes ELEZO as a neighbour: MusicBrainz knows nothing about it
    assert hub.style_match(hub.tag_artist('ELEZO'), 'deep house') >= hub.STYLE_AT


def test_approved_session_keeps_songs_heard_through(hub):
    styles(hub, 'Hotel Pools', {'chillsynth': 1, 'synthwave': .4})
    styles(hub, 'MACROSS 82-99', {'synthwave': 1})
    once = add(hub, 400, 'Horizon', 'Hotel Pools')
    bad = add(hub, 401, 'Sunset', 'MACROSS 82-99', liked=-1)
    skipped = add(hub, 402, 'Eclipse', 'Hotel Pools')
    playing = add(hub, 403, 'Glow', 'Hotel Pools')
    for tid, at, action in [(once, 1000, 'played'), (bad, 1200, 'played'), (bad, 1210, 'skipped'),
                            (skipped, 1210, 'played'), (skipped, 1230, 'skipped'), (playing, 1230, 'played')]:
        hub.db('INSERT INTO plays VALUES(?,?,?)', (tid, at, action))
    assert {t['id'] for t in hub.collection('synthwave')} == set()
    assert hub.keep_session(900, 1300, 'test') == [once]
    assert {t['id'] for t in hub.collection('synthwave')} == {once}


def test_near_twin_styles_share_one_chip(hub):
    for i, artist in enumerate(['A', 'B', 'C', 'D']):
        styles(hub, artist, {'synthwave': 1, 'chillwave': 1, 'vaporwave': 1})
        add(hub, 300 + i, f'S{i}', artist, liked=1)
    assert [c['label'] for c in hub.collections()] == ['Synthwave']
