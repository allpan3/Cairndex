#!/usr/bin/env bash
# ADDITIVE enrichment for the demo library created by seed_demo_library.sh.
#
# Unlike that script, this one NEVER wipes: it only creates new nested folders
# and files under DEST, leaving the existing Movies/Cosmos, Movies/Waves,
# Photos/*, and the .cairndex metadata package untouched. Safe to run against a
# registered/open library — afterwards just hit "Update" (or Scan) in the GUI to
# pick up the new files.
#
# It builds a deliberately messy, realistic tree: deep nesting, some folders
# that clearly belong together (a doc's video + subtitles + poster, an album's
# tracks + cover, a trip's photo set) and some unrelated standalones, across
# many common file types (mp4, srt, jpg, png, gif, mp3, pdf, md, txt, csv, json).
#
#   ./demo/seed_demo_extras.sh [DEST]
#
# DEST defaults to ~/CairndexDemo. Re-running overwrites only these extras.
set -euo pipefail

DEST="${1:-$HOME/CairndexDemo}"

command -v ffmpeg >/dev/null || { echo "ffmpeg is required (brew install ffmpeg)"; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }

if [[ ! -d "$DEST" ]]; then
  echo "DEST '$DEST' does not exist — run demo/seed_demo_library.sh first." >&2
  exit 1
fi

echo "==> Enriching demo media at $DEST (additive; nothing existing is removed)"

# --- generators ---------------------------------------------------------------
make_video() {  # <file> <lavfi-source> <freq>
  [[ -f "$1" ]] && return 0
  ffmpeg -y -loglevel error \
    -f lavfi -i "${2}=duration=4:size=320x240:rate=24" \
    -f lavfi -i "sine=frequency=${3}:duration=4" \
    -c:v libx264 -pix_fmt yuv420p -profile:v baseline -movflags +faststart \
    -c:a aac -shortest "$1"
}
make_image() {  # <file> <lavfi-source>
  [[ -f "$1" ]] && return 0
  ffmpeg -y -loglevel error -f lavfi -i "$2" -frames:v 1 "$1"
}
make_gif() {  # <file>
  [[ -f "$1" ]] && return 0
  ffmpeg -y -loglevel error -f lavfi -i "testsrc=size=160x160:rate=10:duration=2" "$1"
}
make_audio() {  # <file> <freq>
  [[ -f "$1" ]] && return 0
  ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=${2}:duration=3" -c:a libmp3lame -q:a 6 "$1"
}
write() {  # <file> <<'EOF' body ...
  cat > "$1"
}
make_pdf() {  # <file> <title> <line...>
  local out="$1"; shift
  [[ -f "$out" ]] && return 0
  python3 - "$out" "$@" <<'PY'
import sys
def esc(s): return s.replace('\\','\\\\').replace('(','\\(').replace(')','\\)')
path, title, *body = sys.argv[1], sys.argv[2], *sys.argv[3:]
parts = ["BT","/F1 20 Tf","72 720 Td","(%s) Tj" % esc(title),"ET"]
y = 688
for ln in body:
    parts += ["BT","/F1 11 Tf","72 %d Td" % y,"(%s) Tj" % esc(ln),"ET"]; y -= 16
content = "\n".join(parts).encode('latin-1', 'replace')
objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
]
out = b"%PDF-1.4\n"; offsets = []
for i, o in enumerate(objs, start=1):
    offsets.append(len(out)); out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
for off in offsets: out += b"%010d 00000 n \n" % off
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
open(path, "wb").write(out)
PY
}

mkd() { mkdir -p "$@"; }

# --- Movies: documentaries (grouping fixtures) + loose trailers ---------------
echo "==> Movies/Documentaries + Trailers"
mkd "$DEST/Movies/Documentaries/DeepOcean" "$DEST/Movies/Documentaries/SpaceRace" "$DEST/Movies/Trailers"

make_video "$DEST/Movies/Documentaries/DeepOcean/deep_ocean.mp4" "testsrc2" 210
make_image "$DEST/Movies/Documentaries/DeepOcean/poster.jpg" "mandelbrot=size=320x240"
write "$DEST/Movies/Documentaries/DeepOcean/deep_ocean.en.srt" <<'EOF'
1
00:00:00,000 --> 00:00:02,000
Descending into the deep ocean.

2
00:00:02,000 --> 00:00:04,000
Bioluminescence lights the dark.
EOF
write "$DEST/Movies/Documentaries/DeepOcean/deep_ocean.es.srt" <<'EOF'
1
00:00:00,000 --> 00:00:02,000
Descendiendo al océano profundo.

2
00:00:02,000 --> 00:00:04,000
La bioluminiscencia ilumina la oscuridad.
EOF

make_video "$DEST/Movies/Documentaries/SpaceRace/space_race.mp4" "smptehdbars" 330
make_image "$DEST/Movies/Documentaries/SpaceRace/folder.jpg" "gradients=size=320x240"

make_video "$DEST/Movies/Trailers/trailer_neon.mp4" "testsrc" 500
make_video "$DEST/Movies/Trailers/trailer_dunes.mp4" "rgbtestsrc" 260

