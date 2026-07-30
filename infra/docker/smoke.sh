#!/usr/bin/env bash
# Prove the production image *serves*, not just that it builds.
#
# Building an image only proves the Dockerfile is syntactically fine and the
# dependencies resolve. It says nothing about whether the thing starts, whether
# ffmpeg is present, whether the non-root user can write the volumes it is
# given, or whether the read-only root filesystem leaves anything important
# unwritable. Those are exactly the ways this image can rot while CI stays
# green, so they are what this checks.
#
#   ./infra/docker/smoke.sh [image-tag]        # default: cairndex:ci
#
# Builds the image if the tag is not already present. Leaves nothing behind.
set -euo pipefail

IMAGE="${1:-cairndex:ci}"
CONTAINER="cairndex-smoke-$$"
PORT="${CAIRNDEX_SMOKE_PORT:-18000}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIBRARY_DIR="$(mktemp -d)"

cleanup() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    docker volume rm "${CONTAINER}-data" >/dev/null 2>&1 || true
    # The .cairndex/ tree belongs to uid 10001 on the host as well (see
    # in_library below), so this user cannot unlink it. Root in a container can.
    in_library rm -rf /libraries/main/.cairndex >/dev/null 2>&1 || true
    rm -rf "$LIBRARY_DIR"
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

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    step "building $IMAGE"
    docker build -f "$REPO_ROOT/infra/docker/production.Dockerfile" -t "$IMAGE" "$REPO_ROOT"
fi

# The library dir is created by mktemp as this user; the container runs as uid
# 10001 and must be able to write its .cairndex/ package into it.
chmod 777 "$LIBRARY_DIR"

step "starting container (read-only root fs, non-root user)"
docker run -d --name "$CONTAINER" \
    -p "127.0.0.1:${PORT}:8000" \
    -v "${CONTAINER}-data:/data" \
    -v "${LIBRARY_DIR}:/libraries/main:rw" \
    --read-only --tmpfs /tmp \
    --security-opt no-new-privileges:true \
    "$IMAGE" >/dev/null

step "waiting for health"
for _ in $(seq 1 60); do
    if api /health >/dev/null 2>&1; then break; fi
    docker ps -q --filter "name=$CONTAINER" | grep -q . || fail "container exited during startup"
    sleep 1
done
api /health >/dev/null 2>&1 || fail "server never became healthy"

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
in_library test -f /libraries/main/.cairndex/library.db \
    || fail "library package was not written to the mounted volume"

step "generating a real video and scanning it"
# Generated inside the container so the host needs no ffmpeg, and so this also
# exercises writing into the library mount as the non-root user.
docker exec "$CONTAINER" ffmpeg -v error \
    -f lavfi -i testsrc=size=160x120:rate=10:duration=2 \
    -pix_fmt yuv420p /libraries/main/smoke.mp4 || fail "could not write into library mount"
post_json "/libraries/${library_id}/jobs/scan" '{}' >/dev/null

step "waiting for the scan to surface a bundle"
for _ in $(seq 1 60); do
    total=$(post_json "/libraries/${library_id}/bundles/browse" '{"limit":10,"view":"unbundled"}' \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])')
    [ "$total" -gt 0 ] && break
    sleep 1
done
[ "${total:-0}" -gt 0 ] || fail "scan produced no bundles"

# has_cover proves ffprobe ran and a thumbnail was generated into the library's
# .cairndex/cache/ — i.e. the media pipeline works, not just the web layer.
has_cover=$(post_json "/libraries/${library_id}/bundles/browse" '{"limit":10,"view":"unbundled"}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["items"][0]["has_cover"])')
[ "$has_cover" = "True" ] || fail "scanned video produced no cover (media pipeline broken)"

step "graceful stop releases the ownership lease"
docker stop --timeout 30 "$CONTAINER" >/dev/null
lease_json=$(in_library cat /libraries/main/.cairndex/locks/active-owner.json 2>/dev/null) \
    || fail "no ownership lease was ever written"
python3 -c "
import json, sys
lease = json.load(sys.stdin)
if not lease.get('released_at'):
    sys.exit('lease was not released on shutdown: %r' % lease)
" <<<"$lease_json" || fail "lease not released — a restart would be blocked until it ages out"

# A clean shutdown folds the WAL back in, so the library should be one file.
if in_library test -f /libraries/main/.cairndex/library.db-wal; then
    fail "WAL left behind after clean shutdown (checkpoint did not run)"
fi

echo "SMOKE OK: $IMAGE serves, scans, and shuts down cleanly"
