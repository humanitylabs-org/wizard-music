#!/usr/bin/env python3
"""Wizard Music hub: one library across sources, served to Wizard.

Runs on Wizard Home (Mac mini). Sources:
  - online: music-source connector apps (YouTube Music first), found automatically like Money finds bank connectors
  - library: owner MP3/M4A/FLAC files under WIZARD_MUSIC_LIBRARY

Wizard's server proxies /wizard/music/* here over a loopback SSH tunnel and adds
an owner bearer token. Nothing here is exposed on a public or tailnet interface.
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import random
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
import weakref
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # identify.py lives beside the hub, however it is loaded
import identify  # noqa: E402
import navidrome  # noqa: E402  (wizard-music#92: Navidrome as the library backend, switch navidrome)

HOST = os.environ.get("WIZARD_MUSIC_HUB_HOST", "127.0.0.1")
PORT = int(os.environ.get("WIZARD_MUSIC_HUB_PORT", "8793"))
TOKEN = os.environ.get("WIZARD_MUSIC_HUB_TOKEN", "")
ONLINE = os.environ.get("WIZARD_MUSIC_ONLINE", "0") == "1"
# Anonymous YouTube Music radio from a Thai IP front-loads ~30 Thai/K-pop chart hits before the
# songs that actually follow the seed (a Gui Boratto radio opened with Thai pop). Radio asks as
# this region instead; a Thai seed still gets Thai radio. Search keeps the default region.
RADIO_LOCATION = os.environ.get("WIZARD_MUSIC_RADIO_LOCATION", "US").strip()
HOME = Path(os.environ.get("WIZARD_MUSIC_HUB_HOME", str(Path.home() / ".wizard-home/music-hub")))
LIBRARY = Path(os.environ.get("WIZARD_MUSIC_LIBRARY", str(Path.home() / "Music/WizardMusic/Library")))
CACHE = Path(os.environ.get("WIZARD_MUSIC_CACHE", str(HOME / "cache")))
CACHE_MAX_BYTES = int(os.environ.get("WIZARD_MUSIC_CACHE_MAX_BYTES", str(3 * 1024**3)))
# A source answering "blocked" (502) is often a blip: ask again after these pauses (seconds) before giving up.
AUDIO_RETRY_DELAYS = tuple(float(x) for x in os.environ.get("WIZARD_MUSIC_AUDIO_RETRY_DELAYS", "2,5").split(",") if x.strip())
PUBLIC_PREFIX = "/wizard/music"
AUDIO_EXT = {".mp3", ".m4a", ".flac", ".ogg", ".opus", ".wav", ".aac"}
ART_HOSTS = re.compile(r"^(?:[a-z0-9-]+\.)*(?:googleusercontent\.com|ytimg\.com|ggpht\.com)$")
YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
LIB_ID = re.compile(r"^[a-f0-9]{20}$")

VIBES = [
    # Each vibe seeds radio from a real, well-loved track: YouTube Music's radio
    # then does what it is good at. Generic text queries surface SEO filler.
    {"id": "focus", "label": "Deep focus", "query": "Tycho Awake"},
    {"id": "late", "label": "Late night", "query": "Bonobo Black Sands"},
    {"id": "house", "label": "Warm house", "query": "Kerri Chandler Rain"},
    {"id": "morning", "label": "Morning lift", "query": "Khruangbin Time (You and I)"},
    {"id": "dub", "label": "Dub techno", "query": "Deepchord Vantage Isle"},
    {"id": "soul", "label": "Neo soul", "query": "Erykah Badu On & On"},
]

HOME.mkdir(parents=True, exist_ok=True)
CACHE.mkdir(parents=True, exist_ok=True)
_db_lock = threading.Lock()
_db = sqlite3.connect(HOME / "hub.sqlite3", check_same_thread=False)
_db.execute("PRAGMA journal_mode=WAL")
_db.executescript(
    """
    CREATE TABLE IF NOT EXISTS tracks (id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
        duration_ms INTEGER, thumb TEXT, source TEXT, path TEXT, updated REAL);
    CREATE TABLE IF NOT EXISTS likes (id TEXT PRIMARY KEY, value INTEGER, at REAL);
    CREATE TABLE IF NOT EXISTS plays (id TEXT, at REAL, action TEXT);
    CREATE TABLE IF NOT EXISTS playback_events (event_id TEXT PRIMARY KEY, id TEXT, action TEXT, at REAL);
    CREATE TABLE IF NOT EXISTS station_batches (request_id TEXT PRIMARY KEY, station_id TEXT, tracks TEXT, at REAL);
    CREATE TABLE IF NOT EXISTS stations (id TEXT PRIMARY KEY, title TEXT, seed TEXT, state TEXT, at REAL);
    -- genre: Apple Music primary genre ('' = looked up, none found; NULL = not looked up yet)
    -- similar: JSON list of artists YouTube Music relates to this track's artists (fetched for thumbs-down)
    CREATE TABLE IF NOT EXISTS track_info (id TEXT PRIMARY KEY, genre TEXT, similar TEXT, at REAL);
    -- tags: JSON {style: weight 0..1} for an artist ({} = looked up, nothing known); source musicbrainz|related
    -- kept: songs you heard all the way through in a session you said was on point (a softer like)
    CREATE TABLE IF NOT EXISTS kept (id TEXT, at REAL, reason TEXT, PRIMARY KEY (id, reason));
    -- requests: you asked for this exact song (tapped it, or named it out loud); how = tap|spoken|backfill
    CREATE TABLE IF NOT EXISTS requests (id TEXT, at REAL, how TEXT);
    -- feedback_log: every like/unlike/dislike ever given (likes keeps only the latest), for reweighting later
    CREATE TABLE IF NOT EXISTS feedback_log (id TEXT, at REAL, action TEXT);
    CREATE TABLE IF NOT EXISTS artist_styles (key TEXT PRIMARY KEY, name TEXT, tags TEXT, source TEXT, at REAL);
    -- mixes: a named set of songs you saved ("tea music"); ids JSON list, aliases JSON list of other spoken names
    CREATE TABLE IF NOT EXISTS mixes (key TEXT PRIMARY KEY, name TEXT, ids TEXT, aliases TEXT, at REAL);
    -- URL bookmarks, not playback-history mixes. Saving never imports or downloads audio.
    CREATE TABLE IF NOT EXISTS saved_playlists (id TEXT PRIMARY KEY, url TEXT NOT NULL,
        kind TEXT NOT NULL, provider_id TEXT NOT NULL, title TEXT NOT NULL,
        author TEXT NOT NULL, author_url TEXT NOT NULL, thumbnail TEXT NOT NULL, created_at REAL NOT NULL);
    -- Wizard-owned playlists of single songs (wizard-music#39): name, description, ordered JSON list of track ids.
    CREATE TABLE IF NOT EXISTS song_playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        ids TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL);
    """
)
_db.commit()

# Per-install, default-off consent. Environment opt-in is retained only for legacy host installs.
SETTINGS = HOME / "settings.json"
try:
    ONLINE = json.loads(SETTINGS.read_text()).get("online") is True
except FileNotFoundError:
    pass
except (ValueError, OSError):
    ONLINE = False
_consent_lock = threading.RLock()
_downloads = set()
_responses = weakref.WeakSet()  # open outbound responses; Online off closes them (issue 91)


def online_settings():
    return {"online": ONLINE}


def require_online():
    if not ONLINE:
        raise LookupError("online sources disabled")


def set_online(value):
    global ONLINE, _ytm, _ytm_radio
    if not isinstance(value, bool):
        raise ValueError("online must be a boolean")
    with _consent_lock:
        tmp = SETTINGS.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as out:
            json.dump({"online": value}, out)
            out.flush()
            os.fsync(out.fileno())
        tmp.replace(SETTINGS)
        ONLINE = value
        if not value:
            for proc in list(_downloads):
                if proc.poll() is None:
                    proc.terminate()
            for resp in list(_responses):
                try:
                    resp.close()
                except Exception:
                    pass
            _responses.clear()
            _ytm = _ytm_radio = None
            # Queued work is discarded; transport guards also cover already-running workers.
            with _info_cv:
                _info_q.clear()
                _info_pending.clear()
    return online_settings()


def online_urlopen(*args, **kwargs):
    # Check consent under the lock, but never hold it across network I/O (issue 91): urlopen
    # waits for response headers (seconds for a song's audio), and every other outbound call
    # (art, search, the next song) queued behind it. Online off closes open responses, and a
    # response whose headers arrive after Online went off is closed here and refused.
    with _consent_lock:
        require_online()
    resp = urllib.request.urlopen(*args, **kwargs)
    with _consent_lock:
        if not ONLINE:
            resp.close()
            raise LookupError("online sources disabled")
        try:
            _responses.add(resp)
        except TypeError:  # a stand-in without weakref support (tests)
            pass
    return resp


identify.online = lambda: ONLINE  # Identify sends audio and song details out only with Online sources on


def db(sql: str, args: tuple = (), many: bool = False):
    with _db_lock:
        cur = _db.execute(sql, args)
        rows = cur.fetchall()
        _db.commit()
        return rows


navidrome.setup(sys.modules[__name__])


# ---------------------------------------------------------------- Saved URL playlists / long mixes
PLAYLIST_FIELDS = ('id', 'url', 'kind', 'providerId', 'title', 'author', 'authorUrl', 'thumbnail', 'createdAt')


def playlist_source(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 2048 or re.search(r'[\s\x00-\x1f\x7f\\]', value):
        raise ValueError('Use a full YouTube video or playlist URL.')
    u = urllib.parse.urlsplit(value)
    if u.scheme != 'https' or u.netloc not in {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'}:
        raise ValueError('Use a full HTTPS YouTube video or playlist URL.')
    q = urllib.parse.parse_qs(u.query)
    if u.netloc == 'youtu.be':
        kind, pid = 'video', u.path[1:]
    elif u.path == '/watch' and len(q.get('v', [])) == 1:
        kind, pid = 'video', q['v'][0]
    elif u.path == '/playlist' and len(q.get('list', [])) == 1:
        kind, pid = 'playlist', q['list'][0]
    else:
        raise ValueError('Use a YouTube video or playlist link, not a channel or search.')
    if not re.fullmatch(r'[A-Za-z0-9_-]{11}' if kind == 'video' else r'[A-Za-z0-9_-]{10,150}', pid):
        raise ValueError('That YouTube link has an invalid ID.')
    return kind, pid, hashlib.sha256((kind + ':' + pid).encode()).hexdigest()[:24]


def saved_playlists():
    return [dict(zip(PLAYLIST_FIELDS, row)) for row in db('SELECT * FROM saved_playlists ORDER BY created_at DESC,id')]


def save_playlist(body):
    if not isinstance(body, dict) or set(body) - {'url', 'title', 'author', 'authorUrl', 'thumbnail'}:
        raise ValueError('Invalid playlist fields.')
    url = body.get('url')
    kind, pid, key = playlist_source(url)
    values = {}
    for field, limit in [('title', 2000), ('author', 300), ('authorUrl', 2048), ('thumbnail', 2048)]:
        value = body.get(field, '')
        if not isinstance(value, str) or len(value) > limit or re.search(r'[\x00-\x1f\x7f]', value):
            raise ValueError('Invalid playlist metadata.')
        values[field] = value
    # Metadata is stored as text only. No arbitrary URL is fetched, and no credentials are used.
    if values['authorUrl']:
        a = urllib.parse.urlsplit(values['authorUrl'])
        if a.scheme != 'https' or a.netloc not in {'www.youtube.com', 'youtube.com'}:
            raise ValueError('Invalid author link.')
    if values['thumbnail'] and values['thumbnail'] != f'https://i.ytimg.com/vi/{pid}/hqdefault.jpg':
        raise ValueError('Invalid thumbnail.')
    title = values['title'] or f"YouTube {'mix' if kind == 'video' else 'playlist'} · {pid}"
    # First exact URL and metadata win. Equivalent URL retries cannot duplicate or overwrite the bookmark.
    db('INSERT OR IGNORE INTO saved_playlists VALUES(?,?,?,?,?,?,?,?,?)',
       (key, url, kind, pid, title, values['author'], values['authorUrl'], values['thumbnail'], time.time()))
    return next(item for item in saved_playlists() if item['id'] == key)


def playlist_track(key):
    """What a tap on a saved row plays, always inside Music (wizard-os#654: never send the owner to YouTube).
    A long mix is one track; a YouTube playlist is its tracks in order, read through the music source."""
    item = next((p for p in saved_playlists() if p['id'] == key), None)
    if not item:
        raise LookupError('Playlist not found.')
    if not ONLINE:
        raise ValueError('Online playback is off. Turn on Online sources in Music, then try again.')
    if item['kind'] != 'video':
        return saved_playlist_tracks(item)
    tid = 'yt:' + item['providerId']
    # Only an explicit Play tap reaches this path. Do not mutate existing track metadata.
    db('INSERT OR IGNORE INTO tracks VALUES(?,?,?,?,?,?,?,?,?)',
       (tid, item['title'], item['author'] or 'YouTube', '', 0,
        item['thumbnail'] or f"https://i.ytimg.com/vi/{item['providerId']}/hqdefault.jpg", 'youtube', '', time.time()))
    prefetch(tid)  # a long mix downloads whole before it plays: start now, not when the player asks
    return [track(tid)]


def saved_playlist_tracks(item):
    pid = urllib.parse.quote(item['providerId'], safe='')
    raw = None
    # Public playlists need no account (connector 0.1.5+). Older connectors, or a private playlist, use the
    # signed-in account library read when it is there.
    for path in (f'/api/music/playlist?id={pid}&limit=200', f'/api/music/library/playlist?id={pid}&limit=100'):
        try:
            raw = _source_get(source_for(), path)
            if raw.get('tracks'):
                break
        except Exception:
            continue
    if raw is None:
        raise ValueError('Music couldn\u2019t load this playlist. Check that the YouTube Music connector is working, then try again.')
    tracks = [t for t in (remember_yt(i) for i in (raw.get('tracks') or [])[:200] if isinstance(i, dict)) if t]
    if not tracks:
        raise ValueError('Music found no playable songs in this playlist. If it is private, connect your YouTube account in YouTube Music.')
    return tracks


# ---------------------------------------------------------------- Song playlists (wizard-music#39)
# Playlists the owner (or his agent) builds from single songs: yt:* and library tracks, in order. Stored only here;
# nothing is written to a YouTube account. On for everyone (the song-playlists switch was removed).
SONG_PLAYLIST_MAX = 500
SONG_ID = re.compile(r'(?:yt|lib):[A-Za-z0-9_-]{1,40}')
SONG_PLAYLIST_ID = re.compile(r'[a-f0-9]{24}')
_song_playlist_lock = threading.Lock()


def _song_text(value, field, limit, required=False):
    if value is None:
        value = ''
    if not isinstance(value, str) or len(value) > limit or re.search(r'[\x00-\x1f\x7f]', value):
        raise ValueError(f'Invalid playlist {field}.')
    value = value.strip()
    if required and not value:
        raise ValueError('Give the playlist a name.')
    return value


def _song_ids(value):
    """Known songs in the given order, without repeats; unknown or malformed ids come back as skipped."""
    if not isinstance(value, list) or len(value) > SONG_PLAYLIST_MAX:
        raise ValueError(f'Track ids must be a list of at most {SONG_PLAYLIST_MAX}.')
    known, skipped = [], []
    for tid in value:
        if not isinstance(tid, str) or not SONG_ID.fullmatch(tid):
            raise ValueError('Track ids look like yt:<id> or lib:<id>.')
        if tid in known:
            continue
        (known if track(tid) else skipped).append(tid)
    return known, skipped


def _song_row(row, with_tracks=False):
    pid, name, description, ids, created, updated = row
    ids = json.loads(ids or '[]')
    out = {'id': pid, 'name': name, 'description': description, 'trackIds': ids, 'count': len(ids),
           'createdAt': created, 'updatedAt': updated}
    if with_tracks:
        out['tracks'] = [t for t in (track(tid) for tid in ids) if t]
    return out


def song_playlists():
    return [_song_row(r) for r in db('SELECT id,name,description,ids,created_at,updated_at FROM song_playlists ORDER BY updated_at DESC,id')]


def song_playlist(pid):
    if not isinstance(pid, str) or not SONG_PLAYLIST_ID.fullmatch(pid):
        raise LookupError('Playlist not found.')
    rows = db('SELECT id,name,description,ids,created_at,updated_at FROM song_playlists WHERE id=?', (pid,))
    if not rows:
        raise LookupError('Playlist not found.')
    return _song_row(rows[0], True)


def create_song_playlist(body):
    if not isinstance(body, dict) or set(body) - {'name', 'description', 'trackIds'}:
        raise ValueError('Invalid playlist fields.')
    name = _song_text(body.get('name'), 'name', 100, True)
    description = _song_text(body.get('description'), 'description', 500)
    ids, skipped = _song_ids(body.get('trackIds', []))
    pid, now = uuid.uuid4().hex[:24], time.time()
    db('INSERT INTO song_playlists VALUES(?,?,?,?,?,?)', (pid, name, description, json.dumps(ids), now, now))
    return {**song_playlist(pid), 'skipped': skipped}


def update_song_playlist(pid, body, action='update'):
    """update: name/description/trackIds (the full new order); add: trackIds [+ position]; remove: trackIds; delete."""
    if not isinstance(body, dict):
        raise ValueError('Invalid playlist fields.')
    allowed = {'update': {'name', 'description', 'trackIds'}, 'add': {'trackIds', 'position'}, 'remove': {'trackIds'}, 'delete': set()}[action]
    if set(body) - allowed:
        raise ValueError('Invalid playlist fields.')
    with _song_playlist_lock:
        current = song_playlist(pid)
        if action == 'delete':
            db('DELETE FROM song_playlists WHERE id=?', (pid,))
            return {'id': pid, 'deleted': True}
        name, description, ids, skipped = current['name'], current['description'], current['trackIds'], []
        if action == 'update':
            if 'name' in body:
                name = _song_text(body['name'], 'name', 100, True)
            if 'description' in body:
                description = _song_text(body['description'], 'description', 500)
            if 'trackIds' in body:
                ids, skipped = _song_ids(body['trackIds'])
        elif action == 'add':
            new, skipped = _song_ids(body.get('trackIds'))
            new = [t for t in new if t not in ids]
            position = body.get('position', len(ids))
            if not isinstance(position, int) or isinstance(position, bool) or position < 0:
                raise ValueError('Invalid position.')
            position = min(position, len(ids))
            ids = ids[:position] + new + ids[position:]
            if len(ids) > SONG_PLAYLIST_MAX:
                raise ValueError(f'A playlist holds at most {SONG_PLAYLIST_MAX} songs.')
        else:
            gone = body.get('trackIds')
            if not isinstance(gone, list) or not all(isinstance(t, str) for t in gone):
                raise ValueError('Track ids must be a list.')
            ids = [t for t in ids if t not in set(gone)]
        db('UPDATE song_playlists SET name=?,description=?,ids=?,updated_at=? WHERE id=?',
           (name, description, json.dumps(ids), time.time(), pid))
    return {**song_playlist(pid), 'skipped': skipped}


# ---------------------------------------------------------------- YouTube Music
_ytm = None
# Music never talks to YouTube itself. Installed music-source connector apps (contract
# wizard.music-source/1) do, the same way Money reads bank-connection apps. Each entry is
# "<app-id>=<loopback or container URL>"; unreachable ones are simply skipped.
SOURCES = [tuple(x.split("=", 1)) for x in os.environ.get(
    "WIZARD_MUSIC_SOURCES", "wizard-youtube-music=http://wizard-youtube-music:9206").split(",") if "=" in x]
_source_status: dict[str, dict] = {}


def _source_get(base: str, path: str, timeout: float = 20):
    with online_urlopen(urllib.request.Request(base.rstrip("/") + path, headers={"Accept": "application/json"}), timeout=timeout) as r:
        return json.loads(r.read(4_000_000))


def sources_status(refresh: bool = False) -> list[dict]:
    """Each connector's own status; a missing connector is reported as not installed."""
    out = []
    for app_id, base in SOURCES:
        cached = _source_status.get(app_id)
        if refresh or not cached or time.time() - cached["at"] > 30:
            try:
                if not ONLINE:
                    raise LookupError("off")
                st = _source_get(base, "/api/status", timeout=4)
                cached = {"at": time.time(), "installed": True, **st}
            except LookupError:
                cached = {"at": time.time(), "installed": None}
            except Exception:
                cached = {"at": time.time(), "installed": False}
            _source_status[app_id] = cached
        out.append({"id": app_id, "base": base, **cached})
    return out


def source_for(tid: str = "") -> str:
    """Base URL of the connector to use (the YouTube connector owns yt: ids)."""
    for s in sources_status():
        if s.get("installed"):
            return s["base"]
    raise RuntimeError("no music source connected")


def account_library(kind="status", playlist="", limit=100):
    """Read-only account library; never conflate connector likes with Wizard taste."""
    if kind not in ("status", "playlists", "likes", "playlist"):
        raise ValueError("Unknown library kind")
    if kind == "playlist" and not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", playlist):
        raise ValueError("Invalid playlist id")
    limit = max(1, min(int(limit), 100))
    result = {"state": "unavailable", "connect": "/wizard-youtube-music/", "limit": limit}
    if not ONLINE:
        return {**result, "state": "off", "error": "Turn on Online sources to browse your YouTube library."}
    source = next((s for s in sources_status(refresh=True) if s["id"] == "wizard-youtube-music"), None)
    if not source or not source.get("installed"):
        return {**result, "error": "YouTube Music connector is unavailable. Open it to check the connection."}
    if not {"playlists", "likes", "playlist"}.issubset(set((source.get("capabilities") or {}).get("library", []))):
        return {**result, "state": "unsupported", "error": "Update the YouTube Music connector to browse your account library."}
    state = (source.get("account_status") or {}).get("state", "signed_out")
    result["state"] = state
    if state != "connected":
        return {**result, "error": "Connect and verify your YouTube account to browse playlists and liked songs."}
    if kind == "status":
        return result
    query = urllib.parse.urlencode({"id": playlist, "limit": limit})
    try:
        raw = _source_get(source["base"], f"/api/music/library/{kind}?{query}")
        if kind == "playlists":
            playlists = [{"id": p["playlistId"], "title": p.get("title") or "Untitled playlist", "count": p.get("count")}
                         for p in raw["playlists"][:limit]
                         if re.fullmatch(r"[A-Za-z0-9_-]{1,160}", str(p.get("playlistId", "")))]
            return {**result, "playlists": playlists}
        tracks = [t for t in (remember_yt(item) for item in raw["tracks"][:limit]) if t]
        return {**result, "tracks": tracks}
    except Exception:
        _source_status.clear()
        return {**result, "state": "unavailable", "error": "Account library unavailable. Open YouTube Music to verify your connection, then retry."}


class _Connector:
    """Small client with the method names the radio/search code already uses."""

    def search(self, q, filter="songs", limit=20):
        qs = urllib.parse.urlencode({"q": q, "kind": filter, "limit": limit})
        return _source_get(source_for(), f"/api/music/search?{qs}").get("tracks", [])

    def get_watch_playlist(self, vid, radio=True, limit=60):
        qs = urllib.parse.urlencode({"seed": vid, "limit": limit})
        return {"tracks": _source_get(source_for(), f"/api/music/radio?{qs}").get("tracks", [])}


_connector = _Connector()


def ytm():
    if not ONLINE:
        raise RuntimeError("Online sources disabled")
    return _connector


def ytm_radio():
    return ytm()


def _secs(text) -> int:
    if not text:
        return 0
    parts = [int(p) for p in str(text).split(":") if p.isdigit()]
    total = 0
    for p in parts:
        total = total * 60 + p
    return total


def _best_thumb(thumbs) -> str:
    if not thumbs:
        return ""
    url = sorted(thumbs, key=lambda t: t.get("width", 0))[-1].get("url", "")
    # googleusercontent art can be requested at a larger square size
    return re.sub(r"=w\d+-h\d+", "=w544-h544", url)


def remember_yt(item: dict) -> dict | None:
    vid = item.get("videoId")
    if not vid or not YT_ID.match(vid):
        return None
    artists = item.get("artists") or []
    artist = ", ".join(a.get("name", "") for a in artists if a.get("name")) or item.get("author", "") or ""
    album = (item.get("album") or {}).get("name", "") if isinstance(item.get("album"), dict) else ""
    duration = item.get("duration_seconds") or _secs(item.get("length") or item.get("duration"))
    thumb = _best_thumb(item.get("thumbnails") or item.get("thumbnail") or [])
    tid = f"yt:{vid}"
    db(
        "INSERT INTO tracks(id,title,artist,album,duration_ms,thumb,source,path,updated) VALUES(?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET title=excluded.title, artist=excluded.artist, album=COALESCE(NULLIF(excluded.album,''),album), "
        "duration_ms=COALESCE(NULLIF(excluded.duration_ms,0),duration_ms), thumb=COALESCE(NULLIF(excluded.thumb,''),thumb), updated=excluded.updated",
        (tid, item.get("title") or "Untitled", artist, album, int(duration) * 1000, thumb, "youtube", "", time.time()),
    )
    return track(tid)


# ---------------------------------------------------------------- Library
def _lib_id(path: Path) -> str:
    return hashlib.sha256(str(path.relative_to(LIBRARY)).encode()).hexdigest()[:20]


def scan_library() -> int:
    if not LIBRARY.exists():
        return 0
    try:
        from tinytag import TinyTag
    except Exception:  # pragma: no cover
        TinyTag = None
    seen = set()
    for path in LIBRARY.rglob("*"):
        if path.suffix.lower() not in AUDIO_EXT or not path.is_file():
            continue
        tid = f"lib:{_lib_id(path)}"
        seen.add(tid)
        title, artist, album, dur = path.stem, "", path.parent.name if path.parent != LIBRARY else "", 0
        if TinyTag:
            try:
                meta = TinyTag.get(path)
                title = meta.title or title
                artist = meta.artist or ""
                album = meta.album or album
                dur = int((meta.duration or 0) * 1000)
            except Exception:
                pass
        db(
            "INSERT OR REPLACE INTO tracks(id,title,artist,album,duration_ms,thumb,source,path,updated) VALUES(?,?,?,?,?,?,?,?,?)",
            (tid, title, artist or "Your library", album, dur, "", "library", str(path), time.time()),
        )
    known = [r[0] for r in db("SELECT id FROM tracks WHERE source='library'")]
    for tid in known:
        if tid not in seen:
            db("DELETE FROM tracks WHERE id=?", (tid,))
    return len(seen)


_library_kick = threading.Event()


def refresh_library() -> int:
    """Navidrome's library while its switch is on (wizard-music#92), else Music's own scan of the folder. When
    Navidrome doesn't answer, Music scans the folder itself, so the library never goes away."""
    if navidrome.active():
        try:
            return navidrome.sync(sys.modules[__name__])
        except navidrome.Unavailable as exc:
            print("navidrome sync failed, scanning the folder", exc, file=sys.stderr)
    return scan_library()


def kick_library():
    """A playlist or like changed: copy it to Navidrome now, not at the next minute."""
    if navidrome.active():
        _library_kick.set()


def _library_loop():
    while True:
        try:
            refresh_library()
        except Exception as exc:  # keep scanning
            print("library scan failed", exc, file=sys.stderr)
        _library_kick.wait(60)
        _library_kick.clear()


# ---------------------------------------------------------------- Track model
def track(tid: str) -> dict | None:
    rows = db("SELECT id,title,artist,album,duration_ms,source FROM tracks WHERE id=?", (tid,))
    if not rows:
        return None
    r = rows[0]
    liked = db("SELECT value FROM likes WHERE id=?", (tid,))
    return {
        "id": r[0],
        "title": r[1],
        "artist": r[2],
        "album": r[3] or "",
        "durationMs": r[4] or 0,
        "source": r[5],
        "art": f"{PUBLIC_PREFIX}/art/{urllib.parse.quote(r[0])}",
        "stream": f"{PUBLIC_PREFIX}/stream/{urllib.parse.quote(r[0])}",
        "liked": bool(liked and liked[0][0] > 0),
    }


def _norm(text: str) -> str:
    text = re.sub(r"\(.*?\)|\[.*?\]|feat\..*|ft\..*", "", (text or "").lower())
    return re.sub(r"[^a-z0-9]+", "", text)


def library_match(title: str, artist: str) -> str | None:
    key = _norm(title)
    if not key:
        return None
    for tid, t, a in db("SELECT id,title,artist FROM tracks WHERE source='library'"):
        if _norm(t) == key and (_norm(a) in _norm(artist) or _norm(artist) in _norm(a)):
            return tid
    return None


def prefer_library(t: dict) -> dict:
    if t and t["source"] == "youtube":
        local = library_match(t["title"], t["artist"])
        if local:
            return track(local) or t
    return t


# ---------------------------------------------------------------- Taste
# Thumbs are the truth (likes: 1 up, -1 down, 0 cleared). Taste is derived from them on demand,
# so a thumb can be flipped or cleared without drift:
#   artist   +/-1 per thumb on one of their tracks
#   genre    +/-1 per thumb (Apple Music genre via the iTunes Search API, best effort)
#   similar  -0.5 per thumbs-down for each artist YouTube Music relates to the disliked artist
# A station skips a candidate when (its lowest artist score + half its genre score) <= -1, unless you
# liked the track or one of its artists is net positive. So one thumbs-down rules out that artist, and
# similar artists playing the same genre; two thumbs-down in a genre rule out the genre.
BLOCK_AT = -1.0
GENRE_WEIGHT = 0.5
SIMILAR_WEIGHT = 0.5
ITUNES_COUNTRY = os.environ.get("WIZARD_MUSIC_ITUNES_COUNTRY", "TH")
UA = {"User-Agent": "WizardMusic/1 (private personal player)"}
NOT_ARTISTS = {"", "yourlibrary", "variousartists", "unknownartist", "unknown"}
_SPLIT_ARTISTS = re.compile(r"\s*(?:,|&|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\bfeaturing\b|\s[x\u00d7]\s)\s*", re.I)
_BRACKETS = re.compile(r"\s*[(\[][^)\]]*[)\]]")


def _key(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "").casefold()
    return "".join(ch for ch in text if unicodedata.category(ch)[0] in "LNM")


def artist_names(artist: str) -> list[str]:
    out, seen = [], set()
    for part in _SPLIT_ARTISTS.split(artist or ""):
        name, key = part.strip(), _key(part)
        if key in NOT_ARTISTS or key in seen:
            continue
        seen.add(key)
        out.append(name)
    return out


class Taste:
    def __init__(self):
        self.artist: dict[str, float] = {}
        self.genre: dict[str, float] = {}
        self.labels: dict[tuple[str, str], str] = {}
        self.direct: set[str] = set()  # artists you thumbed directly (not only via similarity)
        self.disliked: set[str] = set()

    def bump(self, kind: str, key: str, label: str, delta: float):
        if not key:
            return
        table = self.artist if kind == "artist" else self.genre
        table[key] = table.get(key, 0.0) + delta
        self.labels.setdefault((kind, key), label)


_taste_lock = threading.Lock()
_taste_version = 0
_taste_cache: dict = {"version": -1, "taste": None}


def taste_changed():
    global _taste_version
    with _taste_lock:
        _taste_version += 1


def taste_profile() -> Taste:
    with _taste_lock:
        if _taste_cache["version"] == _taste_version:
            return _taste_cache["taste"]
        version = _taste_version
    taste = Taste()
    rows = db(
        "SELECT l.id, l.value, t.artist, i.genre, i.similar FROM likes l LEFT JOIN tracks t ON t.id=l.id "
        "LEFT JOIN track_info i ON i.id=l.id WHERE l.value != 0"
    )
    for tid, value, artist, genre, similar in rows:
        if value < 0:
            taste.disliked.add(tid)
        own = set()
        for name in artist_names(artist or ""):
            key = _key(name)
            own.add(key)
            taste.direct.add(key)
            taste.bump("artist", key, name, value)
        if genre:
            taste.bump("genre", _key(genre), genre, value)
        if value < 0 and similar:
            for name in json.loads(similar):
                key = _key(name)
                if key not in own:
                    taste.bump("artist", key, name, value * SIMILAR_WEIGHT)
    with _taste_lock:
        _taste_cache.update(version=version, taste=taste)
    return taste


def genre_of(tid: str) -> str:
    rows = db("SELECT genre FROM track_info WHERE id=?", (tid,))
    return (rows[0][0] or "") if rows else ""


def blocked(t: dict, taste: Taste) -> bool:
    """True when this track is the kind of music you said no to."""
    if t.get("liked"):
        return False
    if t["id"] in taste.disliked:
        return True
    scores = [taste.artist.get(_key(name), 0.0) for name in artist_names(t.get("artist", ""))]
    if any(s > 0 for s in scores):
        return False
    genre = genre_of(t["id"])
    genre_score = taste.genre.get(_key(genre), 0.0) if genre else 0.0
    return min(scores, default=0.0) + GENRE_WEIGHT * genre_score <= BLOCK_AT


def fits(tid: str, taste: Taste) -> bool:
    t = track(tid)
    return bool(t) and not blocked(t, taste)


def taste_summary(limit: int = 6) -> dict:
    taste = taste_profile()
    avoid = [(s * GENRE_WEIGHT, taste.labels[("genre", k)]) for k, s in taste.genre.items() if s * GENRE_WEIGHT <= BLOCK_AT]
    avoid += [(s, taste.labels[("artist", k)]) for k, s in taste.artist.items() if s <= BLOCK_AT and k in taste.direct]
    return {"avoid": [label for _, label in sorted(avoid, key=lambda item: item[0])[:limit]]}


def itunes_genre(title: str, artist: str) -> str:
    """Apple Music primary genre for a track, '' when no confident match."""
    if not ONLINE:
        return ""
    names = artist_names(artist)
    clean = _BRACKETS.sub("", title or "").strip() or (title or "").strip()
    if not clean:
        return ""
    term = f"{names[0] if names else ''} {clean}".strip()
    query = urllib.parse.urlencode({"term": term, "entity": "song", "limit": 8, "country": ITUNES_COUNTRY})
    with online_urlopen(urllib.request.Request("https://itunes.apple.com/search?" + query, headers=UA), timeout=8) as r:
        results = json.load(r).get("results", [])
    want_title, want_artists = _key(clean), [_key(n) for n in names]
    for item in results:
        got_title = _key(_BRACKETS.sub("", item.get("trackName") or ""))
        got_artist = _key(item.get("artistName") or "")
        title_ok = bool(got_title) and (got_title.startswith(want_title) or want_title.startswith(got_title))
        artist_ok = not want_artists or any(a and a in got_artist for a in want_artists)
        if title_ok and artist_ok and item.get("primaryGenreName"):
            return item["primaryGenreName"]
    return ""


def related_artists(artist: str) -> list[str]:
    out, seen = [], set()
    for name in artist_names(artist)[:2]:
        try:
            names = _source_get(source_for(), "/api/music/related-artists?" + urllib.parse.urlencode({"name": name})).get("artists", [])
        except Exception:
            names = []
        for label in names[:10]:
            if _key(label) and _key(label) not in seen:
                seen.add(_key(label))
                out.append(label)
    return out[:15]


def save_info(tid: str, genre: str | None = None, similar: list[str] | None = None):
    db(
        "INSERT INTO track_info(id,genre,similar,at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
        "genre=COALESCE(excluded.genre, genre), similar=COALESCE(excluded.similar, similar), at=excluded.at",
        (tid, genre, json.dumps(similar, ensure_ascii=False) if similar is not None else None, time.time()),
    )
    taste_changed()


def enrich(tid: str, want_similar: bool = False) -> bool:
    """Look up genre (and similar artists) for a track. Returns True when it hit the network."""
    if not ONLINE:
        return False
    t = track(tid)
    if not t:
        return False
    rows = db("SELECT genre, similar FROM track_info WHERE id=?", (tid,))
    genre, similar = rows[0] if rows else (None, None)
    used = False
    if genre is None:
        used = True
        try:
            save_info(tid, genre=itunes_genre(t["title"], t["artist"]))
        except Exception as exc:  # retried on the next request for this track
            print("genre lookup failed", tid, repr(exc), file=sys.stderr)
    if want_similar and similar is None:
        used = True
        try:
            save_info(tid, similar=related_artists(t["artist"]))
        except Exception as exc:
            print("related artists failed", tid, repr(exc), file=sys.stderr)
    return used


_info_q: deque = deque()
_info_pending: set = set()
_info_cv = threading.Condition()


def queue_info(tid: str, similar: bool = False):
    if not ONLINE:
        return
    if not similar:
        rows = db("SELECT genre FROM track_info WHERE id=?", (tid,))
        if rows and rows[0][0] is not None:
            return
    with _info_cv:
        if (tid, similar) in _info_pending or len(_info_q) > 400:
            return
        _info_pending.add((tid, similar))
        _info_q.append((tid, similar))
        _info_cv.notify()


def _info_loop():
    # One background lookup at a time, spaced for the iTunes Search API's ~20 requests/minute.
    while True:
        with _info_cv:
            while not _info_q:
                _info_cv.wait()
            tid, similar = _info_q.popleft()
        used = False
        try:
            used = enrich(tid, similar)
        except Exception as exc:
            print("enrich failed", tid, repr(exc), file=sys.stderr)
        finally:
            with _info_cv:
                _info_pending.discard((tid, similar))
        if used:
            time.sleep(3.2)


def learn_dislike(tid: str, budget: float = 5.0) -> dict:
    """Learn what kind of music this is (within a short budget; the rest finishes in the background)."""
    worker = threading.Thread(target=lambda: _quiet(enrich, tid, True), daemon=True)
    worker.start()
    worker.join(budget)
    t = track(tid) or {"artist": ""}
    rows = db("SELECT genre, similar FROM track_info WHERE id=?", (tid,))
    genre = (rows[0][0] or "") if rows else ""
    similar = json.loads(rows[0][1]) if rows and rows[0][1] else []
    return {"artists": artist_names(t["artist"]), "genre": genre, "similar": similar[:5]}


# ---------------------------------------------------------------- Styles and your collections
# "Play me some synthwave" should play the synthwave you already like, not whatever has the word in its
# title. Each artist you like or keep playing gets style tags (MusicBrainz community tags; for artists
# MusicBrainz doesn't tag, the tags of the artists YouTube Music relates to them). A collection is your
# tracks whose style matches: liked, or played at least twice and not mostly skipped.
MB_UA = {"User-Agent": "WizardMusic/1.0 ( private personal player )"}
MB_MIN_GAP = 1.2  # MusicBrainz allows one request per second
STYLE_AT = 0.5  # how well a track must match to join a collection
COLLECTION_MIN = 3  # fewer of your tracks than this: seed a station from them plus the genre's own radio
STYLE_FAMILIES = {
    "synthwave": {"synthwave": 1, "retrowave": 1, "outrun": 1, "chillsynth": .9, "darksynth": .9, "dreamwave": .9,
                  "chillwave": .7, "vaporwave": .6, "synth": .6, "synthpop": .4},
    "vaporwave": {"vaporwave": 1, "mallsoft": .9, "future funk": .7, "chillwave": .6, "synthwave": .6, "simpsonwave": 1},
    "chillwave": {"chillwave": 1, "chillsynth": .9, "synthwave": .6, "vaporwave": .6, "dream pop": .5},
    "deep house": {"deep house": 1, "melodic house": .8, "organic house": .8, "minimal house": .8, "lo-fi house": .7,
                   "garage house": .7, "house": .6, "tech house": .6, "progressive house": .6, "minimal": .6, "minimal techno": .5},
    "house": {"house": 1, "deep house": .9, "tech house": .9, "melodic house": .9, "garage house": .9, "progressive house": .8,
              "organic house": .8, "afro house": .8, "minimal": .6, "dance": .4},
    "melodic house": {"melodic house": 1, "melodic techno": .9, "progressive house": .8, "deep house": .7, "organic house": .8},
    "melodic techno": {"melodic techno": 1, "melodic house": .9, "progressive house": .6, "techno": .6},
    "techno": {"techno": 1, "minimal techno": 1, "melodic techno": 1, "dub techno": .9, "minimal": .8, "tech house": .6},
    "minimal": {"minimal": 1, "minimal techno": 1, "minimal house": 1, "tech house": .7, "deep house": .6, "microhouse": 1},
    "downtempo": {"downtempo": 1, "chillout": .9, "trip hop": .8, "nu jazz": .6, "electronica": .5, "ambient": .5, "chillwave": .5},
    "ambient": {"ambient": 1, "drone": .8, "new age": .7, "downtempo": .5, "idm": .4},
    "trance": {"trance": 1, "progressive trance": 1, "uplifting trance": 1, "progressive house": .5},
    "lofi": {"lofi": 1, "lo-fi": 1, "lo-fi hip hop": 1, "chillhop": 1, "lo-fi house": .6},
    "drum and bass": {"drum and bass": 1, "liquid funk": .9, "jungle": .8, "dnb": 1},
    "trip hop": {"trip hop": 1, "downtempo": .7},
    "disco": {"disco": 1, "nu disco": 1, "italo disco": .9, "funk": .5},
}
STYLE_SAID = {"synth wave": "synthwave", "retro wave": "synthwave", "outrun": "synthwave", "retrowave": "synthwave",
              "vapor wave": "vaporwave", "chill wave": "chillwave", "lo fi": "lofi", "lo-fi": "lofi", "dnb": "drum and bass",
              "d and b": "drum and bass", "drum n bass": "drum and bass", "trip-hop": "trip hop", "triphop": "trip hop",
              "minimal deep house": "deep house", "nu disco": "disco", "chill out": "downtempo", "chillout": "downtempo"}
_STYLE_FILLER = re.compile(r"\b(?:i(?:'ve| have)?\s+(?:liked|like|love|loved|saved|curated)|that|which|you know|of|mine|my|own|"
                           r"some|favou?rites?|faves?|collection|playlist|station|mix|radio|music|songs?|tracks?|stuff|tunes|"
                           r"genre|kind|type|the|me|from|out of|all)\b", re.I)


def style_request(q: str) -> str:
    """'synthwave I like' / 'my deep house playlist' -> 'synthwave' / 'deep house' ('' when it names no style)."""
    rest = re.sub(r"\s+", " ", _STYLE_FILLER.sub(" ", q or "")).strip(" ,.")
    if not rest or len(rest.split()) > 3:
        return ""
    rest = STYLE_SAID.get(rest, rest)
    vocab = set(STYLE_FAMILIES) | {g for g in GENRES if len(g) > 2} | set(STYLE_SAID.values())
    if rest in vocab:
        return rest
    best = max(((heard_like(rest, v), v) for v in vocab), default=(0.0, ""))
    return best[1] if best[0] >= 0.88 else ""


def style_match(tags: dict[str, float], style: str) -> float:
    family = STYLE_FAMILIES.get(style, {style: 1})
    best = 0.0
    for tag, weight in tags.items():
        sim = family.get(tag, 0.0)
        if not sim and (f" {style} " in f" {tag} " or f" {tag} " in f" {style} "):
            sim = 0.7
        best = max(best, weight * sim)
    return best


def _mb(path: str, **q) -> dict:
    require_online()
    q["fmt"] = "json"
    req = urllib.request.Request(f"https://musicbrainz.org/ws/2/{path}?" + urllib.parse.urlencode(q), headers=MB_UA)
    for attempt in range(3):
        try:
            with online_urlopen(req, timeout=10) as r:
                return json.load(r)
        except urllib.error.HTTPError as exc:
            if exc.code not in (429, 503):
                raise
            time.sleep(2 + 2 * attempt)
        finally:
            time.sleep(MB_MIN_GAP)
    return {}


def _mb_tags(items: list[dict]) -> dict[str, float]:
    counts: dict[str, float] = {}
    for item in items or []:
        name = (item.get("name") or "").strip().lower()
        if name and item.get("count", 0) > 0:
            counts[name] = max(counts.get(name, 0), item["count"])
    top = max(counts.values(), default=0)
    return {k: round(v / top, 3) for k, v in counts.items()} if top else {}


def mb_artist_tags(name: str, title: str = "") -> dict[str, float]:
    """MusicBrainz tags for an artist; a known song of theirs picks the right artist among namesakes."""
    want = _key(name)
    aid = ""
    if title:
        clean = _clean_title(title).replace('"', "")
        for rec in _mb("recording", query=f'recording:"{clean}" AND artist:"{name.replace(chr(34), "")}"', limit=5).get("recordings", []):
            credit = next((c["artist"] for c in rec.get("artist-credit", []) if isinstance(c, dict) and _key(c.get("artist", {}).get("name", "")) == want), None)
            if credit and rec.get("score", 0) >= 90:
                aid = credit["id"]
                break
    if aid:
        info = _mb(f"artist/{aid}", inc="tags+genres")
        return _mb_tags((info.get("genres") or []) + (info.get("tags") or []))
    hits = [a for a in _mb("artist", query=f'artist:"{name.replace(chr(34), "")}"', limit=5).get("artists", []) if _key(a.get("name", "")) == want]
    hits.sort(key=lambda a: -sum(t.get("count", 0) for t in a.get("tags", [])))
    return _mb_tags(hits[0].get("tags", [])) if hits else {}


def artist_styles(key: str) -> dict[str, float] | None:
    rows = db("SELECT tags FROM artist_styles WHERE key=?", (key,))
    return json.loads(rows[0][0]) if rows else None


def tag_artist(name: str, title: str = "") -> dict[str, float]:
    """Look up and remember one artist's styles (own tags, else borrowed from related artists)."""
    key = _key(name)
    rows = db("SELECT tags, source FROM artist_styles WHERE key=?", (key,))
    if rows and (rows[0][1] != "probe" or json.loads(rows[0][0])):
        return json.loads(rows[0][0])  # looked up already (a bare probe for someone else's neighbours doesn't count)
    tags, source = mb_artist_tags(name, title), "musicbrainz"
    if not tags:
        source, votes, voters = "related", {}, 0
        try:
            related = related_artists(name)[:6]
        except Exception as exc:
            print("related artists failed", name, repr(exc), file=sys.stderr)
            related = []
        for other in related:
            okey = _key(other)
            theirs = artist_styles(okey)
            if theirs is None:
                theirs = mb_artist_tags(other)
                db("INSERT OR REPLACE INTO artist_styles(key,name,tags,source,at) VALUES(?,?,?,?,?)",
                   (okey, other, json.dumps(theirs), "probe", time.time()))
            if theirs:
                voters += 1
                for tag, w in theirs.items():
                    votes[tag] = votes.get(tag, 0.0) + w
        tags = {t: round(0.8 * v / voters, 3) for t, v in votes.items() if voters and v / voters >= 0.25}
    db("INSERT OR REPLACE INTO artist_styles(key,name,tags,source,at) VALUES(?,?,?,?,?)", (key, name, json.dumps(tags), source, time.time()))
    return tags


# ---------------------------------------------------------------- Points
# Every song earns points from what you did with it. The raw counts are kept (plays, requests, feedback_log,
# kept), so the weights below can change later and every score is recomputed from the same history.
# Override any of them in HOME/score_weights.json, e.g. {"heard_through": 1.5}.
DEFAULT_WEIGHTS = {
    "like": 5.0,           # thumbs up (current state)
    "dislike": -10.0,      # thumbs down (current state); also keeps the song out of every collection
    "request": 3.0,        # each time you asked for this exact song: tapped it, or named it
    "heard_through": 1.0,  # each time it played to (nearly) the end with no skip or thumbs down
    "partial": 0.25,       # each time it played at least 30 seconds, then something else came on (tracked; small for now)
    "skip": -1.0,          # each time you skipped it
    "approved": 1.0,       # it was heard through in a session you said was on point
}
CAPS = {"request": 6, "heard_through": 12, "skip": 8, "partial": 8}  # repeats count, with diminishing room to dominate
YOURS_AT = 2.0  # points a song needs to join your collections


def score_weights() -> dict[str, float]:
    weights = dict(DEFAULT_WEIGHTS)
    try:
        custom = json.loads((HOME / "score_weights.json").read_text())
        weights.update({k: float(v) for k, v in custom.items() if k in DEFAULT_WEIGHTS})
    except FileNotFoundError:
        pass
    except Exception as exc:
        print("score_weights.json ignored", repr(exc), file=sys.stderr)
    return weights


def _heard(events: list[tuple], disliked: set[str], partial: dict | None = None) -> dict[str, int]:
    """Per song, how many times it played to (nearly) the end: not skipped, not turned down, and the next song
    started no sooner than 60% of the way through. A song still playing at the end of `events` is left out.
    Starts that ran 30 seconds or more but not that far are counted into `partial`."""
    out: dict[str, int] = {}
    durations = {r[0]: (r[1] or 0) / 1000 for r in db("SELECT id, duration_ms FROM tracks WHERE id IN (SELECT id FROM plays)")}
    for i, (tid, at, action) in enumerate(events):
        if action != "played" or tid in disliked or i + 1 >= len(events):
            continue
        later = events[i + 1:i + 3]
        if any(e[0] == tid and e[2] == "skipped" for e in later):
            continue
        ran = later[0][1] - at
        if ran >= max(60.0, 0.6 * durations.get(tid, 0)):
            out[tid] = out.get(tid, 0) + 1
        elif ran >= 30 and partial is not None:
            partial[tid] = partial.get(tid, 0) + 1
    return out


def song_metrics() -> dict[str, dict]:
    """Raw per-song counts behind the points."""
    disliked = {r[0] for r in db("SELECT id FROM likes WHERE value<0")}
    m: dict[str, dict] = {}

    def row(tid):
        return m.setdefault(tid, {"like": 0, "dislike": 0, "request": 0, "heard_through": 0, "partial": 0, "skip": 0, "approved": 0, "starts": 0})

    for tid, value in db("SELECT id, value FROM likes WHERE value!=0"):
        row(tid)["like" if value > 0 else "dislike"] = 1
    events = db("SELECT id, at, action FROM plays ORDER BY at")
    # A start you left within 30 seconds (a double tap, a test, changing your mind) is no evidence either way.
    kept_starts: dict[str, list[float]] = {}
    for i, (tid, at, action) in enumerate(events):
        if action == "played" and (i + 1 >= len(events) or events[i + 1][1] - at >= 30):
            kept_starts.setdefault(tid, []).append(at)
    last: dict[str, float] = {}
    for tid, at, how in db("SELECT id, at, how FROM requests ORDER BY at"):
        # One request per minute per song, and only when the song then actually played.
        if at - last.get(tid, -1e12) >= 60 and (how == 'identify' or any(-5 <= s - at <= 90 for s in kept_starts.get(tid, []))):
            row(tid)["request"] += 1
            last[tid] = at
    for tid, action, n in db("SELECT id, action, COUNT(*) FROM plays GROUP BY id, action"):
        row(tid)["starts" if action == "played" else "skip"] = n
    partial: dict[str, int] = {}
    for tid, n in _heard(events, disliked, partial).items():
        row(tid)["heard_through"] = n
    for tid, n in partial.items():
        row(tid)["partial"] = n
    for (tid,) in db("SELECT DISTINCT id FROM kept"):
        if tid not in disliked:
            row(tid)["approved"] = 1
    return m


def song_points(metrics: dict, weights: dict | None = None) -> float:
    w = weights or score_weights()
    return round(sum(w[k] * min(metrics.get(k, 0), CAPS.get(k, 1)) for k in DEFAULT_WEIGHTS), 2)


def scores(limit: int = 0) -> dict:
    weights = score_weights()
    rows = []
    for tid, metrics in song_metrics().items():
        t = track(tid)
        if t:
            rows.append({"id": tid, "title": t["title"], "artist": t["artist"], "points": song_points(metrics, weights), **metrics})
    rows.sort(key=lambda r: -r["points"])
    return {"weights": weights, "caps": CAPS, "yoursAt": YOURS_AT, "songs": rows[:limit] if limit else rows}


def record_request(tid: str, how: str):
    db("INSERT INTO requests(id,at,how) VALUES(?,?,?)", (tid, time.time(), how))
    _collections_cache["at"] = 0.0


def backfill_requests():
    """Before requests were recorded: a station named '<song> radio' was started from that exact song."""
    if db("SELECT 1 FROM requests LIMIT 1"):
        return
    for sid, seed, title, at in db("SELECT id, seed, title, at FROM stations"):
        t = track(seed)
        if t and title == f"{t['title']} radio":
            db("INSERT INTO requests(id,at,how) VALUES(?,?,?)", (seed, at, "backfill"))
    if not db("SELECT 1 FROM feedback_log LIMIT 1"):
        for tid, value, at in db("SELECT id, value, at FROM likes WHERE value!=0"):
            db("INSERT INTO feedback_log(id,at,action) VALUES(?,?,?)", (tid, at, "like" if value > 0 else "dislike"))


def your_tracks() -> list[tuple[dict, float]]:
    """Songs with at least YOURS_AT points and no thumbs down. -> [(track, points)]."""
    taste = taste_profile()
    weights = score_weights()
    out = []
    for tid, metrics in song_metrics().items():
        if metrics["dislike"] or tid in taste.disliked:
            continue
        points = song_points(metrics, weights)
        if points >= YOURS_AT:
            t = track(tid)
            if t and not blocked(t, taste):
                out.append((t, points))
    return out


def heard_through(since: float, until: float) -> list[str]:
    """Songs that played to (nearly) the end between since and until: not skipped, not turned down, and the
    next song started no sooner than 60% of the way through. The song still playing at `until` is left out."""
    events = db("SELECT id, at, action FROM plays WHERE at>=? AND at<=? ORDER BY at", (since, until))
    disliked = {r[0] for r in db("SELECT id FROM likes WHERE value<0")}
    out: list[str] = []
    for i, (tid, at, action) in enumerate(events):
        if action != "played" or tid in disliked:
            continue
        later = events[i + 1:]
        if not later:
            continue
        if any(e[0] == tid and e[2] == "skipped" for e in later[:2]):
            continue
        t = track(tid) or {}
        need = max(60.0, 0.6 * (t.get("durationMs") or 0) / 1000)
        if later[0][1] - at >= need and tid not in out:
            out.append(tid)
    return out


# ---------------------------------------------------------------- Saved mixes
def _mix_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).strip()


