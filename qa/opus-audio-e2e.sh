#!/usr/bin/env bash
# Opus audio end to end (wizard-os#820, on for everyone): the YouTube Music connector, this hub and this app server,
# run as processes on 127.0.0.1, with only YouTube itself replaced. YouTube refuses data-centre machines, so a local
# web server plays YouTube: it lists the formats YouTube offers for a song signed out (itags 139/140 AAC, 249/250/251
# Opus) and serves real audio files for them. The connector runs the REAL yt-dlp (its pinned version), which picks the
# format with its own selector and downloads it; only the page fetch is swapped for that format list
# (--load-info-json). Then it asks Music for the song as different players would, and
# prints what each one got (ffprobe).
#
#   bash qa/opus-audio-e2e.sh            # connector: wizard-youtube-music main, or its PR #18 while main lacks ?codec=opus
#   CONNECTOR_REF=pull/18/head bash qa/opus-audio-e2e.sh
#
# Needs python3, node/npm, ffmpeg + ffprobe and git. Exit 0 when every player got what it should.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/opus-e2e.XXXXXX")"
ref="${CONNECTOR_REF:-main}"
port_yt="${PORT_YT:-19831}" port_conn="${PORT_CONN:-19832}" port_hub="${PORT_HUB:-19833}" port_app="${PORT_APP:-19834}"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || { echo "needs ffmpeg and ffprobe on PATH"; exit 77; }
echo "work dir: $work"

# 1. "YouTube": the same 20 s of sound as AAC 128k 44.1 kHz (itag 140) and Opus 48 kHz in webm (itag 251).
mkdir -p "$work/yt"
ffmpeg -v error -y -f lavfi -i "sine=f=440:d=20" -f lavfi -i "sine=f=660:d=20" -filter_complex amix=inputs=2 -ar 48000 -c:a libopus -b:a 135k -f webm "$work/yt/251.webm"
ffmpeg -v error -y -f lavfi -i "sine=f=440:d=20" -f lavfi -i "sine=f=660:d=20" -filter_complex amix=inputs=2 -ar 44100 -c:a aac -b:a 128k "$work/yt/140.m4a"
ffmpeg -v error -y -f lavfi -i "sine=f=440:d=20" -ar 22050 -c:a aac -b:a 48k "$work/yt/139.m4a"
ffmpeg -v error -y -f lavfi -i "sine=f=440:d=20" -ar 48000 -c:a libopus -b:a 50k -f webm "$work/yt/249.webm"
cp "$work/yt/249.webm" "$work/yt/250.webm"
python3 - "$work" "$port_yt" <<'EOF'
import json, os, sys
work, port = sys.argv[1], sys.argv[2]
def f(itag, ext, acodec, abr, asr):
    p = f"{work}/yt/{itag}.{ext}"
    return {"format_id": itag, "ext": ext, "acodec": acodec, "vcodec": "none", "abr": abr, "tbr": abr, "asr": asr,
            "audio_ext": ext, "video_ext": "none", "filesize": os.path.getsize(p), "protocol": "http",
            "url": f"http://127.0.0.1:{port}/{itag}.{ext}"}
formats = [f("139", "m4a", "mp4a.40.5", 48.8, 22050), f("140", "m4a", "mp4a.40.2", 129.5, 44100),
           f("249", "webm", "opus", 53.0, 48000), f("250", "webm", "opus", 67.0, 48000), f("251", "webm", "opus", 135.6, 48000)]
base = {"title": "Opus check", "extractor": "youtube", "extractor_key": "Youtube", "_type": "video", "duration": 20}
for vid, fmts in (("zKmWd8DPrEc", formats), ("noOpusSong1", formats[:2])):  # the second song has no Opus, like a few do
    json.dump(dict(base, id=vid, webpage_url=f"https://music.youtube.com/watch?v={vid}", formats=fmts), open(f"{work}/yt/{vid}.json", "w"))
EOF
(cd "$work/yt" && exec python3 -m http.server "$port_yt" --bind 127.0.0.1 >/dev/null 2>&1) & pids+=($!)

# 2. The connector at $ref with its pinned yt-dlp; yt-dlp reads the format list above instead of YouTube's page.
git clone -q https://github.com/humanitylabs-org/wizard-youtube-music "$work/connector"
git -C "$work/connector" fetch -q origin "$ref" && git -C "$work/connector" checkout -q FETCH_HEAD
if ! grep -q '"opus": "bestaudio\[acodec=opus\]' "$work/connector/app/server.py"; then
  # main has no ?codec=opus yet: use the connector change that adds it (humanitylabs-org/wizard-youtube-music#18)
  echo "connector $ref has no ?codec=opus yet: using humanitylabs-org/wizard-youtube-music#18"
  git -C "$work/connector" fetch -q origin pull/18/head && git -C "$work/connector" checkout -q FETCH_HEAD
