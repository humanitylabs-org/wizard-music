"""Search lists full-length YouTube uploads beside official songs (issue 44)."""
import importlib.util
import sys
from pathlib import Path

import pytest


@pytest.fixture
def hub(monkeypatch, tmp_path):
    monkeypatch.setenv('WIZARD_MUSIC_HUB_HOME', str(tmp_path))
    monkeypatch.setenv('WIZARD_MUSIC_LIBRARY', str(tmp_path / 'library'))
    monkeypatch.setenv('WIZARD_MUSIC_ONLINE', '1')
    spec = importlib.util.spec_from_file_location('search_videos_hub', Path(__file__).parents[1] / 'hub.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    module.ONLINE = True
    yield module
    module._db.close()


def song(vid, title, artist, length):
    return {'videoId': vid, 'title': title, 'artists': [{'name': artist}], 'duration': length}


def video(vid, title, channel, secs):
    return {'videoId': vid, 'title': title, 'artists': [{'name': channel}], 'duration_seconds': secs}


MILKSHAKE_SONGS = [
    song('kelisEdit01', 'Milkshake 20 (Alex Wann Remix)', 'Kelis', '2:57'),
    song('golabexRip1', 'Milkshake', 'Golabex', '4:45'),
] + [song(f'otherSong{i:02d}', f'Milkshake {i}', f'Someone {i}', '3:00') for i in range(18)]

MILKSHAKE_VIDEOS = [
    video('obsessProg1', 'Alex Wann - Milkshake', 'Obsessive Progressive', 379),
    video('signifMusic', 'Kelis - Milkshake 20 [Alex Wann Extended Remix]', 'Significant Music HD', 380),
    video('djSetLong01', 'Alex Wann live DJ set 2 hours', 'Some Club', 7200),
    video('shortClip01', 'Milkshake teaser', 'Alex Wann', 20),
    video('toniaRemix1', 'Alex Wann --- Milkshake (Original ReMix)', 'Tonia', 377),
]


class Fake:
    def __init__(self, songs, videos):
        self.by_kind = {'songs': songs, 'videos': videos}
        self.asked = []

    def search(self, q, filter='songs', limit=20):
        self.asked.append((filter, limit))
        return self.by_kind.get(filter, [])[:limit]


def test_full_length_uploads_show_in_first_ten(hub, monkeypatch):
    fake = Fake(MILKSHAKE_SONGS, MILKSHAKE_VIDEOS)
    monkeypatch.setattr(hub, '_connector', fake)
    ids = [t['id'] for t in hub.search('Milkshake Alex wann')]
    assert sorted(k for k, _ in fake.asked) == ['songs', 'videos']
    assert ids[0] == 'yt:kelisEdit01'
    assert 'yt:obsessProg1' in ids[:10]
    assert {'yt:signifMusic', 'yt:toniaRemix1'} <= set(ids[:10])
    assert 'yt:djSetLong01' not in ids and 'yt:shortClip01' not in ids
    t = hub.track('yt:obsessProg1')
    assert t['title'] == 'Alex Wann - Milkshake' and t['artist'] == 'Obsessive Progressive'
    assert t['durationMs'] == 379000 and t['stream'].endswith('yt%3AobsessProg1')
    assert len(ids) == len(set(ids))


def test_plain_song_search_keeps_the_official_song_first(hub, monkeypatch):
    songs = [song('kelisMilk01', 'Milkshake', 'Kelis', '3:03'), song('kelisTrick1', 'Trick Me', 'Kelis', '3:26')]
    videos = [video('kelisOmv001', 'Kelis - Milkshake (Official Music Video)', 'Kelis', 185),
              video('coverVid001', 'Milkshake cover', 'A Cover Band', 190)]
    monkeypatch.setattr(hub, '_connector', Fake(songs, videos))
    ids = [t['id'] for t in hub.search('Kelis Milkshake')]
    assert ids[0] == 'yt:kelisMilk01'
    assert 'yt:kelisOmv001' not in ids  # the official video of a song already listed
    assert ids == ['yt:kelisMilk01', 'yt:kelisTrick1', 'yt:coverVid001']


def test_videos_failing_still_returns_songs(hub, monkeypatch):
    class Half(Fake):
        def search(self, q, filter='songs', limit=20):
            if filter == 'videos':
                raise RuntimeError('connector too old')
            return super().search(q, filter, limit)

    monkeypatch.setattr(hub, '_connector', Half(MILKSHAKE_SONGS[:3], []))
    assert [t['id'] for t in hub.search('Milkshake')] == ['yt:kelisEdit01', 'yt:golabexRip1', 'yt:otherSong00']