def _mix_core(name: str) -> str:
    """'my tea music playlist' -> 'tea' (what a spoken request and a mix name must share)."""
    words = [w for w in _mix_key(name).split() if w not in GENERIC and w not in {"my", "mix", "playlist", "list"}]
    return " ".join(words)


def save_mix(name: str, ids: list[str], aliases: list[str] | None = None) -> dict:
    """Save (or replace) a named mix of songs you picked; it shows as a chip and plays on request."""
    name = (name or "").strip()[:60]
    seen: list[str] = []
    for tid in ids:
        if track(tid) and tid not in seen:
            seen.append(tid)
    if not name or not seen:
        raise ValueError("a mix needs a name and at least one known song")
    db("INSERT OR REPLACE INTO mixes(key,name,ids,aliases,at) VALUES(?,?,?,?,?)",
       (_mix_key(name), name, json.dumps(seen[:300]), json.dumps([a[:60] for a in (aliases or [])][:10]), time.time()))
    return {"name": name, "tracks": [track(t) for t in seen]}


def session_songs(since: float, until: float) -> list[str]:
    """Songs that started between since and until, minus ones skipped early (before 60% or a minute in).
    Unlike heard_through, the song still playing at the end counts."""
    events = db("SELECT id, at, action FROM plays WHERE at>=? AND at<=? + 3600 ORDER BY at", (since, until))
    disliked = {r[0] for r in db("SELECT id FROM likes WHERE value<0")}
    out: list[str] = []
    for i, (tid, at, action) in enumerate(events):
        if action != "played" or at > until or tid in disliked or tid in out:
            continue
        nxt = next((e for e in events[i + 1:] if e[2] == "played" or e[0] == tid), None)
        t = track(tid) or {}
        if nxt and nxt[0] == tid and nxt[2] == "skipped" and nxt[1] - at < max(60.0, 0.6 * (t.get("durationMs") or 0) / 1000):
            continue
        out.append(tid)
    return out


