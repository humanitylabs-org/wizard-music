#!/usr/bin/env python3
"""Initialize the data mount, then discard root before starting either server."""
import os
from pathlib import Path

home = Path(os.environ.get("WIZARD_MUSIC_HUB_HOME", "/data"))
home.mkdir(parents=True, exist_ok=True)
# Navidrome's database (wizard-music#92): its container runs as 1000:1000 and starts once Music is healthy. Docker
# makes a missing bind folder as root when it creates the containers, so hand it to 1000 here.
navidrome = home / "navidrome"
if os.getuid() == 0:
    os.chown(home, 1000, 1000)
    # Root here holds no DAC capability, so it can't look inside a 0700 folder it doesn't own: open the folder for a
    # moment (search only, no read or write) to reach data/navidrome.
    os.chmod(home, 0o701)
    try:
        if navidrome.is_dir():
            os.chown(navidrome, 1000, 1000)
            os.chmod(navidrome, 0o700)
    finally:
        os.chmod(home, 0o700)
    os.setgroups([])
    os.setgid(1000)
    os.setuid(1000)
os.umask(0o077)
navidrome.mkdir(exist_ok=True)
os.execvp("node", ["node", "server/launch.mjs"])
