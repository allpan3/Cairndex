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

cleanup() {
    docker rm -f "$CONTAINER" "$ALT_CONTAINER" >/dev/null 2>&1 || true
    docker volume rm "${CONTAINER}-data" >/dev/null 2>&1 || true
    # The .cairndex/ tree belongs to uid 10001 on the host as well (see
    # in_library below), so this user cannot unlink it. Root in a container can.
    in_library rm -rf /libraries/main/.cairndex >/dev/null 2>&1 || true
    rm -rf "$LIBRARY_DIR"
    # The alternate-uid run wrote as *this* user, so no container is needed.
    rm -rf "$ALT_LIBRARY_DIR" "$ALT_DATA_DIR"
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

# …and the file must no longer be *flagged* as WAL, which is a different claim
# and the one that bit in production (ADR-0021). Byte 18 of the SQLite header is
# the write format version: 2 means WAL, 1 means a rollback journal. A library
# left at 2 cannot be opened over SMB or NFS at all, so this container would have
# locked every other machine out of the share it serves.
in_library python3 -c "
import sys
with open('/libraries/main/.cairndex/library.db', 'rb') as f:
    version = f.read(19)[18]
if version != 1:
    sys.exit('library.db is still flagged WAL (header write version %d) after a clean stop' % version)
" || fail "library left in WAL journal mode — unopenable from any machine using SMB or NFS"

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
[ -f "${ALT_LIBRARY_DIR}/.cairndex/library.db" ] \
    || fail "library package not written, or not readable by the invoking user"
docker stop --timeout 30 "$ALT_CONTAINER" >/dev/null

echo "SMOKE OK: $IMAGE serves, scans, shuts down cleanly, and runs as any uid"