def mixes() -> list[dict]:
    out = []
    for key, name, ids, aliases, at in db("SELECT key,name,ids,aliases,at FROM mixes ORDER BY at DESC"):
        out.append({"key": key, "name": name, "ids": json.loads(ids or "[]"), "aliases": json.loads(aliases or "[]")})
    return out


def find_mix(said: str) -> dict | None:
    core = _mix_core(said)
    if not core:
        return None
    for m in mixes():
        if any(core == _mix_core(n) or _mix_key(said) == _mix_key(n) for n in [m["name"], *m["aliases"]]):
            return m
    return None


def mix_station(m: dict) -> dict:
    """Your saved songs in a fresh order first, then radio grown from them that keeps bringing them back."""
    ids = [t for t in m["ids"] if track(t)]
    if not ids:
        raise LookupError("that mix is empty")
    order = ids[:]
    random.shuffle(order)
    return create_station({"trackId": order[0], "label": m["name"], "queue": order[1:], "pool": ids})


def keep_session(since: float, until: float, reason: str) -> list[str]:
    """You said this stretch of listening was on point: every song heard through counts as yours."""
    ids = heard_through(since, until)
    now = time.time()
    for tid in ids:
        db("INSERT OR IGNORE INTO kept(id,at,reason) VALUES(?,?,?)", (tid, now, reason[:80]))
        queue_styles_for(tid)
    _collections_cache["at"] = 0.0
    return ids


