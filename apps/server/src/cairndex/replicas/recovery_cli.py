"""Supported local private-replica backup and reviewed recovery administration"""

import argparse
import json
import sys
from contextlib import closing
from pathlib import Path
from typing import Any

from cairndex.replicas import recovery
from cairndex.replicas.binding import BindingLock, location, private_path
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError, canonical, checksum
from cairndex.replicas.recovery_validation import file_hash, open_store, reader


# Inspection is bounded and opt-in because full draft/job bodies are private user content
def inspect(
    base: Path, identity: str, kind: str, after: str, limit: int, source: str = "prepared"
) -> dict[str, Any]:
    directory, review = recovery.review_at(base, identity)
    database = directory / ("previous.db" if source == "previous" else "prepared.db")
    expected = review["previous_database"] if source == "previous" else review["database"]
    if not expected or database.is_symlink() or file_hash(database) != expected:
        raise ReplicaError("Prepared recovery checksum changed")
    with closing(reader(database)) as db:
        table = {
            "drafts": "drafts",
            "jobs": "catalog_jobs",
            "events": "events",
            "catalog": "catalog_rows",
            "bundles": "bundles",
        }[kind]
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name=?", (table,)).fetchone():
            raise ReplicaError("This inspection requires another replica capability")
        fields = "id,replica,operation,local,published" if kind == "events" else "*"
        if kind == "catalog":
            fields = "family || '/' || entity AS id,body"
        rows = db.execute(
            f"SELECT {fields} FROM {table} WHERE id>? ORDER BY id LIMIT ?", (after, limit + 1)
        ).fetchall()
        items = [dict(row) for row in rows[:limit]]
        if kind == "jobs":
            for item in items:
                item["intent_receipt"] = checksum(item["intent"].encode())
        return {"items": items, "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None}


# Only exact reviewed recovered job intent may be requeued, under the same lifecycle exclusion
def retry_job(root: Path, base: Path, identity: str, receipt: str) -> dict[str, Any]:
    descriptor = recovery.descriptor_at(root)
    base = private_path(base, root)
    guard = BindingLock(base, descriptor)
    try:
        directory, binding = location(base, descriptor)
        if binding == "unbound" or not (directory / "replica.db").is_file():
            raise ReplicaError("Activate a reviewed recovery before retrying its jobs")
        store = open_store(directory, descriptor)
        if not isinstance(store, CatalogStore):
            raise ReplicaError("This replica capability has no catalog jobs")
        with store.connection() as db:
            row = db.execute("SELECT * FROM catalog_jobs WHERE id=?", (identity,)).fetchone()
            if not row or checksum(row["intent"].encode()) != receipt:
                raise ReplicaError("The reviewed job intent changed")
            if (
                row["state"] == "failed"
                and row["error"]
                == "Recovered pending work; review its exact intent and explicitly retry"
            ):
                db.execute(
                    "UPDATE catalog_jobs SET state='queued',error=NULL WHERE id=?", (identity,)
                )
            elif row["state"] not in {"queued", "succeeded"}:
                raise ReplicaError("This job is not awaiting a recovery retry")
        return {"id": identity, "state": "retry_ready", "intent_receipt": receipt}
    finally:
        guard.close()


# Commands accept paths only from a local administrator, never via HTTP or untrusted content
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path, required=True, help="existing replica library root")
    parser.add_argument(
        "--data-dir",
        type=Path,
        required=True,
        help="private server data directory outside sync trees",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser(
        "backup", help="make a coherent private snapshot while the server may be active"
    )
    create.add_argument(
        "--output",
        type=Path,
        required=True,
        help="new private directory outside server data and sync trees",
    )
    verify = commands.add_parser(
        "verify", help="verify backup integrity, schema, ancestry and coverage"
    )
    verify.add_argument("--backup", type=Path, required=True)
    prepare = commands.add_parser(
        "prepare", help="prepare a separate recovery from package history and optional backup"
    )
    prepare.add_argument("--backup", type=Path)
    for name in ("review", "inspect", "activate", "cancel"):
        command = commands.add_parser(name)
        command.add_argument("--recovery", required=True)
        if name in ("activate", "cancel"):
            command.add_argument("--receipt", required=True, help="exact hash printed by review")
        if name == "inspect":
            command.add_argument("kind", choices=("drafts", "jobs", "events", "catalog", "bundles"))
            command.add_argument("--source", choices=("prepared", "previous"), default="prepared")
            command.add_argument("--after", default="")
            command.add_argument(
                "--limit", type=int, choices=range(1, 51), default=20, metavar="1..50"
            )
    retry = commands.add_parser(
        "retry-job", help="explicitly authorize one recovered pending job while released"
    )
    retry.add_argument("--job", required=True)
    retry.add_argument("--intent-receipt", required=True)
    args = parser.parse_args(argv)
    try:
        root = args.library.resolve()
        base = private_path(args.data_dir, root)
        descriptor = recovery.descriptor_at(root)
        if args.command == "backup":
            result = recovery.backup(root, base, args.output)
        elif args.command == "verify":
            result = recovery.verify_backup(private_path(args.backup, root), descriptor)
        elif args.command == "prepare":
            result = recovery.prepare(root, base, args.backup)
        elif args.command == "review":
            directory, result = recovery.review_at(base, args.recovery)
            result = result | {"receipt": checksum(canonical(result))}
            active, _ = location(base, descriptor)
            if active.name == args.recovery:
                result["state"] = "active"
            elif (directory / "cancelled.json").exists():
                result["state"] = "cancelled"
        elif args.command == "inspect":
            result = inspect(base, args.recovery, args.kind, args.after, args.limit, args.source)
        elif args.command == "activate":
            result = recovery.activate(root, base, args.recovery, args.receipt)
        elif args.command == "cancel":
            result = recovery.cancel(root, base, args.recovery, args.receipt)
        else:
            result = retry_job(root, base, args.job, args.intent_receipt)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (ReplicaError, OSError) as error:
        message = (
            error.message
            if isinstance(error, ReplicaError)
            else "Recovery storage is unavailable; original data remains intact"
        )
        print(json.dumps({"state": "blocked", "error": message}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