fi
echo "connector: $(git -C "$work/connector" rev-parse --short HEAD) ($(grep -o 'VERSION = "[^"]*"' "$work/connector/app/server.py"))"
python3 -m venv "$work/venv" && "$work/venv/bin/pip" -q install -r "$work/connector/requirements.txt" tinytag==2.3.2
cat > "$work/yt-dlp" <<EOF
#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
url = args.pop()  # https://music.youtube.com/watch?v=<id>
vid = url.rsplit("=", 1)[1]
open("$work/yt-dlp.log", "a").write(args[args.index("-f") + 1] + "\n")
os.execv("$work/venv/bin/yt-dlp", ["yt-dlp", *[a for a in args if a not in ("--js-runtimes", "node")], "--load-info-json", "$work/yt/" + vid + ".json"])
EOF
chmod +x "$work/yt-dlp"
mkdir -p "$work/conn" "$work/hub" "$work/lib" "$work/sw"
(cd "$work/connector" && DATA_DIR="$work/conn" PORT="$port_conn" YTDLP="$work/yt-dlp" exec "$work/venv/bin/python" app/server.py >"$work/conn.log" 2>&1) & pids+=($!)

# 3. This hub and app server, the way the Music image runs them.
(cd "$here" && WIZARD_MUSIC_HUB_PORT="$port_hub" WIZARD_MUSIC_HUB_TOKEN=qa WIZARD_MUSIC_HUB_HOME="$work/hub" WIZARD_MUSIC_LIBRARY="$work/lib" \
  WIZARD_MUSIC_ONLINE=1 WIZARD_MUSIC_SOURCES="wizard-youtube-music=http://127.0.0.1:$port_conn" exec "$work/venv/bin/python" hub/hub.py >"$work/hub.log" 2>&1) & pids+=($!)
[ -d "$here/dist" ] || (cd "$here" && npm ci --silent && npm run -s build)
(cd "$here" && WIZARD_MUSIC_APP_PORT="$port_app" WIZARD_MUSIC_HUB_ORIGIN="http://127.0.0.1:$port_hub" WIZARD_MUSIC_HUB_TOKEN=qa \
  WIZARD_SWITCHES_DIR="$work/sw" exec node server/index.mjs >"$work/app.log" 2>&1) & pids+=($!)
for p in "$port_conn" "$port_hub" "$port_app"; do for _ in $(seq 60); do curl -s -o /dev/null "127.0.0.1:$p" && break; sleep 0.5; done; done
curl -s -X POST -H "Authorization: Bearer qa" -H 'content-type: application/json' -d '{"online":true}' "127.0.0.1:$port_hub/api/settings" >/dev/null

# 4. Ask for songs as each player would.
declare -A UA=(
  [chrome-desktop]="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  [android-app]="WizardBackgroundAudio/1"
  [firefox]="Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0"
  [safari-mac]="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15"
  [iphone-app]="AppleCoreMedia/1.0.0.22B83 (iPhone; U; CPU OS 18_1 like Mac OS X; en_us)"
)
bad=0
play() {  # player song expected-codec
  curl -s -o "$work/got" -A "${UA[$1]}" "http://127.0.0.1:$port_app/wizard-music/stream/yt:$2"
  got="$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate -of csv=p=0 "$work/got" 2>/dev/null || echo none)"
  itag=?; for f in "$work"/yt/*.*; do cmp -s "$f" "$work/got" && itag="$(basename "${f%.*}")"; done
  want_itag=140; [ "$3" = opus ] && want_itag=251
  ok=ok; [ "${got%%,*}" = "$3" ] && [ "$itag" = "$want_itag" ] || { ok=WRONG; bad=1; }
  printf '%-15s %-12s -> %-12s itag %-4s (want %s, itag %s) %s\n' "$1" "$2" "$got" "$itag" "$3" "$want_itag" "$ok"
}
echo "player          song            got            "
for p in chrome-desktop android-app firefox; do play "$p" zKmWd8DPrEc opus; done
for p in safari-mac iphone-app; do play "$p" zKmWd8DPrEc aac; done
play chrome-desktop noOpusSong1 aac
echo; echo "formats yt-dlp was asked for:"; sort "$work/yt-dlp.log" | uniq -c
echo "connector cache: $(ls "$work/conn/audio" | tr '\n' ' ')"
echo "hub cache:       $(ls "$work/hub/cache" | tr '\n' ' ')"
[ "$bad" = 0 ] && echo "PASS: every player got what it should" || echo "FAIL: see WRONG above"
exit "$bad"
