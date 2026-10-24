import uuid
import pytest
import importlib
import sys
from pathlib import Path


@pytest.fixture
def hub(monkeypatch, tmp_path):
    monkeypatch.setenv('WIZARD_MUSIC_HUB_HOME', str(tmp_path))
    monkeypatch.setenv('WIZARD_MUSIC_LIBRARY', str(tmp_path / 'lib'))
    root = str(Path(__file__).resolve().parents[1])
    sys.path.insert(0, root)
    sys.modules.pop('hub', None)
    module = importlib.import_module('hub')
    yield module
    module._db.close()
    sys.path.remove(root)


def test_native_play_event_is_durable_and_exactly_once(hub):
    key = f'{uuid.uuid4()}:{uuid.uuid4()}:played'
    assert hub.record_play('yt:aaaaaaaaaaa', 'played', key)
    assert not hub.record_play('yt:aaaaaaaaaaa', 'played', key)
    assert hub.db("SELECT COUNT(*) FROM plays WHERE id=?", ('yt:aaaaaaaaaaa',))[0][0] == 1
    assert hub.record_play('yt:aaaaaaaaaaa', 'played', f'{uuid.uuid4()}:{uuid.uuid4()}:played')
    assert hub.db("SELECT COUNT(*) FROM plays WHERE id=?", ('yt:aaaaaaaaaaa',))[0][0] == 2
    with pytest.raises(ValueError):
        hub.record_play('yt:aaaaaaaaaaa', 'played', 'arbitrary-id')


def test_station_continuation_retries_return_same_batch(hub, monkeypatch):
    sid = 'a'*16
    hub.db('INSERT INTO stations(id,title,seed,state,at) VALUES(?,?,?,?,?)', (sid,'test','yt:aaaaaaaaaaa','{}',0))
    calls=[]
    monkeypatch.setattr(hub,'_take',lambda *_: calls.append(1) or [{'id':'yt:bbbbbbbbbbb'}])
    monkeypatch.setattr(hub,'prefetch',lambda *_: None)
    key = str(uuid.uuid4())
    first = hub.station_more(sid,10,key)
    assert hub.station_more(sid,10,key) == first
    assert len(calls)==1
    with pytest.raises(ValueError):
        hub.station_more('b'*16,10,key)
    assert hub.station_more(sid,10,str(uuid.uuid4()))==first
    assert len(calls)==2


def test_station_receipt_and_advancement_rollback_together(hub, monkeypatch):
    import json
    import sqlite3
    sid = 'c'*16
    ids = ['yt:aaaaaaaaaaa', 'yt:bbbbbbbbbbb']
    for tid in ids:
        hub.db('INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?,?)', (tid, 'Alpha' if tid == ids[0] else 'Different composition', 'Artist', '', 12000, '', 'youtube', '', 0))
    state = {'seed':ids[0], 'queue':[ids[1]], 'played':[ids[0]], 'lastSeed':ids[0]}
    hub.db('INSERT INTO stations VALUES(?,?,?,?,?)', (sid,'test',ids[0],json.dumps(state),0))
    monkeypatch.setattr(hub,'prefetch',lambda *_: None)
    key=str(uuid.uuid4())
    hub.db("CREATE TRIGGER reject_receipt BEFORE INSERT ON station_batches BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END")
    with pytest.raises(sqlite3.IntegrityError):
        hub.station_more(sid,1,key)
    assert json.loads(hub.db('SELECT state FROM stations WHERE id=?',(sid,))[0][0]) == state
    hub.db('DROP TRIGGER reject_receipt')
    assert hub.station_more(sid,1,key)[0]['id'] == ids[1]
    assert hub.station_more(sid,1,key)[0]['id'] == ids[1]


def test_empty_station_batch_is_not_cached_forever(hub,monkeypatch):
    sid='d'*16
    hub.db('INSERT INTO stations VALUES(?,?,?,?,?)',(sid,'test','yt:aaaaaaaaaaa','{}',0))
    batches=[[],[{'id':'yt:bbbbbbbbbbb'}]]
    monkeypatch.setattr(hub,'_take',lambda *_: batches.pop(0))
    monkeypatch.setattr(hub,'prefetch',lambda *_: None)
    key=str(uuid.uuid4())
    assert hub.station_more(sid,1,key)==[]
    assert hub.station_more(sid,1,key)==[{'id':'yt:bbbbbbbbbbb'}]


def test_conflicting_playback_event_is_rejected(hub):
    key=f'{uuid.uuid4()}:{uuid.uuid4()}:played'
    assert hub.record_play('yt:aaaaaaaaaaa','played',key)
    with pytest.raises(ValueError): hub.record_play('yt:bbbbbbbbbbb','played',key)
    with pytest.raises(ValueError): hub.record_play('yt:aaaaaaaaaaa','skipped',key)
