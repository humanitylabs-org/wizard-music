#!/usr/bin/env python3
"""Wizard Music hub: one library across sources, served to Wizard.

Runs on Wizard Home (Mac mini). Sources:
  - youtube: YouTube Music catalog search + endless radio (ytmusicapi), audio via yt-dlp
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
HOME = Path(os.environ.get("WIZARD_MUSIC_HUB_HOME", str(Path.home() / ".wizard-home/music-hub")))
LIBRARY = Path(os.environ.get("WIZARD_MUSIC_LIBRARY", str(Path.home() / "Music/WizardMusic/Library")))
CACHE = Path(os.environ.get("WIZARD_MUSIC_CACHE", str(HOME / "cache")))
CACHE_MAX_BYTES = int(os.environ.get("WIZARD_MUSIC_CACHE_MAX_BYTES", str(3 * 1024**3)))
YTDLP = os.environ.get("WIZARD_MUSIC_YTDLP", str(Path(sys.executable).with_name("yt-dlp")))
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
    """
)
_db.commit()


def db(sql: str, args: tuple = (), many: bool = False):
    with _db_lock:
        cur = _db.execute(sql, args)
        rows = cur.fetchall()
        _db.commit()
        return rows


# ---------------------------------------------------------------- YouTube Music
_ytm = None
_ytm_lock = threading.Lock()


def ytm():
    if not ONLINE:
        raise RuntimeError("Online sources disabled; set WIZARD_MUSIC_ONLINE=1 to opt in")
    global _ytm
    with _ytm_lock:
        if _ytm is None:
            from ytmusicapi import YTMusic

            auth = HOME / "ytmusic-browser.json"
            _ytm = YTMusic(str(auth)) if auth.exists() else YTMusic()
        return _ytm


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
        import mutagen
    except Exception:  # pragma: no cover
        mutagen = None
    seen = set()
    for path in LIBRARY.rglob("*"):
        if path.suffix.lower() not in AUDIO_EXT or not path.is_file():
            continue
        tid = f"lib:{_lib_id(path)}"
        seen.add(tid)
        title, artist, album, dur = path.stem, "", path.parent.name if path.parent != LIBRARY else "", 0
        if mutagen:
            try:
                meta = mutagen.File(path, easy=True)
                if meta is not None:
                    title = (meta.get("title") or [title])[0]
                    artist = (meta.get("artist") or [""])[0]
                    album = (meta.get("album") or [album])[0]
                    dur = int((meta.info.length or 0) * 1000)
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
    with urllib.request.urlopen(urllib.request.Request("https://itunes.apple.com/search?" + query, headers=UA), timeout=8) as r:
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
        want = _key(name)
        hits = ytm().search(name, filter="artists", limit=5)
        hit = next((h for h in hits if h.get("browseId") and _key(h.get("artist") or h.get("title") or "") == want), None)
        if not hit:
            continue
        info = ytm().get_artist(hit["browseId"])
        for item in ((info.get("related") or {}).get("results") or [])[:10]:
            label = item.get("title") or ""
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
    with urllib.request.urlopen(req, timeout=4) as r:
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
        lists = ytm().search(genre, filter="featured_playlists", limit=3)
        pid = next((p["browseId"] for p in lists if p.get("browseId")), "")
        if not pid:
            return None
        items = (ytm().get_playlist(pid[2:] if pid.startswith("VL") else pid, limit=25).get("tracks") or [])
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
    if LIKES.match(q):
        liked = [track(r[0]) for r in db("SELECT id FROM likes WHERE value>0 ORDER BY at DESC LIMIT 60")]
        liked = [t for t in liked if t]
        if not liked:
            raise LookupError("You haven’t liked any songs yet.")
        random.shuffle(liked)
        return {"kind": "likes", "said": said, "query": q, "heard": "Your likes", "station": None, "tracks": liked}
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
            watch = ytm().get_watch_playlist(seed_vid, radio=True, limit=60)
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
        results = search(seed["query"])
        if not results:
            raise LookupError("nothing matched that")
        tid = results[0]["id"]
        title = seed.get("label") or seed["query"]
    first = track(tid)
    if not first:
        raise LookupError("unknown track")
    title = title or seed.get("label") or f"{first['title']} radio"
    candidates = [c for c in _radio_from(tid) if c != tid]
    state = {"seed": tid, "queue": candidates, "played": [tid], "lastSeed": tid}
    sid = uuid.uuid4().hex[:16]
    db("INSERT INTO stations(id,title,seed,state,at) VALUES(?,?,?,?,?)", (sid, title, tid, json.dumps(state), time.time()))
    tracks = [first] + _take(sid, state, 14)
    for t in tracks[:3]:
        prefetch(t["id"])
    return {"station": {"id": sid, "title": title, "more": f"{PUBLIC_PREFIX}/api/station/{sid}/more"}, "tracks": tracks}


