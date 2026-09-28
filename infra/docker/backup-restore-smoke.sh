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
BACKUP_DIR="$(mktemp -d)"
LIBRARY_DIR="$(mktemp -d)"

# Remove only this run's container and temporary state
cleanup() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$DATA_DIR" "$LIBRARY_DIR" "$BACKUP_DIR"
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
        -v "${BACKUP_DIR}:/backups" \
        -e CAIRNDEX_PRIVATE_BACKUP_DIR=/backups \
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

# Each phase uses the public portable recovery API. Original stores stay intact.
phase() {
    python3 - "$PORT" "$DATA_DIR/smoke-state.json" "$1" <<'PYTHON'
import json
import sys
import time
import urllib.request
from pathlib import Path
from uuid import uuid4
port, state_path, phase = sys.argv[1:]
base = f"http://127.0.0.1:{port}/api/v1"
def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)
def task(library, action, **body):
    path = f"/libraries/{library}/private-recovery/tasks"
    row = request(path, {"operation": uuid4().hex, "action": action, **body})
    for _ in range(120):
        row = request(path + "/" + row["id"])
        if row["state"] == "succeeded":
            return row
        if row["state"] in {"failed", "cancelled", "interrupted"}:
            raise SystemExit("Synthetic recovery task failed")
        time.sleep(0.5)
    raise SystemExit("Synthetic recovery task timed out")
if phase == "backup":
    library = request("/libraries/create", {"display_name": "Recovery Smoke", "root_path": "/libraries/main"})["id"]
    for _ in range(120):
        if request(f"/libraries/{library}/replica/status")["ready"]:
            break
        time.sleep(0.5)
    else:
        raise SystemExit("Portable baseline did not become ready")
    snapshot = task(library, "backup")
    Path(state_path).write_text(json.dumps({"library": library, "snapshot": snapshot["id"]}))
else:
    state = json.loads(Path(state_path).read_text())
    library = state["library"]
    task(library, "verify", backup=state["snapshot"])
    request(f"/libraries/{library}/ownership/release", {})
    prepared = task(library, "prepare", backup=state["snapshot"])
    reviewed = task(library, "review", recovery=prepared["id"])
    task(library, "activate", recovery=prepared["id"], receipt=reviewed["result"]["receipt"])
    request(f"/libraries/{library}/ownership/reopen", {})
    assert request(f"/libraries/{library}/replica/status")["ready"]
PYTHON
}
step "creating a private snapshot with $SOURCE_IMAGE"
start_image "$SOURCE_IMAGE"
phase backup
docker stop --timeout 30 "$CONTAINER" >/dev/null
docker rm "$CONTAINER" >/dev/null
step "verifying and activating a separate private recovery with $TARGET_IMAGE"
start_image "$TARGET_IMAGE"
phase recover
docker stop --timeout 30 "$CONTAINER" >/dev/null
echo "RECOVERY OK: private snapshot verified and activated; original stores retained"
