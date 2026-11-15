# wizard-music#63: Liked > View all reads every liked song, newest like first; home keeps its short preview.
import importlib
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
    now = time.time()
    for i in range(45):
        tid = f'yt:song{i:07d}'
        h.db('INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?,?)', (tid, f'Song {i}', 'Argy', '', 200000, '', 'youtube', '', now))
        h.db('INSERT INTO likes(id, value, at) VALUES(?,?,?)', (tid, 1 if i != 7 else -1, now + i))
    yield h
    h._db.close()


def test_liked_all_lists_every_like_newest_first(hub):
    ids = [t['id'] for t in hub.liked_all()]
    assert len(ids) == 44  # 45 rated, one thumbs-down
    assert ids[0] == 'yt:song0000044' and ids[-1] == 'yt:song0000000'
    assert 'yt:song0000007' not in ids
    assert len(hub.home()['liked']) == 30  # the home preview is unchanged
