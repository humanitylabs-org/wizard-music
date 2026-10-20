import importlib, sys, json
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
    monkeypatch.setattr(module, '_radio_from', lambda tid: [])
    yield module
    module._db.close()
    sys.path.remove(root)


def add(hub, n, mins=5):
    tid = f'yt:{n:0>11}'
    hub.db('INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?,?)', (tid, f'Song {n}', 'Artist', '', mins * 60000, '', 'youtube', '', 0))
    return tid


def test_session_songs_keeps_last_song_and_drops_early_skips(hub):
    a, b, c = add(hub, 1), add(hub, 2), add(hub, 3)
    hub.db('INSERT INTO plays VALUES(?,?,?)', (a, 1000, 'played'))
    hub.db('INSERT INTO plays VALUES(?,?,?)', (b, 1300, 'played'))
    hub.db('INSERT INTO plays VALUES(?,?,?)', (b, 1330, 'skipped'))  # skipped 30s in
    hub.db('INSERT INTO plays VALUES(?,?,?)', (c, 1335, 'played'))  # still playing
    assert hub.session_songs(900, 1400) == [a, c]


def test_saved_mix_shows_as_chip_and_plays_by_name(hub):
    ids = [add(hub, i) for i in range(1, 5)]
    hub.save_mix('Tea music', ids, ['tea playlist', 'meditation mix'])
    chips = hub.home()['vibes']
    assert chips[0]['label'] == 'Tea music' and chips[0]['count'] == 4
    for said in ('play tea music', 'Play my tea playlist', 'put on the meditation mix', 'tea music'):
        out = hub.play_spoken(said)
        assert out['heard'] == 'Tea music', said
        assert {t['id'] for t in out['tracks']} == set(ids)
    st = hub.create_station({'query': 'Tea music', 'label': 'Tea music'})
    assert st['station']['title'] == 'Tea music' and len(st['tracks']) == 4


def test_unrelated_request_does_not_hit_mix(hub):
    hub.save_mix('Tea music', [add(hub, 1)])
    assert hub.find_mix('deep house') is None
    assert hub.find_mix('music') is None
