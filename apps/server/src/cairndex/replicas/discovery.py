"""Manual bounded replica discovery, private observations and conservative causal repairs"""

import json
import sqlite3
import time
from collections import deque
from collections.abc import Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from typing import Any

from cairndex.core.errors import DomainError
from cairndex.domain.enums import MediaKind
from cairndex.replicas import discovery_sources as sources
from cairndex.replicas.catalog.commands import Preview
from cairndex.replicas.catalog.model import key, value_text
from cairndex.replicas.catalog.protocol import UnitChange
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.discovery_progress import advance
from cairndex.replicas.discovery_state import capable
from cairndex.replicas.media import generation
from cairndex.replicas.protocol import ReplicaError, checksum
from cairndex.scanning.media_types import classify


# Candidate media was already classified by the read-only walker
def media_kind(path: str) -> MediaKind:
    result = classify(path)
    return result[0] if result else MediaKind.OTHER


BATCH = 32
# File observations are small. Amortize durable commits while limiting both
# memory and time between cancellation/save opportunities on slower storage.
SCAN_BATCH = 512
SCAN_SECONDS = 0.05
SMB_READERS = 16
_walks: dict[CatalogStore, tuple[str, Iterator[sources.Entry | None]]] = {}


# Release/cancel closes pinned directory handles before retiring a private generation
def close(store: CatalogStore) -> None:
    from cairndex.replicas.discovery_verification import close as close_verification

    close_verification(store)
    close_walk(store)


# Finished traversal does not interrupt a separately queued content verification
def close_walk(store: CatalogStore) -> None:
    entry = _walks.pop(store, None)
    if entry:
        entry[1].close()  # type: ignore[attr-defined]


# Evidence and reviewed file identity survive scans without entering transport observations
def baseline(db: sqlite3.Connection, identity: str, observation: dict[str, Any]) -> None:
    from cairndex.replicas.catalog.local_history import observed

    observed(
        db, identity, observation["path"], observation["evidence"]["size"], observation["mtime"]
    )
    db.execute(
        "INSERT INTO discovery_baselines VALUES (?,?) ON CONFLICT(file_id) DO UPDATE SET "
        "body=excluded.body WHERE discovery_baselines.body<>excluded.body",
        (identity, value_text(observation)),
    )


# A stable candidate can be reopened; a prepared review holds its own immutable snapshot
def candidate(db: sqlite3.Connection, run: str, body: dict[str, Any]) -> None:
    identity = checksum(value_text(body).encode())
    db.execute(
        "INSERT INTO discovery_candidates VALUES (?,?,?,?,'pending') "
        "ON CONFLICT(id) DO UPDATE SET run=excluded.run,state='pending'",
        (identity, run, body["files"][0]["path"], value_text(body)),
    )


# Recheck only the changed path unit; unrelated authored notes/rating never become scan intent
def current_path(
    store: CatalogStore, db: sqlite3.Connection, identity: str, bases: list[str]
) -> bool:
    return {
        tip["event"] for tip in store.tips(db, key("asset_files", identity, "relative_path"))
    } == set(bases) and not db.execute(
        "SELECT 1 FROM catalog_holds WHERE unit IN (?,?,?) LIMIT 1",
        tuple(
            key("asset_files", identity, field) for field in ("relative_path", "$content", "$alive")
        ),
    ).fetchone()


# Causal repair preserves the original file and all relationships, with one atomic private receipt
def repair(
    store: CatalogStore,
    db: sqlite3.Connection,
    root: Path,
    old: dict[str, Any],
    new: dict[str, Any],
    operation: str,
) -> None:
    identity = old["file_id"]
    if not current_path(store, db, identity, old["basis"]) or not sources.absent(root, old["path"]):
        raise ReplicaError("The file location changed; review the current identity")
    if {tip["event"] for tip in store.tips(db, key("asset_files", identity, "$content"))} != set(
        old.get("content_basis", [])
    ):
        raise ReplicaError("The file content choice changed; review its identity")
    verified = sources.inspect(root, new["path"])
    if verified["generation"] != new["generation"] or not sources.matches(old, verified):
        raise ReplicaError("Moved-file evidence changed; run Update again")
    builder = Preview(store, db)
    builder.put(key("asset_files", identity, "relative_path"), new["path"])
    if not store.tips(db, key("asset_files", identity, "$content")):
        builder.put(key("asset_files", identity, "$content"), old["evidence"])
    receipt = builder.receipt()
    store.save_in(
        db,
        [UnitChange.model_validate(c) for c in receipt["changes"]],
        operation,
        parents=receipt["parents"],
    )
    repaired_local_state(db, identity, old, new)


