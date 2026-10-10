#!/usr/bin/env bash
# Prove a live backup can restore state that the candidate image can reopen
#
# Two separate mechanisms restore a portable library (ADR-0035). The server
# registry is a SQLite file: backup.sh copies it while the server runs and
# restore.sh puts it back while the server is stopped. A library's private store
# is restored only through the private recovery API: a snapshot, its verification,
# Release, preparation, an exact review receipt, activation and an explicit
# Reopen. Snapshots go to their own volume, apart from /data, so they survive a
# damaged private store; this test damages it the way a failed disk would.
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
SNAPSHOT_DIR="$(mktemp -d)"
LIBRARY_DIR="$(mktemp -d)"
STATE_FILE="$(mktemp)"

# Remove only this run's container and temporary state
cleanup() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$DATA_DIR" "$SNAPSHOT_DIR" "$LIBRARY_DIR"
    rm -f "$STATE_FILE"
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
        -v "${SNAPSHOT_DIR}:/snapshots" \
        -e CAIRNDEX_PRIVATE_BACKUP_DIR=/snapshots \
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

# One portable phase against the running container. The state file carries
# identities from the source image to the target image; it holds no secret
# beyond the synthetic passphrase below.
phase() {
    python3 - "$PORT" "$STATE_FILE" "$1" <<'PYTHON'
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4

port, state_path, phase = sys.argv[1:]
base = f"http://127.0.0.1:{port}/api/v1"
PASSPHRASE = "Synthetic recovery smoke guard"
opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
)


def request(path, body=None, *, method=None, expect=200):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        base + path, data=data, method=method, headers={"Content-Type": "application/json"}
    )
    try:
        response = opener.open(req, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        if response.status != expect:
            raise SystemExit(f"{path} returned HTTP {response.status}, expected {expect}")
        return json.loads(raw) if raw else None


def wait(path, field, value):
    for _ in range(240):
        row = request(path)
        if row.get(field) == value:
            return row
        if row.get("state") in {"failed", "cancelled", "interrupted"}:
            action = row.get("action", "operation")
            raise SystemExit(f"{action} ended as {row.get('state')}: {row.get('error')}")
        time.sleep(0.5)
    raise SystemExit(f"{path} timed out")


def task(library, action, **body):
    path = f"/libraries/{library}/private-recovery/tasks"
    row = request(path, {"operation": uuid4().hex, "action": action, **body}, expect=202)
    return wait(f"{path}/{row['id']}", "state", "succeeded")


def catalog(library):
    prefix = f"/libraries/{library}/replica"
    wait(prefix + "/status", "ready", True)
    bundles = request(prefix + "/catalog/entities/asset_bundles?limit=10")["items"]
    files = [
        item["id"]
        for bundle in bundles
        for item in request(f"{prefix}/media/bundles/{bundle['id']}")["files"]
    ]
    return sorted(bundle["id"] for bundle in bundles), sorted(files)


# A locked library refuses content and recovery; only its passphrase reopens it.
def access_is_enforced(library):
    request(f"/libraries/{library}/auth/lock", method="POST")
    for path in ("/replica/status", "/private-recovery/tasks"):
        request(f"/libraries/{library}{path}", expect=401)
    request(f"/libraries/{library}/auth/unlock", {"passphrase": "wrong"}, expect=401)
    request(f"/libraries/{library}/auth/unlock", {"passphrase": PASSPHRASE})


if phase == "create":
    library = request(
        "/libraries/create",
        {"display_name": "Recovery Smoke", "root_path": "/libraries/main"},
        expect=201,
    )["id"]
    Path(state_path).write_text(json.dumps({"library": library}))
elif phase == "snapshot":
    state = json.loads(Path(state_path).read_text())
    library = state["library"]
    prefix = f"/libraries/{library}/replica"
    wait(prefix + "/status", "ready", True)
    request(prefix + "/discovery/runs", {"operation": "recovery-update"}, expect=202)
    wait(prefix + "/discovery/status", "state", "succeeded")
    candidate = request(prefix + "/discovery/candidates")["items"][0]
    review = prefix + "/discovery/reviews/recovery-review"
    request(
        prefix + "/discovery/reviews",
        {"operation": "recovery-review", "candidate": candidate["id"]},
        expect=202,
    )
    receipt = wait(review, "state", "ready")["receipt"]
    request(review + "/accept", {"receipt": receipt}, expect=202)
    wait(review, "state", "applied")
    bundles, files = catalog(library)
    if len(bundles) != 1 or len(files) != 1:
        raise SystemExit("Update did not admit exactly one bundle with one file")
    request(f"/libraries/{library}/auth/settings", {"passphrase": PASSPHRASE}, method="PUT")
    access_is_enforced(library)
    snapshot = task(library, "backup")
    state.update(snapshot=snapshot["id"], bundles=bundles, files=files)
    Path(state_path).write_text(json.dumps(state))
elif phase == "recover":
    state = json.loads(Path(state_path).read_text())
    library = state["library"]
    # A new server process has no owner session, so the library starts locked.
    request(f"/libraries/{library}/replica/status", expect=401)
    access_is_enforced(library)
    task(library, "verify", backup=state["snapshot"])
    request(f"/libraries/{library}/ownership/release", {}, expect=200)
    request(f"/libraries/{library}/replica/status", expect=409)
    prepared = task(library, "prepare", backup=state["snapshot"])
    reviewed = task(library, "review", recovery=prepared["id"])["result"]
    if reviewed["previous"]["state"] != "damaged":
        raise SystemExit(f"review found the original {reviewed['previous']['state']}")
    if reviewed["state"] != "prepared":
        gaps = {name: count for name, count in reviewed["previous_private_gaps"].items() if count}
        raise SystemExit(
            f"recovery review is {reviewed['state']}: store {reviewed['status']}, gaps {gaps}"
        )
    task(library, "activate", recovery=prepared["id"], receipt=reviewed["receipt"])
    request(f"/libraries/{library}/ownership/reopen", {}, expect=200)
    if catalog(library) != (state["bundles"], state["files"]):
        raise SystemExit("the recovered catalog lost or changed bundle or file identities")
    # Recovery keeps this server's access setting; it does not reset the guard.
    access_is_enforced(library)
else:
    raise SystemExit(f"unknown phase {phase}")
PYTHON
}

