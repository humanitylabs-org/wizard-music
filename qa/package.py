"""Exercise the shipped Runtipi Compose verbatim, not a hand-written docker run."""
import json, pathlib, secrets, subprocess, sys, time, urllib.request
root=pathlib.Path(sys.argv[1]); image='ghcr.io/humanitylabs-org/wizard-music:0.1.0-test'
def run(*args,**kw):return subprocess.check_output(args,text=True,**kw).strip()
run('docker','volume','create','music-package-state')
mount=json.loads(run('docker','volume','inspect','music-package-state'))[0]['Mountpoint']
run('docker','run','--rm','--user','0','-v','music-package-state:/state',image,'sh','-c','mkdir -p /state/data /state/music && chown 1000:1000 /state/data && chmod 755 /state/music')
helper=run('docker','create','-v','music-package-state:/state',image)
run('docker','cp',str(root/'library/Recipient QA Melody.wav'),helper+':/state/music/Recipient QA Melody.wav');run('docker','rm',helper)
env=dict(__import__('os').environ,APP_PORT='19307',APP_DATA_DIR=mount,WIZARD_MUSIC_HUB_TOKEN=secrets.token_hex(32),WIZARD_TRUSTED_ORIGINS='http://127.0.0.1:19325')
cmd=['docker','compose','-p','music-package-test','-f','runtipi/docker-compose.yml']
run(*cmd,'up','-d',env=env)
ctr=run(*cmd,'ps','-q',env=env)
ports=run('docker','port',ctr);assert ports=='9205/tcp -> 127.0.0.1:19307',ports
for _ in range(30):
 try:
  home=json.load(urllib.request.urlopen('http://127.0.0.1:19307/wizard-music/api/home'))
  if home['library']:break
 except Exception:pass
 time.sleep(.5)
assert home['library'][0]['title']=='Recipient QA Melody'
config=json.loads(run(*cmd,'config','--format','json',env=env))
assert config['services']['wizard-music']['pull_policy']=='never'
# Recreate same package and mounts, never remove data.
run(*cmd,'up','-d','--force-recreate',env=env)
for _ in range(30):
 try:
  home=json.load(urllib.request.urlopen('http://127.0.0.1:19307/wizard-music/api/home'))
  if home['library']:break
 except Exception:pass
 time.sleep(.5)
assert home['library'][0]['title']=='Recipient QA Melody'
r={'ok':True,'compose':'runtipi/docker-compose.yml','port':ports,'pull_policy':'never','data_preserved':True,'image_id':run('docker','image','inspect',image,'--format','{{.Id}}'),'scope':'Exact package Compose installed/recreated; not public or private store catalog admission'}
(root/'evidence/package-install.json').write_text(json.dumps(r,indent=2));print(json.dumps(r,indent=2))
