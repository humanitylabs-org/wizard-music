"""Reject machine-private paths/hosts in tracked text before public packaging."""
from pathlib import Path
import re
import subprocess
import sys
root = Path(__file__).resolve().parents[1]
patterns = [re.compile(x, re.I) for x in ["/home/" + "telos", "/Users/" + "thales", "tail" + "c0f369", r"\b" + "Ja" + "mes" + r"\b"]]
offenders = []
for name in subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().split('\0'):
    if not name: continue
    try: lines = (root/name).read_text().splitlines()
    except (UnicodeError, IsADirectoryError, FileNotFoundError): continue
    for number, line in enumerate(lines,1):
        if any(p.search(line) for p in patterns): offenders.append(f'{name}:{number}')
if offenders:
    print('Nonportable tracked text: ' + ', '.join(offenders)); sys.exit(1)
print('Tracked source portability: PASS')
