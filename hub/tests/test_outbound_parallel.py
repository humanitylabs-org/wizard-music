"""Issue 91: one slow outbound call (a song's audio, headers after seconds) must not hold up art or search."""
import importlib.util
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest


@pytest.fixture
def hub(monkeypatch, tmp_path):
    monkeypatch.setenv('WIZARD_MUSIC_HUB_HOME', str(tmp_path))
    monkeypatch.setenv('WIZARD_MUSIC_LIBRARY', str(tmp_path / 'library'))
    monkeypatch.setenv('WIZARD_MUSIC_ONLINE', '0')
    spec = importlib.util.spec_from_file_location('parallel_hub', Path(__file__).parents[1] / 'hub.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    module.set_online(True)
    yield module
    module._db.close()


@pytest.fixture
def server():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith('/slow'):
                time.sleep(1.5)  # like the connector resolving audio before any header
            body = b'ok' * 10
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f'http://127.0.0.1:{srv.server_address[1]}'
    srv.shutdown()


def _timed(hub, url, out, key):
    t = time.monotonic()
    with hub.online_urlopen(url, timeout=10) as r:
        r.read()
    out[key] = time.monotonic() - t


def test_fast_call_not_queued_behind_slow_one(hub, server):
    out = {}
    slow = threading.Thread(target=_timed, args=(hub, server + '/slow', out, 'slow'))
    slow.start()
    time.sleep(0.2)  # the slow call is now waiting for headers
    _timed(hub, server + '/fast', out, 'fast')
    slow.join()
    assert out['fast'] < 0.8, out
    assert out['slow'] >= 1.4


def test_two_slow_calls_run_together(hub, server):
    out = {}
    threads = [threading.Thread(target=_timed, args=(hub, server + '/slow', out, k)) for k in ('a', 'b')]
    t = time.monotonic()
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert time.monotonic() - t < 2.6, out  # serialized would be about 3 s


def test_online_off_while_waiting_refuses_the_answer(hub, server):
    errors = []

    def call():
        try:
            hub.online_urlopen(server + '/slow', timeout=10)
        except LookupError as exc:
            errors.append(exc)

    th = threading.Thread(target=call)
    th.start()
    time.sleep(0.3)
    t = time.monotonic()
    hub.set_online(False)
    assert time.monotonic() - t < 0.5  # turning Online off never waits on the network
    th.join()
    assert len(errors) == 1


def test_online_off_closes_open_responses(hub, server):
    r = hub.online_urlopen(server + '/fast', timeout=10)
    assert not r.closed
    hub.set_online(False)
    assert r.closed
    with pytest.raises(LookupError):
        hub.online_urlopen(server + '/fast', timeout=10)
