
#!/usr/bin/env python3
from __future__ import annotations
import asyncio, datetime as dt, hashlib, json, mimetypes, os, queue, re, shutil, sqlite3, subprocess, threading, time, uuid, urllib.parse, urllib.request
from pathlib import Path
from typing import Any
import sys
class HTTPException(ValueError):
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail
        super().__init__(detail)

APP_ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get('WIZARD_MUSIC_HUB_HOME', str(Path.home()/'.wizard-home/music-hub'))).expanduser()
DB_PATH = DATA_DIR/'hub.sqlite3'
AUDIO_DIR = DATA_DIR/'identify/audio'
EXPORT_DIR = DATA_DIR/'identify/exports'
FFMPEG = os.environ.get('FFMPEG','/usr/bin/ffmpeg')
FFPROBE = os.environ.get('FFPROBE','/usr/bin/ffprobe')
MAX_UPLOAD_BYTES = int(os.environ.get('TRACKHUNT_MAX_UPLOAD_BYTES', str(15*1024*1024)))
SHAZAM_TIMEOUT = int(os.environ.get('TRACKHUNT_SHAZAM_TIMEOUT','35'))
UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
DB_LOCK = threading.RLock()
JOBS: queue.Queue[str] = queue.Queue()
STOP = threading.Event()
_pending = set()
_pending_lock = threading.Lock()
_started = False

def utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00','Z')

def safe_uuid(v: str | None) -> str:
    t = (v or '').strip().lower() or str(uuid.uuid4())
    if not UUID_RE.match(t):
        raise HTTPException(400, 'capture id must be a UUID')
    return t

def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True); AUDIO_DIR.mkdir(parents=True, exist_ok=True); EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=5, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA journal_mode=WAL')
    con.execute('PRAGMA busy_timeout=5000')
    con.execute('PRAGMA synchronous=FULL')
    return con

def init_db() -> None:
    with DB_LOCK, connect() as con:
        con.executescript('''
CREATE TABLE IF NOT EXISTS captures (
 id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, client_ts TEXT, duration_s REAL, mime TEXT,
 raw_path TEXT NOT NULL, raw_sha256 TEXT, normalized_path TEXT, waveform_path TEXT, export_path TEXT,
 lat REAL, lon REAL, accuracy_m REAL, note TEXT, status TEXT NOT NULL DEFAULT 'uploaded', confirmed_candidate_id INTEGER,
 last_error TEXT, retention_state TEXT NOT NULL DEFAULT 'active', archived_at TEXT, audio_deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
 id INTEGER PRIMARY KEY AUTOINCREMENT, capture_id TEXT NOT NULL, provider TEXT NOT NULL, segment_start_s REAL, segment_end_s REAL,
 preprocess TEXT, created_at TEXT NOT NULL, outcome TEXT NOT NULL, matched_title TEXT, matched_artist TEXT, confidence REAL,
 raw_response_json TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS candidates (
 id INTEGER PRIMARY KEY AUTOINCREMENT, capture_id TEXT NOT NULL, title TEXT NOT NULL, artist TEXT, source TEXT, provider TEXT,
 source_url TEXT, preview_url TEXT, artwork_url TEXT, confidence REAL, isrc TEXT, added_at TEXT NOT NULL, verdict TEXT,
 verdict_note TEXT, raw_json TEXT, UNIQUE(capture_id,title,artist,provider)
);
CREATE INDEX IF NOT EXISTS idx_captures_created ON captures(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_capture ON attempts(capture_id,created_at);
CREATE INDEX IF NOT EXISTS idx_candidates_capture ON candidates(capture_id,added_at);
''')

def rowdict(r):
    return None if r is None else {k:r[k] for k in r.keys()}

def ext_for_mime(m: str) -> str:
    m=(m or '').split(';',1)[0].strip().lower()
    return {'audio/webm':'.webm','video/webm':'.webm','audio/mp4':'.m4a','audio/x-m4a':'.m4a','audio/aac':'.m4a','audio/mpeg':'.mp3','audio/mp3':'.mp3','audio/wav':'.wav','audio/x-wav':'.wav'}.get(m, mimetypes.guess_extension(m) or '.bin')

def capdir(cid: str) -> Path:
    cid=safe_uuid(cid); p=AUDIO_DIR/cid; p.mkdir(parents=True, exist_ok=True); return p

