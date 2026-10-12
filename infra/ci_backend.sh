#!/usr/bin/env bash
# Fast synthetic fixtures; source-operation and backup/restore safety stays on disk.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root/apps/server"
temporary_parent=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
memory_root=
disk_root=
memory_mounted=false

cleanup() {
  local result=$?
  trap - EXIT
  if "$memory_mounted"; then
    if ! sudo -n umount "$memory_root"; then
      # Leave a busy mount intact and fail CI instead of recursively deleting it.
      printf '%s\n' 'CI test mount cleanup failed'
      exit 1
    fi
    rmdir "$memory_root"
  elif [[ -n "$memory_root" ]]; then
    rm -rf -- "$memory_root"
  fi
  if [[ -n "$disk_root" ]]; then
    rm -rf -- "$disk_root"
  fi
  exit "$result"
}
trap cleanup EXIT

# mktemp creates only owned directories; no caller-provided directory is removed.
disk_root=$(mktemp -d "$temporary_parent/cairndex-ci-disk.XXXXXX")
memory_root=$(mktemp -d "${CAIRNDEX_CI_MEMORY_PARENT:-$temporary_parent}/cairndex-ci-memory.XXXXXX")
if [[ -z "${CAIRNDEX_CI_MEMORY_PARENT:-}" ]]; then
  # Standard public Ubuntu runners have 16 GiB. Retain a disk fallback for hosts
  # with less headroom rather than risking an OOM or reducing test coverage.
  available_kib=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  if (( available_kib >= 6 * 1024 * 1024 )); then
    sudo -n mount -t tmpfs \
      -o "size=4G,nodev,nosuid,uid=$(id -u),gid=$(id -g),mode=0700" \
      tmpfs "$memory_root"
    memory_mounted=true
    printf '%s\n' 'CI bulk fixtures use isolated memory storage'
  else
    printf '%s\n' 'CI bulk fixtures use disk because memory headroom is limited'
  fi
fi

disk_tests=(
  tests/test_backup_restore_scripts.py
  tests/test_portable_source_operations.py
)
ignore=()
for module in "${disk_tests[@]}"; do
  ignore+=("--ignore=$module")
done

TMPDIR="$memory_root" uv run pytest --durations=25 \
  --basetemp "$memory_root/pytest" "${ignore[@]}" "$@"
TMPDIR="$disk_root" uv run pytest --durations=10 \
  --basetemp "$disk_root/pytest" "${disk_tests[@]}" "$@"