# Resume follows only this device's earlier verified generation, never another device's bytes
def repaired_local_state(
    db: sqlite3.Connection, identity: str, old: dict[str, Any], new: dict[str, Any]
) -> None:
    if sources.matches(old, new):
        db.execute(
            "UPDATE local_progress SET generation=? WHERE file_id=? AND generation=?",
            (new["generation"], identity, old.get("generation", "")),
        )
    db.execute(
        (
            "UPDATE local_media SET "
            "generation=?,metadata=NULL,state='available',error=NULL WHERE "
            "file_id=?"
        ),
        (new["generation"], identity),
    )
    baseline(db, identity, new)


# One worker tick consumes at most a bounded entry/metadata batch before yielding to exchange
def tick(store: CatalogStore, root: Path) -> None:
    if store.descriptor.format_version != 3:
        return
    status = store.status()
    if not status["ready"] or status["blocked"]:
        return
    with store.connection(readonly=True) as db:
        row = db.execute(
            "SELECT * FROM discovery_runs WHERE state='running' ORDER BY sequence LIMIT 1"
        ).fetchone()
    if row is None:
        close_walk(store)
        from cairndex.replicas.discovery_review import tick as review_tick
        from cairndex.replicas.discovery_verification import tick as verification_tick

        if verification_tick(store, root):
            return
        review_tick(store, root)
        return
    run, phase = row["id"], row["phase"]
    try:
        capable(store)
        if phase == "walk":
            enumerate_batch(store, root, run)
        elif phase == "known":
            known_batch(store, root, run, row["cursor"])
        elif phase == "repair":
            repair_batch(store, root, run, row["cursor"])
        else:
            propose_batch(store, run)
    except (OSError, ValueError, DomainError) as error:
        close(store)
        with store.connection() as db:
            db.execute(
                "UPDATE discovery_runs SET state='failed',error=? WHERE id=? AND state='running'",
                (
                    error.message
                    if isinstance(error, DomainError)
                    else (
                        "A local folder or file could not be read completely; retry "
                        "Update when it is available"
                    ),
                    run,
                ),
            )


# Enumeration records observations in fixed batches and never publishes provisional catalog entries
def enumerate_batch(store: CatalogStore, root: Path, run: str) -> None:
    if store not in _walks or _walks[store][0] != run:
        close(store)
        # Restart enumerates afresh so files removed during downtime cannot survive as observations
        with store.connection() as db:
            db.execute("DELETE FROM discovery_entries WHERE run=?", (run,))
            db.execute("UPDATE discovery_runs SET observed=0 WHERE id=?", (run,))
        _walks[store] = run, sources.walk(root)
    walker = _walks[store][1]
    found = []
    complete = False
    with store.connection(readonly=True) as db, ExitStack() as workers:
        pool = None
        pending: deque[Future[dict[str, Any]]] = deque()

        def record(observation: dict[str, Any]) -> None:
            from cairndex.replicas.discovery_verification import evidence

            full = evidence(db, observation)
            if full and observation["evidence"]["algorithm"] != "sha256":
                observation = observation | {"sample": observation["evidence"], "evidence": full}
            path = observation["path"]
            found.append((run, path, path.rpartition("/")[0], value_text(observation)))

        deadline = time.monotonic() + SCAN_SECONDS
        for index in range(SCAN_BATCH):
            if index and time.monotonic() >= deadline:
                break
            try:
                entry = next(walker)
            except StopIteration:
                complete = True
                break
            if entry is None or classify(entry.path) is None:
                continue
            path = entry.path
            prior = db.execute(
                "SELECT body FROM discovery_baselines WHERE json_extract(body,'$.path')=? LIMIT 1",
                (path,),
            ).fetchone()
            cached = json.loads(prior[0]) if prior else None
            if entry.network and (
                cached is None or cached["generation"] != generation(path, entry.info)
            ):
                if pool is None:
                    pool = workers.enter_context(ThreadPoolExecutor(max_workers=SMB_READERS))
                pending.append(sources.submit(pool, root, entry, cached))
                if len(pending) == SMB_READERS:
                    record(pending.popleft().result())
            else:
                record(sources.inspect(root, path, cached, entry=entry))
        # All SQLite work stays on this thread. ExitStack drains even failed
        # batches before any observations commit or directory handles retire.
        for future in pending:
            record(future.result())
    with store.connection() as db:
        if not db.execute(
            "SELECT 1 FROM discovery_runs WHERE id=? AND state='running'", (run,)
        ).fetchone():
            close(store)
            return
        db.executemany(
            "INSERT OR REPLACE INTO discovery_entries(run,path,parent,body) VALUES (?,?,?,?)", found
        )
        db.execute(
            "UPDATE discovery_runs SET observed=observed+?,phase=? WHERE id=?",
            (len(found), "known" if complete else "walk", run),
        )
    if complete:
        close(store)


