#!/usr/bin/env python3
"""Run only on the admitted Linux worker; never changes the owner's services/data."""
from pathlib import Path
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
import urllib.error
import wave

ROOT=Path(__file__).resolve().parents[1]
INPUT=Path(os.environ.get('IDENTIFY_INPUT','/srv/work/music-identify-input'))
OUT=Path(os.environ.get('IDENTIFY_OUT',str(ROOT/'evidence/identify')))
OUT.mkdir(parents=True,exist_ok=True)
PY=ROOT/'.venv/bin/python'


def run(args,**kw):
    print('+',' '.join(map(str,args)),flush=True)
    return subprocess.run(list(map(str,args)),cwd=ROOT,check=True,**kw)


def ready(url):
    end=time.monotonic()+20
    while time.monotonic()<end:
        try:
            with urllib.request.urlopen(url,timeout=2) as r:
                if r.status==200:return
        except Exception: time.sleep(.2)
    raise RuntimeError('Local fixture did not become ready: '+url)


def main():
    discard_only=os.environ.get('IDENTIFY_DISCARD_ONLY')=='1'
    browser_only=os.environ.get('IDENTIFY_BROWSER_ONLY')=='1'
    if browser_only:
        # Reuse successful unchanged build/tests; fresh output keeps failed evidence intact.
        if not PY.exists() or not (ROOT/'node_modules').is_dir() or not (ROOT/'dist/index.html').is_file():
            raise RuntimeError('Browser-only continuation requires existing dependencies and built app')
        print('Browser-only continuation: build/tests not rerun; previous receipt remains authoritative',flush=True)
    else:
        if not PY.exists():run(['python3','-m','venv',ROOT/'.venv'])
        run([PY,'-m','pip','install','--only-binary=:all:','-r','hub/requirements.txt','pytest==8.4.2'])
        run(['npm','ci','--no-audit','--no-fund'])
        run(['npx','playwright','install','chromium'])
        run(['npm','run','build'])
        run(['npm','test'])
        run(['node','--test','qa/identify-transport.mjs'])
        run([PY,'-m','pytest','hub/tests/test_identify.py','-q'])
    # Use real recognizer network only in its isolated scratch home, not the owner's hub.
    env={**os.environ,'WIZARD_MUSIC_HUB_HOME':str(OUT/'recognizer-home'),'IDENTIFY_KNOWN_PREVIEW':'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/f5/0c/cb/f50ccb25-c1fd-8940-1f8a-e42495300745/mzaf_15922365127289521089.plus.aac.p.m4a','IDENTIFY_KNOWN_TITLE':'Nevada'}
    if not browser_only and not os.environ.get('IDENTIFY_SKIP_RECOGNIZER'):
        with (OUT/'recognizer.log').open('w') as f:run([PY,'hub/qa_identify_network.py'],env=env,stdout=f,stderr=subprocess.STDOUT)
    else: print('Unchanged provider-network check explicitly skipped for recording-only UX', flush=True)
    home=OUT/'hub-home'
    if home.exists():raise RuntimeError('Refusing to reuse an already-mutated fixture home')
    if discard_only:
        # Empty throwaway hub and generated silence: no owner audio/names/data are used.
        home.mkdir()
        with wave.open(str(OUT/'synthetic.wav'),'wb') as f:
            f.setparams((1,2,44100,0,'NONE','not compressed')); f.writeframes(b'\0\0'*44100*7)
    else:
        shutil.copytree(INPUT/'hub-home',home)
        with (OUT/'migration.log').open('w') as f:run([PY,'hub/import_trackhunt.py',INPUT/'trackhunt',home,'--backup',OUT/'migration-backup'],stdout=f,stderr=subprocess.STDOUT)
    env={**os.environ,'WIZARD_MUSIC_HUB_HOME':str(home),'WIZARD_MUSIC_LIBRARY':str(OUT/'library'),'WIZARD_MUSIC_HUB_TOKEN':'identify-fixture-only','WIZARD_MUSIC_HUB_PORT':'19401','WIZARD_MUSIC_APP_PORT':'19305','WIZARD_MUSIC_HUB_ORIGIN':'http://127.0.0.1:19401','WIZARD_MUSIC_ONLINE':'0','WIZARD_MUSIC_RELEASE':os.environ.get('WIZARD_MUSIC_RELEASE') or subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()}
    code="import sys;sys.path.insert(0,'hub');import hub,identify;identify.shazam_lookup=lambda p:{'ok':True,'raw':{'matches':[]}};identify.start();hub.ThreadingHTTPServer((hub.HOST,hub.PORT),hub.Handler).serve_forever()"
    logs=[(OUT/'hub.log').open('w'),(OUT/'node.log').open('w')]
    children=[]
    try:
        children.append(subprocess.Popen([str(PY),'-u','-c',code],cwd=ROOT,env=env,stdout=logs[0],stderr=subprocess.STDOUT))
        children.append(subprocess.Popen(['node','server/index.mjs'],cwd=ROOT,env=env,stdout=logs[1],stderr=subprocess.STDOUT))
        ready('http://127.0.0.1:19305/wizard-music/api/identify/captures')
        def get(path):
            with urllib.request.urlopen('http://127.0.0.1:19305'+path,timeout=20) as r:return r.read(),r.headers,r.status
        status=json.loads(get('/wizard-music/api/status')[0]); assert status['configured'] is True and status['version']=='0.2.0-identify'
        captures=json.loads(get('/wizard-music/api/identify/captures')[0])['captures']
        assert len(captures)==(0 if discard_only else 5)
        rows=[]
        for cap in captures:
            d=json.loads(get('/wizard-music/api/identify/captures/'+cap['id'])[0])
            audio,headers,status=get(d['audio_url'])
            assert status==200 and len(audio)>44 and headers['Content-Type'].startswith('audio/')
            rows.append({'id':cap['id'],'bytes':len(audio),'content_type':headers['Content-Type'],'sha256':d['raw_sha256']})
        (OUT/'five-captures.json').write_text(json.dumps({'ok':True,'count':len(rows),'rows':rows},indent=2))
        if discard_only:
            # Real proxy + hub status codes, UUID validation, persistence and MCP routes.
            import uuid
            base='http://127.0.0.1:19305/wizard-music/api/identify/'
            def request(path,payload=None):
                req=urllib.request.Request(base+path,data=json.dumps(payload).encode() if payload is not None else None,headers={'Content-Type':'application/json'})
                try:
                    with urllib.request.urlopen(req) as r:return r.status,json.load(r)
                except urllib.error.HTTPError as e:return e.code,json.load(e)
            assert request('captures/'+str(uuid.uuid4())+'/discard',{})[0]==404
            assert request('captures/'+'a'*36+'/discard',{})[0]==400
            req=urllib.request.Request(base+'captures?id='+str(uuid.uuid4()),data=(OUT/'synthetic.wav').read_bytes(),headers={'Content-Type':'audio/wav'})
            with urllib.request.urlopen(req) as r: uploaded=json.load(r)
            cid=uploaded['id']
            original={}
            end=time.monotonic()+20
            while time.monotonic()<end:
                original=request('captures/'+cid)[1]
                if original['status']=='no_match':break
                time.sleep(.1)
            assert original['status']=='no_match'
            status,discarded=request('captures/'+cid+'/discard',{});assert status==200 and discarded['retention_state']=='discarded'
            assert request('captures/'+cid+'/discard',{})[1]==discarded
            assert cid not in [c['id'] for c in request('captures')[1]['captures']]
            assert request('captures/'+cid+'/retry',{})[0]==409
            assert request('captures/'+cid+'/restore',{})[0]==200
            restored=request('captures/'+cid)[1]
            for k in original:
                if k not in ('updated_at','retention_state'):assert restored[k]==original[k],k
            for action in ('discard','restore'):
                req=urllib.request.Request('http://127.0.0.1:19305/mcp',data=json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'identify_'+action,'arguments':{'id':cid}}}).encode(),headers={'Content-Type':'application/json'})
                with urllib.request.urlopen(req) as r:result=json.load(r)['result']
                assert not result['isError'];assert json.loads(result['content'][0]['text'])['id']==cid
            (OUT/'discard-api.json').write_text(json.dumps({'ok':True,'synthetic_only':True,'proxy_hub_mcp':True,'idempotent':True,'preserved':True},indent=2))
        qaenv={**env,'QA_SHELL_WEB':str(INPUT/'shell-web'),'OUT':str(OUT),'QA_AUDIO':str(OUT/'synthetic.wav') if discard_only else str(next((INPUT/'trackhunt/audio').glob('*/normalized.wav')))}
        run(['node','qa/identify-browser.mjs'],env=qaenv)
    finally:
        for p in children:p.terminate()
        for p in children:
            try:p.wait(timeout=10)
            except subprocess.TimeoutExpired:p.kill();p.wait()
        for f in logs:f.close()
    (OUT/'complete.json').write_text(json.dumps({'ok':True,'source':env['WIZARD_MUSIC_RELEASE'],'live_changes':False,'scope':'browser-only' if browser_only else 'full','build_tests_reused':browser_only},indent=2))
    print('Identify isolated browser acceptance complete' if browser_only else 'Identify build and isolated acceptance complete',flush=True)


if __name__=='__main__':main()
