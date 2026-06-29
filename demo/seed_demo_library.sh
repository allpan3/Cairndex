#!/usr/bin/env bash
# Generate a demo media folder with REAL, browser-playable media so every
# implemented feature can be exercised end to end from the GUI:
#   - bundling (a movie dir → one bundle of video + cover + subtitle)
#   - direct playback (H.264/AAC MP4 in an mp4 container)
#   - external subtitle auto-link (basename + language suffix)
#   - probe (ffprobe tech metadata) and thumbnails (cover generation)
#   - standalone images for grid/justified/list layouts
#
# The folder is a plain media tree with NO .cairndex marker, so you can add it
# from the GUI via "Create new" and then Scan. It lives OUTSIDE the server's
# `var/` data dir, so wiping `var` (the registry) never deletes your media — you
# can just re-register the same folder afterwards (ADR-0008 portability).
#
#   ./demo/seed_demo_library.sh [DEST]
#
# DEST defaults to ~/CairndexDemo. Re-running wipes and regenerates DEST.
set -euo pipefail

DEST="${1:-$HOME/CairndexDemo}"

command -v ffmpeg >/dev/null || { echo "ffmpeg is required (brew install ffmpeg)"; exit 1; }

echo "==> (Re)creating demo media at $DEST"
rm -rf "$DEST"
mkdir -p "$DEST/Movies/Cosmos" "$DEST/Movies/Waves" "$DEST/Photos"

# --- A short H.264/AAC MP4 the browser can actually play -----------------------
make_video() {  # <file> <testsrc-pattern> <freq>
  ffmpeg -y -loglevel error \
    -f lavfi -i "${2}=duration=6:size=854x480:rate=24" \
    -f lavfi -i "sine=frequency=${3}:duration=6" \
    -c:v libx264 -pix_fmt yuv420p -profile:v baseline -movflags +faststart \
    -c:a aac -shortest "$1"
}

# --- A single-frame image -----------------------------------------------------
make_image() {  # <file> <lavfi-source>
  ffmpeg -y -loglevel error -f lavfi -i "$2" -frames:v 1 "$1"
}

echo "==> Movies/Cosmos (video + poster + subtitle → one bundle)"
make_video "$DEST/Movies/Cosmos/cosmos.mp4" "testsrc" 300
make_image "$DEST/Movies/Cosmos/poster.jpg" "mandelbrot=size=854x480"
cat > "$DEST/Movies/Cosmos/cosmos.en.srt" <<'SRT'
1
00:00:00,000 --> 00:00:03,000
A journey through the cosmos.

2
00:00:03,000 --> 00:00:06,000
Subtitles auto-link to the video.
SRT

echo "==> Movies/Waves (a second video bundle)"
make_video "$DEST/Movies/Waves/waves.mp4" "smptebars" 440
make_image "$DEST/Movies/Waves/cover.jpg" "rgbtestsrc=size=854x480"

echo "==> Photos (standalone images)"
make_image "$DEST/Photos/aurora.jpg"   "gradients=size=800x600"
make_image "$DEST/Photos/canyon.png"   "mandelbrot=size=800x600"
make_image "$DEST/Photos/portrait.jpg" "testsrc2=size=600x800"

echo
echo "==> Done. Demo media tree:"
find "$DEST" -type f | sort | sed "s|$DEST|.|"
echo
echo "Next: add this library from the GUI ('Create new' → path below), then Scan:"
echo "  $DEST"
