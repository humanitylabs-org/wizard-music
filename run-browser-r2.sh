#!/usr/bin/env bash
set -euo pipefail
EXPECTED=$(git rev-parse 05e6f20)
[ "$(git rev-parse HEAD)" = "$EXPECTED" ]
[ -z "$(git status --porcelain --untracked-files=no)" ]
export TMPDIR="$PWD/.scratch"
mkdir -p "$TMPDIR"
python3 - <<'PY'
import subprocess,json,hashlib,pathlib
root=pathlib.Path.cwd()
changed=set(subprocess.check_output(['git','diff','--name-only','764dfcb','HEAD'],text=True).splitlines())
assert changed=={'qa/identify-browser.mjs','docs/unmatched-discard.md'},changed
receipt=json.loads((root/'evidence/build-tests.json').read_text())
assert receipt['ok'] and receipt['source']=='764dfcb8e182f54f355061ba161601b11c06a5dd'
for p,h in receipt['dist'].items():assert hashlib.sha256((root/'dist'/p).read_bytes()).hexdigest()==h,p
(root/'evidence/r2-build-reuse.json').write_text(json.dumps({'ok':True,'runtime_source_equivalent':True,'built_source':receipt['source'],'qa_source':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'original_receipt':'evidence/build-tests.json','dist_manifest_verified':True},indent=2))
PY
export WIZARD_MUSIC_RELEASE="$EXPECTED" IDENTIFY_INPUT=/srv/work/music-opus-integrated-input-20261106 IDENTIFY_DISCARD_ONLY=1 IDENTIFY_SKIP_RECOGNIZER=1 IDENTIFY_BROWSER_ONLY=1
IDENTIFY_OUT="$PWD/evidence/local-discard-r2" IDENTIFY_LOCAL_DISCARD_ONLY=1 python3 qa/run-identify-forum.py 2>&1 | tee evidence/local-discard-r2.log
IDENTIFY_OUT="$PWD/evidence/remote-discard-r2" IDENTIFY_LOCAL_DISCARD_ONLY=0 python3 qa/run-identify-forum.py 2>&1 | tee evidence/remote-discard-r2.log
python3 - <<'PY'
import json,pathlib,subprocess
root=pathlib.Path.cwd();sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();checks={}
for name in ['local-discard-r2','remote-discard-r2']:
 d=root/'evidence'/name;c=json.loads((d/'complete.json').read_text());b=json.loads((d/'browser-results.json').read_text())
 assert c['ok'] and c['source']==sha and b['ok'];assert {(r['shell'],r['skin']) for r in b['rows']}=={(s,k) for s in ['phone','desktop'] for k in ['nebula','grove']}
 assert all(not r['pageerrors'] for r in b['rows']);checks[name]=c
(root/'evidence/focused-complete-r2.json').write_text(json.dumps({'ok':True,'source':sha,'checks':checks,'build_reuse':json.loads((root/'evidence/r2-build-reuse.json').read_text())},indent=2))
PY
