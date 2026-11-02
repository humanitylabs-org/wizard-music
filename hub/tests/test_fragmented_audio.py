"""YouTube's m4a is DASH-fragmented; Safari/WebKit then report double length and play silence.

The hub rewrites such files as plain MP4 (stream copy) on download and on the next play of an
already cached song.
"""
import importlib.util
import json
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

FFMPEG = shutil.which('ffmpeg')
pytestmark = pytest.mark.skipif(not FFMPEG or not shutil.which('ffprobe'), reason='ffmpeg not installed')
VID = 'sWcLccMuCA8'


def make_fragmented(path: Path, seconds: int = 12) -> Path:
    subprocess.run([FFMPEG, '-v', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency=440:duration={seconds}',
                    '-c:a', 'aac', '-b:a', '96k', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
                    '-frag_duration', '2000000', '-f', 'mp4', str(path)], check=True)
    return path


def probe_duration(path: Path) -> float:
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(path)],
                         check=True, capture_output=True, text=True).stdout
    return float(json.loads(out)['format']['duration'])


def packets_md5(path: Path) -> str:
    """Hash of the compressed audio packets: a stream copy must not change a single byte."""
    return subprocess.run([FFMPEG, '-v', 'error', '-i', str(path), '-map', '0:a:0', '-c', 'copy', '-f', 'md5', '-'],
                          check=True, capture_output=True, text=True).stdout.strip()


class Fake(BaseHTTPRequestHandler):
    body = b''

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == '/api/status':
            raw = json.dumps({'name': 'YouTube Music', 'playback': {'state': 'ok'}}).encode()
            self.send_response(200); self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw); return
        if self.path.startswith('/api/music/audio/'):
            self.send_response(200); self.send_header('Content-Length', str(len(Fake.body))); self.end_headers(); self.wfile.write(Fake.body); return
        self.send_response(404); self.send_header('Content-Length', '0'); self.end_headers()


@pytest.fixture
def hub(monkeypatch, tmp_path):
    srv = ThreadingHTTPServer(('127.0.0.1', 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setenv('WIZARD_MUSIC_HUB_HOME', str(tmp_path))
    monkeypatch.setenv('WIZARD_MUSIC_LIBRARY', str(tmp_path / 'library'))
    monkeypatch.setenv('WIZARD_MUSIC_SOURCES', f'wizard-youtube-music=http://127.0.0.1:{srv.server_port}')
    spec = importlib.util.spec_from_file_location('fragmented_hub', Path(__file__).parents[1] / 'hub.py')
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    mod.set_online(True)
    yield mod
    srv.shutdown()
    mod._db.close()


def test_remux_turns_fragments_into_a_plain_file_without_touching_the_audio(hub, tmp_path):
    song = make_fragmented(hub.CACHE / 'song.m4a')
    before, length = packets_md5(song), probe_duration(song)
    assert hub.is_fragmented_mp4(song)
    assert hub.remux_plain(song) == song
    assert not hub.is_fragmented_mp4(song)
    assert packets_md5(song) == before
    assert abs(probe_duration(song) - length) < 0.1
    assert not [p for p in hub.CACHE.iterdir() if p.name.startswith('.')]  # no temp files left


def test_plain_and_non_mp4_files_are_left_alone(hub, tmp_path):
    song = make_fragmented(hub.CACHE / 'song.m4a')
    hub.remux_plain(song)
    inode = song.stat().st_ino
    hub.remux_plain(song)
    assert song.stat().st_ino == inode
    junk = hub.CACHE / 'junk.m4a'
    junk.write_bytes(b'not audio at all')
    assert not hub.is_fragmented_mp4(junk)
    assert hub.remux_plain(junk).read_bytes() == b'not audio at all'


def test_missing_ffmpeg_keeps_the_song_playable(hub, tmp_path, monkeypatch):
    song = make_fragmented(hub.CACHE / 'song.m4a')
    raw = song.read_bytes()
    monkeypatch.setattr(hub, 'FFMPEG', str(tmp_path / 'no-ffmpeg'))
    assert hub.remux_plain(song).read_bytes() == raw
    assert song.name in hub._remux_failed  # tried once, not on every range request


def test_download_and_old_cache_both_end_up_plain(hub, tmp_path):
    Fake.body = make_fragmented(tmp_path / 'source.m4a').read_bytes()
    got = hub.fetch_audio(VID)
    assert got.name == f'{VID}.m4a' and not hub.is_fragmented_mp4(got)
    # A song cached by an older Music is fixed on its next play.
    old = hub.CACHE / 'aaaaaaaaaaa.m4a'
    old.write_bytes(Fake.body)
    assert hub.is_fragmented_mp4(old)
    assert not hub.is_fragmented_mp4(hub.fetch_audio('aaaaaaaaaaa'))


def test_files_outside_the_audio_cache_are_never_rewritten(hub, tmp_path):
    outside = make_fragmented(tmp_path / 'outside.m4a')
    raw = outside.read_bytes()
    assert not hub.is_fragmented_mp4(outside)
    assert hub.remux_plain(outside).read_bytes() == raw
