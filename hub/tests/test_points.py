import json

import pytest

from test_collections import add, hub, styles  # noqa: F401  (fixture + helpers)


def plays(hub, rows):
    for tid, at, action in rows:
        hub.db('INSERT INTO plays VALUES(?,?,?)', (tid, at, action))


def test_points_follow_the_weights(hub):
    liked = add(hub, 1, 'A', 'X', liked=1)
    asked = add(hub, 2, 'B', 'X')
    heard = add(hub, 3, 'C', 'X')
    skipped = add(hub, 4, 'D', 'X')
    hated = add(hub, 5, 'E', 'X', liked=-1)
    end = add(hub, 6, 'F', 'X')
    hub.db('INSERT INTO requests VALUES(?,?,?)', (asked, 0, 'tap'))
    plays(hub, [(asked, 0, 'played'), (heard, 300, 'played'), (heard, 600, 'played'), (skipped, 900, 'played'),
                (skipped, 920, 'skipped'), (hated, 920, 'played'), (end, 1220, 'played')])
    m = hub.song_metrics()
    assert m[liked]['like'] == 1 and m[asked] ['request'] == 1 and m[asked]['heard_through'] == 1
    assert m[heard]['heard_through'] == 2 and m[skipped]['skip'] == 1 and m[skipped]['heard_through'] == 0
    assert m[hated]['dislike'] == 1 and m[hated]['heard_through'] == 0  # a thumbs down is never "heard through"
    pts = {tid: hub.song_points(m[tid]) for tid in m}
    assert pts[liked] == 5 and pts[asked] == 4 and pts[heard] == 2 and pts[skipped] == -1 and pts[hated] == -10
    assert {t['id'] for t, _ in hub.your_tracks()} == {liked, asked, heard}


def test_double_taps_and_abandoned_requests_do_not_count(hub):
    song = add(hub, 12, 'Rain', 'Kerri Chandler')
    other = add(hub, 13, 'Elysian', 'Bonobo')
    for at in (1000, 1001, 1100):  # a double tap, then one more a minute and a half later
        hub.db('INSERT INTO requests VALUES(?,?,?)', (song, at, 'tap'))
    plays(hub, [(song, 1001, 'played'), (song, 1002, 'played'), (song, 1100, 'played'), (other, 1101.5, 'played'),
                (other, 2000, 'played')])
    # 1000/1001 are one request and its play lasted; the 1100 request was abandoned after 1.5 s
    assert hub.song_metrics()[song]['request'] == 1


def test_repeats_are_capped(hub):
    tid = add(hub, 7, 'G', 'X', plays=40)
    assert hub.song_metrics()[tid]['heard_through'] == 39
    assert hub.song_points(hub.song_metrics()[tid]) == hub.CAPS['heard_through']


def test_weights_can_be_changed_without_losing_history(hub):
    tid = add(hub, 8, 'H', 'X', plays=2)  # one heard through: 1 point, not yours yet
    assert tid not in {t['id'] for t, _ in hub.your_tracks()}
    (hub.HOME / 'score_weights.json').write_text(json.dumps({'heard_through': 2.5}))
    assert tid in {t['id'] for t, _ in hub.your_tracks()}
    s = hub.scores()
    assert s['weights']['heard_through'] == 2.5 and s['songs'][0]['points'] == 2.5


def test_spoken_song_and_tap_count_as_requests(hub, monkeypatch):
    song = add(hub, 9, 'Trap', 'Gui Boratto')
    monkeypatch.setattr(hub, 'correct_spoken', lambda q: {'query': q, 'artist': 'Gui Boratto', 'title': 'Trap', 'kind': 'song', 'source': 'history'})
    monkeypatch.setattr(hub, 'search', lambda q: [hub.track(song)])
    monkeypatch.setattr(hub, '_radio_from', lambda tid: [])
    hub.play_spoken('play Gui Boratto Trap')
    assert hub.db('SELECT id, how FROM requests') == [(song, 'spoken')]
    hub.play_spoken('play some synthwave')  # a style is not a request for any one song
    assert hub.db('SELECT COUNT(*) FROM requests')[0][0] == 1


def test_backfill_reads_old_song_stations(hub):
    song = add(hub, 10, 'Tides', 'Home')
    other = add(hub, 11, 'Rain', 'Kerri Chandler')
    hub.db('INSERT INTO stations VALUES(?,?,?,?,?)', ('a' * 16, 'Tides radio', song, '{}', 5))
    hub.db('INSERT INTO stations VALUES(?,?,?,?,?)', ('b' * 16, 'Warm house', other, '{}', 6))
    hub.db('INSERT INTO likes VALUES(?,?,?)', (other, 1, 7))
    hub.backfill_requests()
    assert hub.db('SELECT id, how FROM requests') == [(song, 'backfill')]
    assert hub.db('SELECT id, action FROM feedback_log') == [(other, 'like')]
    hub.backfill_requests()  # runs once
    assert hub.db('SELECT COUNT(*) FROM requests')[0][0] == 1