def run(cmd: list[str], timeout: int=60) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)

def update_capture(cid: str, **fields: Any) -> None:
    if not fields: return
    fields['updated_at']=utcnow()
    cols=', '.join(f'{k}=?' for k in fields)
    with DB_LOCK, connect() as con:
        con.execute(f'UPDATE captures SET {cols} WHERE id=?', list(fields.values())+[cid])

def insert_attempt(cid: str, provider: str, outcome: str, **kw: Any) -> None:
    raw=kw.get('raw'); raw_json=json.dumps(raw, ensure_ascii=False) if raw is not None else None
    with DB_LOCK, connect() as con:
        con.execute('''INSERT INTO attempts(capture_id,provider,segment_start_s,segment_end_s,preprocess,created_at,outcome,matched_title,matched_artist,confidence,raw_response_json,error)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)''',
                    (cid,provider,kw.get('start'),kw.get('end'),kw.get('preprocess'),utcnow(),outcome,kw.get('title'),kw.get('artist'),kw.get('confidence'),raw_json,kw.get('error')))

def add_candidate(cid: str, cand: dict[str,Any]) -> int | None:
    title=(cand.get('title') or '').strip(); artist=(cand.get('artist') or '').strip()
    if not title: return None
    raw_json=json.dumps(cand.get('raw') if cand.get('raw') is not None else cand, ensure_ascii=False)
    with DB_LOCK, connect() as con:
        cur=con.execute('''INSERT OR IGNORE INTO candidates(capture_id,title,artist,source,provider,source_url,preview_url,artwork_url,confidence,isrc,added_at,raw_json)
                           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)''',
                        (cid,title,artist,cand.get('source'),cand.get('provider'),cand.get('source_url'),cand.get('preview_url'),cand.get('artwork_url'),cand.get('confidence'),cand.get('isrc'),utcnow(),raw_json))
        if cur.rowcount: return int(cur.lastrowid)
        r=con.execute('SELECT id FROM candidates WHERE capture_id=? AND title=? AND COALESCE(artist,"")=COALESCE(?,"") AND COALESCE(provider,"")=COALESCE(?,"")',(cid,title,artist,cand.get('provider'))).fetchone()
        return int(r['id']) if r else None

def itunes_norm(x: dict[str,Any], provider='itunes') -> dict[str,Any]:
    return {'title':x.get('trackName') or x.get('collectionName') or '', 'artist':x.get('artistName') or '', 'source':provider, 'provider':provider,
            'source_url':x.get('trackViewUrl') or x.get('collectionViewUrl'), 'preview_url':x.get('previewUrl'),
            'artwork_url':(x.get('artworkUrl100') or '').replace('100x100bb','600x600bb') if x.get('artworkUrl100') else None,
            'confidence':x.get('confidence'), 'isrc':x.get('isrc'), 'raw':x}

def itunes_search(q: str, limit: int=8) -> list[dict[str,Any]]:
    params=urllib.parse.urlencode({'term':q,'media':'music','entity':'song','limit':str(limit)})
    req=urllib.request.Request('https://itunes.apple.com/search?'+params, headers={'User-Agent':'TrackHunt/0.1'})
    with urllib.request.urlopen(req, timeout=12) as resp:
        data=json.loads(resp.read().decode('utf-8','replace'))
    return [itunes_norm(x) for x in data.get('results',[])]

def enrich(title: str, artist: str | None) -> dict[str,Any]:
    try:
        r=itunes_search(f'{title} {artist or ""}'.strip(),1)
        if r:
            r[0].update({'title':title,'artist':artist or '', 'source':'recognizer+itunes'})
            return r[0]
    except Exception:
        pass
    return {'title':title,'artist':artist or '', 'provider':'recognizer','source':'recognizer'}

