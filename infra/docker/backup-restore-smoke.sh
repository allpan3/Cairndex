#!/usr/bin/env bash
# Prove a live backup can restore state that the candidate image can reopen
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
    echo "usage: $0 <candidate-image> [source-image]" >&2
    echo "       source defaults to the candidate; pass an older image for an upgrade test" >&2
    exit 2
fi

TARGET_IMAGE="$1"
SOURCE_IMAGE="${2:-$TARGET_IMAGE}"
CONTAINER="cairndex-recovery-$$"
PORT="${CAIRNDEX_RECOVERY_PORT:-18020}"
DATA_DIR="$(mktemp -d)"
LIBRARY_DIR="$(mktemp -d)"

# Remove only this run's container and temporary state
cleanup() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$DATA_DIR" "$LIBRARY_DIR"
}
trap cleanup EXIT

# Report the current container log with an acceptance failure
fail() {
    echo "RECOVERY FAIL: $*" >&2
    docker logs "$CONTAINER" 2>&1 | tail -40 >&2 || true
    exit 1
}

step() { echo "==> $*"; }
api() { curl -fsS "http://127.0.0.1:${PORT}/api/v1$1" "${@:2}"; }
post_json() { api "$1" -X POST -H 'content-type: application/json' -d "$2"; }

# Start one image against the persistent test directories
start_image() {
    local image="$1"
    docker run -d --name "$CONTAINER" \
        -p "127.0.0.1:${PORT}:8000" \
        --user "$(id -u):$(id -g)" \
        -v "${DATA_DIR}:/data" \
        -v "${LIBRARY_DIR}:/libraries/main:rw" \
        --read-only --tmpfs /tmp \
        --security-opt no-new-privileges:true \
        "$image" >/dev/null

    for _ in $(seq 1 60); do
        if api /health >/dev/null 2>&1; then return; fi
        docker ps -q --filter "name=$CONTAINER" | grep -q . \
            || fail "$image exited during startup"
        sleep 1
    done
    fail "$image never became healthy"
}

for image in "$SOURCE_IMAGE" "$TARGET_IMAGE"; do
    docker image inspect "$image" >/dev/null 2>&1 \
        || { echo "RECOVERY FAIL: image does not exist: $image" >&2; exit 1; }
done

step "creating recoverable state with $SOURCE_IMAGE"
start_image "$SOURCE_IMAGE"
library_id=$(post_json /libraries/create \
    '{"display_name":"Recovery Smoke","root_path":"/libraries/main"}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
docker exec "$CONTAINER" ffmpeg -v error \
    -f lavfi -i testsrc=size=160x120:rate=10:duration=2 \
    -pix_fmt yuv420p /libraries/main/recovery-smoke.mp4 \
    || fail "could not create synthetic media"
post_json "/libraries/${library_id}/jobs/scan" '{}' >/dev/null

for _ in $(seq 1 60); do
    total=$(post_json "/libraries/${library_id}/bundles/browse" \
        '{"limit":10,"view":"unbundled"}' \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])')
    [[ "$total" -gt 0 ]] && break
    sleep 1
done
[[ "${total:-0}" -gt 0 ]] || fail "source image produced no restorable bundle"

step "taking hot registry and library backups"
registry_output=$(docker exec "$CONTAINER" \
    /app/infra/backup.sh /data/registry.db /data/backups)
library_output=$(docker exec "$CONTAINER" \
    /app/infra/backup.sh /libraries/main/.cairndex/library.db /data/backups)
registry_backup=$(awk '{print $3}' <<<"$registry_output")
library_backup=$(awk '{print $3}' <<<"$library_output")
[[ -n "$registry_backup" && -n "$library_backup" ]] \
    || fail "backup helper did not report its output paths"

step "stopping cleanly and removing the working databases"
docker stop --timeout 30 "$CONTAINER" >/dev/null
docker rm "$CONTAINER" >/dev/null
mv "$DATA_DIR/registry.db" "$DATA_DIR/registry.db.removed-for-test"
mv "$LIBRARY_DIR/.cairndex/library.db" \
    "$LIBRARY_DIR/.cairndex/library.db.removed-for-test"

step "restoring atomically with $TARGET_IMAGE"
docker run --rm --user "$(id -u):$(id -g)" \
    --entrypoint /app/infra/restore.sh \
    -v "${DATA_DIR}:/data" \
    -v "${LIBRARY_DIR}:/libraries/main:rw" \
    "$TARGET_IMAGE" --stopped "$registry_backup" /data/registry.db
docker run --rm --user "$(id -u):$(id -g)" \
    --entrypoint /app/infra/restore.sh \
    -v "${DATA_DIR}:/data" \
    -v "${LIBRARY_DIR}:/libraries/main:rw" \
    "$TARGET_IMAGE" --stopped "$library_backup" /libraries/main/.cairndex/library.db

step "opening the restored state with $TARGET_IMAGE"
start_image "$TARGET_IMAGE"
restored_total=$(post_json "/libraries/${library_id}/bundles/browse" \
    '{"limit":10,"view":"unbundled"}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])')
[[ "$restored_total" -eq "$total" ]] \
    || fail "restored bundle count is $restored_total, expected $total"
docker stop --timeout 30 "$CONTAINER" >/dev/null

echo "RECOVERY OK: backups from $SOURCE_IMAGE restore and open with $TARGET_IMAGE"