# Cataloged paths are checked independently; incomplete delivery never becomes a shared absence
def known_batch(store: CatalogStore, root: Path, run: str, after: str) -> None:
    with store.connection() as db:
        if not db.execute(
            "SELECT 1 FROM discovery_runs WHERE id=? AND state='running' "
            "AND phase='known' AND cursor=?",
            (run, after),
        ).fetchone():
            return
        deadline = time.monotonic() + SCAN_SECONDS
        rows = db.execute(
            (
                "SELECT f.entity,p.path FROM catalog_rows f JOIN catalog_paths p "
                "ON p.owner='asset_files/'||f.entity WHERE f.family='asset_files' "
                "AND f.entity>? ORDER BY f.entity LIMIT ?"
            ),
            (after, SCAN_BATCH),
        ).fetchall()
        completed, cursor = 0, after
        for row in rows:
            if completed and time.monotonic() >= deadline:
                break
            identity, path = row
            old_row = db.execute(
                "SELECT body FROM discovery_baselines WHERE file_id=?", (identity,)
            ).fetchone()
            old = json.loads(old_row[0]) if old_row else None
            evidence_row = db.execute(
                "SELECT value FROM catalog_units WHERE unit=?",
                (key("asset_files", identity, "$content"),),
            ).fetchone()
            shared = json.loads(evidence_row[0]) if evidence_row and evidence_row[0] else None
            observed = db.execute(
                "SELECT body FROM discovery_entries WHERE run=? AND path=?", (run, path)
            ).fetchone()
            if observed:
                new = json.loads(observed[0])
                expected = shared or (old["evidence"] if old and old["path"] == path else None)
                if expected is not None and sources.confirms(old, path, expected, new):
                    # The recorded samples carry the complete hash across a remount
                    new = new | {"evidence": expected, "sample": new["evidence"]}
                if expected is not None and expected != new["evidence"]:
                    db.execute("DELETE FROM local_file_facts WHERE file_id=?", (identity,))
                    needs_verification = (
                        expected["algorithm"] == "sha256"
                        and new["evidence"]["algorithm"] != "sha256"
                    )
                    candidate(
                        db,
                        run,
                        {
                            "kind": "verification" if needs_verification else "replacement",
                            "files": [new | {"id": identity}],
                            "title": Path(path).name,
                            "target": None,
                            "file_id": identity,
                            "expected": expected,
                            "basis": [
                                tip["event"]
                                for tip in store.tips(
                                    db, key("asset_files", identity, "relative_path")
                                )
                            ],
                            "content_basis": [
                                tip["event"]
                                for tip in store.tips(db, key("asset_files", identity, "$content"))
                            ],
                            "reason": (
                                "Complete content verification is needed for this local copy"
                                if needs_verification
                                else "Different local content requires explicit replacement review"
                            ),
                        },
                    )
                else:
                    baseline(db, identity, new)
                    db.execute(
                        (
                            "UPDATE discovery_candidates SET state='observed' WHERE path=? "
                            "AND state='pending'"
                        ),
                        (path,),
                    )
                db.execute(
                    "UPDATE discovery_entries SET handled=1 WHERE run=? AND path=?", (run, path)
                )
            elif sources.absent(root, path):
                db.execute("DELETE FROM local_file_facts WHERE file_id=?", (identity,))
                db.execute(
                    (
                        "INSERT INTO local_media VALUES (?,NULL,'unavailable',NULL,NULL) "
                        "ON CONFLICT(file_id) DO UPDATE SET state='unavailable'"
                    ),
                    (identity,),
                )
                if old and (
                    old["path"] != path or shared is not None and shared != old["evidence"]
                ):
                    old = None
                if old or shared:
                    body = (old or {"path": path, "evidence": shared}) | {
                        "file_id": identity,
                        "automatic": old is not None,
                        "content_basis": [
                            tip["event"]
                            for tip in store.tips(db, key("asset_files", identity, "$content"))
                        ],
                        "basis": [
                            tip["event"]
                            for tip in store.tips(db, key("asset_files", identity, "relative_path"))
                        ],
                    }
                    db.execute(
                        "INSERT OR REPLACE INTO discovery_missing VALUES (?,?,?)",
                        (run, identity, value_text(body)),
                    )
            completed += 1
            cursor = identity
        advance(
            db,
            run,
            "known",
            completed,
            "SELECT count(*) FROM catalog_paths WHERE family='asset_files'",
        )
        db.execute(
            "UPDATE discovery_runs SET cursor=?,phase=? WHERE id=?",
            (cursor if rows else "", "known" if rows else "repair", run),
        )


