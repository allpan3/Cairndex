"""Compare SQLite sync costs using only newly created synthetic temp databases.

This measures storage transactions, not HTTP, catalog replay or media scanning.
"""

import argparse
import fcntl
import json
import math
import os
import platform
import sqlite3
import statistics
import tempfile
import time
from collections import defaultdict
from contextlib import closing
from pathlib import Path
from typing import Any

from cairndex.persistence.sqlite_durability import configure_durability


def _summary(values: list[float]) -> dict[str, float]:
    ordered = sorted(values)
    return {
        "samples": len(values),
        "median_ms": round(statistics.median(ordered), 3),
        "p95_ms": round(ordered[math.ceil(len(ordered) * 0.95) - 1], 3),
    }


def _probe(directory: Path) -> dict[str, Any]:
    """Probe only our own synthetic file; report errors without private paths."""
    with (directory / "sync-probe").open("xb") as stream:
        stream.write(b"synthetic sync probe")
        stream.flush()
        result: dict[str, Any] = {}
        if platform.system() == "Darwin":
            try:
                fcntl.fcntl(stream.fileno(), 51)  # macOS F_FULLFSYNC
                result["fullfsync"] = "ok"
            except OSError as error:
                result["fullfsync_errno"] = error.errno
        os.fsync(stream.fileno())
        result["fsync"] = "ok"
        return result


def _configure(db: sqlite3.Connection, policy: str) -> None:
    if policy == "after":
        configure_durability(db)
    else:
        db.execute(f"PRAGMA synchronous={'NORMAL' if policy == 'normal' else 'FULL'}")
        db.execute("PRAGMA fullfsync=OFF")
        db.execute("PRAGMA checkpoint_fullfsync=OFF")


def _run(path: Path, journal: str, policy: str) -> dict[str, list[float]]:
    timings: dict[str, list[float]] = defaultdict(list)
    with closing(sqlite3.connect(path)) as db:
        _configure(db, policy)
        assert db.execute(f"PRAGMA journal_mode={journal}").fetchone()[0] == journal.lower()
        db.execute("PRAGMA wal_autocheckpoint=0")
        db.executescript(
            "CREATE TABLE bundles (id INTEGER PRIMARY KEY, rating REAL);"
            "INSERT INTO bundles VALUES (1, 0);"
            "CREATE TABLE scan_entries (path TEXT PRIMARY KEY, parent TEXT, body TEXT);"
            "CREATE INDEX scan_parent ON scan_entries(parent, path);"
            "CREATE TABLE checkpoint_data (id INTEGER PRIMARY KEY, body BLOB);"
        )
        db.commit()
        if journal == "WAL":
            assert db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0] == 0
        for index in range(50):
            started = time.perf_counter()
            db.execute("UPDATE bundles SET rating=? WHERE id=1", ((index % 10 + 1) / 2,))
            db.commit()
            timings["rating"].append((time.perf_counter() - started) * 1000)
        for batch in (32, 200):
            for iteration in range(20):
                # JSON and invented filenames are prepared outside the timed transaction.
                rows = [
                    (
                        f"synthetic-{batch}-{iteration}-{index}.mp4",
                        "synthetic-folder",
                        json.dumps({"size": 123456, "fingerprint": "a" * 64, "details": "x" * 512}),
                    )
                    for index in range(batch)
                ]
                started = time.perf_counter()
                db.executemany("INSERT INTO scan_entries VALUES (?, ?, ?)", rows)
                db.commit()
                timings[f"scan_{batch}"].append((time.perf_counter() - started) * 1000)
        if journal == "WAL":
            for _ in range(10):
                assert db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0] == 0
                db.execute("DELETE FROM checkpoint_data")
                db.executemany(
                    "INSERT INTO checkpoint_data(body) VALUES (?)", [(b"x" * 4096,)] * 256
                )
                db.commit()
                started = time.perf_counter()
                assert db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0] == 0
                timings["checkpoint_1mib"].append((time.perf_counter() - started) * 1000)
        assert db.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
        assert db.execute("SELECT count(*) FROM scan_entries").fetchone()[0] == 20 * (32 + 200)
    # PrivateStore opens and closes each transaction. The last WAL connection
    # also checkpoints on close, so measure that lifecycle separately from pooling.
    for index in range(50):
        started = time.perf_counter()
        with closing(sqlite3.connect(path)) as db:
            _configure(db, policy)
            db.execute("UPDATE bundles SET rating=? WHERE id=1", ((index % 10 + 1) / 2,))
            db.commit()
        timings["rating_reopen"].append((time.perf_counter() - started) * 1000)
    return timings


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parent", type=Path, help="Existing scratch parent, never a database")
    parser.add_argument("--storage", choices=("local", "smb"), default="local")
    args = parser.parse_args()
    samples: dict[str, dict[str, list[float]]] = {}
    with tempfile.TemporaryDirectory(prefix="cairndex-sqlite-durability-", dir=args.parent) as name:
        directory = Path(name)
        probe = _probe(directory)
        variants = [
            (mode, policy) for mode in ("WAL", "DELETE") for policy in ("normal", "full", "after")
        ]
        if args.storage == "smb":
            # ADR-0021 forbids WAL on a network mount; never attempt it there.
            variants = [variant for variant in variants if variant[0] == "DELETE"]
        for repeat in range(3):
            for journal, policy in variants if repeat % 2 == 0 else reversed(variants):
                key = f"{journal.lower()}_{policy}"
                target = samples.setdefault(key, defaultdict(list))
                for operation, values in _run(
                    directory / f"{key}-{repeat}.db", journal, policy
                ).items():
                    target[operation].extend(values)
    print(
        json.dumps(
            {
                "storage": args.storage,
                "python": platform.python_version(),
                "sqlite": sqlite3.sqlite_version,
                "repeats": 3,
                "sync_probe": probe,
                "results": {
                    key: {operation: _summary(values) for operation, values in operations.items()}
                    for key, operations in samples.items()
                },
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
