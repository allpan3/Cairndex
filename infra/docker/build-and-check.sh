#!/usr/bin/env bash
# Build every Docker context with private-data canaries and enforce a size ceiling
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PRODUCTION_IMAGE="${1:-cairndex:ci}"
CONTEXT_LIMIT_BYTES="${CAIRNDEX_DOCKER_CONTEXT_LIMIT_BYTES:-52428800}"
CANARY="cairndex-context-canary-$$"
LOG_DIR="$(mktemp -d)"

SERVER_CANARIES=(
    "apps/server/var/${CANARY}"
    "apps/server/.venv-${CANARY}"
    "apps/server/packaging/build/${CANARY}"
    "apps/server/packaging/dist/${CANARY}"
    "apps/server/packaging/vendor/${CANARY}"
)
WEB_CANARIES=(
    "apps/web/node_modules/${CANARY}"
    "apps/web/dist/${CANARY}"
)
CANARY_FILES=(
    "apps/server/.env.${CANARY}"
    "apps/server/private-${CANARY}.db"
    "apps/web/.env.${CANARY}"
)

# Remove only this run's synthetic files
cleanup() {
    for path in "${SERVER_CANARIES[@]}" "${WEB_CANARIES[@]}"; do
        rm -rf "${REPO_ROOT}/${path}"
    done
    for path in "${CANARY_FILES[@]}"; do
        rm -f "${REPO_ROOT}/${path}"
    done
    rm -rf "$LOG_DIR"
}
trap cleanup EXIT

# Fail when BuildKit reports an unexpectedly large transferred context
check_context_sizes() {
    local log_file="$1"
    python3 - "$log_file" "$CONTEXT_LIMIT_BYTES" <<'PY'
import re
import sys
from pathlib import Path

log_path = Path(sys.argv[1])
limit = int(sys.argv[2])
units = {"B": 1, "kB": 1_000, "MB": 1_000_000, "GB": 1_000_000_000}
matches = re.findall(
    r"transferring context:\s+([0-9]+(?:\.[0-9]+)?)(B|kB|MB|GB)",
    log_path.read_text(errors="replace"),
)
if not matches:
    raise SystemExit(f"CONTEXT FAIL: no BuildKit context size found in {log_path}")
sizes = [float(value) * units[unit] for value, unit in matches]
largest = max(sizes)
print(f"context ceiling: largest transfer {largest / 1_000_000:.2f} MB")
if largest > limit:
    raise SystemExit(
        f"CONTEXT FAIL: {largest / 1_000_000:.2f} MB exceeds "
        f"{limit / 1_000_000:.2f} MB"
    )
PY
}

# Run one build while retaining its BuildKit transfer record
run_build() {
    local name="$1"
    shift
    local log_file="${LOG_DIR}/${name}.log"
    BUILDKIT_PROGRESS=plain "$@" 2>&1 | tee "$log_file"
    check_context_sizes "$log_file"
}

# Refuse a canary name that already exists before creating test data
for path in "${SERVER_CANARIES[@]}" "${WEB_CANARIES[@]}" "${CANARY_FILES[@]}"; do
    if [[ -e "${REPO_ROOT}/${path}" ]]; then
        echo "CONTEXT FAIL: canary path already exists: $path" >&2
        exit 1
    fi
done

for path in "${SERVER_CANARIES[@]}" "${WEB_CANARIES[@]}"; do
    mkdir -p "${REPO_ROOT}/${path}"
    printf '%s\n' "$CANARY" >"${REPO_ROOT}/${path}/private-data"
done
for path in "${CANARY_FILES[@]}"; do
    printf '%s\n' "$CANARY" >"${REPO_ROOT}/${path}"
done

cd "$REPO_ROOT"
run_build development docker compose build
run_build production docker build \
    -f infra/docker/production.Dockerfile \
    -t "$PRODUCTION_IMAGE" .

# Prove broad COPY instructions did not admit any synthetic private-data path
for image in cairndex-server cairndex-web "$PRODUCTION_IMAGE"; do
    found=$(docker run --rm --entrypoint sh "$image" -c \
        "find /app -name '*${CANARY}*' -print -quit")
    if [[ -n "$found" ]]; then
        echo "CONTEXT FAIL: $image contains ignored canary $found" >&2
        exit 1
    fi
done

echo "CONTEXT OK: dev and production images exclude canaries and stay under the ceiling"