# Ambiguous source matches stay private and reviewable, retaining every original catalog identity
def repair_batch(store: CatalogStore, root: Path, run: str, after: str) -> None:
    with store.connection() as db:
        rows = db.execute(
            (
                "SELECT path,body FROM discovery_entries WHERE run=? AND "
                "handled=0 AND path>? ORDER BY path LIMIT ?"
            ),
            (run, after, BATCH),
        ).fetchall()
        advance(
            db,
            run,
            "repair",
            len(rows),
            "SELECT count(*) FROM discovery_entries WHERE run=? AND handled=0",
            (run,),
        )
        for path, raw in rows:
            new = json.loads(raw)
            from cairndex.replicas.discovery_choices import matching, stage

            choices = [json.loads(r[0]) for r in matching(db, run, new).fetchmany(2)]
            matches = []
            if len(choices) == 1:
                matches = [
                    json.loads(r[0])
                    for r in db.execute(
                        (
                            "SELECT body FROM discovery_entries WHERE run=? AND handled IN "
                            "(0,2) AND json_extract(body,'$.evidence.digest')=? LIMIT ?"
                        ),
                        (run, new["evidence"]["digest"], 2),
                    )
                    if choices[0]["evidence"] == json.loads(r[0])["evidence"]
                ]
            if (
                len(choices) == len(matches) == 1
                and choices[0]["automatic"]
                and sources.matches(choices[0], new)
            ):
                repair(
                    store,
                    db,
                    root,
                    choices[0],
                    new,
                    "move_" + checksum(value_text([run, path]).encode())[:40],
                )
                db.execute(
                    "UPDATE discovery_entries SET handled=1 WHERE run=? AND path=?", (run, path)
                )
                db.execute("UPDATE discovery_runs SET repaired=repaired+1 WHERE id=?", (run,))
            elif choices:
                stage(
                    db,
                    run,
                    {
                        "kind": "repair",
                        "files": [new],
                        "title": Path(path).name,
                        "target": None,
                        "choices": choices,
                        "reason": (
                            "Sampled evidence cannot prove complete equality; explicitly choose "
                            "whether this file belongs to a missing identity"
                            if new["evidence"]["algorithm"] != "sha256"
                            else "The missing identity requires your confirmation"
                        ),
                    },
                )
                db.execute(
                    "UPDATE discovery_entries SET handled=2 WHERE run=? AND path=?", (run, path)
                )
        db.execute(
            "UPDATE discovery_runs SET cursor=?,phase=? WHERE id=?",
            (rows[-1][0] if rows else "", "repair" if rows else "propose", run),
        )


# Complete grouping context is indexed before rules run; batches never define review boundaries
def propose_batch(store: CatalogStore, run: str) -> None:
    from cairndex.replicas import discovery_plan as plan
    from cairndex.replicas import discovery_proposals as proposals

    # Cached indexing, grouping and export share one bounded transaction. A
    # durable flush per subject otherwise dominates small-file Updates on macOS.
    with store.connection() as db:
        # Connection setup and waiting for a writer do not consume the work
        # budget; under load that would reduce every batch to a single step.
        deadline = time.monotonic() + 0.05
        for _ in range(BATCH):
            job = db.execute("SELECT * FROM discovery_runs WHERE id=?", (run,)).fetchone()
            if job["state"] != "running":
                return
            phase = job["phase"]
            if phase == "propose" and not job["cursor"] and not plan.has_grouping_sources(db, run):
                phase = "export"
            if phase in ("propose", "plan_known"):
                done = plan.index_batch(store, db, run, job["cursor"], known=phase == "plan_known")
            else:
                done = plan.tick(db, run) if phase == "group" else proposals.tick(db, run)
            if done:
                following = {"propose": "plan_known", "plan_known": "group", "group": "export"}
                if phase in following:
                    db.execute(
                        "UPDATE discovery_runs SET phase=?,cursor='' WHERE id=?",
                        (following[phase], run),
                    )
                else:
                    db.execute(
                        "UPDATE discovery_candidates SET state='superseded' "
                        "WHERE run<>? AND state='pending'",
                        (run,),
                    )
                    db.execute(
                        "UPDATE discovery_runs SET state='succeeded',phase='complete' WHERE id=?",
                        (run,),
                    )
                    return
            if time.monotonic() >= deadline:
                return