step "creating recoverable state with $SOURCE_IMAGE"
start_image "$SOURCE_IMAGE"
phase create || fail "could not create a portable library"
docker exec "$CONTAINER" ffmpeg -v error \
    -f lavfi -i testsrc=size=160x120:rate=10:duration=2 \
    -pix_fmt yuv420p /libraries/main/recovery-smoke.mp4 \
    || fail "could not create synthetic media"
phase snapshot || fail "could not admit media, protect access and take a private snapshot"
[[ -n "$(find "$SNAPSHOT_DIR" -mindepth 1 -print -quit)" ]] \
    || fail "the private snapshot was not written to its own volume"

step "taking a hot registry backup"
registry_output=$(docker exec "$CONTAINER" \
    /app/infra/backup.sh /data/registry.db /data/backups)
registry_backup=$(awk '{print $3}' <<<"$registry_output")
[[ -n "$registry_backup" ]] || fail "backup helper did not report its output path"

step "stopping cleanly, removing the registry and damaging the private store"
docker stop --timeout 30 "$CONTAINER" >/dev/null
docker rm "$CONTAINER" >/dev/null
mv "$DATA_DIR/registry.db" "$DATA_DIR/registry.db.removed-for-test"
if find "$LIBRARY_DIR/.cairndex" -name '*.db*' | grep -q .; then
    fail "a mutable database entered the portable package"
fi
stores=("$DATA_DIR"/replicas/*/replica.db)
[[ ${#stores[@]} -eq 1 && -f "${stores[0]}" ]] || fail "expected exactly one private store"
DAMAGED="damaged synthetic private store"
printf '%s' "$DAMAGED" >"${stores[0]}"
rm -f "${stores[0]}-wal" "${stores[0]}-shm"

step "restoring the registry atomically with $TARGET_IMAGE"
docker run --rm --user "$(id -u):$(id -g)" \
    --entrypoint /app/infra/restore.sh \
    -v "${DATA_DIR}:/data" \
    "$TARGET_IMAGE" --stopped "$registry_backup" /data/registry.db

step "recovering the private store from its snapshot with $TARGET_IMAGE"
start_image "$TARGET_IMAGE"
phase recover || fail "explicit private recovery or retained access failed"
docker stop --timeout 30 "$CONTAINER" >/dev/null
# Recovery activates a new generation and keeps the original bytes for review.
[[ "$(cat "${stores[0]}")" == "$DAMAGED" ]] || fail "recovery changed the damaged original store"

echo "RECOVERY OK: registry backup and private snapshot from $SOURCE_IMAGE restore with $TARGET_IMAGE; access retained"
