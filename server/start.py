#!/usr/bin/env python3
"""Initialize the data mount, then discard root before starting either server."""
import os
from pathlib import Path

home = Path(os.environ.get("WIZARD_MUSIC_HUB_HOME", "/data"))
home.mkdir(parents=True, exist_ok=True)
if os.getuid() == 0:
    os.chown(home, 1000, 1000)
    os.chmod(home, 0o700)
    os.setgroups([])
    os.setgid(1000)
    os.setuid(1000)
os.umask(0o077)
os.execvp("node", ["node", "server/launch.mjs"])
