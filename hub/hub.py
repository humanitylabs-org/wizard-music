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
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

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
            _ytm = _ytm_radio = None
            # Queued work is discarded; transport guards also cover already-running workers.
            with _info_cv:
                _info_q.clear()
                _info_pending.clear()
    return online_settings()


def online_urlopen(*args, **kwargs):
    with _consent_lock:
        require_online()
        return urllib.request.urlopen(*args, **kwargs)


def online_session():
    import requests

    class ConsentSession(requests.Session):
        def send(self, *args, **kwargs):
            # Each HTTP send (including retries/redirects) rechecks consent.
            with _consent_lock:
                require_online()
                return super().send(*args, **kwargs)

    return ConsentSession()


def db(sql: str, args: tuple = (), many: bool = False):
    with _db_lock:
        cur = _db.execute(sql, args)
        rows = cur.fetchall()
        _db.commit()
        return rows


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


def _library_loop():
    while True:
        try:
            scan_library()
        except Exception as exc:  # keep scanning
            print("library scan failed", exc, file=sys.stderr)
        time.sleep(60)


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
    for tid, at in db("SELECT id, at FROM requests ORDER BY at"):
        # One request per minute per song, and only when the song then actually played.
        if at - last.get(tid, -1e12) >= 60 and any(-5 <= s - at <= 90 for s in kept_starts.get(tid, [])):
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
def search(q: str) -> list[dict]:
    q = q.strip()
    out: list[dict] = []
    like = f"%{q}%"
    for (tid,) in db(
        "SELECT id FROM tracks WHERE source='library' AND (title LIKE ? OR artist LIKE ? OR album LIKE ?) LIMIT 8",
        (like, like, like),
    ):
        out.append(track(tid))
    try:
        for item in ytm().search(q, filter="songs", limit=20)[:20]:
            t = remember_yt(item)
            if t:
                out.append(t)
    except Exception as exc:
        print("ytm search failed", exc, file=sys.stderr)
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


def _take(sid: str, state: dict, n: int, persist: bool = True) -> list[dict]:
    taste = taste_profile()
    recent = recent_songs(state)
    out: list[dict] = []
    attempts = 0
    while len(out) < n and attempts < 4:
        attempts += 1
        allowed = station_scripts(state)
        pool = set(state.get("pool") or [])
        while state["queue"] and len(out) < n:
            tid = state["queue"].pop(0)
            if tid in state["played"] and not (tid in pool and tid not in state["played"][-40:] and tid not in [t["id"] for t in out]):
                continue
            t = track(tid)
            if t and not blocked(t, taste) and not off_station(t, allowed, taste):
                sig = song_sig(t)
                if any(rid != tid and same_song(sig, rsig) for rid, rsig in recent):
                    continue  # another version of a song you just heard
                out.append(t)
                state["played"].append(tid)
                recent.append((tid, sig))
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
            reseed = random.choice(pool_) if pool_ else state["seed"]
            state["lastSeed"] = reseed
            state["queue"] = [c for c in _radio_from(reseed) if c not in state["played"]]
            if not state["queue"]:
                break
    state["played"] = state["played"][-400:]
    if persist:
        db("UPDATE stations SET state=?, at=? WHERE id=?", (json.dumps(state), time.time(), sid))
    if any(score < 0 for score in taste.genre.values()):
        # Learn genres for what was just served and what comes next; the player prunes late finds via `drop`.
        for cid in [t["id"] for t in out] + state["queue"][:12]:
            queue_info(cid)
    return out


def station_more(sid: str, n: int, request_id: str = "") -> list[dict]:
    if request_id and not re.fullmatch(r"[a-f0-9-]{36}", request_id):
        raise ValueError("invalid continuation key")
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
        tracks = _take(sid, state, max(1, min(n, 25)), False)
        # Compute outside the DB transaction, commit advancement and receipt atomically.
        with _db_lock, _db as con:
            con.execute("UPDATE stations SET state=?,at=? WHERE id=?", (json.dumps(state), time.time(), sid))
            if request_id and tracks:
                con.execute("INSERT INTO station_batches VALUES(?,?,?,?)", (request_id, sid, json.dumps(tracks), time.time()))
            con.execute("DELETE FROM station_batches WHERE at<?", (time.time() - 7*86400,))
    for t in tracks[:2]:
        prefetch(t["id"])
    return tracks


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