def _take(sid: str, state: dict, n: int, persist: bool = True) -> list[dict]:
    taste = taste_profile()
    out: list[dict] = []
    attempts = 0
    while len(out) < n and attempts < 4:
        attempts += 1
        while state["queue"] and len(out) < n:
            tid = state["queue"].pop(0)
            if tid in state["played"]:
                continue
            t = track(tid)
            if t and not blocked(t, taste):
                out.append(t)
                state["played"].append(tid)
        if len(out) < n:
            # Endless: reseed from the most recent liked track in this station, else a recent track
            # that is not the kind of music you turned down.
            liked = [r[0] for r in db("SELECT id FROM likes WHERE value>0 ORDER BY at DESC LIMIT 20")]
            pool = [p for p in state["played"][-30:] if p in liked] or [p for p in state["played"][-8:] if fits(p, taste)]
            reseed = random.choice(pool) if pool else state["seed"]
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
        tmp = CACHE / f".{vid}.{uuid.uuid4().hex[:6]}"
        cmd = [YTDLP, "-q", "--no-cache-dir", "--no-warnings", "--no-playlist", "-f", "bestaudio[ext=m4a]/bestaudio",
               "-o", f"{tmp}.%(ext)s", f"https://music.youtube.com/watch?v={vid}"]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        made = sorted(CACHE.glob(f"{tmp.name}.*"))
        if proc.returncode != 0 or not made:
            for m in made:
                m.unlink(missing_ok=True)
            raise RuntimeError((proc.stderr or "download failed").strip()[-300:])
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
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "WizardMusic/1"}), timeout=10) as r:
            data = r.read(2_000_000)
    elif tid.startswith("lib:"):
        try:
            import mutagen

            meta = mutagen.File(audio_path(tid))
            for key_name in (meta.tags or {}).keys() if meta and meta.tags else []:
                if str(key_name).startswith("APIC"):
                    data = meta.tags[key_name].data
                    break
            if data is None and meta is not None and hasattr(meta, "pictures") and meta.pictures:
                data = meta.pictures[0].data
            if data is None and meta is not None and meta.tags and "covr" in meta.tags:
                data = bytes(meta.tags["covr"][0])
        except Exception:
            data = None
    if not data:
        return None
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_bytes(data)
    return data, "image/jpeg"


# ---------------------------------------------------------------- Home
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
    yt_ok = ONLINE
    return {
        "sources": [
            {"id": "youtube", "name": "Online sources", "status": "enabled" if ONLINE else "disabled",
             "detail": "Catalog access enabled; availability varies" if ONLINE else "Setup required · disabled by default", "ok": yt_ok},
            {"id": "library", "name": "Wizard Library", "status": "connected", "detail": f"{count} track{'s' if count != 1 else ''} on your Wizard", "ok": True},
        ],
        "vibes": [{"id": v["id"], "label": v["label"]} for v in VIBES] if ONLINE else [],
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
            if path == "/api/home":
                return self._json(200, home())
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
            if url.path == "/api/station":
                return self._json(200, create_station(body))
            if url.path == "/api/play":
                said = str(body.get("said", ""))[:300]
                return self._json(200, play_spoken(said))
            if url.path == "/api/feedback":
                tid = str(body.get("id", ""))[:40]
                action = body.get("action")
                if not track(tid) or action not in {"like", "unlike", "dislike", "played", "skipped"}:
                    return self._json(400, {"error": "invalid"})
                learned = None
                if action in {"like", "unlike", "dislike"}:
                    value = {"like": 1, "unlike": 0, "dislike": -1}[action]
                    db("INSERT OR REPLACE INTO likes(id,value,at) VALUES(?,?,?)", (tid, value, time.time()))
                    taste_changed()
                    if action == "dislike":
                        learned = learn_dislike(tid)
                    elif action == "like":
                        queue_info(tid)
                else:
                    fresh = record_play(tid, action, str(body.get("eventId", "")))
                    if action == "played" and fresh:
                        prefetch(tid)
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
    for tid, value in db("SELECT id, value FROM likes WHERE value != 0"):
        queue_info(tid, similar=value < 0)  # learn genre/similar artists for thumbs given before this existed
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"Wizard Music hub on {HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
