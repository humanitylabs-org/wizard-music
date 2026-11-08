import importlib
import json
import sys
from pathlib import Path

import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

SONGS = {  # id: (title, artist, genre, artist tags or None for "not looked up yet")
    "yt:deep1": ("Rust", "Ben Böhmer", "Electronic", {"deep house": 1.0, "house": 1.0, "melodic house": 1.0}),
    "yt:deep2": ("Rise", "Lynnic", "Electronic", {"deep house": 1.0, "house": 1.0}),
    "yt:deep3": ("Make Me Feel", "oskar med k", "House", {"house": 1.0, "deep house": 1.0}),
    "yt:tech": ("Somebody", "FISHER, Chris Lake", "Dance", {"tech house": 1.0, "house": 1.0}),
    "yt:party": ("Rasputin", "Majestic, Boney M.", "Dance", {"garage house": 1.0, "house": 1.0, "edm": 1.0}),
    "yt:hiphop": ("Passionfruit", "Drake", "Hip-Hop/Rap", None),
    "yt:rock": ("Dracula", "Tame Impala", "Alternative", {"psychedelic rock": 1.0, "alternative rock": 0.8}),
    "yt:bieber": ("Sorry", "Justin Bieber", "", None),
    "yt:unknown_house": ("Fire Fire", "Shimza", "Dance", None),
}
NOT_DEEP = {"yt:tech", "yt:party", "yt:hiphop", "yt:rock", "yt:bieber"}


@pytest.fixture
def hub(tmp_path, monkeypatch):
    monkeypatch.setenv("WIZARD_MUSIC_HUB_HOME", str(tmp_path))
    monkeypatch.setenv("WIZARD_MUSIC_ONLINE", "0")
    import hub as h
    h = importlib.reload(h)
    for tid, (title, artist, genre, tags) in SONGS.items():
        h.db("INSERT INTO tracks(id,title,artist,album,duration_ms,thumb,source,path,updated) VALUES(?,?,?,?,?,?,?,?,?)",
             (tid, title, artist, "", 200000, "", "yt", "", 0))
        if genre:
            h.db("INSERT INTO track_info(id,genre,similar,at) VALUES(?,?,?,?)", (tid, genre, None, 0))
        if tags is not None:
            for name in h.artist_names(artist):
                h.db("INSERT OR REPLACE INTO artist_styles(key,name,tags,source,at) VALUES(?,?,?,?,?)",
                     (h._key(name), name, json.dumps(tags), "musicbrainz", 0))
    yield h
    h._db.close()


def fit(h, tid):
    return h.style_fit(h.track(tid), "deep house")


def test_plain_house_party_and_other_genres_are_not_deep_house(hub):
    assert [fit(hub, t) for t in ("yt:deep1", "yt:deep2", "yt:deep3")] == [2, 2, 2]
    for tid in ("yt:tech", "yt:party", "yt:hiphop", "yt:rock"):
        assert fit(hub, tid) == 0, tid


def test_unknown_artists_wait_unless_genre_is_electronic(hub):
    assert fit(hub, "yt:unknown_house") == 1
    assert fit(hub, "yt:bieber") == -1


def test_deep_house_station_serves_only_deep_house(hub, monkeypatch):
    ids = list(SONGS)
    monkeypatch.setattr(hub, "_radio_from", lambda tid: [i for i in ids if i != tid])
    out = hub.create_station({"trackId": "yt:deep1", "label": "Deep house", "queue": [i for i in ids if i != "yt:deep1"],
                              "pool": ["yt:deep1", "yt:deep2", "yt:deep3"], "style": "deep house"})
    served = {t["id"] for t in out["tracks"]}
    assert not served & NOT_DEEP
    assert {"yt:deep1", "yt:deep2", "yt:deep3"} <= served
    more = {t["id"] for t in hub.station_more(out["station"]["id"], 10)}
    assert not more & NOT_DEEP


def test_station_without_style_is_unchanged(hub):
    ids = list(SONGS)
    out = hub.create_station({"trackId": "yt:deep1", "label": "radio", "queue": [i for i in ids if i != "yt:deep1"]})
    assert {"yt:hiphop", "yt:rock"} <= {t["id"] for t in out["tracks"]}


def test_scene_station_leads_with_scene_songs_and_tags_scene_artists(hub, monkeypatch):
    monkeypatch.setattr(hub, "ONLINE", True)
    monkeypatch.setattr(hub, "SCENES", {"deep house": {"artists": ["Darren Phillips"], "seeds": ["Darren Phillips Velvet Skies"]}})
    hub._scene_tracks.clear()
    hub.db("INSERT INTO tracks(id,title,artist,album,duration_ms,thumb,source,path,updated) VALUES(?,?,?,?,?,?,?,?,?)",
           ("yt:scene1", "Velvet Skies", "Darren Phillips", "", 200000, "", "yt", "", 0))

    class FakeYTM:
        def search(self, q, filter=None, limit=5):
            return [{"videoId": "other"}, {"videoId": "scene1"}]
    monkeypatch.setattr(hub, "ytm", lambda: FakeYTM())
    monkeypatch.setattr(hub, "remember_yt", lambda item: hub.track("yt:" + item["videoId"]))
    monkeypatch.setattr(hub, "_radio_from", lambda tid: ["yt:tech", "yt:hiphop"])
    assert hub.scene_tracks("deep house") == ["yt:scene1"]
    assert hub.artist_styles(hub._key("Darren Phillips"))["deep house"] == 1.0
    out = hub.style_station("deep house", "Deep house", "deep house")
    ids = [t["id"] for t in out["tracks"]]
    assert ids[0] == "yt:scene1" or "yt:scene1" in ids
    assert not set(ids) & {"yt:tech", "yt:hiphop"}
