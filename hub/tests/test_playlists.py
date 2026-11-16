import importlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

URL = 'https://www.youtube.com/watch?v=9TbASs-ZjHA'
TITLE = 'Hypnotic Progressive House & Melodic Techno 2026 | XAVRINOX - Ethereal Mix I'

@pytest.fixture
def hub(tmp_path, monkeypatch):
    monkeypatch.setenv('WIZARD_MUSIC_HUB_HOME', str(tmp_path))
    monkeypatch.setenv('WIZARD_MUSIC_ONLINE', '0')
    import hub as h
    h = importlib.reload(h)
    yield h
    h._db.close()


def test_save_dedupe_metadata_restart_and_no_existing_cells_changed(hub):
    tables = [r[0] for r in hub.db("SELECT name FROM sqlite_master WHERE type='table' AND name != 'saved_playlists'")]
    before = {t: hub.db('SELECT * FROM '+t) for t in tables}
    body = dict(url=URL, title=TITLE, author='Xavrinox', authorUrl='https://www.youtube.com/@Xavrinox', thumbnail='https://i.ytimg.com/vi/9TbASs-ZjHA/hqdefault.jpg')
    first = hub.save_playlist(body)
    assert first['url'] == URL and first['title'] == TITLE and first['kind'] == 'video'
    assert hub.save_playlist(body) == first
    assert hub.save_playlist({'url':'https://youtu.be/9TbASs-ZjHA?t=25','title':'Do not overwrite'}) == first
    assert len(hub.saved_playlists()) == 1
    assert before == {t: hub.db('SELECT * FROM '+t) for t in tables}
    assert not list(hub.CACHE.iterdir())
    with pytest.raises(ValueError, match='Online playback is off'): hub.playlist_track(first['id'])
    code = "import hub,json;print(json.dumps(hub.saved_playlists()))"
    result = subprocess.check_output([sys.executable, '-c', code], cwd=Path(hub.__file__).parent, env=os.environ, text=True)
    assert json.loads(result) == [first]
    playlist = hub.save_playlist({'url':'https://www.youtube.com/playlist?list=PLtest1234567890'})
    assert playlist['kind'] == 'playlist'
    with pytest.raises(ValueError, match='Online playback is off'): hub.playlist_track(playlist['id'])


@pytest.mark.parametrize('url', [URL+' ', 'https://www.youtube.com.evil.invalid/watch?v=9TbASs-ZjHA', 'https://www.youtube.com@127.0.0.1/watch?v=9TbASs-ZjHA', 'http://www.youtube.com/watch?v=9TbASs-ZjHA', 'https://www.youtube.com:443/watch?v=9TbASs-ZjHA', 'https://www.youtube.com/watch?v=9TbASs-ZjHA&v=aaaaaaaaaaa', 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/@Xavrinox', 'file:///etc/passwd', 'https://youtu.be/9TbASs-ZjHA/other', '\\https://youtu.be/9TbASs-ZjHA'])
def test_rejects_untrusted_or_malformed_without_writes(hub, url):
    with pytest.raises(ValueError): hub.save_playlist({'url':url})
    assert hub.saved_playlists() == []


def test_metadata_validation_and_text_not_html(hub):
    for extra in [{'title':1}, {'authorUrl':'https://evil.invalid'}, {'thumbnail':'https://evil.invalid/x'}, {'title':'x\nsecret'}, {'url':'https://youtu.be/9TbASs-ZjHA','account':'other'}]:
        with pytest.raises(ValueError): hub.save_playlist({'url':URL, **extra})
    assert hub.save_playlist({'url':URL,'title':'<script>text only</script>'})['title'] == '<script>text only</script>'


def test_saved_youtube_playlist_plays_in_music_never_on_youtube(hub, monkeypatch):
    """wizard-os#654: a saved playlist row plays its songs in Music, in order, through the music source."""
    playlist = hub.save_playlist({'url': 'https://www.youtube.com/playlist?list=PLtest1234567890', 'title': 'Study'})
    seen = []

    def source_get(base, path, timeout=20):
        seen.append(path)
        return {'tracks': [{'videoId': 'aaaaaaaaaaa', 'title': 'One', 'artists': [{'name': 'A'}]},
                           {'videoId': 'bad', 'title': 'Skipped'}, {'videoId': 'bbbbbbbbbbb', 'title': 'Two'}]}
    monkeypatch.setattr(hub, 'ONLINE', True)
    monkeypatch.setattr(hub, 'source_for', lambda tid='': 'http://connector')
    monkeypatch.setattr(hub, '_source_get', source_get)
    tracks = hub.playlist_track(playlist['id'])
    assert [t['id'] for t in tracks] == ['yt:aaaaaaaaaaa', 'yt:bbbbbbbbbbb']
    assert seen == ['/api/music/playlist?id=PLtest1234567890&limit=200']


def test_old_connector_falls_back_to_account_read_and_errors_stay_in_music(hub, monkeypatch):
    playlist = hub.save_playlist({'url': 'https://www.youtube.com/playlist?list=PLtest1234567890'})
    calls = []

    def old_connector(base, path, timeout=20):
        calls.append(path)
        if path.startswith('/api/music/playlist'):
            raise OSError('404')
        return {'tracks': [{'videoId': 'ccccccccccc', 'title': 'Three'}]}
    monkeypatch.setattr(hub, 'ONLINE', True)
    monkeypatch.setattr(hub, 'source_for', lambda tid='': 'http://connector')
    monkeypatch.setattr(hub, '_source_get', old_connector)
    assert [t['id'] for t in hub.playlist_track(playlist['id'])] == ['yt:ccccccccccc']
    assert calls[1].startswith('/api/music/library/playlist?id=PLtest1234567890')

    def down(base, path, timeout=20):
        raise OSError('down')
    monkeypatch.setattr(hub, '_source_get', down)
    with pytest.raises(ValueError) as err:
        hub.playlist_track(playlist['id'])
    assert 'youtube' not in str(err.value).lower().replace('youtube music connector', '')
    monkeypatch.setattr(hub, '_source_get', lambda base, path, timeout=20: {'tracks': []})
    with pytest.raises(ValueError, match='no playable songs'):
        hub.playlist_track(playlist['id'])
