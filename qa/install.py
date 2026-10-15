"""Real clean/configured install QA on the build worker; fixtures are our own generated audio."""
import json, math, os, pathlib, secrets, struct, subprocess, sys, time, urllib.request, urllib.error, wave
ROOT=pathlib.Path(sys.argv[1]); IMAGE=sys.argv[2]
ROOT.mkdir(parents=True,exist_ok=True)
for d in ['library','evidence']: (ROOT/d).mkdir(exist_ok=True)
# An original, deterministic melody rendered to PCM. Never another owner's library.
with wave.open(str(ROOT/'library/Recipient QA Melody.wav'),'wb') as f:
 f.setnchannels(1);f.setsampwidth(2);f.setframerate(22050)
 f.writeframes(b''.join(struct.pack('<h',int(7000*math.sin(2*math.pi*[261.63,329.63,392,523.25][int(i/22050)%4]*i/22050)*min(1,(i%22050)/500,(22050-i%22050)/500))) for i in range(22050*45)))
def run(*args): return subprocess.check_output(args,text=True).strip()
def api(path,body=None,port=19305,headers=None):
 data=None if body is None else json.dumps(body).encode(); h={'Content-Type':'application/json',**(headers or {})}
 try:
  with urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}'+path,data=data,headers=h),timeout=15) as r:return r.status,dict(r.headers),r.read()
 except urllib.error.HTTPError as e:return e.code,dict(e.headers),e.read()
def ready(port):
 for _ in range(40):
  try:
   if api('/health',port=port)[0]==200:return
  except Exception:pass
  time.sleep(.5)
 raise RuntimeError('container not ready')
for name in ['music-test-clean','music-test-configured']:
 subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
run('docker','run','-d','--name','music-test-clean','-p','127.0.0.1:19306:9205',IMAGE)
ready(19306)
assert json.loads(api('/health',port=19306)[2])['configured'] is False
assert api('/wizard-music/api/home',port=19306)[0]==503
checks=['clean install process healthy and honestly unconfigured (503)']
token=secrets.token_hex(32)
env=ROOT/'qa.env';env.write_text('WIZARD_MUSIC_HUB_TOKEN='+token+'\nWIZARD_TRUSTED_ORIGINS=http://127.0.0.1:19325\n');env.chmod(0o600)
run('docker','volume','create','music-test-data')
run('docker','volume','create','music-test-library')
# Colima daemon may not mount the host's external SSD path. Populate a dedicated
# volume via Docker's copy API; no owner library or global daemon config changes.
helper=run('docker','create','-v','music-test-library:/music',IMAGE)
run('docker','cp',str(ROOT/'library/Recipient QA Melody.wav'),helper+':/music/Recipient QA Melody.wav')
run('docker','rm',helper)
def create():
 return run('docker','run','-d','--name','music-test-configured','--env-file',str(env),'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp','-p','127.0.0.1:19305:9205','-v','music-test-data:/data','-v','music-test-library:/music:ro',IMAGE)
create();ready(19305)
for _ in range(30):
 s,_,b=api('/wizard-music/api/home')
 if s==200 and json.loads(b)['library']:break
 time.sleep(.5)
home=json.loads(b);assert s==200 and len(home['library'])==1
track=home['library'][0];assert track['title']=='Recipient QA Melody'
assert not home['sources'][0]['ok'] and not home['vibes'];checks.append('configured own library detected; online sources disabled')
s,h,b=api(track['stream'],headers={'Range':'bytes=0-4095'});assert s==206 and len(b)==4096 and h.get('content-range','').startswith('bytes 0-4095/')
checks.append('real audio range stream 206, 4096 bytes')
assert token.encode() not in json.dumps(home).encode()
assert api('/wizard-music/api/home',headers={'Host':'evil.example'})[0]==403
assert api('/wizard-music/api/home',headers={'Origin':'https://evil.example'})[0]==403
assert api('/wizard-music/api/admin')[0]==404
checks.append('Host Origin and undeclared route negative controls')
s,_,b=api('/wizard-music/api/feedback',{'id':track['id'],'action':'like'});assert s==200
assert json.loads(api('/wizard-music/api/home')[2])['liked'][0]['id']==track['id'];checks.append('like persisted and read back')
run('docker','rm','-f','music-test-configured');create();ready(19305)
for _ in range(20):
 s,_,b=api('/wizard-music/api/home')
 if s==200:break
 time.sleep(.5)
assert json.loads(b)['liked'][0]['id']==track['id'];checks.append('update/recreate same image retains library and liked database')
for method,params in [('initialize',{}),('tools/list',{}),('tools/call',{'name':'music_search','arguments':{'query':'Recipient QA'}})]:
 s,_,b=api('/mcp',{'jsonrpc':'2.0','id':1,'method':method,'params':params});assert s==200 and 'result' in json.loads(b)
 if method=='tools/call':assert 'Recipient QA Melody' in b.decode()
checks.append('real MCP initialize list and search')
result={'ok':True,'image':run('docker','image','inspect',IMAGE,'--format','{{.Id}}'),'checks':checks,'stream_bytes':4096,'track_id':track['id'],'fixture':'Original generated 45-second melody, not shipped and not owner private media','container':run('docker','inspect','music-test-configured','--format','{{.Id}}')}
(ROOT/'evidence/api-install.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
