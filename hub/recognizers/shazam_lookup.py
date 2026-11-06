
#!/usr/bin/env python3
import asyncio, json, sys
from pathlib import Path
async def main():
    from shazamio import Shazam
    path = Path(sys.argv[1])
    shazam = Shazam()
    try:
        if hasattr(shazam, 'recognize'):
            data = await shazam.recognize(str(path))
        else:
            data = await shazam.recognize_song(str(path))
        print(json.dumps(data, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'error': type(exc).__name__, 'message': str(exc)}, ensure_ascii=False))
        raise
if __name__ == '__main__': asyncio.run(main())