# --- Photos: a trip with per-city sets (related) + loose screenshots -----------
echo "==> Photos/Vacation2025 + Screenshots"
mkd "$DEST/Photos/Vacation2025/Rome" "$DEST/Photos/Vacation2025/Paris" "$DEST/Photos/Screenshots"

make_image "$DEST/Photos/Vacation2025/Rome/colosseum.jpg" "mandelbrot=size=800x600"
make_image "$DEST/Photos/Vacation2025/Rome/forum.png" "testsrc2=size=800x600"
write "$DEST/Photos/Vacation2025/Rome/captions.txt" <<'EOF'
colosseum.jpg — morning light, west side
forum.png — from the Palatine hill
EOF
make_image "$DEST/Photos/Vacation2025/Paris/eiffel.jpg" "gradients=size=600x800"
make_image "$DEST/Photos/Vacation2025/Paris/seine.png" "rgbtestsrc=size=800x600"
make_pdf "$DEST/Photos/Vacation2025/itinerary.pdf" "Vacation 2025 Itinerary" \
  "Day 1  Rome - Colosseum, Roman Forum" \
  "Day 2  Rome - Vatican Museums" \
  "Day 3  Paris - Eiffel Tower, Seine cruise" \
  "Day 4  Paris - Louvre"

make_image "$DEST/Photos/Screenshots/screen-2025-01-03.png" "testsrc=size=1024x640"
make_image "$DEST/Photos/Screenshots/screen-2025-02-14.png" "smptebars=size=1024x640"

# --- Music: an album (related tracks + cover + notes) + a loose single ---------
echo "==> Music/Albums/SynthWave + Singles"
mkd "$DEST/Music/Albums/SynthWave" "$DEST/Music/Singles"

make_audio "$DEST/Music/Albums/SynthWave/01-intro.mp3" 220
make_audio "$DEST/Music/Albums/SynthWave/02-drive.mp3" 330
make_audio "$DEST/Music/Albums/SynthWave/03-sunset.mp3" 440
make_image "$DEST/Music/Albums/SynthWave/cover.jpg" "gradients=size=500x500"
write "$DEST/Music/Albums/SynthWave/album.md" <<'EOF'
# SynthWave

A three-track demo album.

1. Intro
2. Drive
3. Sunset
EOF
make_audio "$DEST/Music/Singles/lonely-signal.mp3" 180

# --- Documents: unrelated office/personal files across common formats ----------
echo "==> Documents (work / personal / manuals)"
mkd "$DEST/Documents/Work" "$DEST/Documents/Personal" "$DEST/Documents/Manuals"

make_pdf "$DEST/Documents/Work/q1-report.pdf" "Q1 Report" \
  "Revenue up 12% quarter over quarter." \
  "Headcount steady; two open roles." \
  "Risks: supplier lead times."
write "$DEST/Documents/Work/budget.csv" <<'EOF'
category,planned,actual
engineering,120000,118400
marketing,40000,45230
operations,30000,28900
EOF
write "$DEST/Documents/Work/standup-notes.md" <<'EOF'
# Standup — 2025-03-14

- [x] Ship file-view grid
- [ ] Wire whole-library file search
- [ ] Review grouping edge cases
EOF

make_pdf "$DEST/Documents/Personal/resume.pdf" "Jane Doe - Resume" \
  "Experience: 8 years building media tooling." \
  "Skills: Python, TypeScript, SQLite, ffmpeg."
write "$DEST/Documents/Personal/recipes.txt" <<'EOF'
Weeknight pasta
- garlic, olive oil, chili flakes
- parmesan, parsley
Toss with reserved pasta water.
EOF
write "$DEST/Documents/Personal/todo.md" <<'EOF'
# Todo

- renew passport
- back up the NAS
- label the vacation photos
EOF

make_pdf "$DEST/Documents/Manuals/camera-guide.pdf" "Camera Quick Guide" \
  "Aperture priority: control depth of field." \
  "ISO: keep low in daylight." \
  "RAW + JPEG for flexibility."

# --- Archive: deep, mixed cruft (unrelated) -----------------------------------
echo "==> Archive (deep mixed cruft)"
mkd "$DEST/Archive/2019-project" "$DEST/Archive/misc"

write "$DEST/Archive/2019-project/data.json" <<'EOF'
{
  "project": "atlas",
  "year": 2019,
  "tags": ["legacy", "archive"],
  "active": false
}
EOF
write "$DEST/Archive/2019-project/README.md" <<'EOF'
# Atlas (2019, archived)

Old prototype. Kept for reference only.
EOF
write "$DEST/Archive/2019-project/legacy-notes.txt" <<'EOF'
Do not delete. Historical notes for the atlas prototype.
EOF
make_gif "$DEST/Archive/misc/loop.gif"

echo
echo "==> Done. New/updated tree (excluding .cairndex):"
find "$DEST" -type f -not -path '*/.cairndex/*' | sort | sed "s|$DEST|.|"
echo
echo "Next: in the GUI, hit Update (or Scan new files) to index the additions."
