import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import random
import struct
import sys
import uuid
import wave

import pytest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))

@pytest.fixture
def identify(tmp_path,monkeypatch):
    monkeypatch.setenv('WIZARD_MUSIC_HUB_HOME',str(tmp_path))
    import identify as module
    module = importlib.reload(module)
    module.init_db()
    monkeypatch.setattr(module,'enqueue',lambda cid: True)
    monkeypatch.setattr(module.time,'sleep',lambda _: None)
    return module


def wave_bytes(seconds=.5):
    b=io.BytesIO()
    rng=random.Random(41)
    with wave.open(b,'wb') as f:
        f.setparams((1,2,44100,0,'NONE','not compressed'))
        f.writeframes(struct.pack('<'+'h'*int(44100*seconds),*[rng.randint(-100,100) for _ in range(int(44100*seconds))]))
    return b.getvalue()


def saved(identify):
    raw=wave_bytes()
    cid=str(uuid.uuid4())
    cap=identify.accept(cid,raw,'audio/wav',{})
    return cid,raw,cap


def test_custody_before_recognition_and_duplicate_upload(identify,monkeypatch):
    calls=[]
    def enqueue(cid):
        cap=identify.get_capture(cid)
        assert Path(cap['raw_path']).is_file()
        assert cap['raw_sha256']==hashlib.sha256(Path(cap['raw_path']).read_bytes()).hexdigest()
        calls.append(cid)
    monkeypatch.setattr(identify,'enqueue',enqueue)
    cid,raw,cap=saved(identify)
    assert identify.accept(cid,raw,'audio/wav',{})['id']==cid
    assert calls==[cid]
    with pytest.raises(identify.HTTPException): identify.accept(cid,b'different','audio/wav',{})
    assert Path(cap['raw_path']).read_bytes()==raw


def test_noise_no_match_keeps_original_and_normalized_audio(identify,monkeypatch):
    cid,raw,cap=saved(identify)
    monkeypatch.setattr(identify,'shazam_lookup',lambda path:{'ok':True,'raw':{'matches':[]}})
    identify.recognize(cid)
    result=identify.get_capture(cid)
    assert result['status']=='no_match'
    assert Path(result['raw_path']).read_bytes()==raw
    assert Path(result['normalized_path']).stat().st_size>0
    assert any(a['preprocess']=='filtered-window' for a in result['attempts'])
    assert any(a['outcome']=='no_match' for a in result['attempts'])


def test_known_song_provider_fixture_and_attempt_json(identify,monkeypatch):
    cid,raw,cap=saved(identify)
    provider={'track':{'title':'Known song','subtitle':'Known artist','share':{},'images':{}},'matches':[{'id':'recognizer-fixture'}]}
    monkeypatch.setattr(identify,'shazam_lookup',lambda path:{'ok':True,'raw':provider})
    monkeypatch.setattr(identify,'enrich',lambda title,artist:{'title':title,'artist':artist})
    identify.recognize(cid)
    result=identify.get_capture(cid)
    assert result['status']=='has_leads'
    assert result['candidates'][0]['title']=='Known song'
    assert result['attempts'][0]['raw_response_json']==provider
    assert Path(result['raw_path']).read_bytes()==raw


def test_pipeline_error_does_not_discard_audio(identify,monkeypatch):
    cid,raw,cap=saved(identify)
    def fail(*args): raise RuntimeError('decoder unavailable')
    monkeypatch.setattr(identify,'prepare',fail)
    identify.recognize(cid)
    result=identify.get_capture(cid)
    assert result['status']=='error'
    assert Path(result['raw_path']).read_bytes()==raw


def test_confirmation_atomic_like_request_and_restart(identify,monkeypatch):
    import hub
    hub=importlib.reload(hub)
    monkeypatch.setattr(hub,'queue_info',lambda *a:None)
    monkeypatch.setattr(hub,'queue_styles_for',lambda *a:None)
    cid,raw,cap=saved(identify)
    hub.db("INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?,?)",('yt:abcdefghijk','Song','Artist','',1000,'','youtube','',0))
    candidate=identify.add_candidate(cid,{'title':'Song','artist':'Artist','provider':'manual','music_track_id':'yt:abcdefghijk'})
    first=identify.verdict(candidate,{'verdict':'confirmed'},hub)
    identify.verdict(candidate,{'verdict':'confirmed'},hub)
    assert first['track']['liked'] is True
    assert hub.db("SELECT COUNT(*) FROM requests WHERE how='identify'")[0][0]==1
    assert hub.scores()['songs'][0]['request']==1
    hub._db.close()
    hub=importlib.reload(hub)
    assert hub.track('yt:abcdefghijk')['liked'] is True
    assert identify.get_capture(cid)['confirmed_candidate_id']==candidate
    assert Path(cap['raw_path']).read_bytes()==raw


def test_retry_enqueue_deduplicates(identify,monkeypatch):
    # Restore original enqueue after fixture isolates network processing.
    original=identify.__dict__.copy()
    cid,_,_=saved(identify)
    identify=importlib.reload(identify)
    assert identify.enqueue(cid) is True
    assert identify.enqueue(cid) is False
    assert identify.JOBS.qsize()==1


def test_public_audio_paths_and_paid_providers_off(identify):
    cid,_,cap=saved(identify)
    view=identify.public_capture(identify.get_capture(cid))
    assert 'raw_path' not in view
    assert view['audio_url'].endswith(cid+'/audio')
    assert identify.audd_lookup(Path('/unused'))['not_configured'] is True
    assert identify.audio_path(cid,'original').is_file()
    with pytest.raises(ValueError): identify.audio_path(cid,'../../hub.env')
