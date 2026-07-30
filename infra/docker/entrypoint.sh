#!/usr/bin/env bash
# Production container entrypoint: fail fast, with a legible reason, on the two
# misconfigurations that otherwise surface much later as an opaque error.
#
# This used to run `alembic upgrade head`. That call had stopped doing anything:
# Cairndex has no migration chain in use (apps/server/alembic/ has no versions/),
# the registry DB is bootstrapped by create_all on first open, and each library's
# schema is created with the library package and patched additively on open
# (persistence.engine.ensure_content_indexes). The command still exited 0, so the
# only real effect was a startup line claiming migrations had been applied.
set -euo pipefail

data_dir="${CAIRNDEX_DATA_DIR:-/data}"

# The image runs as uid 10001. A bind-mounted host directory arrives with the
# host's ownership, so on a NAS this is the usual first failure — and without
# this check it appears much later as a SQLite "unable to open database file"
# from whichever request happened to touch the registry first.
if ! mkdir -p "$data_dir" 2>/dev/null || ! [ -w "$data_dir" ]; then
    echo "FATAL: app-data dir '$data_dir' is not writable by uid $(id -u)." >&2
    echo "       It holds registry.db and runtime state. Give that uid write" >&2
    echo "       access to the mounted volume, or mount a named volume instead" >&2
    echo "       of a host path. See docs/deployment.md." >&2
    exit 1
fi

# Warnings, not failures: a read-only library is a legitimate way to run
# Cairndex for browsing alone, and an empty root is simply what a container
# looks like before anyone has mounted a share into it.
#
# Every mount is a *child* of the root — /libraries/main, /libraries/archive —
# and never the root itself. Two reasons, one of which is this check:
#
#   * the root is a directory baked into the image, so under `read_only: true`
#     it is never writable, and testing it would print a warning every start;
#   * a deployment that starts with one share and later adds a second does not
#     have to move the first. Moving it would change the path every library is
#     registered under, and the registry stores that path.
library_root="${CAIRNDEX_LIBRARY_ROOT:-/libraries}"
shopt -s nullglob
library_mounts=("$library_root"/*/)
if [ ${#library_mounts[@]} -eq 0 ]; then
    echo "WARNING: nothing is mounted under '$library_root'." >&2
    echo "         Cairndex can only see files you mount into the container." >&2
    echo "         Add at least one, e.g. '/your/share:$library_root/main'." >&2
    echo "         See docs/deployment.md." >&2
else
    for mount in "${library_mounts[@]}"; do
        if ! [ -w "$mount" ]; then
            echo "WARNING: library mount '${mount%/}' is not writable by uid $(id -u)." >&2
            echo "         Existing libraries can be browsed, but creating or" >&2
            echo "         scanning one needs to write its .cairndex/ package." >&2
        fi
    done
fi

# Hand off to the image CMD (uvicorn) as PID 1 so signals propagate cleanly —
# which is what lets a `docker stop` release library leases and checkpoint each
# WAL instead of being killed part-way through (ADR-0018 §6).
exec "$@"