def _cache_path(vid: str) -> Path | None:
    for ext in ("m4a", "webm", "opus", "mp3"):
        p = CACHE / f"{vid}.{ext}"
        if p.exists() and p.stat().st_size > 0:
            return p
    return None


def fetch_audio(vid: str) -> Path:
    if not ONLINE:
        raise LookupError("online sources disabled")
    if not YT_ID.match(vid):
        raise LookupError("bad id")
    hit = _cache_path(vid)
    if hit:
        os.utime(hit)
        return hit
    with _dl_guard:
        lock = _dl_locks.setdefault(vid, threading.Lock())
    with lock:
        hit = _cache_path(vid)
        if hit:
            return hit
        tmp = CACHE / f".{vid}.{uuid.uuid4().hex[:6]}.m4a"
        try:
            with online_urlopen(source_for(f"yt:{vid}").rstrip("/") + f"/api/music/audio/{vid}", timeout=170) as r, tmp.open("wb") as out:
                shutil.copyfileobj(r, out, 262144)
        except urllib.error.HTTPError as exc:
            tmp.unlink(missing_ok=True)
            _source_status.clear()  # the connector recorded why; re-read it for the home screen
            raise RuntimeError("blocked" if exc.code == 502 else f"source answered {exc.code}") from None
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
        if not ONLINE or tmp.stat().st_size == 0:
            tmp.unlink(missing_ok=True)
            raise RuntimeError("download failed")
        made = [tmp]
        final = CACHE / f"{vid}{made[0].suffix}"
        made[0].replace(final)
        _evict()
        return final


def _evict():
    files = [p for p in CACHE.iterdir() if p.is_file() and not p.name.startswith(".")]
    total = sum(p.stat().st_size for p in files)
    for p in sorted(files, key=lambda p: p.stat().st_mtime):
        if total <= CACHE_MAX_BYTES:
            break
        total -= p.stat().st_size
        p.unlink(missing_ok=True)


def prefetch(tid: str):
    if ONLINE and tid.startswith("yt:") and not _cache_path(tid[3:]):
        threading.Thread(target=lambda: _quiet(fetch_audio, tid[3:]), daemon=True).start()


def _quiet(fn, *a):
    try:
        fn(*a)
    except Exception as exc:
        print("prefetch failed", a, exc, file=sys.stderr)


def audio_path(tid: str) -> Path:
    if tid.startswith("yt:"):
        return fetch_audio(tid[3:])
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
        sys.stderr.write("%s %s\n" % (self.command, self.path.split("?")[0]))

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
            if path == "/api/settings":
                return self._json(200, online_settings())
            if path == "/api/home":
                return self._json(200, home())
            if path == "/api/scores":  # points per song, with the raw counts behind them
                return self._json(200, scores(int(qs.get("limit", ["0"])[0] or 0)))
            if path == "/api/search":
                q = (qs.get("q") or [""])[0][:200]
                return self._json(200, {"tracks": search(q) if q.strip() else []})
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
            body = self._body()
            if url.path == "/api/settings":
                return self._json(200, set_online(body.get("online")))
            if url.path == "/api/station":
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
                return self._json(200, {"tracks": scan_library()})
            return self._json(404, {"error": "not_found"})
        except LookupError as exc:
            return self._json(404, {"error": str(exc)})
        except ValueError:
            return self._json(400, {"error": "invalid"})
        except Exception as exc:
            print("POST failed", url.path, repr(exc), file=sys.stderr)
            return self._json(502, {"error": "source_unavailable"})

    def _stream(self, tid: str):
        path = audio_path(tid)
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


def main():
    if not TOKEN:
        print("WIZARD_MUSIC_HUB_TOKEN is required", file=sys.stderr)
        sys.exit(1)
    if HOST not in {"127.0.0.1", "::1"}:
        print("hub binds loopback only", file=sys.stderr)
        sys.exit(1)
    scan_library()
    threading.Thread(target=_library_loop, daemon=True).start()
    threading.Thread(target=_info_loop, daemon=True).start()
    threading.Thread(target=_style_loop, daemon=True).start()
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
