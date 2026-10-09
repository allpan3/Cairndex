#!/usr/bin/env bash
# Prove the production image *serves*, not just that it builds.
#
# Building an image only proves the Dockerfile is syntactically fine and the
# dependencies resolve. It says nothing about whether the thing starts, whether
# ffmpeg is present, whether the non-root user can write the volumes it is
# given, whether direct video ranges are served, or whether the read-only root
# filesystem leaves anything important unwritable. Those are exactly the ways
# this image can rot while CI stays green, so they are what this checks.
#
# Libraries are portable format three (ADR-0035): the mounted root receives only
# the descriptor and immutable history under .cairndex/, and every working
# database, cache and process lock stays in the private /data volume.
#
#   ./infra/docker/smoke.sh                    # build fresh, test, remove image
#   ./infra/docker/smoke.sh <image-tag>        # test an explicitly built image
#
# An explicit image is the only reuse path. Leaves nothing behind otherwise.
set -euo pipefail

if [[ $# -gt 1 ]]; then
    echo "usage: $0 [image-tag]" >&2
    exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILT_IMAGE=false
if [[ $# -eq 0 ]]; then
    REVISION=$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo worktree)
    IMAGE="cairndex:smoke-${REVISION}-$$"
    BUILT_IMAGE=true
else
    IMAGE="$1"
fi
CONTAINER="cairndex-smoke-$$"
PORT="${CAIRNDEX_SMOKE_PORT:-18000}"
LIBRARY_DIR="$(mktemp -d)"
ALT_CONTAINER="${CONTAINER}-altuid"
ALT_LIBRARY_DIR="$(mktemp -d)"
ALT_DATA_DIR="$(mktemp -d)"
ALT_PORT=$((PORT + 1))
RANGE_HEADERS=""
RANGE_BODY=""

cleanup() {
    docker rm -f "$CONTAINER" "$ALT_CONTAINER" >/dev/null 2>&1 || true
    docker volume rm "${CONTAINER}-data" >/dev/null 2>&1 || true
    # The .cairndex/ tree and the generated video belong to uid 10001 on the host
    # as well (see in_library below), so this user cannot unlink them. Root in a
    # container can.
    in_library rm -rf /libraries/main/.cairndex /libraries/main/smoke.mp4 >/dev/null 2>&1 || true
    rm -rf "$LIBRARY_DIR"
    # The alternate-uid run wrote as *this* user, so no container is needed.
    rm -rf "$ALT_LIBRARY_DIR" "$ALT_DATA_DIR"
    [[ -z "$RANGE_HEADERS" ]] || rm -f "$RANGE_HEADERS"
    [[ -z "$RANGE_BODY" ]] || rm -f "$RANGE_BODY"
    if [[ "$BUILT_IMAGE" == true ]]; then
        docker image rm "$IMAGE" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $*" >&2; docker logs "$CONTAINER" 2>&1 | tail -40 >&2; exit 1; }
step() { echo "==> $*"; }

# Inspect the library mount from inside a container, as root.
#
# A Linux bind mount preserves real uids, so everything the container writes
# into the library is owned on the host by its uid 10001: the lease file (mode
# 0600) is unreadable to this user and the .cairndex/ tree is unremovable.
# Docker Desktop for macOS instead remaps ownership to the invoking user, which
# is why every host-side check below passed locally and this only broke the
# first time it ran on Linux — the same trap that made the entrypoint's
# permission preflight untestable on a Mac. Reading through a container makes
# the checks mean the same thing on both, and matches what the NAS will do.
in_library() {
    docker run --rm --user 0:0 --entrypoint "$1" \
        -v "${LIBRARY_DIR}:/libraries/main" "$IMAGE" "${@:2}"
}

api() { curl -fsS "http://127.0.0.1:${PORT}/api/v1$1" "${@:2}"; }
post_json() { api "$1" -X POST -H 'content-type: application/json' -d "$2"; }

wait_healthy() {
    for _ in $(seq 1 60); do
        if api /health >/dev/null 2>&1; then return 0; fi
        docker ps -q --filter "name=$CONTAINER" | grep -q . || fail "container exited during startup"
        sleep 1
    done
    fail "server never became healthy"
}

# Run one portable workflow step against the first container. Statuses are
# checked here so a failure names the step instead of a JSON traceback.
portable() {
    python3 - "$PORT" "$@" <<'PYTHON'
import json
import sys
import time
import urllib.error
import urllib.request

port, action, library = sys.argv[1:4]
base = f"http://127.0.0.1:{port}/api/v1/libraries/{library}"


def request(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        base + path, data=data, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{path} returned HTTP {error.code}") from None


def wait(path, field, value):
    for _ in range(240):
        result = request(path)
        if result.get(field) == value:
            return result
        if result.get("state") in {"failed", "cancelled", "interrupted"}:
            raise SystemExit(f"portable operation {path} ended as {result.get('state')}")
        time.sleep(0.5)
    raise SystemExit(f"portable operation {path} timed out")


if action == "update":
    # Update finds the generated video; an explicit reviewed accept admits it.
    wait("/replica/status", "ready", True)
    request("/replica/discovery/runs", {"operation": "smoke-update"})
    wait("/replica/discovery/status", "state", "succeeded")
    candidates = request("/replica/discovery/candidates")["items"]
    if len(candidates) != 1:
        raise SystemExit(f"Update found {len(candidates)} candidates, expected 1")
    request(
        "/replica/discovery/reviews",
        {"operation": "smoke-review", "candidate": candidates[0]["id"]},
    )
    review = wait("/replica/discovery/reviews/smoke-review", "state", "ready")
    request("/replica/discovery/reviews/smoke-review/accept", {"receipt": review["receipt"]})
    wait("/replica/discovery/reviews/smoke-review", "state", "applied")
elif action == "catalog":
    # Print "<bundle id> <file id>" for the one admitted bundle and its video.
    wait("/replica/status", "ready", True)
    bundles = request("/replica/catalog/entities/asset_bundles?limit=10")["items"]
    if len(bundles) != 1:
        raise SystemExit(f"catalog has {len(bundles)} bundles, expected 1")
    files = request(f"/replica/media/bundles/{bundles[0]['id']}")["files"]
    if len(files) != 1 or not files[0]["relative_path"].endswith("smoke.mp4"):
        raise SystemExit("the admitted bundle does not hold the generated video")
    print(bundles[0]["id"], files[0]["id"])
else:
    raise SystemExit(f"unknown portable action {action}")
PYTHON
}

if [[ "$BUILT_IMAGE" == true ]]; then
    step "building $IMAGE"
    docker build -f "$REPO_ROOT/infra/docker/production.Dockerfile" -t "$IMAGE" "$REPO_ROOT"
elif ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "SMOKE FAIL: explicit image does not exist: $IMAGE" >&2
    exit 1
fi

# The library dir is created by mktemp as this user; the container runs as uid
# 10001 and must be able to write its .cairndex/ package into it.
chmod 777 "$LIBRARY_DIR"

step "starting container (read-only root fs, non-root user)"
docker run -d --name "$CONTAINER" \
    -p "127.0.0.1:${PORT}:8000" \
    -e CAIRNDEX_PREFER_HLS=true \
    -v "${CONTAINER}-data:/data" \
    -v "${LIBRARY_DIR}:/libraries/main:rw" \
    --read-only --tmpfs /tmp \
    --security-opt no-new-privileges:true \
    "$IMAGE" >/dev/null

step "waiting for health"
wait_healthy
if [[ -n "${CAIRNDEX_EXPECTED_BUILD_COMMIT:-}" ]]; then
    health_json=$(api /health)
    python3 -c '
import json, sys

health = json.load(sys.stdin)
expected = sys.argv[1].lower()
actual = health.get("build_commit")
if actual != expected:
    raise SystemExit(f"health build_commit is {actual!r}, expected {expected!r}")
' "$CAIRNDEX_EXPECTED_BUILD_COMMIT" <<<"$health_json" \
        || fail "image health did not report the expected build commit"
fi

step "SPA is served"
spa_status=$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/")
[ "$spa_status" = "200" ] || fail "SPA root returned $spa_status"

step "ffmpeg and ffprobe are present"
docker exec "$CONTAINER" ffmpeg -version >/dev/null 2>&1 || fail "ffmpeg missing from image"
docker exec "$CONTAINER" ffprobe -version >/dev/null 2>&1 || fail "ffprobe missing from image"

step "creating a library on the mounted volume"
library_id=$(post_json /libraries/create \
    '{"display_name":"Smoke","root_path":"/libraries/main"}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
in_library test -f /libraries/main/.cairndex/manifest.json \
    || fail "library package was not written to the mounted volume"

step "generating a real video and running a reviewed Update"
# Generated inside the container so the host needs no ffmpeg, and so this also
# exercises writing into the library mount as the non-root user.
docker exec "$CONTAINER" ffmpeg -v error \
    -f lavfi -i testsrc=size=160x120:rate=10:duration=2 \
    -pix_fmt yuv420p /libraries/main/smoke.mp4 || fail "could not write into library mount"
portable update "$library_id" || fail "reviewed Update did not admit the generated video"
read -r bundle_id file_id < <(portable catalog "$library_id") \
    || fail "the catalog does not hold the admitted video"

# A decodable thumbnail proves ffmpeg ran and wrote its derivative into the
# private /data cache — i.e. the media pipeline works, not just the web layer.
step "the admitted video has a thumbnail"
thumbnail_type=$(api "/libraries/${library_id}/bundles/${bundle_id}/files/${file_id}/thumbnail" \
    | python3 -c '
import sys
# Read the whole body: an early exit would end curl with SIGPIPE.
head = sys.stdin.buffer.read()[:12]
print("jpeg" if head.startswith(b"\xff\xd8\xff") else "webp" if head[8:12] == b"WEBP" else "other")
') || fail "thumbnail request failed (media pipeline broken)"
[ "$thumbnail_type" != "other" ] || fail "thumbnail is not a JPEG or WebP image"

step "direct video supports bounded byte ranges"
media_json=$(api "/libraries/${library_id}/replica/media/files/${file_id}") \
    || fail "could not read the video's media state"
stream_path=$(python3 -c '
import json, sys
media = json.load(sys.stdin)
assert media["state"] == "available", media["state"]
print(media["playback"]["stream_url"])
' <<<"$media_json") || fail "the admitted video is not available for playback"
source_generation=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["generation"])' \
    <<<"$media_json")
RANGE_HEADERS=$(mktemp)
RANGE_BODY=$(mktemp)
range_status=$(curl -fsS -D "$RANGE_HEADERS" -o "$RANGE_BODY" -w '%{http_code}' \
    -H 'Range: bytes=0-1023' "http://127.0.0.1:${PORT}${stream_path}") \
    || fail "direct video range request failed"
[ "$range_status" = "206" ] || fail "direct video range returned $range_status instead of 206"
[ "$(wc -c <"$RANGE_BODY" | tr -d ' ')" = "1024" ] \
    || fail "direct video range returned the wrong body length"
# curl preserves the CR in HTTP header line endings
grep -Eqi '^accept-ranges: bytes[[:space:]]*$' "$RANGE_HEADERS" \
    || fail "direct video response omitted Accept-Ranges"
grep -Eqi '^content-range: bytes 0-1023/[0-9]+[[:space:]]*$' "$RANGE_HEADERS" \
    || fail "direct video response returned the wrong Content-Range"
rm -f "$RANGE_HEADERS" "$RANGE_BODY"
RANGE_HEADERS=""
RANGE_BODY=""

step "production playback preference serves copy-only HLS"
hls_decision=$(post_json "/libraries/${library_id}/files/${file_id}/playback-decision" \
    "{\"source_generation\":\"${source_generation}\",\"caps\":{\"protocols\":[\"progressive\",\"hls\"],\"containers\":[\"mp4\"],\"video_codecs\":[\"h264\"],\"audio_codecs\":[\"aac\"]}}")
hls_method=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["method"])' <<<"$hls_decision")
[ "$hls_method" = "remux" ] || fail "HLS preference returned $hls_method instead of remux"
playlist_path=$(python3 -c \
    'import json,sys; print(json.load(sys.stdin)["session"]["playlist_url"])' \
    <<<"$hls_decision")
session_path="${playlist_path%/index.m3u8}"
api "${playlist_path#/api/v1}" >/dev/null || fail "preferred HLS playlist was unavailable"
api "${session_path#/api/v1}/init.mp4" >/dev/null || fail "preferred HLS init was unavailable"
api "${session_path#/api/v1}/0.m4s" >/dev/null || fail "preferred HLS segment was unavailable"
api "${session_path#/api/v1}" -X DELETE >/dev/null || fail "preferred HLS session teardown failed"

# The portable package must hold no mutable database: a database there is what
# made the old format unsafe to open over SMB or NFS from more than one server
# (ADR-0021, ADR-0035). The working stores belong in the private /data volume.
package_has_no_database() {
    in_library python3 -c '
from pathlib import Path
found = [p for p in Path("/libraries/main/.cairndex").rglob("*") if ".db" in p.name]
raise SystemExit("mutable database in portable package" if found else 0)
' || fail "mutable database found inside the portable package ($1)"
}

# The same container restarts with its volumes; the admitted bundle and its
# file keep their IDs, which proves the private store survived the stop.
restarted_catalog_is_intact() {
    docker start "$CONTAINER" >/dev/null || fail "container did not restart ($1)"
    wait_healthy
    read -r restarted_bundle restarted_file < <(portable catalog "$library_id") \
        || fail "the catalog was not readable after $1"
    [ "$restarted_bundle $restarted_file" = "$bundle_id $file_id" ] \
        || fail "bundle or file identity changed after $1"
}

step "graceful stop keeps the portable package free of databases"
docker stop --timeout 30 "$CONTAINER" >/dev/null
package_has_no_database "clean stop"
docker run --rm --user 0:0 --entrypoint python3 -v "${CONTAINER}-data:/data" "$IMAGE" -c '
from pathlib import Path
raise SystemExit(0 if list(Path("/data/replica-bindings").glob("*.json")) else 1)
' || fail "the private store binding is not in the /data volume"
step "clean restart reopens the same catalog"
restarted_catalog_is_intact "a clean restart"

# A killed server gets no lifespan shutdown. Its private process lock must not
# survive it, and the private store must reopen without a manual repair.
step "forced process exit, then restart reopens the same catalog"
docker kill --signal KILL "$CONTAINER" >/dev/null
docker wait "$CONTAINER" >/dev/null
package_has_no_database "forced exit"
restarted_catalog_is_intact "a forced exit"
docker stop --timeout 30 "$CONTAINER" >/dev/null

# --- The image under somebody else's uid -------------------------------------
#
# A NAS owner should not have to hand ownership of their shares to uid 10001
# just to run this. The alternative is to run the container as *their* id
# (`user: "1000:1000"`), which needs no chown at all and leaves everything
# Cairndex creates owned by them — including the files a host-side backup has to
# read.
#
# That only works while the image writes nowhere it has to own: /data, /tmp, and
# the library mounts, all of them supplied from outside. It is one `pip install`
# of a library with a cache directory away from quietly becoming false, so it is
# tested rather than assumed. /data is bind-mounted here on purpose — a *named*
# volume inherits the image's 10001 ownership and would defeat the override.
step "runs as an arbitrary uid, with no chown anywhere"
docker run -d --name "$ALT_CONTAINER" \
    -p "127.0.0.1:${ALT_PORT}:8000" \
    --user "$(id -u):$(id -g)" \
    -v "${ALT_DATA_DIR}:/data" \
    -v "${ALT_LIBRARY_DIR}:/libraries/main:rw" \
    --read-only --tmpfs /tmp \
    --security-opt no-new-privileges:true \
    "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${ALT_PORT}/api/v1/health" >/dev/null 2>&1; then break; fi
    docker ps -q --filter "name=$ALT_CONTAINER" | grep -q . \
        || fail "container exited during startup as uid $(id -u) — it needs a path it does not own"
    sleep 1
done
curl -fsS "http://127.0.0.1:${ALT_PORT}/api/v1/health" >/dev/null 2>&1 \
    || fail "never became healthy as uid $(id -u)"

curl -fsS "http://127.0.0.1:${ALT_PORT}/api/v1/libraries/create" \
    -X POST -H 'content-type: application/json' \
    -d '{"display_name":"AltUid","root_path":"/libraries/main"}' >/dev/null \
    || fail "could not create a library as uid $(id -u)"
# Readable from the host without a container, which is the whole point.
[ -f "${ALT_LIBRARY_DIR}/.cairndex/manifest.json" ] \
    || fail "library package not written, or not readable by the invoking user"
docker stop --timeout 30 "$ALT_CONTAINER" >/dev/null

echo "SMOKE OK: $IMAGE serves portable libraries, survives clean and forced restarts, and runs as any uid"
