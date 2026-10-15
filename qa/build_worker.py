"""Build/save architecture-specific artifacts on the designated worker only."""
import fcntl, hashlib, json, os, pathlib, subprocess, sys, time
root=pathlib.Path(sys.argv[1]); root.mkdir(parents=True,exist_ok=True)
lock=open('/Volumes/ThalesMedia/AndroidBuilds/worker.lock','a+')
for _ in range(180):
 try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
 except BlockingIOError: time.sleep(2)
else: raise SystemExit('Build worker lock unavailable; checkpoint retained')
sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
images=[]
for arch in ['arm64','amd64']:
 tag='ghcr.io/humanitylabs-org/wizard-music:0.1.0-test'
 with open(root/f'build-{arch}.log','w') as log:
  subprocess.run(['docker','build','--platform',f'linux/{arch}','--label','org.opencontainers.image.source=https://github.com/humanitylabs-org/wizard-music','--label',f'org.opencontainers.image.revision={sha}','-t',tag,'.'],stdout=log,stderr=subprocess.STDOUT,check=True)
 info=json.loads(subprocess.check_output(['docker','image','inspect',tag]))[0]
 archive=root/f'wizard-music-0.1.0-test-linux-{arch}.tar.gz'
 with open(archive,'wb') as f:
  save=subprocess.Popen(['docker','save',tag],stdout=subprocess.PIPE)
  compress=subprocess.run(['gzip','-1'],stdin=save.stdout,stdout=f);save.stdout.close()
  assert save.wait()==0 and compress.returncode==0
 images.append({'architecture':arch,'image_id':info['Id'],'image_source_sha':sha,'archive':archive.name,'bytes':archive.stat().st_size,'sha256':hashlib.file_digest(open(archive,'rb'),'sha256').hexdigest()})
(root/'images.json').write_text(json.dumps(images,indent=2));print(json.dumps(images,indent=2))
