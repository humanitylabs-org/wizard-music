import importlib
import json
import sys
from pathlib import Path

import pytest


@pytest.fixture
def hub(monkeypatch, tmp_path):
    monkeypatch.setenv('WIZARD_MUSIC_HUB_HOME', str(tmp_path))
    monkeypatch.setenv('WIZARD_MUSIC_LIBRARY', str(tmp_path / 'lib'))
    root = str(Path(__file__).resolve().parents[1])
    sys.path.insert(0, root)
    sys.modules.pop('hub', None)
    module = importlib.import_module('hub')
    monkeypatch.setattr(module, 'queue_info', lambda *a, **k: None)
    monkeypatch.setattr(module, '_radio_from', lambda tid: [])
    yield module
    module._db.close()
    sys.path.remove(root)


def add(hub, vid, title, artist):
    tid = f'yt:{vid}'
    hub.db('INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?,?)', (tid, title, artist, '', 300000, '', 'youtube', '', 0))
    return tid


def station(hub, seed, queue):
    sid = 'e' * 16
    state = {'seed': seed, 'queue': queue, 'played': [seed], 'lastSeed': seed}
    hub.db('INSERT INTO stations VALUES(?,?,?,?,?)', (sid, 't', seed, json.dumps(state), 0))
    return sid, state


def test_station_skips_other_versions_of_the_seed(hub):
    seed = add(hub, 'aaaaaaaaaa1', 'Somebody That I Used To Know (modish. Remix)', 'Gotye')
    fisher = add(hub, 'aaaaaaaaaa2', 'Somebody (2024) (feat. Kimbra & Sante Sansone)', 'Gotye, FISHER, Chris Lake')
    original = add(hub, 'aaaaaaaaaa3', 'Somebody That I Used To Know', 'Gotye, Kimbra')
    other_remix = add(hub, 'aaaaaaaaaa4', 'Somebody That I Used To Know - Tiësto Remix', 'Tiësto')
    flip = add(hub, 'aaaaaaaaaa6', 'USED TO KNOW', 'SCXLETTE')
    good = add(hub, 'aaaaaaaaaa5', 'HOT DRUM', 'JOYRYDE')
    sid, state = station(hub, seed, [fisher, original, other_remix, flip, good])
    assert [t['id'] for t in hub._take(sid, state, 4)] == [good]


def test_station_serves_one_version_per_song_and_skips_mashups(hub):
    seed = add(hub, 'bbbbbbbbbb1', 'Rise', 'Lynnic')
    a = add(hub, 'bbbbbbbbbb2', 'Show Me Love', 'Robin S')
    mashup = add(hub, 'bbbbbbbbbb3', 'Show Me Love X Cola', 'Dorthy Kosmicki')
    edit = add(hub, 'bbbbbbbbbb4', 'COLD (ZHU EDIT)', 'ZHU')
    cold = add(hub, 'bbbbbbbbbb5', 'Cold', 'ZHU')
    other_rise = add(hub, 'bbbbbbbbbb6', 'Rise', 'Katy Perry')
    upload = add(hub, 'bbbbbbbbbb7', 'Beyoncé, Robin S - Break My Soul x Show Me Love (Astro Raw Mashup)', 'astroraw')
    sid, state = station(hub, seed, [a, mashup, edit, cold, other_rise, upload])
    assert [t['id'] for t in hub._take(sid, state, 6)] == [a, edit, other_rise]


def test_skips_versions_of_what_you_just_played_elsewhere(hub):
    played = add(hub, 'ccccccccc01', 'Around (Solomun Vox)', 'Noir, Haze')
    hub.db("INSERT INTO plays(id,at,action) VALUES(?,?,?)", (played, 1.0, 'played'))
    seed = add(hub, 'ccccccccc02', 'Neon Genesis', 'blueberry, Narvent')
    again = add(hub, 'ccccccccc03', 'Around', 'Noir & Haze')
    good = add(hub, 'ccccccccc04', 'Rise', 'Lynnic')
    sid, state = station(hub, seed, [again, good])
    assert [t['id'] for t in hub._take(sid, state, 2)] == [good]


def test_different_songs_sharing_a_first_word_still_play(hub):
    seed = add(hub, 'ddddddddd01', 'Love Story', 'Taylor Swift')
    other = add(hub, 'ddddddddd02', 'Love Me Again', 'John Newman')
    sid, state = station(hub, seed, [other])
    assert [t['id'] for t in hub._take(sid, state, 1)] == [other]
