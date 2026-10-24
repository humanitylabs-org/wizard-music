"""Native-architecture container smoke; no fixture claims to prove online/provider playback."""
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave

image = sys.argv[1]
out = Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
name = 'wizard-music-release-smoke'
volume = name + '-data'
library = name + '-library'

def run(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()

def api(path, body=None, headers=None):
    req = urllib.request.Request('http://127.0.0.1:19305' + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return res.status, dict(res.headers), res.read()
    except urllib.error.HTTPError as res:
        return res.code, dict(res.headers), res.read()

def get(path):
    status, _, data = api(path)
    assert status == 200, (path, status, data)
    return json.loads(data)

def ready():
    for _ in range(100):
        try:
            if get('/wizard-music/api/home')['settings'].get('online') is False: return
        except Exception: pass
        time.sleep(.2)
    raise RuntimeError(run('logs', name))

def create():
    run('run', '-d', '--name', name, '--read-only', '--cap-drop', 'ALL',
        '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'SETUID', '--cap-add', 'SETGID',
        '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp',
        '-v', volume + ':/data', '-v', library + ':/music:ro',
        '-p', '127.0.0.1:19305:9205', image)
    ready()

try:
    run('volume', 'create', volume); run('volume', 'create', library)
    create()
    home = get('/wizard-music/api/home')
    assert home['library'] == [] and home['liked'] == [] and home['vibes'] == []
    assert get('/health')['configured'] is True
    token_info = run('exec', '--user', '1000:1000', name, 'python3', '-c',
        'import pathlib,hashlib,json; p=pathlib.Path("/data/hub-token"); print(json.dumps({"mode": oct(p.stat().st_mode & 0o777), "length":len(p.read_text()), "sha256":hashlib.sha256(p.read_bytes()).hexdigest()}))')
    token = json.loads(token_info)
    assert token['mode'] == '0o600' and token['length'] == 64
    status = run('exec', name, 'sh', '-c', 'cat /proc/1/status')
    assert 'Uid:\t1000\t1000\t1000\t1000' in status
    assert 'CapEff:\t0000000000000000' in status
    assert api('/wizard-music/api/settings', {'online': True}, {'Origin':'https://foreign.example'})[0] == 403
    assert api('/wizard-music/api/settings', {'online': True}, {'Origin':'https://wizard.example', 'X-Forwarded-Host':'wizard.example', 'X-Forwarded-Proto':'https'})[0] == 200
    assert get('/wizard-music/api/settings')['online'] is True
    assert api('/wizard-music/api/settings', {'online': False})[0] == 200
    assert api('/wizard-music/stream/yt:aaaaaaaaaaa')[0] == 404
    assert api('/wizard-music/art/yt:aaaaaaaaaaa')[0] == 404
    assert api('/wizard-music/api/catalog?videoId=aaaaaaaaaaa')[0] == 403
    wav = out / 'Generated QA melody.wav'
    with wave.open(str(wav), 'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(22050)
        audio.writeframes(b''.join(struct.pack('<h', int(5000*math.sin(2*math.pi*440*i/22050))) for i in range(22050*12)))
    helper = run('create', '-v', library + ':/music', image)
    run('cp', str(wav), helper + ':/music/Generated QA melody.wav'); run('rm', helper)
    assert api('/wizard-music/api/scan', {})[0] == 200
    track = get('/wizard-music/api/home')['library'][0]
    code, headers, data = api(track['stream'], headers={'Range':'bytes=0-4095'})
    assert code == 206 and len(data) == 4096
    assert api('/wizard-music/api/feedback', {'id':track['id'], 'action':'like'})[0] == 200
    run('rm', '-f', name); create()
    assert get('/wizard-music/api/home')['liked'][0]['id'] == track['id']
    after = run('exec', '--user', '1000:1000', name, 'python3', '-c', 'import pathlib,hashlib; print(hashlib.sha256(pathlib.Path("/data/hub-token").read_bytes()).hexdigest())')
    assert after == token['sha256']
    info = json.loads(run('image', 'inspect', image))[0]
    receipt = {'ok':True, 'architecture':info['Architecture'], 'image_id':info['Id'], 'image':image,
        'checks':['empty configured first run without env or manual token', 'uid1000/caps0', 'token0600 stable after recreate',
          'same-origin gateway without env; foreign origin blocked', 'consent toggle/readback/revocation', 'offline downloader/art/catalog denied',
          'generated local WAV range206', 'like retained after recreate'], 'fixture':'generated sine wave, not bundled media',
        'not_claimed':['browser decoded playback','real online provider playback','real Store/WAM install']}
    (out / 'smoke.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt))
finally:
    subprocess.run(['docker','rm','-f',name], stdout=subprocess.DEVNULL)
    subprocess.run(['docker','volume','rm',volume,library], stdout=subprocess.DEVNULL)
