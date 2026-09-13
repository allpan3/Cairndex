"""Manual bounded replica discovery, private observations and conservative causal repairs"""

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from cairndex.core.errors import DomainError
from cairndex.domain.enums import MediaKind
from cairndex.grouping.suggester import FileObservation, suggest_grouping
from cairndex.replicas import discovery_sources as sources
from cairndex.replicas.catalog.commands import Preview
from cairndex.replicas.catalog.model import key, value_text
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.catalog.protocol import UnitChange
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.discovery_state import capable
from cairndex.replicas.protocol import ReplicaError, checksum
from cairndex.scanning.media_types import classify


# Candidate media was already classified by the read-only walker
def media_kind(path: str) -> MediaKind:
    result = classify(path)
    return result[0] if result else MediaKind.OTHER


BATCH = 32
REVIEW_FILES = 128
_walks: dict[CatalogStore, tuple[str, Iterator[str | None]]] = {}


# Release/cancel closes pinned directory handles before retiring a private generation
def close(store: CatalogStore) -> None:
    entry = _walks.pop(store, None)
    if entry:
        entry[1].close()  # type: ignore[attr-defined]


# Evidence and reviewed file identity survive scans without entering transport observations
def baseline(db: sqlite3.Connection, identity: str, observation: dict[str, Any]) -> None:
    db.execute(
        "INSERT OR REPLACE INTO discovery_baselines VALUES (?,?)",
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
        close(store)
        from cairndex.replicas.discovery_review import tick as review_tick

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
    for _ in range(BATCH):
        try:
            path = next(walker)
        except StopIteration:
            complete = True
            break
        if path is None or classify(path) is None:
            continue
        cached = None
        with store.connection(readonly=True) as db:
            prior = db.execute(
                "SELECT body FROM discovery_baselines WHERE json_extract(body,'$.path')=? LIMIT 1",
                (path,),
            ).fetchone()
            if prior:
                cached = json.loads(prior[0])
        observation = sources.inspect(root, path, cached)
        found.append((run, path, path.rpartition("/")[0], value_text(observation)))
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
        rows = db.execute(
            (
                "SELECT entity,path FROM catalog_paths WHERE family='asset_files' "
                "AND entity>? ORDER BY entity LIMIT ?"
            ),
            (after, BATCH),
        ).fetchall()
        for row in rows:
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
                if expected is not None and expected != new["evidence"]:
                    candidate(
                        db,
                        run,
                        {
                            "kind": "replacement",
                            "files": [new | {"id": identity}],
                            "title": Path(path).name,
                            "target": None,
                            "file_id": identity,
                            "reason": (
                                "Different content at an existing path; an explicit source choice "
                                "is required"
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
        db.execute(
            "UPDATE discovery_runs SET cursor=?,phase=? WHERE id=?",
            (rows[-1][0] if rows else "", "known" if rows else "repair", run),
        )


# Uniqueness is checked in both directions before the automatic move policy may apply
def possible(db: sqlite3.Connection, run: str, observation: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        json.loads(row[0])
        for row in db.execute(
            (
                "SELECT body FROM discovery_missing WHERE run=? AND "
                "json_extract(body,'$.evidence.digest')=? LIMIT ?"
            ),
            (run, observation["evidence"]["digest"], REVIEW_FILES + 1),
        )
        if json.loads(row[0])["evidence"] == observation["evidence"]
    ]


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
        for path, raw in rows:
            new = json.loads(raw)
            choices = possible(db, run, new)
            matches = []
            if len(choices) == 1:
                matches = [
                    json.loads(r[0])
                    for r in db.execute(
                        (
                            "SELECT body FROM discovery_entries WHERE run=? AND handled IN "
                            "(0,2) AND json_extract(body,'$.evidence.digest')=? LIMIT ?"
                        ),
                        (run, new["evidence"]["digest"], REVIEW_FILES + 1),
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
                candidate(
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


# Reuse the pure grouping rules on bounded directory batches, without legacy ORM mutation
def propose_batch(store: CatalogStore, run: str) -> None:
    with store.connection() as db:
        first = db.execute(
            "SELECT parent FROM discovery_entries WHERE run=? AND handled=0 ORDER BY path LIMIT 1",
            (run,),
        ).fetchone()
        if not first:
            # Retain historical bodies and drafts outside the completed run's active choices
            db.execute(
                "UPDATE discovery_candidates SET state='superseded' "
                "WHERE run<>? AND state='pending'",
                (run,),
            )
            db.execute(
                "UPDATE discovery_runs SET state='succeeded',phase='complete' WHERE id=?", (run,)
            )
            return
        rows = db.execute(
            (
                "SELECT body FROM discovery_entries WHERE run=? AND handled=0 AND "
                "parent=? ORDER BY path LIMIT ?"
            ),
            (run, first[0], REVIEW_FILES),
        ).fetchall()
        observations = []
        details = {}
        for (raw,) in rows:
            info = json.loads(raw)
            evidence = value_text(info["evidence"])
            prior = db.execute(
                "SELECT file_id FROM discovery_identities WHERE path=? AND evidence=?",
                (info["path"], evidence),
            ).fetchone()
            identity = (
                prior[0]
                if prior
                else sources.file_id(store.descriptor.library_uuid, store.descriptor.epoch, info)
            )
            db.execute(
                "INSERT OR IGNORE INTO discovery_identities VALUES (?,?,?)",
                (info["path"], evidence, identity),
            )
            details[identity] = info | {"id": identity}
            observations.append(FileObservation(identity, info["path"], media_kind(info["path"])))
        known = db.execute(
            (
                "SELECT entity,path FROM catalog_paths WHERE family='asset_files' "
                "AND parent=? ORDER BY path LIMIT ?"
            ),
            (first[0], REVIEW_FILES + 1),
        ).fetchall()
        if len(known) <= REVIEW_FILES:
            for identity, path in known:
                file = read_row(db, "asset_files", identity)
                bundle = read_row(db, "asset_bundles", file["bundle_id"]) if file else None
                if file and bundle and classify(path):
                    observations.append(
                        FileObservation(
                            identity, path, media_kind(path), True, bundle["id"], bundle["title"]
                        )
                    )
        for proposal in suggest_grouping(observations).proposals:
            if not proposal.files:
                continue
            files = [
                details[f.asset_file_id] | {"role": f.role.name, "sequence": f.sequence}
                for f in proposal.files
                if f.asset_file_id in details
            ]
            if files:
                candidate(
                    db,
                    run,
                    {
                        "kind": "new",
                        "files": files,
                        "title": proposal.title,
                        "target": proposal.target_bundle_id,
                        "reason": proposal.reason,
                    },
                )
        db.executemany(
            "UPDATE discovery_entries SET handled=1 WHERE run=? AND path=?",
            ((run, info["path"]) for info in details.values()),
        )