def track_styles(t: dict) -> dict[str, float]:
    tags: dict[str, float] = {}
    for name in artist_names(t.get("artist", "")):
        for tag, w in (artist_styles(_key(name)) or {}).items():
            tags[tag] = max(tags.get(tag, 0.0), w)
    genre = genre_of(t["id"]).strip().lower()
    if genre:
        tags[genre] = max(tags.get(genre, 0.0), 0.6)
    title = (t.get("title") or "").lower()
    for style in set(STYLE_FAMILIES) | {m for fam in STYLE_FAMILIES.values() for m in fam}:
        if len(style) > 4 and re.search(rf"\b{re.escape(style)}\b", title):
            tags[style] = 1.0
    return tags


def collection(style: str) -> list[dict]:
    """Your tracks in this style, best first."""
    scored = []
    for t, affinity in your_tracks():
        match = style_match(track_styles(t), style)
        if match >= STYLE_AT:
            scored.append((match * 2 + affinity, t))
    scored.sort(key=lambda x: -x[0])
    out, seen = [], set()
    for _, t in scored:  # one copy of a song even when YouTube has it twice
        same = (_key(artist_names(t["artist"])[0] if artist_names(t["artist"]) else t["artist"]), _key(_clean_title(t["title"])))
        if same not in seen:
            seen.add(same)
            out.append(t)
    return out


_collections_cache: dict = {"at": 0.0, "value": []}


def style_label(style: str) -> str:
    """'deep house' -> 'Deep house' (chips read as the style itself; 'your' was redundant)."""
    return style[:1].upper() + style[1:]


def hidden_chips() -> set[str]:
    """Styles and vibe chips this listener never wants offered: HOME/hidden_chips.json, e.g. ["trip hop", "neo soul"]."""
    try:
        return {str(x).strip().lower() for x in json.loads((HOME / "hidden_chips.json").read_text())}
    except (OSError, ValueError, TypeError):
        return set()


def collections(limit: int = 8) -> list[dict]:
    """Styles you have at least COLLECTION_MIN tracks in, biggest first (cached for a minute)."""
    if time.time() - _collections_cache["at"] < 60:
        return _collections_cache["value"][:limit]
    mine = [(t, track_styles(t)) for t, _ in your_tracks()]
    out, kept = [], []
    for style in STYLE_FAMILIES:  # listed in order of preference: synthwave before its near-twins
        ids = {t["id"] for t, tags in mine if style_match(tags, style) >= STYLE_AT}
        if style in hidden_chips() or len(ids) < COLLECTION_MIN or any(len(ids & k) / len(ids | k) > 0.6 for k in kept):
            continue
        kept.append(ids)
        out.append({"style": style, "label": style_label(style), "count": len(ids)})
    out.sort(key=lambda c: -c["count"])
    _collections_cache.update(at=time.time(), value=out)
    return out[:limit]


_style_q: deque = deque()
_style_cv = threading.Condition()


def queue_style(name: str, title: str = ""):
    if not ONLINE or not name or _key(name) in NOT_ARTISTS:
        return
    rows = db("SELECT tags, source FROM artist_styles WHERE key=?", (_key(name),))
    if rows and (rows[0][1] != "probe" or json.loads(rows[0][0])):
        return
    with _style_cv:
        if any(_key(n) == _key(name) for n, _ in _style_q) or len(_style_q) > 500:
            return
        _style_q.append((name, title))
        _style_cv.notify()


def queue_styles_for(tid: str):
    t = track(tid)
    for name in artist_names((t or {}).get("artist", "")):
        queue_style(name, (t or {}).get("title", ""))


def backfill_styles():
    for t, _ in your_tracks():
        queue_styles_for(t["id"])


def _style_loop():
    while True:
        with _style_cv:
            while not _style_q:
                _style_cv.wait()
            name, title = _style_q.popleft()
        try:
            tag_artist(name, title)
        except Exception as exc:
            print("style lookup failed", name, repr(exc), file=sys.stderr)
            time.sleep(5)


