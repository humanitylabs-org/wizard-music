#!/usr/bin/env python3
"""Network acceptance: real Shazam response, known song + deterministic noise.
Fixture audio remains private scratch, never committed to this public package.
"""
import hashlib
import json
import os
from pathlib import Path
import random
import struct
import urllib.request
import uuid
import wave

import identify


def main():
    identify.init_db()
    # Owner's existing candidate's public iTunes preview, retrieved rather than fabricated.
    preview=os.environ['IDENTIFY_KNOWN_PREVIEW']
    title=os.environ.get('IDENTIFY_KNOWN_TITLE','Nevada')
    with urllib.request.urlopen(preview,timeout=30) as r: audio=r.read(5_000_000)
    cid=str(uuid.uuid4())
    real_enqueue=identify.enqueue; identify.enqueue=lambda cid: None
    identify.accept(cid,audio,'audio/mp4',{'note':'Acceptance known-song fixture'})
    identify.recognize(cid)
    known=identify.get_capture(cid)
    known_ok=known['status']=='has_leads' and any(title.casefold() in c['title'].casefold() for c in known['candidates'])
    noise=identify.DATA_DIR/'noise-fixture.wav'
    rng=random.Random(20261106)
    with wave.open(str(noise),'wb') as f:
        f.setparams((1,2,44100,0,'NONE','not compressed'))
        f.writeframes(struct.pack('<'+'h'*(44100*5),*[rng.randint(-120,120) for _ in range(44100*5)]))
    raw=noise.read_bytes(); nid=str(uuid.uuid4())
    identify.accept(nid,raw,'audio/wav',{'note':'Acceptance noise fixture'})
    identify.recognize(nid)
    result=identify.get_capture(nid)
    noise_ok=result['status']=='no_match' and Path(result['raw_path']).read_bytes()==raw and Path(result['normalized_path']).is_file()
    receipt={'ok':known_ok and noise_ok,'known_song':{'expected':title,'status':known['status'],'candidates':[(c['title'],c['artist']) for c in known['candidates']],'audio_kept':Path(known['raw_path']).is_file()},'noise':{'status':result['status'],'audio_kept':noise_ok},'provider':'real shazamio network','home':str(identify.DATA_DIR)}
    print(json.dumps(receipt,indent=2))
    (identify.DATA_DIR/'network-identify-receipt.json').write_text(json.dumps(receipt,indent=2))
    if not receipt['ok']: raise SystemExit(1)


if __name__=='__main__': main()
