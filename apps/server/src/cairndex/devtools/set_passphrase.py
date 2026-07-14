"""CLI: set or clear a library's optional owner passphrase lock (ADR-0010).

Stores only a PBKDF2 hash in the library's portable manifest — never the
passphrase. This is a private LAN/Tailscale guardrail, not public-internet
hardening and not multi-user auth.

Usage (from apps/server):

    uv run python -m cairndex.devtools.set_passphrase --library-root /path/to/lib
    uv run python -m cairndex.devtools.set_passphrase --library-id <id>
    uv run python -m cairndex.devtools.set_passphrase --library-root /path --clear
"""

import argparse
import getpass
from pathlib import Path

from cairndex.auth import clear_passphrase, set_passphrase
from cairndex.registry import library_package as pkg
from cairndex.registry import services as registry_service
from cairndex.registry.engine import registry_session_scope


def _root_from_args(args: argparse.Namespace) -> Path:
    if args.library_root:
        return Path(args.library_root)
    with registry_session_scope() as registry:
        return Path(registry_service.get_library(registry, args.library_id).root_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Set or clear a library owner passphrase.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--library-root", help="path to the library root directory")
    group.add_argument("--library-id", help="registry id of the library")
    parser.add_argument(
        "--clear", action="store_true", help="remove the lock instead of setting it"
    )
    args = parser.parse_args()

    root = _root_from_args(args)
    if pkg.detect(root) is None:
        raise SystemExit(f"no Cairndex library at {root}")

    if args.clear:
        clear_passphrase(root)
        print(f"Removed the passphrase lock from {root}.")
        return

    passphrase = getpass.getpass("New library passphrase: ")
    if not passphrase:
        raise SystemExit("passphrase must not be empty")
    if passphrase != getpass.getpass("Confirm passphrase: "):
        raise SystemExit("passphrases did not match")
    with registry_session_scope() as registry:
        revoked = set_passphrase(root, passphrase, registry=registry)
    print(
        f"Set an owner passphrase lock on {root}. It is now locked until unlocked in the app. "
        f"Revoked {revoked} scoped device token(s)."
    )


if __name__ == "__main__":
    main()
