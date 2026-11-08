#!/usr/bin/env bash
set -euo pipefail
EXPECTED=764dfcb8e182f54f355061ba161601b11c06a5dd
BASE=/srv/work/music-discard-5217f17-20261106
INPUT=/srv/work/music-opus-integrated-input-20261106
export TMPDIR="$PWD/.scratch"
mkdir -p "$TMPDIR" evidence
[ "$(git rev-parse HEAD)" = "$EXPECTED" ]
[ -z "$(git status --porcelain --untracked-files=no)" ]
node --input-type=module -e 'import fs from "node:fs";import assert from "node:assert/strict";let p=JSON.parse(fs.readFileSync("package.json"));for(let [k,v] of Object.entries({...p.dependencies,...p.devDependencies}))assert.equal(JSON.parse(fs.readFileSync("node_modules/"+k+"/package.json")).version,v,k);console.log("Pinned installed dependency versions all match")'
cmp package-lock.json "$BASE/package-lock.json"
npm run build 2>&1 | tee evidence/build.log
npm test 2>&1 | tee evidence/tests.log
node --test qa/identify-transport.mjs 2>&1 | tee evidence/transport.log
.venv/bin/python -m pytest hub/tests/test_identify.py -q 2>&1 | tee evidence/hub-tests.log
node --input-type=module -e 'import fs from "node:fs";import crypto from "node:crypto";const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(d+"/"+e.name):[d+"/"+e.name]);fs.writeFileSync("evidence/build-tests.json",JSON.stringify({ok:true,source:process.argv[1],build:true,app_tests:true,transport_tests:true,hub_regression:true,dist:Object.fromEntries(walk("dist").map(p=>[p.slice(5),crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")]))},null,2))' "$EXPECTED"
export IDENTIFY_INPUT="$INPUT" IDENTIFY_DISCARD_ONLY=1 IDENTIFY_SKIP_RECOGNIZER=1 IDENTIFY_BROWSER_ONLY=1
IDENTIFY_OUT="$PWD/evidence/local-discard-r1" IDENTIFY_LOCAL_DISCARD_ONLY=1 python3 qa/run-identify-forum.py 2>&1 | tee evidence/local-discard-r1.log
IDENTIFY_OUT="$PWD/evidence/remote-discard-r1" IDENTIFY_LOCAL_DISCARD_ONLY=0 python3 qa/run-identify-forum.py 2>&1 | tee evidence/remote-discard-r1.log
node --input-type=module -e 'import fs from "node:fs";import assert from "node:assert/strict";const dirs=["local-discard-r1","remote-discard-r1"];let checks=Object.fromEntries(dirs.map(d=>{let p=JSON.parse(fs.readFileSync("evidence/"+d+"/complete.json")),b=JSON.parse(fs.readFileSync("evidence/"+d+"/browser-results.json"));assert.equal(p.ok,true);assert.equal(p.source,process.argv[1]);assert.equal(b.rows.length,4);return[d,p]}));fs.writeFileSync("evidence/focused-complete.json",JSON.stringify({ok:true,source:process.argv[1],checks},null,2))' "$EXPECTED"