def style_station(style: str, said: str, q: str) -> dict | None:
    """A station that plays your own tracks in this style, interleaved with radio grown from them."""
    mine = collection(style)
    label = style_label(style)
    if not mine:
        return None
    seeds = random.sample(mine[: max(6, len(mine) // 2)], k=min(3, len(mine)))
    radio: list[str] = []
    for seed in seeds:
        for cid in _radio_from(seed["id"]):
            if cid not in radio:
                radio.append(cid)
    random.shuffle(radio)
    if len(mine) < COLLECTION_MIN:  # too few of yours yet: lean on the genre's own radio as well
        extra = genre_seed(style)
        if extra:
            radio = [c for c in _radio_from(extra) if c not in radio] + radio
        label = f"{style.title()} radio"
    picks = mine[:]
    random.shuffle(picks)
    first, rest = picks[0], [t["id"] for t in picks[1:]]
    queue, mine_left = [], rest[:]
    while mine_left or radio:  # two of yours, then one new song that follows from them
        queue += mine_left[:2]
        mine_left = mine_left[2:]
        if radio:
            queue.append(radio.pop(0))
        if not mine_left:
            queue += radio
            radio = []
    out = create_station({"trackId": first["id"], "label": label, "queue": queue, "pool": [t["id"] for t in mine]})
    heard = f"{label} · {len(mine)} of your songs" if len(mine) >= COLLECTION_MIN else label
    return {"kind": "collection", "said": said, "query": q, "heard": heard, "style": style, "mine": len(mine), **out}


# ---------------------------------------------------------------- Search
# YouTube Music's "songs" filter only returns official tracks, so full-length versions that live on YouTube as
# uploads (extended mixes, remixes, live takes) never showed up. Videos are asked for too and woven in after
# the first songs, minus copies of a song already listed and anything too short or too long to be a track.
SEARCH_SONGS, SEARCH_VIDEOS = 20, 10
VIDEO_MIN_S, VIDEO_MAX_S = 60, 20 * 60
_VIDEO_NOISE = re.compile(
    r"[(\[][^)\]]*\b(?:official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|m/?v)\b[^)\]]*[)\]]"
    r"|\b(?:official\s+(?:music\s+)?video|official\s+audio|lyric\s+video|lyrics|visuali[sz]er)\b",
    re.I,
)


def _words(text: str) -> frozenset:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    return frozenset(w for w in re.findall(r"[a-z0-9]+", text) if w not in {"the", "ft", "feat", "featuring", "x"})


def _video_track(item: dict) -> bool:
    secs = item.get("duration_seconds") or _secs(item.get("length") or item.get("duration"))
    return VIDEO_MIN_S <= int(secs or 0) <= VIDEO_MAX_S


def _online_search(q: str) -> list[dict]:
    def ask(kind: str, limit: int) -> list[dict]:
        try:
            return list(ytm().search(q, filter=kind, limit=limit) or [])[:limit]
        except Exception as exc:
            print(f"ytm search failed ({kind})", exc, file=sys.stderr)
            return []

    found: dict[str, list[dict]] = {}
    threads = [threading.Thread(target=lambda k=k, n=n: found.__setitem__(k, ask(k, n)), daemon=True)
               for k, n in (("songs", SEARCH_SONGS), ("videos", SEARCH_VIDEOS))]
    for th in threads:
        th.start()
    for th in threads:
        th.join(30)
    songs = [t for t in (remember_yt(i) for i in found.get("songs", [])) if t]
    known = {_words(f"{t['artist']} {t['title']}") for t in songs}
    videos = []
    for item in found.get("videos", []):
        if not _video_track(item):
            continue  # DJ sets, hour-long loops, short clips
        artists = ", ".join(a.get("name", "") for a in item.get("artists") or [] if isinstance(a, dict))
        title = _VIDEO_NOISE.sub(" ", item.get("title") or "")
        if _words(title) in known or _words(f"{artists} {title}") in known:
            continue  # the official video of a song already listed
        t = remember_yt(item)
        if t:
            videos.append(t)
    # Two songs first (a plain song search still starts with the official song), then a video after each song.
    out, songs_left = songs[:2], songs[2:]
    while songs_left or videos:
        if videos:
            out.append(videos.pop(0))
        if songs_left:
            out.append(songs_left.pop(0))
    return out


def search(q: str) -> list[dict]:
    q = q.strip()
    out: list[dict] = []
    like = f"%{q}%"
    for (tid,) in db(
        "SELECT id FROM tracks WHERE source='library' AND (title LIKE ? OR artist LIKE ? OR album LIKE ?) LIMIT 8",
        (like, like, like),
    ):
        out.append(track(tid))
    out += _online_search(q)
    seen, uniq = set(), []
    for t in out:
        if t and t["id"] not in seen:
            seen.add(t["id"])
            uniq.append(t)
    return uniq


# ---------------------------------------------------------------- Spoken requests
# "Play Guy Barato Trap" arrives the way speech-to-text spelled it. Names are fixed before searching:
# first against what the listener plays and likes (the likeliest artists), then against Deezer's catalog search,
# which forgives misspellings ("guy barato trap" -> Gui Boratto - Trap). YouTube Music plays the result.
_LEAD = re.compile(
    r"^(?:(?:hey|ok|okay|yo|please|wizard|archimedes|can you|could you|would you|will you|maybe|just|go ahead and|i want to|i wanna|i'?d like to|let'?s)[,\s]+)*"
    r"(?:play|put on|throw on|queue up|queue|listen to|hear|start|blast|spin)\b[,\s]*"
    r"(?:me\s+)?(?:(?:some|a little|a bit of|more|the|my)\s+)*"
    r"(?:(?:music|songs?|tracks?|tunes)\s+(?:by|from)\s+|something\s+(?:by|from)\s+|(?:the\s+)?(?:song|track)\s+(?:called\s+)?|music\b[,\s]*)?",
    re.I,
)
_TAIL = re.compile(r"[,\s]+(?:on|in|from)\s+(?:wizard\s+music|youtube(?:\s+music)?|spotify|my\s+(?:phone|speaker))\s*$|[,\s]+(?:please|for me|now|right now)\s*$", re.I)
GENERIC = {"something", "some", "music", "vibes", "vibe", "stuff", "songs", "song", "tunes", "a", "bit", "little", "more",
           "really", "very", "for", "to", "the", "mood", "kind", "of", "good", "nice", "type", "beats", "playlist", "radio"}
VIBE_WORDS = [
    (re.compile(r"(?:deep\s+)?focus(?:ing)?|work(?:ing)?|study(?:ing)?|concentrat\w*|coding|deep\s+work"), "focus"),
    (re.compile(r"chill(?:l?ed|y)?(?:\s+out)?|relax\w*|calm(?:ing)?|mellow|late\s+night|night(?:\s+time)?|sleep\w*|downtempo|lo\s?fi"), "late"),
    (re.compile(r"(?:warm\s+)?house|dance|danc(?:ey|y)|groov\w*|party"), "house"),
    (re.compile(r"morning(?:\s+lift)?|upbeat|happy|wake\s+up|uplifting|energ(?:y|etic)|feel\s+good"), "morning"),
    (re.compile(r"dub(?:\s+techno)?"), "dub"),
    (re.compile(r"(?:neo\s+)?soul|r\s?(?:and|n|&)\s?b|rnb"), "soul"),
]
GENRES = {"trap", "techno", "house", "jazz", "hip hop", "hiphop", "rap", "drill", "reggae", "reggaeton", "afrobeats", "afro house",
          "disco", "funk", "soul", "blues", "rock", "metal", "punk", "classical", "ambient", "edm", "dubstep", "drum and bass", "dnb",
          "minimal", "melodic techno", "deep house", "tech house", "lofi", "lo fi", "pop", "k pop", "kpop", "thai pop", "t pop", "trance"}
LIKES = re.compile(r"^(?:my\s+)?(?:likes|liked(?:\s+(?:songs|tracks|music))?|favou?rites?|faves?|(?:songs|music)\s+i\s+(?:like|love))$")
VERSION = re.compile(r"\b(?:remix|mix|live|edit|version|slowed|sped up|reverb|instrumental|acoustic|cover|karaoke|remaster(?:ed)?)\b", re.I)
CORRECT_AT = 0.8       # minimum similarity to replace what STT heard
TRUST_GAP = 0.06       # history beats the catalog unless the catalog is clearly closer


def _squash(text: str) -> str:
    text = unicodedata.normalize("NFKD", (text or "").casefold()).replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", "", "".join(ch for ch in text if not unicodedata.combining(ch)))
    text = text.replace("ph", "f").replace("ck", "k").replace("y", "i").replace("z", "s")
    return re.sub(r"(.)\1+", r"\1", text)


def _skeleton(text: str) -> str:
    s = _squash(text)
    return s[:1] + re.sub(r"[aeiou]", "", s[1:])


def heard_like(said: str, real: str) -> float:
    """How closely `said` (as transcribed) sounds like `real`: spelling 60 %, consonant skeleton 40 %."""
    a, b = _squash(said), _squash(real)
    if not a or not b:
        return 0.0
    from difflib import SequenceMatcher
    return 0.6 * SequenceMatcher(None, a, b).ratio() + 0.4 * SequenceMatcher(None, _skeleton(said), _skeleton(real)).ratio()


def spoken_query(said: str) -> str:
    """'Play music, Guy Barato trap, please.' -> 'guy barato trap'."""
    q = re.sub(r"[.!?\"“”]+", " ", said or "").strip()
    q = re.sub(r"\s+", " ", q)
    for _ in range(2):
        q = _LEAD.sub("", q).strip(" ,")
        q = _TAIL.sub("", q).strip(" ,")
    q = re.sub(r"\s+by\s+", " ", q, flags=re.I)
    return q.strip(" ,").lower()


def spoken_vibe(q: str) -> dict | None:
    words = re.findall(r"[a-z0-9&']+", q)
    rest = " ".join(w for w in words if w not in GENERIC)
    if not rest or (len(rest.split()) > 3):
        return None
    for rx, vid in VIBE_WORDS:
        if rx.fullmatch(rest):
            return next((v for v in VIBES if v["id"] == vid), None)
    return None


def _clean_title(title: str) -> str:
    return re.split(r"\s+[-–—|]\s+", _BRACKETS.sub("", title or ""))[0].strip()


def _windows(words: list[str]):
    for size in range(len(words), 0, -1):
        for start in range(0, len(words) - size + 1):
            yield start, size, " ".join(words[start:start + size])


def score_candidate(q: str, artist: str, title: str) -> tuple[float, str, str]:
    """Best reading of q as 'artist title', 'title artist', or just the artist (plus leftover words).
    Returns (score, kind 'song'|'artist', leftover words)."""
    words = q.split()
    best = (0.0, "song", "")
    title = _clean_title(title)
    if _squash(title):  # titles in other scripts can't be compared with what was heard
        full = max(heard_like(q, f"{artist} {title}"), heard_like(q, f"{title} {artist}"))
        best = (full, "song", "")
    total = len(_squash(q)) or 1
    for start, size, window in _windows(words):
        s = heard_like(window, artist)
        if s < CORRECT_AT:
            continue
        covered = len(_squash(window)) / total
        left = " ".join(words[:start] + words[start + size:])
        # A bare artist name is a full match; leftover words (a song name we couldn't place) cost a little.
        kind_score = s - 0.08 * (1 - covered)
        if kind_score >= best[0]:
            best = (kind_score, "artist", left)
    return best


def _deezer(path: str, q: str, limit: int) -> list[dict]:
    if not ONLINE:
        return []
    query = urllib.parse.urlencode({"q": q, "limit": limit})
    req = urllib.request.Request(f"https://api.deezer.com/{path}?{query}", headers=UA)
    with online_urlopen(req, timeout=4) as r:
        return json.load(r).get("data", []) or []


def catalog_candidates(q: str) -> list[dict]:
    """Catalog spellings for a misheard request (Deezer search is typo-tolerant). Best effort."""
    out: list[dict] = []
    results: dict[str, list] = {}

    def run(name, path, limit):
        try:
            results[name] = _deezer(path, q, limit)
        except Exception as exc:
            print("catalog lookup failed", name, repr(exc), file=sys.stderr)
            results[name] = []

    threads = [threading.Thread(target=run, args=a, daemon=True) for a in (("t", "search", 10), ("a", "search/artist", 5))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(5)
    for item in results.get("t", []):
        artist = (item.get("artist") or {}).get("name") or ""
        if artist and item.get("title"):
            out.append({"artist": artist, "title": item.get("title_short") or item["title"], "pop": item.get("rank", 0), "source": "catalog"})
    for item in results.get("a", []):
        if item.get("name"):
            out.append({"artist": item["name"], "title": "", "pop": item.get("nb_fan", 0), "source": "catalog"})
    return out


def history_candidates() -> list[dict]:
    bad = taste_profile().disliked
    rows = db(
        "SELECT t.id, t.title, t.artist, (SELECT COALESCE(MAX(value),0) FROM likes l WHERE l.id=t.id), "
        "(SELECT COUNT(*) FROM plays p WHERE p.id=t.id AND p.action='played') FROM tracks t"
    )
    out = []
    for tid, title, artist, liked, plays in rows:
        if tid in bad or not artist or _key(artist) in NOT_ARTISTS:
            continue
        mine = liked > 0 or plays > 0
        out.append({"artist": artist, "title": title or "", "pop": (2 if liked > 0 else 1 if plays else 0), "source": "history" if mine else "heard", "id": tid})
    return out


def correct_spoken(q: str, catalog=None, history=None) -> dict:
    """Fix a misheard request. -> {query, artist, title, kind, source, score} (artist '' = no correction)."""
    plain = {"query": q, "artist": "", "title": "", "kind": "search", "source": "as-said", "score": 0.0}
    if not q:
        return plain
    pool = history if history is not None else history_candidates()
    mine = [c for c in pool if c["source"] == "history"]
    seen_only = [c for c in pool if c["source"] != "history"]
    best_hist = (0.0, None, None)
    for c in mine:
        s, kind, left = score_candidate(q, c["artist"], c["title"])
        s += 0.03  # songs the listener liked or played win close calls
        if s > best_hist[0]:
            best_hist = (s, c, (kind, left))
    # Words that already name one of the listener's artists and song need no catalog call.
    if best_hist[0] >= 0.97:
        chosen = best_hist
    else:
        best_cat = (0.0, None, None)
        catalog = catalog if catalog is not None else catalog_candidates(q)
        for c in catalog:
            s, kind, left = score_candidate(q, c["artist"], c["title"])
            if s > best_cat[0] + 1e-9:
                best_cat = (s, c, (kind, left))
        # Tracks only seen in earlier search results include fan uploads ("Erika badu"): they must beat
        # the catalog clearly, the way the catalog must beat the listener's own history.
        for c in seen_only:
            s, kind, left = score_candidate(q, c["artist"], c["title"])
            if s > best_cat[0] + TRUST_GAP:
                best_cat = (s, c, (kind, left))
        chosen = best_cat if best_cat[0] > best_hist[0] + TRUST_GAP else best_hist
        if chosen[1] is None:
            chosen = best_cat
    score, cand, how = chosen
    if not cand or score < CORRECT_AT:
        return plain
    kind, left = how
    artist = artist_names(cand["artist"])[0] if artist_names(cand["artist"]) else cand["artist"]
    if kind == "artist" and left:
        akey = _key(artist)
        if catalog is None:  # the history settled the artist; ask the catalog for their song
            catalog = catalog_candidates(f"{artist} {left}")
        titles = [c for c in pool + catalog if c["title"] and any(_key(n) == akey for n in artist_names(c["artist"]))]
        best_t = max(((heard_like(left, _clean_title(c["title"])), c) for c in titles), key=lambda x: x[0], default=(0.0, None))
        if best_t[0] >= 0.7:
            return {"query": f"{artist} {_clean_title(best_t[1]['title'])}", "artist": artist, "title": _clean_title(best_t[1]["title"]),
                    "kind": "song", "source": best_t[1]["source"], "score": round(score, 3)}
    if kind == "song":
        title = cand["title"] if VERSION.search(q) else _clean_title(cand["title"]) or cand["title"]
        return {"query": f"{artist} {title}", "artist": artist, "title": title, "kind": "song", "source": cand["source"], "score": round(score, 3)}
    return {"query": f"{artist} {left}".strip(), "artist": artist, "title": left, "kind": "artist" if not left else "artist+words", "source": cand["source"], "score": round(score, 3)}


def by_artist(results: list[dict], artist: str) -> list[dict]:
    want = _key(artist)
    return [t for t in results if want and any(want == _key(n) or want in _key(n) for n in artist_names(t["artist"]))]


def _first_by(results: list[dict], artist: str, title: str = "") -> dict | None:
    """The artist's song whose title sounds most like what was said (any of theirs if none is close)."""
    mine = by_artist(results, artist)
    if title and mine:
        def score(t):
            s = heard_like(title, _clean_title(t["title"]))
            if VERSION.search(t["title"]) and not VERSION.search(title):
                s -= 0.05  # the original, unless a remix/live take was asked for
            return s
        scored = sorted(((score(t), -i, t) for i, t in enumerate(mine)), key=lambda x: (x[0], x[1]), reverse=True)
        if scored[0][0] >= 0.6:
            return scored[0][2]
    return (mine or results or [None])[0]


def genre_seed(genre: str) -> str | None:
    """A well-known song for a genre: the first track of YouTube Music's own playlist for it."""
    try:
        ytm()
        items = _source_get(source_for(), "/api/music/genre?" + urllib.parse.urlencode({"genre": genre})).get("tracks") or []
        random.shuffle(items)
        for item in items:
            t = remember_yt(item)
            if t:
                return t["id"]
    except Exception as exc:
        print("genre seed failed", genre, repr(exc), file=sys.stderr)
    return None


def play_spoken(said: str) -> dict:
    """One spoken request -> what to play. Vibes and likes resolve locally; names are fixed first."""
    q = spoken_query(said)
    mix = find_mix(q) if q else None
    if mix:
        out = mix_station(mix)
        return {"kind": "mix", "said": said, "query": q, "heard": mix["name"], **out}
    if LIKES.match(q):
        liked = [track(r[0]) for r in db("SELECT id FROM likes WHERE value>0 ORDER BY at DESC LIMIT 60")]
        liked = [t for t in liked if t]
        if not liked:
            raise LookupError("You haven’t liked any songs yet.")
        random.shuffle(liked)
        return {"kind": "likes", "said": said, "query": q, "heard": "Your likes", "station": None, "tracks": liked}
    style = style_request(q) if q else ""
    if style:
        out = style_station(style, said, q)
        if out:
            return out
        seed = genre_seed(style)
        if seed:
            out = create_station({"trackId": seed, "label": f"{style.title()} radio"})
            return {"kind": "genre", "said": said, "query": q, "heard": f"{style.title()} radio", **out}
    vibe = spoken_vibe(q) if q else None
    if not q:  # "play music": pick up from what the listener likes or played last
        last = db("SELECT id FROM likes WHERE value>0 ORDER BY at DESC LIMIT 1") or db("SELECT id FROM plays WHERE action='played' ORDER BY at DESC LIMIT 1")
        if last:
            out = create_station({"trackId": last[0][0], "label": "Your mix"})
            return {"kind": "mix", "said": said, "query": q, "heard": "Your mix", **out}
        vibe = VIBES[1]
    if vibe:
        out = create_station({"query": vibe["query"], "label": vibe["label"]})
        return {"kind": "vibe", "said": said, "query": q, "heard": vibe["label"], **out}
    if q in GENRES:
        seed = genre_seed(q)
        if seed:
            out = create_station({"trackId": seed, "label": f"{q.title()} radio"})
            return {"kind": "genre", "said": said, "query": q, "heard": f"{q.title()} radio", **out}
    fix = {"query": q, "artist": "", "title": "", "kind": "genre", "source": "as-said"} if q in GENRES else correct_spoken(q)
    results = search(fix["query"])
    if not results and fix["query"] != q:
        results = search(q)
    if not results:
        raise LookupError(f"Couldn’t find “{q}”.")
    kind = fix["kind"]
    if fix["artist"] and not by_artist(results[:8], fix["artist"]):
        kind = "search"  # e.g. "money trees": a catalog artist by that name, but the song is what YouTube finds
    first = _first_by(results, fix["artist"], fix["title"]) if kind != "search" and fix["artist"] else results[0]
    fix = {**fix, "kind": kind}
    label = f"{fix['artist']} radio" if fix["kind"] == "artist" else f"{q.title()} radio" if fix["kind"] == "genre" else ""
    out = create_station({"trackId": first["id"], "label": label})
    if fix["kind"] in {"song", "artist+words", "search"} and not style:
        record_request(first["id"], "spoken")  # you named this song (a style word like "synthwave" names none)
    heard = fix["artist"] if fix["kind"] == "artist" else f"{q.title()} radio" if fix["kind"] == "genre" else f"{first['title']} · {first['artist']}"
    return {"kind": fix["kind"], "said": said, "query": q, "heard": heard, "corrected": fix["query"] if fix["artist"] else "", "source": fix["source"], **out}


# ---------------------------------------------------------------- Stations
_station_lock = threading.Lock()


def _radio_from(tid: str) -> list[str]:
    """Return candidate track ids for an endless radio around tid."""
    seed_vid = None
    if tid.startswith("yt:"):
        seed_vid = tid[3:]
    else:
        t = track(tid)
        if t:
            try:
                hits = ytm().search(f"{t['artist']} {t['title']}", filter="songs", limit=3)
                if hits:
                    seed_vid = hits[0].get("videoId")
            except Exception:
                pass
    ids: list[str] = []
    if seed_vid:
        try:
            watch = ytm_radio().get_watch_playlist(seed_vid, radio=True, limit=60)
            for item in watch.get("tracks", []):
                t = remember_yt(item)
                if t:
                    ids.append(prefer_library(t)["id"])
        except Exception as exc:
            print("radio failed", exc, file=sys.stderr)
    if not ids:  # library-only fallback: shuffle the library
        ids = [r[0] for r in db("SELECT id FROM tracks WHERE source='library'")]
        random.shuffle(ids)
    return ids


def create_station(seed: dict) -> dict:
    tid = seed.get("trackId") or ""
    title = ""
    if seed.get("curate"):  # a song station picked by the owner's AI (wizard-music#90)
        if not tid and seed.get("query"):
            results = search(str(seed["query"])[:200])
            if not results:
                raise LookupError("nothing matched that")
            tid = results[0]["id"]
        first = track(tid)
        if not first:
            raise LookupError("unknown track")
        return curated_station(first, str(seed.get("note") or ""))
    if not tid and seed.get("query"):
        said = str(seed["query"]).strip()
        mine = re.fullmatch(r"(?:your )?(.+)", said.lower())
        if mine and mine.group(1) in STYLE_FAMILIES:  # a "Synthwave" chip (older clients send "Your synthwave")
            out = style_station(mine.group(1), said, said)
            if out:
                return {"station": out["station"], "tracks": out["tracks"]}
        mix = find_mix(said)
        if mix:  # a saved mix chip, or its name typed/said
            return mix_station(mix)
        vibe = next((v for v in VIBES if v["label"].lower() == said.lower()), None)
        if vibe:  # a vibe chip seeds from its well-loved track, not a text search for its label
            seed = {**seed, "query": vibe["query"], "label": vibe["label"]}
    if not tid and seed.get("query"):
        results = search(seed["query"])
        if not results:
            raise LookupError("nothing matched that")
        tid = results[0]["id"]
        title = seed.get("label") or seed["query"]
    first = track(tid)
    if not first:
        raise LookupError("unknown track")
    title = title or seed.get("label") or f"{first['title']} radio"
    candidates = [c for c in (seed.get("queue") or _radio_from(tid)) if c != tid]
    state = {"seed": tid, "queue": candidates, "played": [tid], "lastSeed": tid}
    if seed.get("pool"):
        state["pool"] = list(seed["pool"])[:300]  # your own tracks this station keeps coming back to
    sid = uuid.uuid4().hex[:16]
    db("INSERT INTO stations(id,title,seed,state,at) VALUES(?,?,?,?,?)", (sid, title, tid, json.dumps(state), time.time()))
    tracks = [first] + _take(sid, state, 14)
    for t in tracks[:3]:
        prefetch(t["id"])
    return {"station": {"id": sid, "title": title, "more": f"{PUBLIC_PREFIX}/api/station/{sid}/more"}, "tracks": tracks}


# Scripts that mark a regional chart insert rather than a song that follows the seed.
_SCRIPTS = {"thai": re.compile(r"[\u0e00-\u0e7f]"), "hangul": re.compile(r"[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]")}


def _scripts(text: str) -> set[str]:
    return {name for name, rx in _SCRIPTS.items() if rx.search(text or "")}


def station_scripts(state: dict) -> set[str]:
    out: set[str] = set()
    for tid in {state.get("seed"), state.get("lastSeed")}:
        t = track(tid) if tid else None
        if t:
            out |= _scripts(f"{t.get('title', '')} {t.get('artist', '')}")
    return out


def off_station(t: dict, allowed: set[str], taste: Taste) -> bool:
    """True when a candidate is in a language the station's seed is not (Thai/Korean filler)."""
    if t.get("liked"):
        return False
    if any(taste.artist.get(_key(name), 0.0) > 0 for name in artist_names(t.get("artist", ""))):
        return False
    return bool(_scripts(t.get("title", "")) - allowed)


# Variety: a station never serves another version of a song it just served, or that you played moments ago.
# "Somebody (2024) (feat. Kimbra)" by Gotye, FISHER is the same song as "Somebody That I Used To Know
# (modish. Remix)" by Gotye; "Show Me Love X Cola" is Show Me Love again.
VARIETY_STATION = 40  # songs this station served recently
VARIETY_PLAYED = 12   # songs you played most recently, on any station
_TITLE_TAIL = re.compile(r"\s+(?:feat\.?|ft\.?|featuring)\s.*$", re.I)
_TITLE_PARTS = re.compile(r"\s+(?:[-–—|/]|x|×|vs\.?)\s+", re.I)


def song_names(title: str) -> list[list[str]]:
    """Every song a title names, as words: "Beyoncé, Robin S - Break My Soul x Show Me Love (Mashup)"
    names Break My Soul and Show Me Love. Version tags and featured artists are dropped."""
    text = _BRACKETS.sub("", unicodedata.normalize("NFKC", title or "").casefold())
    names = []
    for part in _TITLE_PARTS.split(text.strip()):
        words = re.findall(r"[^\W_]+", _TITLE_TAIL.sub("", part.strip()))
        if words and words not in names:
            names.append(words)
    return names


def song_sig(t: dict) -> tuple[list[list[str]], set[str]]:
    return song_names(t.get("title", "")), {_key(a) for a in artist_names(t.get("artist", ""))}


def _same_name(wa: list[str], wb: list[str], shared: bool) -> bool:
    if wa == wb:  # a one-word title ("Rise") by someone else is a different song
        return shared or len(wa) >= 2
    short, long_ = (wa, wb) if len(wa) < len(wb) else (wb, wa)
    if shared and long_[:len(short)] == short:  # "Somebody" (2024) vs "Somebody That I Used To Know"
        return True
    # A flip that keeps a 3+ word hook of the title ("USED TO KNOW" by SCXLETTE) is that song again.
    k = len(short)
    return k >= 3 and any(long_[i:i + k] == short for i in range(len(long_) - k + 1))


def same_song(a: tuple[list[list[str]], set[str]], b: tuple[list[list[str]], set[str]]) -> bool:
    shared = bool(a[1] & b[1])
    return any(_same_name(wa, wb, shared) for wa in a[0] for wb in b[0])


def recent_songs(state: dict) -> list[tuple[str, tuple[list[list[str]], set[str]]]]:
    ids = state["played"][-VARIETY_STATION:]
    ids += [r[0] for r in db("SELECT id FROM plays WHERE action='played' ORDER BY at DESC LIMIT ?", (VARIETY_PLAYED,))]
    out = []
    for tid in dict.fromkeys(ids):
        t = track(tid)
        if t:
            out.append((tid, song_sig(t)))
    return out


def _take(sid: str, state: dict, n: int, persist: bool = True, grow: bool = True, hold: bool = False) -> list[dict]:
    taste = taste_profile()
    recent = recent_songs(state)
    out: list[dict] = []
    attempts = 0
    curated = bool(state.get("curated"))  # wizard-music#90: the station rules (station_rule)
    seed_t = track(state["seed"]) if curated else None
    served = served_after_seed(state) if curated else []
    while len(out) < n and attempts < 4:
        attempts += 1
        allowed = station_scripts(state)
        pool = set(state.get("pool") or [])
        later: list[str] = []
        while state["queue"] and len(out) < n:
            tid = state["queue"].pop(0)
            if tid in state["played"] and not (tid in pool and tid not in state["played"][-40:] and tid not in [t["id"] for t in out]):
                continue
            t = track(tid)
            if t and not blocked(t, taste) and not off_station(t, allowed, taste):
                sig = song_sig(t)
                if any(rid != tid and same_song(sig, rsig) for rid, rsig in recent):
                    continue  # another version of a song you just heard
                if seed_t:
                    rule = station_rule(t, state, served, seed_t)
                    if rule == "drop":
                        continue
                    if rule == "later":
                        later.append(tid)
                        continue
                    served.append(t)
                    if later:  # what had to wait gets the next turn
                        state["queue"] = later + state["queue"]
                        later = []
                out.append(t)
                state["played"].append(tid)
                recent.append((tid, sig))
        state["queue"] = later + state["queue"]
        if len(out) < n and later and len(later) == len(state["queue"]):
            state["queue"] = state["queue"][len(later):]  # only songs that must wait are left: grow the station
            state.setdefault("waiting", [])
            state["waiting"] = (later + state["waiting"])[:30]
        if len(out) < n and not grow:
            break  # a look ahead (station_view) shows only what is queued
        if len(out) < n and hold:
            break  # the AI's next picks are on their way: never fill the gap with plain radio
        if len(out) < n:
            # Endless: reseed from the most recent liked track in this station, else a recent track
            # that is not the kind of music you turned down.
            liked = [r[0] for r in db("SELECT id FROM likes WHERE value>0 ORDER BY at DESC LIMIT 20")]
            if pool:  # a collection station grows from your own tracks and brings a few of them back
                seeds = [p for p in pool if fits(p, taste)]
                reseed = random.choice(seeds) if seeds else state["seed"]
                again = [p for p in seeds if p not in state["played"][-40:]]
                random.shuffle(again)
                fresh = [c for c in _radio_from(reseed) if c not in state["played"]]
                mixed = []
                while again or fresh:
                    mixed += again[:1] + fresh[:3]
                    again, fresh = again[1:], fresh[3:]
                state["lastSeed"] = reseed
                state["queue"] = mixed
                if not state["queue"]:
                    break
                continue
            pool_ = [p for p in state["played"][-30:] if p in liked] or [p for p in state["played"][-8:] if fits(p, taste)]
            if curated:  # a curated station grows only from its seed or songs you played through on it
                pool_ = kept_ids(state)[-10:] + [state["seed"]]
            reseed = random.choice(pool_) if pool_ else state["seed"]
            state["lastSeed"] = reseed
            state["queue"] = [c for c in _radio_from(reseed) if c not in state["played"]] + state.pop("waiting", [])
            if not state["queue"]:
                break
    state["played"] = state["played"][-400:]
    if persist:
        db("UPDATE stations SET state=?, at=? WHERE id=?", (json.dumps(state), time.time(), sid))
    if curated or any(score < 0 for score in taste.genre.values()):
        # Learn genres for what was just served and what comes next; the player prunes late finds via `drop`.
        for cid in [t["id"] for t in out] + state["queue"][:12]:
            queue_info(cid)
    return out


def station_more(sid: str, n: int, request_id: str = "") -> list[dict]:
    if request_id and not re.fullmatch(r"[a-f0-9-]{36}", request_id):
        raise ValueError("invalid continuation key")
    loaded = _load_station(sid)
    short = bool(loaded) and len(loaded[1].get("queue") or []) < n
    if loaded and ai_queued(loaded[1]) < n and loaded[1].get("picks") == "ai" and curate_due(loaded[1]):
        start_curating(sid, False)  # the AI's list ran short: ask for more before falling back to plain radio
    in_time = True
    if loaded and (short or loaded[1].get("picks") == "pending"):
        in_time = wait_curating(sid)  # a curated station's picks (wizard-music#90); returns at once when none are coming
    # While the AI's picks are coming (and came in time), a short answer beats padding it with plain radio.
    hold = in_time and bool(loaded) and bool(loaded[1].get("curated")) and sid in _curating
    with _station_lock:
        if request_id:
            cached = db("SELECT station_id,tracks FROM station_batches WHERE request_id=?", (request_id,))
            if cached:
                if cached[0][0] != sid:
                    raise ValueError("continuation belongs to another station")
                return json.loads(cached[0][1])
        rows = db("SELECT state FROM stations WHERE id=?", (sid,))
        if not rows:
            raise LookupError("unknown station")
        state = json.loads(rows[0][0])
        tracks = _take(sid, state, max(1, min(n, 25)), False, **({"hold": True} if hold else {}))
        # Compute outside the DB transaction, commit advancement and receipt atomically.
        with _db_lock, _db as con:
            con.execute("UPDATE stations SET state=?,at=? WHERE id=?", (json.dumps(state), time.time(), sid))
            if request_id and tracks:
                con.execute("INSERT INTO station_batches VALUES(?,?,?,?)", (request_id, sid, json.dumps(tracks), time.time()))
            con.execute("DELETE FROM station_batches WHERE at<?", (time.time() - 7*86400,))
    if ai_queued(state) < CURATE_LOW and curate_due(state):
        start_curating(sid, False)  # endless, still curated: the next picks arrive before the queue runs out
    for t in tracks[:2]:
        prefetch(t["id"])
    return tracks


# ---------------------------------------------------------------- Curated stations (wizard-music#90)
# On for everyone (the app server sends X-Wizard-Music-Curated: 1 on every station start). A song station asks the
# owner's AI, through the Connection Router, for a short sound profile of the seed and songs that match it, picked
# from YouTube Music's radio for the seed plus its own suggestions. Music resolves every suggestion with its own search
# and drops what it cannot find, so nothing unplayable is queued. Coherence rules (station_rule) apply to the AI's list
# and to the plain-radio fallback alike. Only the seed, genre/style tags and artist and song names go to the AI.
CURATE_FEATURE = "curated-radio"
CURATE_FIRST = 25          # songs asked for when a station starts
CURATE_MORE = 15           # songs asked for on each refill
CURATE_LOW = 12            # refill in the background once fewer than this are queued
CURATE_WAIT = float(os.environ.get("WIZARD_MUSIC_CURATE_WAIT_SECONDS", "45"))
CURATE_TIMEOUT = float(os.environ.get("WIZARD_MUSIC_CURATE_TIMEOUT_SECONDS", "25"))
SEED_ARTIST_CAP = 2        # seed artist at most this often in any 15 after the seed
LIKED_EVERY = 8            # at most one liked song in any 8
ROUTER_SLOT = "slot:connection-router"
_curating: dict[str, threading.Event] = {}
_curating_lock = threading.Lock()

# Families that never belong on a station whose seed is not one of them (anime in a techno station, the Backrooms
# soundtrack in a Trap station). Matched against the genre Music knows, the artist's style tags and the title.
ODD_FAMILIES = {
    "anime": re.compile(r"\banime\b|\banimation\b|アニメ|\bost\b|\bvocaloid\b", re.I),
    "score": re.compile(r"\bsoundtrack\b|\bscore\b|\bvideo game\b|\bgame music\b|\boriginal motion picture\b|"
                        r"\bfrom the (?:game|film|movie|series)\b|\bbackrooms\b|\bkane parsons\b", re.I),
    "lofi": re.compile(r"\blo-?fi\b(?! house)|\bchillhop\b|\bbeats to (?:study|relax|sleep)\b|\bstudy beats\b", re.I),
    "children": re.compile(r"\bchildren'?s\b|\bkids\b|\bnursery\b|\blullab(?:y|ies)\b", re.I),
    "comedy": re.compile(r"\bcomedy\b|\bstand-?up\b|\bparody\b", re.I),
    "chart": re.compile(r"\bk-?pop\b|\bj-?pop\b|\bt-?pop\b|\bchristmas\b|\bholiday\b", re.I),
}


# A game's or film's original score, named on the album: never on a station whose seed is not one, AI pick or not.
SCORE_ALBUM = re.compile(r"\boriginal (?:game |video game |motion picture |television |anime |series )?(?:sound ?track|score)\b|"
                         r"\bgame sound ?track\b|\bost\b|\bsound ?track from\b", re.I)


def odd_families(t: dict, picked: bool = False) -> set[str]:
    """The off-profile families a track belongs to ('anime', 'score', ...), from what Music already knows.

    picked: the AI suggested this song itself (not a radio candidate it kept). A film's song (Sky and Sand, on Berlin Calling's soundtrack album) is filed
    under the genre Soundtrack, so for the AI's own picks only the title, the artist and strong style tags can make a
    song a score; the other families still count the genre."""
    tags = " | ".join(sorted(tag for name in artist_names(t.get("artist", "")) for tag, w in (artist_styles(_key(name)) or {}).items() if w >= 0.5))
    strong = f"{tags} | {t.get('title', '')} | {t.get('artist', '')}"
    weak = f"{genre_of(t['id'])} | {t.get('album', '')}"
    found = {name for name, rx in ODD_FAMILIES.items() if rx.search(strong) or (not (picked and name == "score") and rx.search(weak))}
    if SCORE_ALBUM.search(t.get("album", "")):
        found.add("score")
    return found


def _artist_keys(t: dict | None) -> set[str]:
    return {_key(a) for a in artist_names((t or {}).get("artist", ""))} - NOT_ARTISTS


def station_rule(t: dict, state: dict, served: list[dict], seed: dict) -> str:
    """'ok', 'drop' (never on this station) or 'later' (fine, just not right now) for one candidate.

    served: the songs this station served after the seed, oldest first, including this batch so far."""
    allowed = state.setdefault("families", sorted(odd_families(seed)))
    if odd_families(t, t["id"] in set(state.get("aiOwn") or [])) - set(allowed):
        return "drop"
    mine = _artist_keys(t)
    if served and mine & _artist_keys(served[-1]):
        return "later"  # no artist twice in a row
    window = served[-14:]
    if mine & _artist_keys(seed) and sum(1 for s in window if _artist_keys(s) & _artist_keys(seed)) >= SEED_ARTIST_CAP:
        return "later"  # the seed artist at most 2 in every 15
    if t.get("liked") and any(s.get("liked") for s in served[-(LIKED_EVERY - 1):]):
        return "later"  # liked songs at most 1 in 8
    return "ok"


def served_after_seed(state: dict) -> list[dict]:
    ids = [x for x in state["played"] if x != state["seed"]][-14:]
    return [t for t in (track(x) for x in ids) if t]


class CurateUnavailable(Exception):
    """No AI connection for this app, or it failed: the station falls back to radio with the rules applied."""


def router_target() -> tuple[str, str] | None:
    """Where this app's Connection Router answers and its grant key (wizard-os spec/PERMISSIONS.md), else None."""
    url = os.environ.get("WIZARD_MUSIC_ROUTER_URL", "").strip()
    key = ""
    path = os.environ.get("WIZARD_GRANTS_FILE", "").strip()
    if path:
        try:
            grants = json.loads(Path(path).read_text())
            key = str((grants.get("outgoing") or {}).get(ROUTER_SLOT) or "")
            url = url or str((grants.get("provider_endpoints") or {}).get(ROUTER_SLOT) or "")
        except (OSError, ValueError, AttributeError):
            pass
    if not url.startswith(("http://", "https://")):
        return None
    return url.rstrip("/"), key


def ask_model(system: str, prompt: str, max_tokens: int = 1800) -> dict:
    """One isolated run of this app's curated-radio feature through the Connection Router; the JSON it answered."""
    target = router_target()
    if not target:
        raise CurateUnavailable("no AI connection")
    url, key = target
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream", "X-Wizard-App": "wizard-music"}
    if key:
        headers["X-Wizard-Grant"] = key
    body = json.dumps({"system": system, "messages": [{"role": "user", "content": prompt}],
                       "max_tokens": max_tokens, "stream": True}).encode()
    req = urllib.request.Request(f"{url}/v1/models/{CURATE_FEATURE}/run", data=body, headers=headers, method="POST")
    text, done = [], False
    try:
        with urllib.request.urlopen(req, timeout=CURATE_TIMEOUT) as res:
            for raw in res:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                event = json.loads(line[5:].strip() or "{}")
                kind = event.get("type")
                if kind in ("delta", "text") and isinstance(event.get("text"), str):
                    text.append(event["text"])
                elif kind == "error":
                    raise CurateUnavailable(str(event.get("code") or "provider_error"))
                elif kind == "done":
                    done = True
                    break
    except CurateUnavailable:
        raise
    except Exception as exc:  # router down, timeout, malformed stream
        raise CurateUnavailable(type(exc).__name__) from None
    if not done:
        raise CurateUnavailable("no answer")  # provisional text without the router's done is discarded
    answer = "".join(text)
    start, end = answer.find("{"), answer.rfind("}")
    try:
        value = json.loads(answer[start:end + 1]) if 0 <= start < end else None
    except ValueError:
        value = None
    if not isinstance(value, dict):
        raise CurateUnavailable("not json")
    return value


CURATE_SYSTEM = (
    "You are a music curator for one listener. They started a station from one song because they love its sound "
    "and want more songs that sound like it: a curated list, not generic radio. Reply with one JSON object only.")


def _liked_artists_like(seed: dict, limit: int = 15) -> list[str]:
    """Names of artists you liked whose styles share one with the seed's (names only)."""
    want = {tag for tag, w in track_styles(seed).items() if w >= 0.5}
    out, seen = [], _artist_keys(seed)
    for (artist,) in db("SELECT t.artist FROM likes l JOIN tracks t ON t.id=l.id WHERE l.value>0 ORDER BY l.at DESC LIMIT 300"):
        for name in artist_names(artist or ""):
            key = _key(name)
            if key in seen:
                continue
            tags = artist_styles(key) or {}
            if want and any(w >= 0.5 and tag in want for tag, w in tags.items()):
                seen.add(key)
                out.append(name)
    return out[:limit]


def _avoid_artists(limit: int = 15) -> list[str]:
    out, seen = [], set()
    for (artist,) in db("SELECT t.artist FROM likes l JOIN tracks t ON t.id=l.id WHERE l.value<0 ORDER BY l.at DESC LIMIT 60"):
        for name in artist_names(artist or ""):
            if _key(name) not in seen:
                seen.add(_key(name))
                out.append(name)
    return out[:limit]


def kept_ids(state: dict) -> list[str]:
    """Songs on this station you played through (the only ones a curated station may grow from)."""
    ids = set(state["played"])
    rows = db("SELECT DISTINCT id FROM plays WHERE at>=? AND action='played'", (float(state.get("at0") or 0),))
    return [r[0] for r in rows if r[0] in ids]


def station_heard(state: dict) -> tuple[list[dict], list[dict]]:
    """Songs on this station you played through, and songs you skipped (titles and artists, no times)."""
    since = float(state.get("at0") or 0)
    ids = set(state["played"]) - {state["seed"]}
    kept, skipped, seen = [], [], set()
    for tid, action in db("SELECT id, action FROM plays WHERE at>=? ORDER BY at", (since,)):
        t = track(tid) if tid in ids and (tid, action) not in seen else None
        seen.add((tid, action))
        if t:
            row = {"title": t["title"], "artist": t["artist"], "styles": sorted(track_styles(t))[:4]}
            (kept if action == "played" else skipped).append(row)
    return kept[-20:], skipped[-20:]


def curate_prompt(seed: dict, candidates: list[dict], state: dict, want: int, related: list[str] | None = None) -> str:
    kept, skipped = station_heard(state)
    styles = [tag for tag, w in sorted(track_styles(seed).items(), key=lambda x: -x[1]) if w >= 0.3][:8]
    ask = {
        "seed": {"title": seed["title"], "artist": seed["artist"], "genre": genre_of(seed["id"]), "styles": styles},
        "listener_note": str(state.get("note") or "")[:500],
        "profile_so_far": state.get("profile") or "",
        "liked_artists_in_this_style": _liked_artists_like(seed),
        "avoid_artists": _avoid_artists(),
        "related_artists": related if related is not None else (related_artists(seed["artist"])[:12] if ONLINE else []),
        "candidates": [{"ref": f"c{i}", "title": c["title"], "artist": c["artist"]} for i, c in enumerate(candidates)],
        "played_through_on_this_station": kept,
        "skipped_on_this_station": skipped,
        "already_on_this_station": [f"{t['title']} · {t['artist']}" for t in served_after_seed(state)],
    }
    return (
        f"Pick {want} songs that sound like the seed, in play order.\n"
        "1. profile: one line (at most 90 characters) naming the seed's sound, e.g. "
        "\"Hypnotic melodic techno: warm arpeggios, slow builds, Kompakt-style\". Keep profile_so_far if it is set.\n"
        "2. songs: keep candidates that fit the profile ({\"ref\": \"c3\"}) and add real, released songs you know "
        "({\"artist\": \"...\", \"title\": \"...\"}). Leave out every candidate that does not fit.\n"
        "Rules: nothing from anime, game or film scores, lo-fi, children's music, comedy or chart filler unless the "
        "seed is that itself; the seed's artist at most 2 times; never the same artist twice in a row; nothing by "
        "avoid_artists; nothing in already_on_this_station. Lean towards what was played through; steer away from "
        "the sound of skipped songs, and drop a sub-style entirely once two songs of it were skipped.\n"
        "Reply exactly: {\"profile\": \"...\", \"songs\": [{\"ref\": \"c0\"}, {\"artist\": \"...\", \"title\": \"...\"}]}\n\n"
        + json.dumps(ask, ensure_ascii=False))


def _library_like(q: str) -> list[dict]:
    like = f"%{q}%"
    rows = db("SELECT id FROM tracks WHERE source='library' AND (title LIKE ? OR artist LIKE ?) LIMIT 8", (like, like))
    return [t for t in (track(r[0]) for r in rows) if t]


def _pick_search(artist: str, title: str) -> list[dict]:
    """One quick lookup for a model's pick: your library (by title), then one songs search on the music source."""
    out = _library_like(title)
    if ONLINE:
        try:
            out += [t for t in (remember_yt(i) for i in (ytm().search(f"{artist} {title}", filter="songs", limit=5) or [])[:5]) if t]
        except Exception as exc:
            print("pick search failed", repr(exc), file=sys.stderr)
    return out


def resolve_pick(artist: str, title: str) -> dict | None:
    """A model's suggestion as a playable track, or None when Music can't find that song by that artist."""
    artist, title = str(artist or "").strip()[:120], str(title or "").strip()[:200]
    if not artist or not title:
        return None
    try:
        mine = [t for t in by_artist(_pick_search(artist, title), artist) if t]
    except Exception:
        return None
    best, score = None, 0.0
    for t in mine:
        s = heard_like(_clean_title(title).lower(), _clean_title(t["title"]).lower())
        if s > score:
            best, score = t, s
    return prefer_library(best) if best and score >= 0.6 else None


CURATE_BATCH = 10  # the first picks are queued as soon as these are looked up; the rest follow


def answer_slots(answer: dict, candidates: list[dict]) -> tuple[str, list]:
    """(profile, the model's songs in order: candidate tracks, or (artist, title) picks still to look up)."""
    profile = re.sub(r"\s+", " ", str(answer.get("profile") or "")).strip()[:140]
    songs = answer.get("songs") if isinstance(answer.get("songs"), list) else []
    refs = {f"c{i}": c for i, c in enumerate(candidates)}
    slots: list = []
    for item in songs[:40]:
        if not isinstance(item, dict):
            continue
        if item.get("ref") in refs:
            slots.append(refs[item["ref"]])
        elif item.get("artist") and item.get("title"):
            slots.append((str(item["artist"]), str(item["title"])))
    return profile, slots


RESOLVE_DEADLINE = float(os.environ.get("WIZARD_MUSIC_RESOLVE_SECONDS", "20"))


def resolve_slots(slots: list, publish=None, batch: int = CURATE_BATCH) -> tuple[list[str], int, list[str]]:
    """Look the picks up in parallel, in order; publish(ids, own) once the first `batch` are known, so they can play
    while the rest are found. Picks not found within RESOLVE_DEADLINE are dropped. Returns (all track ids in order,
    how many picks could not be found, the ids the AI suggested itself rather than kept from the radio candidates)."""
    from concurrent.futures import ThreadPoolExecutor
    ids, own, missed, published = [], [], 0, False
    deadline = time.monotonic() + RESOLVE_DEADLINE
    pool = ThreadPoolExecutor(max_workers=10)
    try:
        futures = [pool.submit(resolve_pick, *s) if isinstance(s, tuple) else None for s in slots]
        for i, (s, fut) in enumerate(zip(slots, futures)):
            try:
                t = s if fut is None else fut.result(timeout=max(0.0, deadline - time.monotonic()))
            except Exception:
                t = None
            if not t:
                missed += 1
            elif t["id"] not in ids:
                ids.append(t["id"])
                if fut is not None:
                    own.append(t["id"])
            if publish and not published and i + 1 >= min(batch, len(slots)):
                published = True
                publish(list(ids), list(own))
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    return ids, missed, own


def curated_list(answer: dict, candidates: list[dict]) -> tuple[str, list[str], int]:
    """(profile, track ids in order, how many suggestions could not be found) from the model's answer."""
    profile, slots = answer_slots(answer, candidates)
    ids, missed, _ = resolve_slots(slots)
    return profile, ids, missed


def station_card(sid: str, title: str, state: dict) -> dict:
    out = {"id": sid, "title": title, "more": f"{PUBLIC_PREFIX}/api/station/{sid}/more"}
    if state.get("curated"):
        out.update(picks=state.get("picks", "pending"), profile=state.get("profile", ""))
    return out


def _load_station(sid: str) -> tuple[str, dict] | None:
    rows = db("SELECT title, state FROM stations WHERE id=?", (sid,))
    return (rows[0][0], json.loads(rows[0][1])) if rows else None


def _release(sid: str) -> None:
    """Let the station's waiting /more calls go on (the AI's first picks are queued, or there won't be any)."""
    with _curating_lock:
        ev = _curating.get(sid)
    if ev:
        ev.set()


def _queue_picks(sid: str, ids: list[str], profile: str, final: bool, own: list[str] | None = None) -> None:
    """Queue the AI's picks right after the ones already queued from this answer. Once the AI has picked, plain radio
    that filled a gap leaves the queue, so the station never drifts back to raw radio."""
    with _station_lock:
        loaded = _load_station(sid)
        if not loaded:
            return
        _, state = loaded
        ai = set(state.get("ai") or []) | set(ids)
        if ids:
            queued = [q for q in state["queue"] if q in ai]
            fresh = [i for i in ids if i not in state["played"] and i not in queued]
            at = max((queued.index(i) + 1 for i in ids if i in queued), default=0)
            state["queue"] = queued[:at] + fresh + queued[at:]
            state["ai"] = (list(state.get("ai") or []) + [i for i in ids if i not in (state.get("ai") or [])])[-400:]
            state["aiOwn"] = (list(state.get("aiOwn") or []) + [i for i in own or [] if i not in (state.get("aiOwn") or [])])[-400:]
            state["picks"] = "ai"
            state["profile"] = state.get("profile") or profile
        if final:
            news = [i for i in ids if i not in state["played"]]
            state["dryAt"] = 0 if news else time.time()  # nothing new: don't ask again for a while (curate_due)
        db("UPDATE stations SET state=?, at=? WHERE id=?", (json.dumps(state), time.time(), sid))


def ai_queued(state: dict) -> int:
    """How many of the AI's picks are still queued (all of the queue for a station without them)."""
    queue = state.get("queue") or []
    if state.get("picks") != "ai":
        return len(queue)
    ai = set(state.get("ai") or [])
    return sum(1 for q in queue if q in ai)


def curate(sid: str, first: bool) -> None:
    """Ask the AI for this station's next songs and queue them (background thread; the seed is already playing)."""
    from concurrent.futures import ThreadPoolExecutor
    try:
        loaded = _load_station(sid)
        if not loaded:
            return
        _, state = loaded
        seed = track(state["seed"])
        if not seed:
            return
        base = state["seed"] if first else random.choice(kept_ids(state) or [state["seed"]])
        with ThreadPoolExecutor(max_workers=2) as pool:  # radio candidates and related artists at the same time
            radio_f = pool.submit(_radio_from, base)
            related_f = pool.submit(lambda: related_artists(seed["artist"])[:12] if ONLINE else [])
            radio_ids, related = radio_f.result(), related_f.result()
        radio = [t for t in (track(c) for c in radio_ids[:40]) if t and t["id"] not in state["played"]]
        try:
            answer = ask_model(CURATE_SYSTEM, curate_prompt(seed, radio, state, CURATE_FIRST if first else CURATE_MORE, related))
            profile, slots = answer_slots(answer, radio)
            ids, missed, own = resolve_slots(slots, lambda got, mine: (_queue_picks(sid, got, profile, False, mine), got and _release(sid)))
            _queue_picks(sid, ids, profile, True, own)
            print(f"curated station {sid}: {len(ids)} queued, {missed} not found", file=sys.stderr)
            if ids:
                return
        except CurateUnavailable as exc:
            print(f"curated station {sid}: radio fallback ({exc})", file=sys.stderr)
        with _station_lock:  # no AI picks: plain radio for the seed (or a song you kept), served by the station rules
            loaded = _load_station(sid)
            if not loaded:
                return
            _, state = loaded
            if first or state.get("picks") != "ai":
                state["picks"] = "radio"
            state["queue"] = state["queue"] + [t["id"] for t in radio if t["id"] not in state["queue"]]
            db("UPDATE stations SET state=?, at=? WHERE id=?", (json.dumps(state), time.time(), sid))
    except Exception as exc:
        print("curate failed", sid, repr(exc), file=sys.stderr)
    finally:
        loaded = _load_station(sid)
        for cid in (loaded[1]["queue"][:20] if loaded else []):
            queue_info(cid)  # learn genres, so the family rule knows them by the time they are served
            queue_styles_for(cid)
        with _curating_lock:
            ev = _curating.pop(sid, None)
        if ev:
            ev.set()


def curate_due(state: dict) -> bool:
    """A curated station may ask the AI for more: it is curated, has a router, and the last answer brought news."""
    return bool(state.get("curated")) and time.time() - float(state.get("dryAt") or 0) > 300 and bool(router_target())


def start_curating(sid: str, first: bool) -> bool:
    with _curating_lock:
        if sid in _curating:
            return False
        _curating[sid] = threading.Event()
    threading.Thread(target=curate, args=(sid, first), daemon=True).start()
    return True


def wait_curating(sid: str, timeout: float | None = None) -> bool:
    """Wait for a station's AI picks to be queued; False when they did not come in time."""
    with _curating_lock:
        ev = _curating.get(sid)
    return ev.wait(CURATE_WAIT if timeout is None else timeout) if ev else True


def wait_curated(sid: str, timeout: float | None = None) -> None:
    """Wait until the station's AI answer is fully looked up (station_curate reads back what will play)."""
    end = time.monotonic() + (CURATE_WAIT if timeout is None else timeout)
    while time.monotonic() < end:
        with _curating_lock:
            if sid not in _curating:
                return
        time.sleep(0.2)


def curated_station(first: dict, note: str = "") -> dict:
    """Start a 'more like this' station: the seed plays at once; the AI's picks follow (wizard-music#90)."""
    tid = first["id"]
    title = f"Like {first['title']} · {first['artist']}"[:200]
    state = {"seed": tid, "queue": [], "played": [tid], "lastSeed": tid, "curated": True, "at0": time.time(),
             "note": str(note or "")[:500], "profile": "", "picks": "pending"}
    state["families"] = sorted(odd_families(first))
    sid = uuid.uuid4().hex[:16]
    queue_styles_for(tid)
    if not router_target():
        # No AI connection: today's radio, with the station rules, and the header says so.
        state.update(picks="radio", queue=[c for c in _radio_from(tid) if c != tid])
        db("INSERT INTO stations(id,title,seed,state,at) VALUES(?,?,?,?,?)", (sid, title, tid, json.dumps(state), time.time()))
        with _station_lock:
            tracks = [first] + _take(sid, state, 14)
        for t in tracks[:3]:
            prefetch(t["id"])
        return {"station": station_card(sid, title, state), "tracks": tracks}
    db("INSERT INTO stations(id,title,seed,state,at) VALUES(?,?,?,?,?)", (sid, title, tid, json.dumps(state), time.time()))
    start_curating(sid, True)
    prefetch(tid)
    return {"station": station_card(sid, title, state), "tracks": [first]}


def station_view(sid: str, wait: bool = False, peek: int = 10) -> dict:
    """A station's header (title, profile, picks), its seed and the next songs it will serve (not consumed)."""
    if wait:
        wait_curating(sid)
        if peek:
            wait_curated(sid)  # the read-back lists every song the AI's answer queued, not only the first ones
    loaded = _load_station(sid)
    if not loaded:
        raise LookupError("unknown station")
    title, state = loaded
    with _station_lock:
        upcoming = _take(sid, json.loads(json.dumps(state)), max(0, min(peek, 25)), persist=False, grow=False) if peek else []
    return {"station": station_card(sid, title, state), "seed": track(state["seed"]), "tracks": upcoming}


def record_play(tid: str, action: str, event_id: str = "") -> bool:
    """One play/skip per native transition, even across retries and view reloads."""
    if event_id and (not re.fullmatch(r"[a-f0-9-]{36}:[a-f0-9-]{36}:(played|skipped)", event_id) or event_id.rsplit(":", 1)[-1] != action):
        raise ValueError("invalid playback event")
    with _db_lock, _db as con:
        if event_id:
            previous = con.execute("SELECT id,action FROM playback_events WHERE event_id=?", (event_id,)).fetchone()
            if previous:
                if previous != (tid, action):
                    raise ValueError("conflicting playback event")
                return False
            con.execute("INSERT INTO playback_events VALUES(?,?,?,?)", (event_id, tid, action, time.time()))
        con.execute("INSERT INTO plays(id,at,action) VALUES(?,?,?)", (tid, time.time(), action))
        return True


# ---------------------------------------------------------------- Audio cache
_dl_locks: dict[str, threading.Lock] = {}
_dl_guard = threading.Lock()


# Opus audio (wizard-os#820, switch opus-audio): the app server asks for YouTube's Opus stream (X-Wizard-Music-Codec:
# opus) only for a player that can decode it. Each song then has two cache variants side by side: <id>.m4a (AAC, every
# player, as before) and <id>.webm (Opus). An AAC request never gets the webm, so Safari and Apple's players stay safe.
CODEC_EXTS = {"aac": ("m4a", "mp3"), "opus": ("webm", "opus")}
_no_opus: set[str] = set()  # songs YouTube has no Opus for: the connector sent AAC, so an Opus request reuses <id>.m4a
_prefetch_codec = ["aac"]  # the variant the last player asked for, so songs fetched ahead match it


def _codec(value) -> str:
    return "opus" if value == "opus" else "aac"


def _cache_path(vid: str, codec: str = "aac") -> Path | None:
    base = os.path.realpath(str(CACHE)) + os.sep
    if codec == "opus" and vid in _no_opus:
        codec = "aac"
    for ext in CODEC_EXTS[_codec(codec)]:
        # Checked inline (not via a helper) so code scanning sees the guard on every caller.
        full = os.path.realpath(str(CACHE / f"{vid}.{ext}"))
        if not full.startswith(base):
            return None
        p = Path(full)
        if p.exists() and p.stat().st_size > 0:
            return p
    return None


FFMPEG = os.environ.get("WIZARD_MUSIC_FFMPEG", "ffmpeg")
_remux_failed: set[str] = set()


def _inside(path: Path, root: Path) -> Path | None:
    """The real path when it sits inside root (the audio cache), else None."""
    full = os.path.realpath(str(path))
    base = os.path.realpath(str(root))
    return Path(full) if full.startswith(base + os.sep) else None


def is_fragmented_mp4(path: Path) -> bool:
    """True for DASH-style MP4 audio (top-level moof boxes), which is how YouTube serves its m4a.

    Safari and the Mac app's WebKit read such a file as about twice its real length: the song
    ends halfway through the bar and the rest is silence before the next track starts.
    """
    safe = _inside(path, CACHE)
    if safe is None:
        return False
    try:
        size_total = safe.stat().st_size
        with safe.open("rb") as fh:
            pos = 0
            for _ in range(64):  # top-level boxes only; moof comes right after moov/sidx
                head = fh.read(16)
                if len(head) < 8:
                    return False
                size, kind = int.from_bytes(head[:4], "big"), head[4:8]
                if kind == b"moof":
                    return True
                if kind == b"mdat":
                    return False  # plain file: samples without fragments
                if size == 1 and len(head) == 16:
                    size = int.from_bytes(head[8:16], "big")
                if size < 8 or pos + size > size_total:
                    return False
                pos += size
                fh.seek(pos)
    except OSError:
        return False
    return False


def remux_plain(path: Path) -> Path:
    """Rewrite fragmented MP4 audio as a plain MP4 in place (stream copy, no re-encode).

    Every browser then reports the real length, so the next song starts when this one ends and
    the seek bar maps to the real song. Leaves the file alone when it is already plain or ffmpeg
    is missing or fails; the song still plays as before.
    """
    safe = _inside(path, CACHE)
    if safe is None or safe.suffix.lower() not in (".m4a", ".mp4") or safe.name in _remux_failed or not is_fragmented_mp4(safe):
        return path
    out = safe.with_name(f".{safe.stem.lstrip('.')}.{uuid.uuid4().hex[:6]}.plain.m4a")
    try:
        proc = subprocess.run([FFMPEG, "-nostdin", "-v", "error", "-y", "-i", str(safe), "-map", "0:a:0",
                               "-c", "copy", "-movflags", "+faststart", str(out)], capture_output=True, timeout=120)
        ok = proc.returncode == 0 and out.exists() and out.stat().st_size >= safe.stat().st_size // 2 and not is_fragmented_mp4(out)
        if not ok:
            print("remux failed", safe.name, (proc.stderr or b"")[-300:].decode("utf-8", "replace"), file=sys.stderr)
            _remux_failed.add(safe.name)
            out.unlink(missing_ok=True)
            return path
        os.replace(out, safe)
    except (OSError, subprocess.SubprocessError) as exc:
        print("remux failed", safe.name, repr(exc), file=sys.stderr)
        _remux_failed.add(safe.name)
        out.unlink(missing_ok=True)
    return path


# ---- Progressive play (wizard-music#46, on for everyone) ----
# The app server asks for every song with X-Wizard-Music-Live: 1. The hub then answers as soon as the
# first bytes of the download are on disk and keeps sending while the rest arrives (seeking ahead waits for its bytes).
# A song a live player has open keeps its downloaded bytes: the plain-MP4 rewrite waits until nobody has asked for it
# for LIVE_KEEP_SECONDS, so the bytes under a playing song never change.
LIVE_FIRST_BYTES = 64 * 1024
LIVE_KEEP_SECONDS = float(os.environ.get("WIZARD_MUSIC_LIVE_KEEP_SECONDS", "1800"))
LIVE_STALL_SECONDS = 120.0


class LiveDownload:
    """One running download that live players read while it grows."""

    def __init__(self):
        self.cond = threading.Condition()
        self.path: Path | None = None
        self.final: Path | None = None
        self.total: int | None = None
        self.written = 0
        self.done = self.failed = self.attached = self.remuxing = False

    ctype: str | None = None  # what the source sent, for an Opus download (wizard-os#820); None: audio/mp4 as before

    def begin(self, path: Path, total: int | None, ctype: str | None = None):
        with self.cond:
            self.path, self.total, self.written, self.ctype = path, total, 0, ctype
            self.cond.notify_all()

    def grew(self, n: int):
        with self.cond:
            self.written += n
            self.cond.notify_all()

    def finish(self, final: Path | None = None):
        with self.cond:
            if not self.done:
                self.final = final if final is not None else self.final
                self.done, self.failed = True, final is None and self.final is None
                self.cond.notify_all()

    def attach(self) -> bool:
        """Read it live, unless the finished file is already being rewritten."""
        with self.cond:
            if self.remuxing:
                return False
            self.attached = True
            return True

    def claim_remux(self, vid: str) -> bool:
        with self.cond:
            if self.attached or _live_kept(vid):
                return False
            self.remuxing = True
            return True

    def wait(self, test, timeout: float) -> bool:
        with self.cond:
            return self.cond.wait_for(lambda: test() or self.done, timeout)


_live: dict[str, LiveDownload] = {}
_live_read: dict[str, float] = {}


def _live_kept(vid: str) -> bool:
    return time.time() - _live_read.get(vid, 0.0) < LIVE_KEEP_SECONDS


def _variant(vid: str, codec: str) -> str:
    """Lock and live-download key of one cache variant: the plain id for AAC (as before), <id>.opus for Opus."""
    return f"{vid}.opus" if codec == "opus" else vid


def fetch_audio(vid: str, live: bool = False, codec: str = "aac") -> Path:
    if not ONLINE:
        raise LookupError("online sources disabled")
    m = YT_ID.fullmatch(vid or "")
    if not m:
        raise LookupError("bad id")
    vid = m.group(0)  # only [A-Za-z0-9_-]{11} from here on; never a path
    codec = _codec(codec)
    key = _variant(vid, codec)
    hit = _cache_path(vid, codec)
    if hit and (hit.name in _remux_failed or _live_kept(vid) or not is_fragmented_mp4(hit)):
        os.utime(hit)
        return hit
    with _dl_guard:
        lock = _dl_locks.setdefault(key, threading.Lock())
    with lock:
        with _dl_guard:
            dl = _live.setdefault(key, LiveDownload())
        made = None
        try:
            made = _download_locked(vid, live, dl, codec)
            return made
        finally:
            with _dl_guard:
                if _live.get(key) is dl:
                    del _live[key]
            dl.finish(made)


def _download_locked(vid: str, live: bool, dl: LiveDownload, codec: str = "aac") -> Path:
    hit = _cache_path(vid, codec)
    if hit:
        # Songs cached before the fix are still fragmented; fix each once, on its next play.
        return remux_plain(hit) if dl.claim_remux(vid) else hit
    opus = codec == "opus"
    full = os.path.realpath(str(CACHE / f".{vid}.{uuid.uuid4().hex[:6]}.{'webm' if opus else 'm4a'}"))
    if not full.startswith(os.path.realpath(str(CACHE)) + os.sep):
        raise LookupError("bad id")
    tmp = Path(full)
    query = "&".join(([] if not live else ["live=1"]) + (["codec=opus"] if opus else []))
    url = source_for(f"yt:{vid}").rstrip("/") + f"/api/music/audio/{vid}" + (f"?{query}" if query else "")
    sent_aac = False
    for attempt in range(len(AUDIO_RETRY_DELAYS) + 1):
        try:
            with online_urlopen(url, timeout=170) as r, tmp.open("wb") as out:
                length = r.headers.get("Content-Length") or ""
                ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                sent_aac = opus and ctype == "audio/mp4"  # YouTube has no Opus for this song: the connector sent AAC
                dl.begin(tmp, int(length) if length.isdigit() else None, (ctype or "audio/webm") if opus else None)
                read = getattr(r, "read1", r.read)
                while chunk := read(262144):
                    out.write(chunk)
                    out.flush()
                    dl.grew(len(chunk))
            if dl.total is not None and dl.written != dl.total:
                raise RuntimeError("download cut short")
            break
        except urllib.error.HTTPError as exc:
            tmp.unlink(missing_ok=True)
            _source_status.clear()  # the connector recorded why; re-read it for the home screen
            if exc.code == 502 and attempt < len(AUDIO_RETRY_DELAYS):
                print("audio blocked, retrying", vid, attempt + 1, file=sys.stderr)
                time.sleep(AUDIO_RETRY_DELAYS[attempt])
                continue
            raise RuntimeError("blocked" if exc.code == 502 else f"source answered {exc.code}") from None
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
    if not ONLINE or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError("download failed")
    if sent_aac:
        full = os.path.realpath(str(CACHE / f".{vid}.{uuid.uuid4().hex[:6]}.m4a"))
        if not full.startswith(os.path.realpath(str(CACHE)) + os.sep):
            raise LookupError("bad id")
        aac = Path(full)
        with dl.cond:
            tmp.replace(aac)  # under the lock, so a live reader that misses the old name finds dl.final below
            dl.path = aac
        tmp = aac
        _no_opus.add(vid)
    made = [remux_plain(tmp) if dl.claim_remux(vid) else tmp]
    final = CACHE / f"{vid}{made[0].suffix}"
    with dl.cond:
        dl.final = final  # set before the rename, so a reader that misses the temp name finds this one
    made[0].replace(final)
    _evict()
    return final


def live_audio(vid: str, codec: str = "aac") -> Path | LiveDownload:
    """The song file, or its running download once the first bytes are in (wizard-music#46)."""
    if not ONLINE:
        raise LookupError("online sources disabled")
    m = YT_ID.fullmatch(vid or "")
    if not m:
        raise LookupError("bad id")
    vid = m.group(0)
    codec = _codec(codec)
    key = _variant(vid, codec)
    _live_read[vid] = time.time()  # first: no rewrite may start under this player from now on
    with _dl_guard:
        dl = _live.get(key)
        if dl is None and not _cache_path(vid, codec):
            dl = _live[key] = LiveDownload()
            threading.Thread(target=_live_worker, args=(vid, dl, codec), daemon=True).start()
    if dl is None or not dl.attach():
        if dl is not None:
            dl.wait(lambda: False, 300)
        return fetch_audio(vid, codec=codec)
    dl.wait(lambda: dl.written >= LIVE_FIRST_BYTES, 300)
    if dl.total is None or not dl.written:
        dl.wait(lambda: False, 300)  # no size known: the whole file first, as before
        if dl.failed or not dl.final:
            raise RuntimeError("download failed")
        return dl.final
    if dl.failed:
        raise RuntimeError("download failed")
    return dl.final if dl.done else dl


def _live_worker(vid: str, dl: LiveDownload, codec: str = "aac"):
    made = None
    key = _variant(vid, codec)
    try:
        made = fetch_audio(vid, live=True, codec=codec)
    except Exception as exc:
        print("live download failed", vid, exc, file=sys.stderr)
    finally:
        with _dl_guard:
            if _live.get(key) is dl:
                del _live[key]
        dl.finish(made)


REMUX_IDLE_EVERY = float(os.environ.get("WIZARD_MUSIC_REMUX_IDLE_SECONDS", "300"))


def remux_idle() -> int:
    """Rewrite cached songs that live players left fragmented, once nobody is playing them (try-wizard#141).

    Every play is live since 0.2.0-test.22, so a play never rewrites the song it opens (see LiveDownload). Without
    this pass those songs stayed fragmented for good and Safari/the Mac app kept playing a minute of silence at their
    end. A song is idle when no live download runs for it, no player asked for it for LIVE_KEEP_SECONDS and its file
    was not touched for that long either (that last test also covers the first pass after a hub restart).
    Returns how many songs were rewritten.
    """
    fixed = 0
    quiet_since = time.time() - LIVE_KEEP_SECONDS
    try:
        names = sorted(p.name for p in CACHE.iterdir())
    except OSError:
        return 0
    for name in names:
        stem, dot, ext = name.rpartition(".")
        if not dot or ext.lower() != "m4a" or not YT_ID.fullmatch(stem) or name in _remux_failed:
            continue
        with _dl_guard:
            if stem in _live:
                continue
            lock = _dl_locks.setdefault(stem, threading.Lock())
        if not lock.acquire(blocking=False):
            continue  # a download or play holds it right now; try again next pass
        try:
            hit = _cache_path(stem)
            if hit is None or hit.suffix != ".m4a" or _live_kept(stem) or hit.stat().st_mtime > quiet_since:
                continue
            if not is_fragmented_mp4(hit):
                continue
            remux_plain(hit)
            if not is_fragmented_mp4(hit):
                fixed += 1
        except OSError:
            continue
        finally:
            lock.release()
    return fixed


def _remux_loop():
    while True:
        time.sleep(REMUX_IDLE_EVERY)
        try:
            n = remux_idle()
            if n:
                print("rewrote", n, "songs as plain audio", file=sys.stderr, flush=True)
        except Exception as exc:  # keep going
            print("idle rewrite failed", exc, file=sys.stderr)


def _evict():
    files = [p for p in CACHE.iterdir() if p.is_file() and not p.name.startswith(".")]
    total = sum(p.stat().st_size for p in files)
    for p in sorted(files, key=lambda p: p.stat().st_mtime):
        if total <= CACHE_MAX_BYTES:
            break
        total -= p.stat().st_size
        p.unlink(missing_ok=True)


def prefetch(tid: str):
    codec = _prefetch_codec[0]
    if ONLINE and tid.startswith("yt:") and not _cache_path(tid[3:], codec):
        threading.Thread(target=lambda: _quiet(fetch_audio, tid[3:], False, codec), daemon=True).start()


def _quiet(fn, *a):
    try:
        fn(*a)
    except Exception as exc:
        print("prefetch failed", a, exc, file=sys.stderr)


def audio_path(tid: str, codec: str = "aac") -> Path:
    if tid.startswith("yt:"):
        return fetch_audio(tid[3:], codec=codec)
    if tid.startswith("lib:") and LIB_ID.match(tid[4:]):
        rows = db("SELECT path FROM tracks WHERE id=? AND source='library'", (tid,))
        if rows:
            p = Path(rows[0][0]).resolve()
            if LIBRARY.resolve() in p.parents and p.is_file():
                return p
    raise LookupError("unknown track")


# ---------------------------------------------------------------- Art
def art_bytes(tid: str) -> tuple[bytes, str] | None:
    key = hashlib.sha256(tid.encode()).hexdigest()[:24]
    cached = CACHE / "art" / key
    if cached.exists():
        return cached.read_bytes(), "image/jpeg"
    data = None
    if tid.startswith("yt:"):
        if not ONLINE:
            return None
        rows = db("SELECT thumb FROM tracks WHERE id=?", (tid,))
        url = rows[0][0] if rows and rows[0][0] else f"https://i.ytimg.com/vi/{tid[3:]}/hqdefault.jpg"
        host = urllib.parse.urlparse(url).hostname or ""
        if not url.startswith("https://") or not ART_HOSTS.match(host):
            return None
        with online_urlopen(urllib.request.Request(url, headers={"User-Agent": "WizardMusic/1"}), timeout=10) as r:
            data = r.read(2_000_000)
    elif tid.startswith("lib:") and navidrome.active() and LIB_ID.match(tid[4:]) and (data := navidrome.art(sys.modules[__name__], tid)):
        pass  # the cover Navidrome found (embedded or a folder image), wizard-music#92
    elif tid.startswith("lib:"):
        try:
            from tinytag import TinyTag

            meta = TinyTag.get(audio_path(tid), image=True)
            image = meta.images.any if meta is not None else None
            data = image.data if image is not None else None
        except Exception:
            data = None
    if not data:
        return None
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_bytes(data)
    return data, "image/jpeg"


# ---------------------------------------------------------------- Home
def source_card(x: dict) -> dict:
    name = x.get("name") or x["id"].removeprefix("wizard-").replace("-", " ").title()
    if x.get("installed") is None:
        return {"id": x["id"], "name": name, "status": "off", "detail": "Turn on Online sources to use it", "ok": False}
    if not x.get("installed"):
        return {"id": x["id"], "name": name, "status": "missing", "detail": "Not installed \u00b7 get it in the App Store", "ok": False}
    p = x.get("playback") or {}
    detail = {"ok": "Playing", "untested": "Connected \u00b7 not tested yet"}.get(p.get("state"), p.get("message") or "Not working")
    return {"id": x["id"], "name": name, "status": p.get("state", "untested"), "detail": detail,
            "ok": p.get("state") in ("ok", "untested"), "open": f"/{x['id']}/"}


def liked_all(limit: int = 2000) -> list[dict]:
    """Every liked song, newest like first (wizard-music#63: Liked > View all). Home keeps its short preview."""
    rows = db("SELECT id FROM likes WHERE value>0 ORDER BY at DESC LIMIT ?", (max(1, min(int(limit), 2000)),))
    return [t for t in (track(r[0]) for r in rows) if t]


def home() -> dict:
    liked = [track(r[0]) for r in db("SELECT id FROM likes WHERE value>0 ORDER BY at DESC LIMIT 30")]
    recent_ids, seen = [], set()
    for (tid,) in db("SELECT id FROM plays WHERE action='played' ORDER BY at DESC LIMIT 120"):
        if tid not in seen:
            seen.add(tid)
            recent_ids.append(tid)
    taste = taste_profile()
    recent = [track(t) for t in recent_ids if t not in taste.disliked][:20]
    library = [track(r[0]) for r in db("SELECT id FROM tracks WHERE source='library' ORDER BY artist, album, title LIMIT 200")]
    count = db("SELECT COUNT(*) FROM tracks WHERE source='library'")[0][0]
    return {
        "settings": online_settings(),
        "sources": [source_card(x) for x in sources_status()] + [
            navidrome.card(count) if navidrome.switch_on() else
            {"id": "library", "name": "Wizard Library", "status": "connected", "detail": f"{count} track{'s' if count != 1 else ''} on your Wizard", "ok": True},
        ],
        "vibes": ([{"id": f"mix-{m['key'].replace(' ', '-')}", "label": m["name"], "count": len(m["ids"])} for m in mixes()]
                  + [{"id": f"mine-{c['style'].replace(' ', '-')}", "label": c["label"], "count": c["count"]} for c in collections(6)]
                  + [{"id": v["id"], "label": v["label"]} for v in VIBES
                     if v["id"] not in hidden_chips() and v["label"].lower() not in hidden_chips()]) if ONLINE else [],
        "liked": [t for t in liked if t],
        "recent": [t for t in recent if t],
        "library": [t for t in library if t],
        "taste": taste_summary(),
    }


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "WizardMusicHub/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        code = args[1] if fmt.startswith('"%s"') and len(args) > 1 else ''
        sys.stderr.write("%s %s %s\n" % (self.command, self.path.split("?")[0], code))

    def _auth(self) -> bool:
        if TOKEN and self.headers.get("Authorization", "") != f"Bearer {TOKEN}":
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    def _json(self, code: int, value):
        body = json.dumps(value).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > 65536:
            raise ValueError("too large")
        raw = self.rfile.read(n) if n else b"{}"
        value = json.loads(raw or b"{}")
        if not isinstance(value, dict):
            raise ValueError("object required")
        return value

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        path, qs = url.path, urllib.parse.parse_qs(url.query)
        if path == "/health":
            return self._json(200, {"ok": True, "library": db("SELECT COUNT(*) FROM tracks WHERE source='library'")[0][0]})
        if not self._auth():
            return
        try:
            if identify.handle(self,path,qs,sys.modules[__name__]): return
            if path == '/api/playlists':
                return self._json(200, {'playlists': saved_playlists()})
            if path == '/api/song-playlists':
                return self._json(200, {'playlists': song_playlists()})
            song = re.fullmatch(r'/api/song-playlists/([a-f0-9]{24})', path)
            if song:
                return self._json(200, song_playlist(song[1]))
            if path == "/api/settings":
                return self._json(200, online_settings())
            if path == "/api/home":
                return self._json(200, home())
            if path == "/api/liked":  # all liked songs (wizard-music#63, on for everyone since #72)
                return self._json(200, {"tracks": liked_all()})
            if path == "/api/scores":  # points per song, with the raw counts behind them
                return self._json(200, scores(int(qs.get("limit", ["0"])[0] or 0)))
            if path in ("/api/account-library/status", "/api/account-library/playlists", "/api/account-library/likes", "/api/account-library/playlist"):
                try:
                    result = account_library(path.rsplit("/", 1)[1], qs.get("id", [""])[0], int(qs.get("limit", ["100"])[0]))
                except ValueError as exc:
                    return self._json(400, {"error": str(exc)})
                return self._json(200 if "error" not in result or path.endswith("/status") else 409 if result["state"] in ("signed_out", "needs_attention") else 503, result)
            if path == "/api/search":
                q = (qs.get("q") or [""])[0][:200]
                return self._json(200, {"tracks": search(q) if q.strip() else []})
            m = re.match(r"^/api/station/([a-f0-9]{16})$", path)
            if m:  # a curated station's header and next songs (wizard-music#90); ?wait=1 waits for the AI's picks
                try:
                    peek = int((qs.get("peek") or ["10"])[0] or 0)
                    return self._json(200, station_view(m.group(1), qs.get("wait", [""])[0] == "1", peek))
                except LookupError:
                    return self._json(404, {"error": "unknown station"})
            m = re.match(r"^/api/station/([a-f0-9]{16})/more$", path)
            if m:
                n = int((qs.get("n") or ["10"])[0])
                return self._json(200, {"tracks": station_more(m.group(1), n, qs.get("requestId", [""])[0])})
            m = re.match(r"^/stream/(.+)$", path)
            if m:
                return self._stream(urllib.parse.unquote(m.group(1)))
            m = re.match(r"^/art/(.+)$", path)
            if m:
                art = art_bytes(urllib.parse.unquote(m.group(1)))
                if not art:
                    return self._json(404, {"error": "no_art"})
                self.send_response(200)
                self.send_header("Content-Type", art[1])
                self.send_header("Content-Length", str(len(art[0])))
                self.send_header("Cache-Control", "private, max-age=604800")
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(art[0])
                return
            return self._json(404, {"error": "not_found"})
        except LookupError as exc:
            return self._json(404, {"error": str(exc)})
        except Exception as exc:
            print("GET failed", path, repr(exc), file=sys.stderr)
            return self._json(502, {"error": "source_unavailable"})

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if not self._auth():
            return
        try:
            if url.path == '/api/identify/captures':
                if identify.handle(self,url.path,urllib.parse.parse_qs(url.query),sys.modules[__name__]): return
            body = self._body()
            if identify.handle(self,url.path,urllib.parse.parse_qs(url.query),sys.modules[__name__],body): return
            if url.path == '/api/playlists':
                try:
                    return self._json(200, save_playlist(body))
                except ValueError as exc:
                    return self._json(400, {'error': str(exc)})
            if url.path == '/api/song-playlists':
                try:
                    made = create_song_playlist(body)
                    kick_library()
                    return self._json(200, made)
                except ValueError as exc:
                    return self._json(400, {'error': str(exc)})
            song = re.fullmatch(r'/api/song-playlists/([a-f0-9]{24})(?:/(add|remove|delete))?', url.path)
            if song:
                try:
                    changed = update_song_playlist(song[1], body, song[2] or 'update')
                    kick_library()
                    return self._json(200, changed)
                except LookupError:
                    return self._json(404, {'error': 'Playlist not found.'})
                except ValueError as exc:
                    return self._json(400, {'error': str(exc)})
            playlist_play = re.fullmatch(r'/api/playlists/([a-f0-9]{24})/play', url.path)
            if playlist_play:
                try:
                    tracks = playlist_track(playlist_play[1])
                    return self._json(200, {'track': tracks[0], 'tracks': tracks})
                except LookupError:
                    return self._json(404, {'error': 'Playlist not found.'})
                except ValueError as exc:
                    return self._json(400, {'error': str(exc)})
            if url.path == "/api/settings":
                return self._json(200, set_online(body.get("online")))
            if url.path == "/api/station":
                # The app server sends X-Wizard-Music-Curated on every station start (on for everyone): then a
                # tapped song (or an explicit curate request) starts an AI-picked station (wizard-music#90).
                plain_tap = bool(body.get("trackId")) and not any(body.get(k) for k in ("label", "queue", "pool", "query"))
                curate_on = self.headers.get("X-Wizard-Music-Curated") == "1"
                body["curate"] = curate_on and (plain_tap or bool(body.get("curate")))
                out = create_station(body)
                if body.get("trackId") and not body.get("label") and out.get("tracks"):
                    record_request(out["tracks"][0]["id"], "tap")  # you tapped this song
                return self._json(200, out)
            if url.path == "/api/play":
                said = str(body.get("said", ""))[:300]
                return self._json(200, play_spoken(said))
            if url.path == "/api/keep":  # "that session was on point"
                since, until = float(body.get("since", 0)), float(body.get("until") or time.time())
                if not 0 < since < until or until - since > 86400:
                    return self._json(400, {"error": "since/until must span at most a day"})
                ids = keep_session(since, until, str(body.get("reason") or "session on point"))
                return self._json(200, {"kept": [track(t) for t in ids]})
            if url.path == "/api/mixes":  # save a named mix: explicit ids, or the songs played between since/until
                ids = [str(t)[:40] for t in (body.get("ids") or [])]
                if not ids and body.get("since"):
                    since, until = float(body["since"]), float(body.get("until") or time.time())
                    if not 0 < since < until or until - since > 86400:
                        return self._json(400, {"error": "since/until must span at most a day"})
                    ids = session_songs(since, until)
                try:
                    return self._json(200, save_mix(str(body.get("name", "")), ids, [str(a) for a in body.get("aliases") or []]))
                except ValueError as e:
                    return self._json(400, {"error": str(e)})
            if url.path == "/api/feedback":
                tid = str(body.get("id", ""))[:40]
                action = body.get("action")
                if not track(tid) or action not in {"like", "unlike", "dislike", "played", "skipped"}:
                    return self._json(400, {"error": "invalid"})
                learned = None
                if action in {"like", "unlike", "dislike"}:
                    value = {"like": 1, "unlike": 0, "dislike": -1}[action]
                    db("INSERT OR REPLACE INTO likes(id,value,at) VALUES(?,?,?)", (tid, value, time.time()))
                    db("INSERT INTO feedback_log(id,at,action) VALUES(?,?,?)", (tid, time.time(), action))
                    _collections_cache["at"] = 0.0
                    taste_changed()
                    if tid.startswith("lib:"):
                        kick_library()
                    if action == "dislike":
                        learned = learn_dislike(tid)
                    elif action == "like":
                        queue_info(tid)
                        queue_styles_for(tid)
                else:
                    fresh = record_play(tid, action, str(body.get("eventId", "")))
                    if action == "played" and fresh:
                        prefetch(tid)
                        queue_styles_for(tid)
                # The player sends what is queued after this track; answer with what no longer fits.
                upcoming = body.get("upcoming") if isinstance(body.get("upcoming"), list) else []
                taste = taste_profile()
                drop = []
                for uid in [str(u)[:40] for u in upcoming[:80]]:
                    t = track(uid)
                    if t and blocked(t, taste):
                        drop.append(uid)
                return self._json(200, {"ok": True, "track": track(tid), "drop": drop, "learned": learned})
            if url.path == "/api/scan":
                return self._json(200, {"tracks": refresh_library()})
            return self._json(404, {"error": "not_found"})
        except LookupError as exc:
            return self._json(404, {"error": str(exc)})
        except ValueError:
            return self._json(400, {"error": "invalid"})
        except Exception as exc:
            print("POST failed", url.path, repr(exc), file=sys.stderr)
            return self._json(502, {"error": "source_unavailable"})

    def _stream(self, tid: str):
        codec = _codec(self.headers.get("X-Wizard-Music-Codec"))  # opus only when the app server asks (wizard-os#820)
        if tid.startswith("yt:"):
            _prefetch_codec[0] = codec
        if tid.startswith("yt:") and self.headers.get("X-Wizard-Music-Live") == "1":
            got = live_audio(tid[3:], codec)
            return self._stream_live(got) if isinstance(got, LiveDownload) else self._stream_file(got)
        if tid.startswith("lib:") and LIB_ID.match(tid[4:]) and navidrome.active() and self._stream_navidrome(tid):
            return
        path = audio_path(tid, codec)
        return self._stream_file(path)

    def _stream_navidrome(self, tid: str) -> bool:
        """A library song's bytes from Navidrome (wizard-music#92), Range and all. False: play the file directly."""
        up = navidrome.open_stream(sys.modules[__name__], tid, self.headers.get("Range") or "")
        if up is None:
            return False
        with up:
            status = getattr(up, "status", None) or getattr(up, "code", 200)
            self.send_response(status)
            for name in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"):
                if up.headers.get(name):
                    self.send_header(name, up.headers[name])
            self.send_header("Cache-Control", "private, max-age=86400")
            self.end_headers()
            if self.command == "HEAD" or status == 416:
                return True
            while True:
                chunk = up.read(256 * 1024)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
        return True

    def _stream_live(self, dl: LiveDownload):
        """Like _stream_file, for a song still downloading: its full size up front, bytes as they arrive."""
        size = dl.total
        span = self._send_range_head(size, dl.ctype or "audio/mp4")
        if span is None:
            return
        pos, end = span
        try:
            fh = dl.path.open("rb")
        except FileNotFoundError:  # renamed into the cache between our checks
            fh = dl.final.open("rb")
        with fh:
            while pos <= end:
                if not dl.wait(lambda: dl.written > pos or dl.failed, LIVE_STALL_SECONDS) or dl.failed or dl.written <= pos:
                    self.close_connection = True  # cut short: the player sees a broken answer and retries
                    return
                fh.seek(pos)
                chunk = fh.read(min(256 * 1024, end + 1 - pos, dl.written - pos))
                if not chunk:
                    self.close_connection = True
                    return
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                pos += len(chunk)

    def _stream_file(self,path):
        size = path.stat().st_size
        ctype = {".m4a": "audio/mp4", ".webm": "audio/webm", ".opus": "audio/ogg", ".mp3": "audio/mpeg",
                 ".flac": "audio/flac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".aac": "audio/aac"}.get(
            path.suffix.lower(), mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        m = re.match(r"bytes=(\d*)-(\d*)$", rng or "")
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        # A rewritten song (fragmented -> plain) changes size, so players never splice old and new bytes.
        self.send_header("ETag", f'"{size:x}"')
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "private, max-age=86400")
        self.end_headers()
        if self.command == "HEAD":
            return
        with path.open("rb") as fh:
            fh.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = fh.read(min(256 * 1024, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                left -= len(chunk)

    def _send_range_head(self, size: int, ctype: str):
        """Status and headers for a byte-range answer; (start, end) to send, or None when nothing follows."""
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        m = re.match(r"bytes=(\d*)-(\d*)$", rng or "")
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        # A rewritten song (fragmented -> plain) changes size, so players never splice old and new bytes.
        self.send_header("ETag", f'"{size:x}"')
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "private, max-age=86400")
        self.end_headers()
        if self.command == "HEAD":
            return None
        return start, end


def main():
    if not TOKEN:
        print("WIZARD_MUSIC_HUB_TOKEN is required", file=sys.stderr)
        sys.exit(1)
    if HOST not in {"127.0.0.1", "::1"}:
        print("hub binds loopback only", file=sys.stderr)
        sys.exit(1)
    identify.start()
    _quiet(refresh_library)
    threading.Thread(target=_library_loop, daemon=True).start()
    threading.Thread(target=_info_loop, daemon=True).start()
    threading.Thread(target=_style_loop, daemon=True).start()
    threading.Thread(target=_remux_loop, daemon=True).start()
    _quiet(backfill_requests)
    threading.Thread(target=lambda: _quiet(backfill_styles), daemon=True).start()
    for tid, value in db("SELECT id, value FROM likes WHERE value != 0"):
        queue_info(tid, similar=value < 0)  # learn genre/similar artists for thumbs given before this existed
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"Wizard Music hub on {HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