def ffprobe_duration(path: Path) -> float:
    p=run([FFPROBE,'-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(path)],20)
    if p.returncode: raise RuntimeError(p.stderr.strip() or 'ffprobe failed')
    try: return max(0.0,float(p.stdout.strip()))
    except Exception: return 0.0

def waveform(wav: Path, out: Path, points=120) -> None:
    import wave, struct, math
    peaks=[]
    try:
        with wave.open(str(wav),'rb') as wf:
            frames=wf.getnframes(); width=wf.getsampwidth(); chunk=max(1,frames//points)
            for _ in range(points):
                data=wf.readframes(chunk)
                peaks.append(0 if not data else min(1.0, math.sqrt(sum(x*x for x in struct.unpack('<'+'h'*(len(data)//2),data))/max(1,len(data)//2))/float(2**(8*width-1))*4.0))
    except Exception:
        peaks=[]
    out.write_text(json.dumps({'peaks':peaks,'points':len(peaks)}, separators=(',',':')))

def shazam_lookup(seg: Path) -> dict[str,Any]:
    py=Path(sys.executable); helper=APP_ROOT/'recognizers/shazam_lookup.py'
    if not py.exists(): return {'ok':False,'error':'shazamio venv missing; run setup'}
    try:
        p=subprocess.run([str(py),str(helper),str(seg)], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=SHAZAM_TIMEOUT)
    except subprocess.TimeoutExpired:
        return {'ok':False,'error':'shazamio timed out'}
    if p.returncode: return {'ok':False,'error':(p.stderr or p.stdout or f'exit {p.returncode}')[-4000:]}
    try: return {'ok':True,'raw':json.loads(p.stdout or '{}')}
    except Exception as e: return {'ok':False,'error':f'invalid shazam json: {e}','raw':p.stdout[-4000:]}

def parse_shazam(raw: dict[str,Any]) -> list[dict[str,Any]]:
    tr=raw.get('track') if isinstance(raw,dict) else None
    if not isinstance(tr,dict) or not tr.get('title'): return []
    share=tr.get('share') if isinstance(tr.get('share'),dict) else {}; images=tr.get('images') if isinstance(tr.get('images'),dict) else {}
    conf=None; matches=raw.get('matches') or []
    if isinstance(matches,list) and matches:
        try: conf=float(matches[0].get('freqskew') or 0)
        except Exception: pass
    return [{'title':tr.get('title'),'artist':tr.get('subtitle') or '', 'provider':'shazam','source':'shazamio','source_url':share.get('href'),'artwork_url':images.get('coverarthq') or images.get('coverart'),'confidence':conf,'raw':raw}]

def audd_lookup(seg):
    # Paid providers remain explicitly disabled in the public default.
    return {'ok':False,'not_configured':True,'error':'AudD disabled; paid provider requires separate setup'}

def parse_audd(raw: dict[str,Any]) -> list[dict[str,Any]]:
    if raw.get('status')!='success' or not raw.get('result'): return []
    r=raw.get('result') or {}; apple=r.get('apple_music') if isinstance(r.get('apple_music'),dict) else {}; spotify=r.get('spotify') if isinstance(r.get('spotify'),dict) else {}
    art=None; prev=None
    if isinstance(apple.get('artwork'),dict) and apple['artwork'].get('url'): art=apple['artwork']['url'].replace('{w}','600').replace('{h}','600')
    if isinstance(apple.get('previews'),list) and apple.get('previews'): prev=apple['previews'][0].get('url')
    return [{'title':r.get('title') or '', 'artist':r.get('artist') or '', 'provider':'audd','source':'audd','source_url':apple.get('url') or spotify.get('external_urls',{}).get('spotify'), 'preview_url':prev, 'artwork_url':art, 'confidence':None, 'raw':raw}]

def prepare(cid: str, raw: Path) -> tuple[Path,float]:
    out=capdir(cid); wav=out/'normalized.wav'; mp3=out/'normalized.mp3'
    p=run([FFMPEG,'-hide_banner','-loglevel','error','-y','-i',str(raw),'-vn','-ac','1','-ar','44100','-af','highpass=f=90,dynaudnorm=f=150:g=11,loudnorm=I=-16:TP=-1.5:LRA=11',str(wav)],90)
    if p.returncode: raise RuntimeError(p.stderr.strip() or 'ffmpeg normalize failed')
    p=run([FFMPEG,'-hide_banner','-loglevel','error','-y','-i',str(wav),'-codec:a','libmp3lame','-q:a','3',str(mp3)],60)
    if p.returncode: raise RuntimeError(p.stderr.strip() or 'ffmpeg mp3 failed')
    dur=ffprobe_duration(wav); wave=out/'waveform.json'; waveform(wav,wave); update_capture(cid, normalized_path=str(mp3), waveform_path=str(wave), duration_s=dur)
    return mp3,dur

def offsets(dur: float) -> list[float]:
    starts=[0.0]
    if dur>14: starts.append(max(0.0,min(6.0,dur-12.0)))
    if dur>22: starts.append(max(0.0,dur-16.0))
    out=[]
    for s in starts:
        s=round(float(s),2)
        if all(abs(s-x)>1 for x in out): out.append(s)
    return out[:4]

def recognize(cid: str) -> None:
    with connect() as con: row=con.execute('SELECT * FROM captures WHERE id=?',(cid,)).fetchone()
    if not row: return
    raw=Path(row['raw_path'])
    if not raw.exists(): update_capture(cid,status='error',last_error='raw audio missing'); return
    update_capture(cid,status='hunting',last_error=None); errors=0; nomatch=0
    try:
        mp3,dur=prepare(cid,raw); starts=offsets(dur)
        for start in starts:
            seg=capdir(cid)/f'seg_{int(start*1000)}.mp3'; seglen=min(16.0,max(4.0,dur-start)) if dur else 16.0
            p=run([FFMPEG,'-hide_banner','-loglevel','error','-y','-ss',str(start),'-t',str(seglen),'-i',str(mp3),'-codec:a','libmp3lame','-q:a','3',str(seg)],60)
            if p.returncode: insert_attempt(cid,'ffmpeg','error',start=start,end=start+seglen,preprocess='window',error=p.stderr.strip()); errors+=1; continue
            sres=shazam_lookup(seg)
            if not sres.get('ok'):
                insert_attempt(cid,'shazamio','error',start=start,end=start+seglen,preprocess='normalized-window',raw=sres,error=sres.get('error')); errors+=1
            else:
                leads=parse_shazam(sres.get('raw') or {})
                if leads:
                    for lead in leads:
                        insert_attempt(cid,'shazamio','match',start=start,end=start+seglen,preprocess='normalized-window',title=lead.get('title'),artist=lead.get('artist'),confidence=lead.get('confidence'),raw=sres.get('raw'))
                        c=enrich(lead.get('title'),lead.get('artist')); c.update({k:v for k,v in lead.items() if v and k!='raw'}); add_candidate(cid,c)
                else:
                    insert_attempt(cid,'shazamio','no_match',start=start,end=start+seglen,preprocess='normalized-window',raw=sres.get('raw')); nomatch+=1
            time.sleep(1.2)
            ares=audd_lookup(seg)
            if ares.get('not_configured'):
                if start==starts[0]: insert_attempt(cid,'audd','not_configured',raw={'configured':False},error='AUDD_API_TOKEN not set')
            elif not ares.get('ok'):
                insert_attempt(cid,'audd','error',start=start,end=start+seglen,preprocess='normalized-window',raw=ares,error=ares.get('error')); errors+=1
            else:
                leads=parse_audd(ares.get('raw') or {})
                if leads:
                    for lead in leads:
                        insert_attempt(cid,'audd','match',start=start,end=start+seglen,preprocess='normalized-window',title=lead.get('title'),artist=lead.get('artist'),confidence=lead.get('confidence'),raw=ares.get('raw')); add_candidate(cid,lead)
                else:
                    insert_attempt(cid,'audd','no_match',start=start,end=start+seglen,preprocess='normalized-window',raw=ares.get('raw')); nomatch+=1
        with connect() as con:
            has_lead = con.execute('SELECT 1 FROM candidates WHERE capture_id=? LIMIT 1', (cid,)).fetchone()
        if not has_lead:
            seg = capdir(cid)/'filtered.mp3'
            p = run([FFMPEG,'-hide_banner','-loglevel','error','-y','-t','16','-i',str(mp3),'-af','highpass=f=180,lowpass=f=6000','-codec:a','libmp3lame',str(seg)],60)
            if p.returncode == 0:
                result = shazam_lookup(seg)
                leads = parse_shazam(result.get('raw') or {}) if result.get('ok') else []
                insert_attempt(cid,'shazamio','match' if leads else 'no_match' if result.get('ok') else 'error',
                    start=0,end=min(16,dur),preprocess='filtered-window',raw=result.get('raw'),error=result.get('error'))
                for lead in leads: add_candidate(cid,lead)
                if result.get('ok'): nomatch += not bool(leads)
                else: errors += 1
        insert_attempt(cid,'acrcloud','not_configured',raw={'configured':False},error='ACRCloud deferred; set credentials after signup')
        with connect() as con: cnt=con.execute('SELECT COUNT(*) n FROM candidates WHERE capture_id=?',(cid,)).fetchone()['n']
        if cnt: update_capture(cid,status='has_leads',last_error=None)
        elif errors and not nomatch: update_capture(cid,status='error',last_error='recognition providers errored; audio is saved')
        else: update_capture(cid,status='no_match',last_error=None)
    except Exception as e:
        insert_attempt(cid,'pipeline','error',error=str(e)); update_capture(cid,status='error',last_error=str(e))

def worker_loop() -> None:
    while not STOP.is_set():
        try: cid=JOBS.get(timeout=.5)
        except queue.Empty: continue
        try: recognize(cid)
        finally:
            with _pending_lock: _pending.discard(cid)
            JOBS.task_done()

def enqueue(cid: str) -> None:
    cid = safe_uuid(cid)
    with _pending_lock:
        if cid in _pending: return False
        _pending.add(cid)
        update_capture(cid, status='pending', last_error=None)
        JOBS.put_nowait(cid)
        return True

def get_capture(cid: str) -> dict[str,Any] | None:
    cid=safe_uuid(cid)
    with connect() as con:
        cap=rowdict(con.execute('SELECT * FROM captures WHERE id=?',(cid,)).fetchone())
        if not cap: return None
        cap['attempts']=[rowdict(r) for r in con.execute('SELECT * FROM attempts WHERE capture_id=? ORDER BY id',(cid,)).fetchall()]
        cap['candidates']=[rowdict(r) for r in con.execute('SELECT * FROM candidates WHERE capture_id=? ORDER BY COALESCE(confidence,0) DESC,id',(cid,)).fetchall()]
    for a in cap['attempts']:
        if a.get('raw_response_json'):
            try: a['raw_response_json']=json.loads(a['raw_response_json'])
            except Exception: pass
    for c in cap['candidates']:
        if c.get('raw_json'):
            try: c['raw_json']=json.loads(c['raw_json'])
            except Exception: pass
    return cap

def list_captures() -> list[dict[str,Any]]:
    with connect() as con:
        rows=con.execute('''SELECT c.*, (SELECT COUNT(*) FROM candidates ca WHERE ca.capture_id=c.id) candidate_count, (SELECT title FROM candidates ca WHERE ca.capture_id=c.id AND COALESCE(verdict,'')!='rejected' ORDER BY CASE WHEN verdict='confirmed' THEN 0 ELSE 1 END, COALESCE(confidence,0) DESC,id LIMIT 1) best_title, (SELECT artist FROM candidates ca WHERE ca.capture_id=c.id AND COALESCE(verdict,'')!='rejected' ORDER BY CASE WHEN verdict='confirmed' THEN 0 ELSE 1 END, COALESCE(confidence,0) DESC,id LIMIT 1) best_artist, (SELECT COUNT(*) FROM attempts at WHERE at.capture_id=c.id) attempt_count FROM captures c ORDER BY created_at DESC LIMIT 300''').fetchall()
    return [rowdict(r) for r in rows]

def retention_dry_run(days_archive=60, days_delete_after_archive=30, size_cap_mb=2048):
    now=dt.datetime.now(dt.timezone.utc); acut=now-dt.timedelta(days=days_archive); dcut=now-dt.timedelta(days=days_archive+days_delete_after_archive)
    to_archive=[]; to_delete=[]; size=0
    with connect() as con: rows=con.execute('SELECT * FROM captures ORDER BY created_at ASC').fetchall()
    for r in rows:
        d=rowdict(r)
        for fld in ['raw_path','normalized_path','export_path']:
            p=d.get(fld)
            if p and Path(p).exists(): size += Path(p).stat().st_size
        try: created=dt.datetime.fromisoformat((d.get('created_at') or '').replace('Z','+00:00'))
        except Exception: continue
        if d.get('status') in ('resolved','identified') and d.get('retention_state')=='active' and created<acut: to_archive.append(d['id'])
        if d.get('retention_state')=='archived' and created<dcut: to_delete.append(d['id'])
    return {'archive_after_days':days_archive,'delete_audio_after_archive_days':days_delete_after_archive,'size_cap_mb':size_cap_mb,'current_audio_mb':round(size/1024/1024,2),'would_archive':to_archive,'would_delete_audio':to_delete,'policy':'unresolved/no_match/error captures are never auto-deleted'}

def ensure_export(cid: str, cap: dict[str,Any]) -> Path:
    p=Path(cap.get('export_path') or '') if cap.get('export_path') else EXPORT_DIR/f'{cid}.mp3'
    if p.exists(): return p
    src=Path(cap.get('normalized_path') or cap['raw_path'])
    proc=run([FFMPEG,'-hide_banner','-loglevel','error','-y','-i',str(src),'-vn','-t','30','-af','loudnorm=I=-16:TP=-1.5:LRA=11','-codec:a','libmp3lame','-q:a','3',str(p)],60)
    if proc.returncode: raise HTTPException(500, proc.stderr.strip() or 'export failed')
    update_capture(cid, export_path=str(p)); return p



def start():
    global _started
    if _started: return
    init_db()
    _started = True
    threading.Thread(target=worker_loop, name='music-identify', daemon=True).start()
    with connect() as con:
        rows = con.execute("SELECT id FROM captures WHERE status IN ('uploaded','pending','hunting')").fetchall()
    for row in rows: enqueue(row['id'])


def accept(cid, audio, mime, meta):
    cid = safe_uuid(cid)
    if not 0 < len(audio) <= MAX_UPLOAD_BYTES: raise HTTPException(413, 'Empty or oversized clip')
    if mime.split(';')[0] not in {'audio/webm','video/webm','audio/mp4','audio/x-m4a','audio/aac','audio/mpeg','audio/wav','audio/x-wav','audio/ogg'}:
        raise HTTPException(415, 'Unsupported audio type')
    digest = hashlib.sha256(audio).hexdigest()
    with DB_LOCK, connect() as con:
        row = con.execute('SELECT raw_sha256 FROM captures WHERE id=?', (cid,)).fetchone()
        if row:
            if row[0] != digest: raise HTTPException(409, 'Capture id already holds a different clip')
            return get_capture(cid)  # Response loss is a read, never another recognition job.
        raw = capdir(cid)/('original'+ext_for_mime(mime))
        tmp = raw.with_suffix(raw.suffix+'.part')
        with tmp.open('wb') as f:
            f.write(audio); f.flush(); os.fsync(f.fileno())
        tmp.replace(raw)
        fd = os.open(str(raw.parent),os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
        con.execute('INSERT INTO captures(id,created_at,updated_at,client_ts,mime,raw_path,raw_sha256,note,status,lat,lon,accuracy_m) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                    (cid,utcnow(),utcnow(),str(meta.get('client_ts') or '')[:80],mime,str(raw),digest,str(meta.get('note') or '')[:2000],'uploaded',meta.get('lat'),meta.get('lon'),meta.get('accuracy_m')))
    enqueue(cid)
    return get_capture(cid)


def audio_path(cid, kind='normalized'):
    cap = get_capture(cid)
    if not cap: raise LookupError('Unknown hunt')
    field = {'original':'raw_path','normalized':'normalized_path','export':'export_path','waveform':'waveform_path'}.get(kind)
    if not field: raise ValueError('Invalid audio kind')
    p = Path(cap.get(field) or (cap.get('normalized_path') if kind=='export' else None) or cap['raw_path']).resolve()
    if not p.is_file() or AUDIO_DIR.resolve() not in p.parents:
        raise LookupError('Audio is not available')
    return p


def public_capture(cap):
    if not cap: raise LookupError('Unknown hunt')
    out = {k:v for k,v in cap.items() if not k.endswith('_path')}
    cid = out['id']
    out['audio_url'] = f'/wizard/music/api/identify/captures/{cid}/audio'
    out['original_url'] = out['audio_url']+'?kind=original'
    out['export_url'] = out['audio_url']+'?kind=export'
    for c in out.get('candidates',[]):
        c['art_url'] = f"/wizard/music/api/identify/candidates/{c['id']}/media?kind=art" if c.get('artwork_url') else None
        c['compare_url'] = f"/wizard/music/api/identify/candidates/{c['id']}/media?kind=preview" if c.get('preview_url') else None
    return out


def verdict(candidate_id, body, hub):
    value = body.get('verdict')
    if value not in {'confirmed','rejected',None}: raise ValueError('Invalid verdict')
    with connect() as con:
        row = con.execute('SELECT * FROM candidates WHERE id=?',(candidate_id,)).fetchone()
    if not row: raise LookupError('Unknown candidate')
    cap = get_capture(row['capture_id'])
    t = None
    if value == 'confirmed':
        t = resolve_candidate(candidate_id, hub)
        # One SQLite transaction: a response loss/restart cannot duplicate the request/like.
        with hub._db_lock, hub._db as con:
            previous = con.execute('SELECT verdict FROM candidates WHERE id=?',(candidate_id,)).fetchone()
            if previous[0] != 'confirmed':
                con.execute('INSERT OR REPLACE INTO likes VALUES(?,?,?)',(t['id'],1,time.time()))
                con.execute('INSERT INTO feedback_log VALUES(?,?,?)',(t['id'],time.time(),'like'))
                con.execute('INSERT INTO requests VALUES(?,?,?)',(t['id'],time.time(),'identify'))
                con.execute("UPDATE candidates SET verdict=NULL WHERE capture_id=? AND verdict='confirmed'",(row['capture_id'],))
            con.execute('UPDATE candidates SET verdict=?,verdict_note=? WHERE id=?',(value,str(body.get('verdict_note') or '')[:1000],candidate_id))
            con.execute("UPDATE captures SET status='resolved',confirmed_candidate_id=?,updated_at=? WHERE id=?",(candidate_id,utcnow(),row['capture_id']))
        hub.taste_changed(); hub._collections_cache['at'] = 0
        hub.queue_info(t['id']); hub.queue_styles_for(t['id'])
    else:
        with DB_LOCK, connect() as con:
            con.execute('UPDATE candidates SET verdict=?,verdict_note=? WHERE id=?',(value,str(body.get('verdict_note') or '')[:1000],candidate_id))
            if cap.get('confirmed_candidate_id') == candidate_id:
                con.execute("UPDATE captures SET status='has_leads',confirmed_candidate_id=NULL WHERE id=?",(row['capture_id'],))
    return {'ok':True, 'capture':public_capture(get_capture(row['capture_id'])), 'track':hub.track(t['id']) if t else None}


def resolve_candidate(candidate_id, hub):
    with connect() as con: row = con.execute('SELECT * FROM candidates WHERE id=?',(candidate_id,)).fetchone()
    if not row: raise LookupError('Unknown candidate')
    t = None
    raw = json.loads(row['raw_json'] or '{}')
    if raw.get('music_track_id'): t = hub.track(raw['music_track_id'])
    if not t:
        results = hub.search(f"{row['title']} {row['artist'] or ''}")
        if not results: raise LookupError('No playable Music track found. Add the correct one manually.')
        # Do not silently pick an unrelated result.
        def match(t):
            return hub.heard_like(row['title'],t['title']) + hub.heard_like(row['artist'] or '',t['artist'])
        t = max(results,key=match)
        if hub.heard_like(row['title'],t['title']) < .7 or (row['artist'] and hub.heard_like(row['artist'],t['artist']) < .6):
            raise LookupError('Could not resolve this candidate to a confident playable track. Search manually.')
    return hub.prefer_library(t)


def download(candidate_id, hub):
    t = resolve_candidate(candidate_id,hub)
    p = hub.audio_path(t['id'])
    if t['source'] == 'library': return {'ok':True,'track':t}
    # Same cached full-song audio as Music playback; no second downloader/provider.
    folder = hub.LIBRARY/'Identified'
    folder.mkdir(parents=True,exist_ok=True)
    name = re.sub(r'[^\w .-]','_',f"{t['artist']} - {t['title']}")[:130]+'-'+t['id'].split(':')[-1]
    final = folder/(name+p.suffix)
    tmp = final.with_name(final.stem+'.pending'+final.suffix)
    shutil.copyfile(p,tmp)
    try:
        import mutagen
        tag = mutagen.File(tmp,easy=True)
        if tag is not None:
            tag['title']=[t['title']]; tag['artist']=[t['artist']]; tag['album']=[t.get('album') or 'Identified in Music']; tag.save()
    except Exception:
        pass  # Keep the playable full song even when its container cannot carry tags.
    tmp.replace(final)
    hub.scan_library()
    return {'ok':True,'track':hub.track('lib:'+hub._lib_id(final))}


def candidate_media(candidate_id, kind):
    with connect() as con: row = con.execute('SELECT * FROM candidates WHERE id=?',(candidate_id,)).fetchone()
    if not row: raise LookupError('Unknown candidate')
    url = row['artwork_url' if kind=='art' else 'preview_url']
    u = urllib.parse.urlparse(url or '')
    allowed = ('mzstatic.com','shazam.com','itunes.apple.com')
    if u.scheme != 'https' or not any(u.hostname == h or (u.hostname or '').endswith('.'+h) for h in allowed):
        raise LookupError('Media unavailable')
    # Disable redirects to keep the hostname boundary true after connection.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*a,**kw): return None
    with urllib.request.build_opener(NoRedirect).open(urllib.request.Request(url,headers={'User-Agent':'WizardMusic/1'}),timeout=15) as r:
        data = r.read(4_000_001)
        if len(data)>4_000_000: raise ValueError('Media too large')
        return data, 'image/jpeg' if kind=='art' else 'audio/mp4'


def handle(handler, path, qs, hub, body=None):
    """Return True only for identify routes; hub auth has already run."""
    if not path.startswith('/api/identify/'): return False
    sub = path[len('/api/identify/'):].strip('/')
    method = handler.command
    try:
        if method in {'GET','HEAD'}:
            if sub == 'captures': handler._json(200,{'captures':[public_capture(c) for c in list_captures()]})
            elif sub == 'search': handler._json(200,{'candidates':itunes_search(str(qs.get('q',[''])[0])[:200])})
            elif sub == 'retention/dry-run': handler._json(200,retention_dry_run())
            elif re.fullmatch(r'captures/[a-f0-9-]{36}',sub): handler._json(200,public_capture(get_capture(sub.split('/')[1])))
            elif re.fullmatch(r'captures/[a-f0-9-]{36}/audio',sub): handler._stream_file(audio_path(sub.split('/')[1],qs.get('kind',['normalized'])[0]))
            elif re.fullmatch(r'candidates/[0-9]+/media',sub):
                data,ctype = candidate_media(int(sub.split('/')[1]),qs.get('kind',['art'])[0])
                handler.send_response(200); handler.send_header('Content-Type',ctype); handler.send_header('Content-Length',str(len(data))); handler.end_headers()
                if method != 'HEAD': handler.wfile.write(data)
            else: handler._json(404,{'error':'Unknown identify route'})
        elif method == 'POST':
            if sub == 'captures':
                n = int(handler.headers.get('Content-Length') or 0)
                if not 0<n<=MAX_UPLOAD_BYTES: raise HTTPException(413,'Empty or oversized clip')
                raw = handler.rfile.read(n)
                if len(raw)!=n: raise ValueError('Incomplete upload')
                cid = qs.get('id',[''])[0]
                meta = {k:qs[k][0] for k in ('client_ts','note') if qs.get(k)}
                for k in ('lat','lon','accuracy_m'):
                    if qs.get(k): meta[k]=float(qs[k][0])
                handler._json(200,public_capture(accept(cid,raw,handler.headers.get('Content-Type','audio/webm'),meta)))
            elif re.fullmatch(r'captures/[a-f0-9-]{36}/retry',sub):
                cid = sub.split('/')[1]
                if not get_capture(cid): raise LookupError('Unknown hunt')
                enqueue(cid); handler._json(200,public_capture(get_capture(cid)))
            elif re.fullmatch(r'captures/[a-f0-9-]{36}/candidates',sub):
                cid=sub.split('/')[1]
                if not get_capture(cid): raise LookupError('Unknown hunt')
                c = dict(body or {}); c.update(provider='manual',source='manual')
                if not c.get('title'): raise ValueError('Title required')
                add_candidate(cid,c); update_capture(cid,status='has_leads')
                handler._json(200,public_capture(get_capture(cid)))
            elif re.fullmatch(r'candidates/[0-9]+/(verdict|resolve|download)',sub):
                cid=int(sub.split('/')[1]); action=sub.split('/')[2]
                handler._json(200,verdict(cid,body or {},hub) if action=='verdict' else download(cid,hub) if action=='download' else {'track':resolve_candidate(cid,hub)})
            else: handler._json(404,{'error':'Unknown identify route'})
        else: handler._json(405,{'error':'Method not allowed'})
    except HTTPException as e: handler._json(e.status_code,{'error':str(e)})
    except LookupError as e: handler._json(404,{'error':str(e)})
    except ValueError as e: handler._json(400,{'error':str(e)})
    return True
