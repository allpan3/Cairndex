#!/usr/bin/env bash
# Seed a small scratch library for the Docker dev stack.
#
#   ./infra/docker/dev-library.sh [target-dir] [--force]
#
# Generates real (tiny) media rather than metadata rows: a handful of 2-second
# 160x120 clips, JPEG covers, and subtitle files, arranged so that grouping,
# multi-file bundles, covers, and playback all have something to work on. The
# whole tree is well under a megabyte.
#
# This is deliberately not `devtools.synthetic_library`, which writes database
# rows for files that do not exist — right for benchmarking query plans at
# 100k bundles, wrong here, because every file would show as missing and no
# thumbnail or playback path would run.
#
# ffmpeg comes from the project's own dev image, so the host needs no local
# ffmpeg — which is much of the point of working in containers.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="${1:-$REPO_ROOT/var/docker-library}"
FORCE="${2:-}"
IMAGE="cairndex-dev-ffmpeg"

if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ] && [ "$FORCE" != "--force" ]; then
    echo "'$TARGET' already exists and is not empty." >&2
    echo "Re-run with --force to add to it, or remove it first." >&2
    exit 1
fi
mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"

# A tiny single-purpose image rather than the compose dev image: this needs
# nothing but ffmpeg, and building it takes seconds instead of a uv sync.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "==> building a small ffmpeg image ($IMAGE)"
    docker build -q -t "$IMAGE" - >/dev/null <<'DOCKERFILE'
FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
DOCKERFILE
fi

echo "==> generating media in $TARGET"
docker run --rm -v "$TARGET:/out" -w /out --entrypoint sh "$IMAGE" -c '
set -e
# testsrc gives each clip visibly different content, so covers and storyboards
# are distinguishable rather than five copies of the same grey frame.
clip() { ffmpeg -v error -y -f lavfi -i "testsrc=size=160x120:rate=10:duration=2" \
           -f lavfi -i "sine=frequency=$2:duration=2" \
           -pix_fmt yuv420p -shortest "$1"; }
still() { ffmpeg -v error -y -f lavfi -i "testsrc=size=320x240:duration=1" -frames:v 1 "$1"; }
sub() { printf "1\n00:00:00,000 --> 00:00:02,000\n%s\n" "$2" > "$1"; }

mkdir -p "Wandering Coast (2021)" "Northern Signal (2019)" "Field Notes S01" photos

# A multi-part film with a cover and subtitles: the multi-file bundle case.
clip "Wandering Coast (2021)/Wandering.Coast.2021.part1.mp4" 220
clip "Wandering Coast (2021)/Wandering.Coast.2021.part2.mp4" 260
still "Wandering Coast (2021)/cover.jpg"
sub "Wandering Coast (2021)/Wandering.Coast.2021.srt" "Wandering Coast"

# A single-file film, also with an external subtitle.
clip "Northern Signal (2019)/Northern.Signal.2019.mp4" 300
sub "Northern Signal (2019)/Northern.Signal.2019.srt" "Northern Signal"

# An episodic set: several siblings that should group together.
for i in 1 2 3; do
  clip "Field Notes S01/Field.Notes.S01E0${i}.mp4" $((330 + i * 20))
done

# Loose images and a loose clip, so image handling and unbundled files appear.
for i in 1 2 3 4; do still "photos/img-00${i}.jpg"; done
clip "roadside.mp4" 440
'

echo
echo "==> seeded $(find "$TARGET" -type f | wc -l | tr -d ' ') files"
find "$TARGET" -type f | sed "s|^$TARGET/|  |" | sort
echo
echo "Next:"
echo "  1. set CAIRNDEX_DEV_LIBRARY_PATH=$TARGET in .env"
echo "  2. just docker-dev"
echo "  3. add the library in the app (root /libraries/main), then Update"
