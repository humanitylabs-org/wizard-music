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
    yield module
    module._db.close()
    sys.path.remove(root)


def add(hub, vid, title, artist):
    tid = f'yt:{vid}'
    hub.db('INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?,?)', (tid, title, artist, '', 300000, '', 'youtube', '', 0))
    return tid


def station(hub, seed, queue):
    sid = 'd' * 16
    state = {'seed': seed, 'queue': queue, 'played': [seed], 'lastSeed': seed}
    hub.db('INSERT INTO stations VALUES(?,?,?,?,?)', (sid, 't', seed, json.dumps(state), 0))
    return sid, state


def test_deep_house_station_skips_thai_and_korean_chart_filler(hub, monkeypatch):
    seed = add(hub, 'EoJy_GR1Lb0', 'Trap', 'Gui Boratto')
    thai = add(hub, 'zbHo0tCeHvI', 'ได้โปรดอยู่ตรงนี้ (Upside Down)', 'BLVCKHEART')
    korean = add(hub, 'FqB_g8Qw_V4', '꿈결 Like A Dream', 'NCT WISH')
    good = add(hub, 'PqnMY3YU6hg', 'Azzurra', 'Gui Boratto')
    vapor = add(hub, 'xE-ahR4FmyQ', 'Warmpop', 'ESPRIT 空想')
    monkeypatch.setattr(hub, '_radio_from', lambda tid: [])
    sid, state = station(hub, seed, [thai, korean, good, vapor])
    got = [t['id'] for t in hub._take(sid, state, 4)]
    assert got == [good, vapor]


def test_thai_seed_keeps_thai_radio(hub, monkeypatch):
    seed = add(hub, 'eFA4mKbAfpk', 'หมอก (just u and i)', 'Violette Wautier')
    thai = add(hub, 'H4g_vV91p3I', 'หลุมอากาศ', 'Palmy')
    english = add(hub, 'aaaaaaaaaaa', 'Smoke', 'Violette Wautier')
    monkeypatch.setattr(hub, '_radio_from', lambda tid: [])
    sid, state = station(hub, seed, [thai, english])
    assert [t['id'] for t in hub._take(sid, state, 2)] == [thai, english]


def test_liked_artist_passes_language_guard(hub, monkeypatch):
    seed = add(hub, 'EoJy_GR1Lb0', 'Trap', 'Gui Boratto')
    liked = add(hub, 'H4g_vV91p3I', 'ยิ้มอันตราย', 'PORZAX')
    other = add(hub, 'bbbbbbbbbbb', 'ยิ้ม', 'PORZAX')
    hub.db('INSERT INTO likes VALUES(?,?,?)', (liked, 1, 0))
    hub.taste_changed()
    monkeypatch.setattr(hub, '_radio_from', lambda tid: [])
    sid, state = station(hub, seed, [other])
    assert [t['id'] for t in hub._take(sid, state, 1)] == [other]


def test_radio_uses_pinned_region_client(hub, monkeypatch):
    calls = []

    class Fake:
        def get_watch_playlist(self, vid, radio, limit):
            calls.append(vid)
            return {'tracks': [{'videoId': 'PqnMY3YU6hg', 'title': 'Azzurra', 'artists': [{'name': 'Gui Boratto'}]}]}

    monkeypatch.setattr(hub, 'ytm_radio', lambda: Fake())
    assert hub._radio_from('yt:EoJy_GR1Lb0') == ['yt:PqnMY3YU6hg']
    assert calls == ['EoJy_GR1Lb0']
    assert hub.RADIO_LOCATION == 'US'
