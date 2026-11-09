#!/usr/bin/env python3
"""Import TrackHunt without dropping captures, attempts, candidates or audio.

Run on the hub host with the TrackHunt data copied into a private staging folder.
Both SQLite databases are backed up using the SQLite backup API before any write.
Idempotent on capture UUID and raw digest. Existing hub captures are not replaced.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3


def checksum(p):
    with p.open('rb') as f:
        return hashlib.file_digest(f,'sha256').hexdigest()


def migrate(source, target, backup):
    os.environ['WIZARD_MUSIC_HUB_HOME'] = str(target)
    import identify
    identify.DATA_DIR = target
    identify.DB_PATH = target/'hub.sqlite3'
    identify.AUDIO_DIR = target/'identify/audio'
    identify.EXPORT_DIR = target/'identify/exports'
    backup.mkdir(parents=True,exist_ok=False)
    src = sqlite3.connect(f'file:{source / "trackhunt.sqlite3"}?mode=ro',uri=True)
    src.row_factory = sqlite3.Row
    dst = sqlite3.connect(target/'hub.sqlite3')
    for con,name in ((src,'trackhunt.sqlite3'),(dst,'hub.sqlite3')):
        b = sqlite3.connect(backup/name); con.backup(b); b.close()
    shutil.copytree(source/'audio',backup/'trackhunt-audio')
    identify.init_db()
    before = {name:dst.execute(f'SELECT COUNT(*) FROM {name}').fetchone()[0] for name in ('tracks','likes','plays','requests','mixes') if dst.execute('SELECT 1 FROM sqlite_master WHERE name=?',(name,)).fetchone()}
    ids,files,imported=[],[],0
    for cap in src.execute('SELECT * FROM captures ORDER BY created_at'):
        cap=dict(cap); cid=cap['id']; identify.safe_uuid(cid)
        source_dir = source/'audio'/cid
        target_dir = identify.AUDIO_DIR/cid
        target_dir.mkdir(parents=True,exist_ok=True)
        for p in source_dir.rglob('*'):
            if not p.is_file(): continue
            rel=p.relative_to(source_dir); q=target_dir/rel; q.parent.mkdir(parents=True,exist_ok=True)
            if q.exists() and checksum(q)!=checksum(p): raise RuntimeError('Conflicting destination audio: '+str(q))
            if not q.exists(): shutil.copy2(p,q)
            digest=checksum(p)
            if checksum(q)!=digest: raise RuntimeError('Audio copy hash mismatch')
            files.append({'capture':cid,'file':str(rel),'sha256':digest,'bytes':p.stat().st_size})
        for k,v in list(cap.items()):
            if k.endswith('_path') and v:
                # TrackHunt audio files live below capture UUID; exports can be outside.
                if cid in Path(v).parts:
                    parts=Path(v).parts; cap[k]=str(target_dir.joinpath(*parts[parts.index(cid)+1:]))
                elif k=='export_path' and (source/'exports'/Path(v).name).exists():
                    q=identify.EXPORT_DIR/Path(v).name; q.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(source/'exports'/Path(v).name,q); cap[k]=str(q)
                else: cap[k]=None
        if not cap.get('raw_path') or not Path(cap['raw_path']).is_file(): raise RuntimeError('Original missing: '+cid)
        cap['raw_sha256']=checksum(Path(cap['raw_path']))
        exists=dst.execute('SELECT raw_sha256 FROM captures WHERE id=?',(cid,)).fetchone()
        if exists:
            if exists[0]!=cap['raw_sha256']: raise RuntimeError('Conflicting capture UUID: '+cid)
            ids.append(cid); continue
        confirmed=cap['confirmed_candidate_id']; cap['confirmed_candidate_id']=None
        with dst:
            cols=list(cap); dst.execute(f'INSERT INTO captures({",".join(cols)}) VALUES({",".join("?" for _ in cols)})',list(cap.values()))
            candidate_ids={}
            for table in ('attempts','candidates'):
                for row in src.execute(f'SELECT * FROM {table} WHERE capture_id=? ORDER BY id',(cid,)):
                    row=dict(row); old=row.pop('id'); cols=list(row)
                    cur=dst.execute(f'INSERT INTO {table}({",".join(cols)}) VALUES({",".join("?" for _ in cols)})',list(row.values()))
                    if table=='candidates': candidate_ids[old]=cur.lastrowid
            if confirmed: dst.execute('UPDATE captures SET confirmed_candidate_id=? WHERE id=?',(candidate_ids[confirmed],cid))
        ids.append(cid); imported+=1
    after={name:dst.execute(f'SELECT COUNT(*) FROM {name}').fetchone()[0] for name in before}
    if before!=after: raise RuntimeError('Unrelated Music tables changed')
    if len(ids)!=src.execute('SELECT COUNT(*) FROM captures').fetchone()[0]: raise RuntimeError('Count mismatch')
    result={'ok':True,'source_count':len(ids),'imported':imported,'ids':ids,'audio_files':files,'music_before':before,'music_after':after,'backup':str(backup)}
    (backup/'migration-receipt.json').write_text(json.dumps(result,indent=2))
    src.close(); dst.close()
    return result


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('source',type=Path);p.add_argument('target',type=Path);p.add_argument('--backup',type=Path,required=True);a=p.parse_args()
    print(json.dumps(migrate(a.source.resolve(),a.target.resolve(),a.backup.resolve()),indent=2))
