import importlib.util
import json
import sys
import pytest
from pathlib import Path
from unittest.mock import Mock


@pytest.fixture
def hub(monkeypatch, tmp_path):
    monkeypatch.setenv('WIZARD_MUSIC_HUB_HOME', str(tmp_path))
    monkeypatch.setenv('WIZARD_MUSIC_LIBRARY', str(tmp_path / 'library'))
    monkeypatch.setenv('WIZARD_MUSIC_ONLINE', '0')
    spec = importlib.util.spec_from_file_location('consent_hub', Path(__file__).parents[1] / 'hub.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    yield module
    module._db.close()


def test_default_off_persist_and_revoke(hub, monkeypatch):
    assert hub.online_settings() == {'online': False}
    assert hub.home()['settings'] == {'online': False}
    assert hub.set_online(True) == {'online': True}
    assert json.loads(hub.SETTINGS.read_text()) == {'online': True}
    assert hub.SETTINGS.stat().st_mode & 0o777 == 0o600
    client = Mock()
    monkeypatch.setattr(hub, '_ytm', client)
    downloader = Mock()
    downloader.poll.return_value = None
    hub._downloads.add(downloader)
    hub._info_q.append(('yt:aaaaaaaaaaa', False))
    hub.set_online(False)
    downloader.terminate.assert_called_once()
    assert not hub._info_q
    assert hub._ytm is None
    with pytest.raises(LookupError): hub.online_urlopen('https://music.youtube.com/')
    assert json.loads(hub.SETTINGS.read_text()) == {'online': False}
    with pytest.raises(ValueError): hub.set_online('yes')


def test_revoked_every_outbound_branch(hub, monkeypatch):
    hub.set_online(True)
    hub.set_online(False)
    def forbidden(*a, **kw): raise AssertionError('network after revocation')
    monkeypatch.setattr(hub.urllib.request, 'urlopen', forbidden)
    monkeypatch.setattr(hub.subprocess, 'Popen', forbidden)
    assert hub.itunes_genre('Song', 'Artist') == ''
    assert hub.enrich('yt:aaaaaaaaaaa') is False
    with pytest.raises(LookupError): hub._mb('artist', query='test')
    assert hub._deezer('search', 'test', 1) == []
    with pytest.raises(RuntimeError): hub.ytm()
    with pytest.raises(RuntimeError): hub.ytm_radio()
    with pytest.raises(LookupError): hub.fetch_audio('aaaaaaaaaaa')
    hub.prefetch('yt:aaaaaaaaaaa')
    hub.queue_info('yt:aaaaaaaaaaa')
    assert hub.art_bytes('yt:aaaaaaaaaaa') is None
    assert hub.search('local only') == []


def test_settings_reload_ignores_legacy_env_after_revoke(hub, monkeypatch):
    hub.set_online(False)
    monkeypatch.setenv('WIZARD_MUSIC_ONLINE', '1')
    spec = importlib.util.spec_from_file_location('reloaded_hub', Path(__file__).parents[1] / 'hub.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    assert module.ONLINE is False
    module._db.close()
