"""Navidrome as Music's library backend (wizard-music#92; on for everyone, the `navidrome` switch is gone).

Navidrome (stock image, bundled in runtipi/docker-compose.yml) reads the same /music folder as the hub. When it is
bundled, the hub stops scanning the folder itself: the library rows, their art and their audio come from
Navidrome's Subsonic API, and Music's own playlists and liked songs are copied into Navidrome so a Subsonic phone app
sees them too. Track ids stay `lib:<sha of the path>`, so likes, history, mixes and playlists keep pointing at the
same songs. Nothing in the hub's own tables is deleted, and when Navidrome doesn't answer the hub reads the folder
itself again.

Navidrome answers only on the app's own Docker network (no published port). It trusts one header naming its user
(`ND_EXTAUTH_USERHEADER`), so no password is stored anywhere: the hub sends it, and Music's app server sends it for
the owner's phone app (server/subsonic.mjs), after the tailnet login check.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

URL = os.environ.get("WIZARD_MUSIC_NAVIDROME_URL", "").rstrip("/")   # e.g. http://navidrome:4533/wizard-music
USER = "wizard"
USER_HEADER = "X-Wizard-Navidrome-User"
MUSIC_ROOT = os.environ.get("WIZARD_MUSIC_NAVIDROME_MUSIC", "/music").rstrip("/")   # Navidrome's view of the library
CLIENT = "wizard-music"
API_VERSION = "1.16.1"
PAGE = 500
MARK = "Kept in step with Wizard Music"   # comment on the playlists Music writes, so they are never mistaken for others
_lock = threading.Lock()
_user_ready = False
state = {"ok": None, "error": "", "songs": 0, "at": 0.0}


def bundled() -> bool:
    return bool(URL)


def active() -> bool:
    """Navidrome serves the library: it is bundled with this install."""
    return bundled()


class Unavailable(Exception):
    pass


def _request(path: str, params: dict | None = None, method: str = "GET", body: bytes | None = None,
             headers: dict | None = None, timeout: float = 20):
    q = urllib.parse.urlencode({**(params or {}), "c": CLIENT, "v": API_VERSION, "f": "json"}, doseq=True) \
        if path.startswith("/rest/") else urllib.parse.urlencode(params or {}, doseq=True)
    req = urllib.request.Request(f"{URL}{path}{'?' + q if q else ''}", data=body, method=method,
                                 headers={USER_HEADER: USER, **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout)


def api(view: str, **params) -> dict:
    """One Subsonic call; the `subsonic-response` body, or Unavailable."""
    global _user_ready
    for attempt in (0, 1):
        try:
            with _request(f"/rest/{view}", params) as r:
                doc = json.loads(r.read(20_000_000)).get("subsonic-response") or {}
        except (OSError, ValueError) as exc:
            raise Unavailable(f"Navidrome did not answer ({type(exc).__name__})") from exc
        if doc.get("status") == "ok":
            return doc
        err = doc.get("error") or {}
        if err.get("code") == 40 and attempt == 0:   # its user isn't made yet (a fresh Navidrome)
            _user_ready = False
            ensure_user()
            continue
        raise Unavailable(f"Navidrome said: {err.get('message') or 'error'}")
    raise Unavailable("Navidrome refused Music's user")


def ensure_user():
    """A fresh Navidrome has no users: make its one admin. The random password is never kept, because Navidrome
    trusts the user header from Music alone (only Music's own containers can reach it)."""
    global _user_ready
    if _user_ready:
        return
    body = json.dumps({"username": USER, "password": secrets.token_urlsafe(32)}).encode()
    try:
        with _request("/auth/createAdmin", method="POST", body=body, headers={"Content-Type": "application/json"}) as r:
            r.read(10_000)
    except urllib.error.HTTPError as exc:   # 403: users exist already, which is fine
        if exc.code not in (403, 409):
            raise Unavailable(f"Navidrome did not make Music's user ({exc.code})") from exc
    except OSError as exc:
        raise Unavailable(f"Navidrome did not answer ({type(exc).__name__})") from exc
    _user_ready = True


def songs() -> list[dict]:
    out, offset = [], 0
    while True:
        page = (api("search3.view", query="", songCount=PAGE, songOffset=offset, artistCount=0, albumCount=0)
                .get("searchResult3") or {}).get("song") or []
        out += [s for s in page if isinstance(s, dict) and s.get("id")]
        if len(page) < PAGE:
            return out
        offset += PAGE


def rel_path(path: str) -> str:
    p = (path or "").replace("\\", "/")
    if MUSIC_ROOT and p.startswith(MUSIC_ROOT + "/"):
        p = p[len(MUSIC_ROOT) + 1:]
    return p.lstrip("/")


def lib_id(rel: str) -> str:
    """The hub's own id for a library file (hub._lib_id), so a song keeps its likes and history across backends."""
    return "lib:" + hashlib.sha256(rel.encode()).hexdigest()[:20]


def setup(h):
    h.db("CREATE TABLE IF NOT EXISTS navidrome_songs (id TEXT PRIMARY KEY, nd TEXT NOT NULL, cover TEXT NOT NULL, at REAL)")
    h.db("CREATE TABLE IF NOT EXISTS navidrome_playlists (pid TEXT PRIMARY KEY, nd TEXT NOT NULL, sig TEXT NOT NULL)")
    h.db("CREATE TABLE IF NOT EXISTS navidrome_stars (id TEXT PRIMARY KEY)")


def sync(h) -> int:
    """Library rows from Navidrome, then Music's playlists and likes into Navidrome. Returns the song count."""
    with _lock:
        try:
            n = _sync_songs(h)
            _sync_playlists(h)
            _sync_stars(h)
        except Unavailable as exc:
            state.update(ok=False, error=str(exc), at=time.time())
            raise
        state.update(ok=True, error="", songs=n, at=time.time())
        return n


def _sync_songs(h) -> int:
    ensure_user()
    scanning = bool((api("getScanStatus.view").get("scanStatus") or {}).get("scanning"))
    found = songs()
    seen, now = set(), time.time()
    for s in found:
        rel = rel_path(s.get("path") or "")
        if not rel:
            continue
        tid = lib_id(rel)
        seen.add(tid)
        artist = s.get("artist") or s.get("displayArtist") or ""
        album = s.get("album") or ""
        if album == "[Unknown Album]":
            album = ""
        h.db("INSERT OR REPLACE INTO tracks(id,title,artist,album,duration_ms,thumb,source,path,updated) VALUES(?,?,?,?,?,?,?,?,?)",
             (tid, s.get("title") or Path(rel).stem, artist if artist and artist != "[Unknown Artist]" else "Your library",
              album, int(s.get("duration") or 0) * 1000, "", "library", str(h.LIBRARY / rel), now))
        h.db("INSERT OR REPLACE INTO navidrome_songs VALUES(?,?,?,?)", (tid, str(s["id"]), str(s.get("coverArt") or ""), now))
    # A scan still running (or a fresh Navidrome that has found nothing yet) lists only part of the folder: keep the
    # rows Music has until a finished scan says a file is gone.
    if not scanning and (seen or not h.db("SELECT 1 FROM tracks WHERE source='library' LIMIT 1")):
        for (tid,) in h.db("SELECT id FROM tracks WHERE source='library'"):
            if tid not in seen:
                h.db("DELETE FROM tracks WHERE id=?", (tid,))
        for (tid,) in h.db("SELECT id FROM navidrome_songs"):
            if tid not in seen:
                h.db("DELETE FROM navidrome_songs WHERE id=?", (tid,))
    return len(seen)


def nd_id(h, tid: str) -> str | None:
    rows = h.db("SELECT nd FROM navidrome_songs WHERE id=?", (tid,))
    return rows[0][0] if rows else None


def _sync_playlists(h):
    """Each of Music's own playlists as a Navidrome playlist of its library songs, in order. YouTube songs can't play
    from Navidrome, so they stay only in Music; a playlist without a library song is not copied."""
    theirs = {str(p.get("id")): p for p in ((api("getPlaylists.view").get("playlists") or {}).get("playlist") or [])}
    mine = {row[0]: (row[1], row[2]) for row in h.db("SELECT pid, nd, sig FROM navidrome_playlists")}
    keep = set()
    for p in h.song_playlists():
        nds = [x for x in (nd_id(h, tid) for tid in p["trackIds"] if tid.startswith("lib:")) if x]
        if not nds:
            continue
        keep.add(p["id"])
        sig = hashlib.sha256(json.dumps([p["name"], nds]).encode()).hexdigest()
        nd, old = mine.get(p["id"], ("", ""))
        if nd and nd in theirs and old == sig:
            continue
        if nd and nd in theirs:   # replace the songs (Subsonic createPlaylist with playlistId sets the whole list)
            api("createPlaylist.view", playlistId=nd, songId=nds)
            api("updatePlaylist.view", playlistId=nd, name=p["name"], comment=MARK)
        else:
            made = api("createPlaylist.view", name=p["name"], songId=nds).get("playlist") or {}
            nd = str(made.get("id") or "")
            if not nd:
                continue
            api("updatePlaylist.view", playlistId=nd, comment=MARK)
        h.db("INSERT OR REPLACE INTO navidrome_playlists VALUES(?,?,?)", (p["id"], nd, sig))
    for pid, (nd, _) in mine.items():
        if pid not in keep:   # deleted in Music, or no library songs left: take Music's copy out of Navidrome
            if nd in theirs and theirs[nd].get("comment") == MARK:
                api("deletePlaylist.view", id=nd)
            h.db("DELETE FROM navidrome_playlists WHERE pid=?", (pid,))


def _sync_stars(h):
    """Music's liked library songs starred in Navidrome. Only stars Music itself set are ever taken away, so a star
    given in a phone app stays."""
    want = {tid for (tid,) in h.db("SELECT l.id FROM likes l JOIN navidrome_songs n ON n.id=l.id WHERE l.value>0")}
    had = {tid for (tid,) in h.db("SELECT id FROM navidrome_stars")}
    add = sorted(want - had)
    drop = sorted(had - want)
    for chunk in range(0, len(add), 100):
        ids = [x for x in (nd_id(h, t) for t in add[chunk:chunk + 100]) if x]
        if ids:
            api("star.view", id=ids)
    for chunk in range(0, len(drop), 100):
        ids = [x for x in (nd_id(h, t) for t in drop[chunk:chunk + 100]) if x]
        if ids:
            api("unstar.view", id=ids)
    for t in add:
        h.db("INSERT OR IGNORE INTO navidrome_stars VALUES(?)", (t,))
    for t in drop:
        h.db("DELETE FROM navidrome_stars WHERE id=?", (t,))


def open_stream(h, tid: str, rng: str = ""):
    """Navidrome's original file bytes for a library song (format=raw: no transcoding), or None."""
    nd = nd_id(h, tid)
    if not nd:
        return None
    headers = {"Range": rng[:100]} if rng else {}
    try:
        return _request("/rest/stream.view", {"id": nd, "format": "raw"}, headers=headers, timeout=30)
    except urllib.error.HTTPError as exc:
        if exc.code == 416:
            return exc
        return None
    except OSError:
        return None


def art(h, tid: str) -> bytes | None:
    rows = h.db("SELECT cover FROM navidrome_songs WHERE id=?", (tid,))
    if not rows or not rows[0][0]:   # no cover found: Navidrome would draw its own placeholder record, Music shows its own
        return None
    try:
        with _request("/rest/getCoverArt.view", {"id": rows[0][0], "size": 600}, timeout=15) as r:
            if not (r.headers.get("Content-Type") or "").startswith("image/"):
                return None
            return r.read(5_000_000) or None
    except OSError:
        return None


def card(count: int) -> dict:
    """The library row under Sources."""
    if not bundled():
        return {"id": "library", "name": "Wizard Library", "status": "connected", "ok": True,
                "detail": f"{count} track{'s' if count != 1 else ''} on your Wizard · Navidrome isn't part of this install"}
    if state["ok"] is False:
        return {"id": "library", "name": "Wizard Library · Navidrome", "status": "error", "ok": False,
                "detail": "Navidrome isn't answering, so Music reads the folder itself for now"}
    return {"id": "library", "name": "Wizard Library · Navidrome", "status": "connected", "ok": True,
            "detail": f"{count} track{'s' if count != 1 else ''} · phone music apps can play them too"}
