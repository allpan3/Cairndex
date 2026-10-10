"""Paged source preparation and complete catalog assembly for directory and collection reviews"""

import base64
import hashlib
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cairndex.replicas import discovery_sources as sources
from cairndex.replicas.catalog.model import key, value_text
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.discovery_collections import place
from cairndex.replicas.discovery_preview import DiscoveryPreview
from cairndex.replicas.protocol import ReplicaError

BATCH = 32


# Default selection includes the complete candidate; explicit exceptions stay independent of paging
def selection(intent: dict[str, Any]) -> tuple[str, tuple[Any, ...]]:
    query = ""
    parameters: list[Any] = []
    for name, field, exclude in (
        ("files", "json_extract(f.body,'$.id')", False),
        ("exclude_files", "json_extract(f.body,'$.id')", True),
        ("groups", "f.group_id", False),
        ("exclude_groups", "f.group_id", True),
    ):
        if intent.get(name) is not None:
            chosen = intent[name]
            if len(chosen) != len(set(chosen)):
                raise ReplicaError("Review selection contains duplicate identities")
            query += (
                f" AND {field} {'NOT IN' if exclude else 'IN'} (SELECT value FROM json_each(?))"
            )
            parameters.append(value_text(chosen))
    return query, tuple(parameters)


# The opening frontier and complete immutable selection are captured before staged catalog writes
def begin(
    store: CatalogStore, db: sqlite3.Connection, operation: str, intent: dict[str, Any]
) -> None:
    row = db.execute(
        "SELECT * FROM discovery_candidates WHERE id=? AND state='pending'", (intent["candidate"],)
    ).fetchone()
    if row is None:
        raise ReplicaError("Discovery candidate changed; run Update and review again")
    candidate = json.loads(row["body"])
    if candidate.get("version") != 2:
        raise ReplicaError("This review requires its retained original preparation")
    query, params = selection(intent)
    for name, expression in (
        ("files", "json_extract(body,'$.id')"),
        ("groups", "group_id"),
        ("exclude_files", "json_extract(body,'$.id')"),
        ("exclude_groups", "group_id"),
    ):
        if (
            intent.get(name)
            and db.execute(
                f"SELECT 1 FROM json_each(?) WHERE value NOT IN (SELECT {expression} "
                "FROM discovery_candidate_files WHERE candidate=?) LIMIT 1",
                (value_text(intent[name]), intent["candidate"]),
            ).fetchone()
        ):
            raise ReplicaError("Review selection must belong to the displayed candidate")
    total = db.execute(
        "SELECT COUNT(*) FROM discovery_candidate_files f WHERE f.candidate=?" + query,
        (intent["candidate"], *params),
    ).fetchone()[0]
    if not total:
        raise ReplicaError("Choose at least one discovered file")
    parents = [row[0] for row in db.execute("SELECT event FROM catalog_frontier ORDER BY event")]
    db.execute(
        "INSERT INTO discovery_review_work VALUES (?,'copy',-1,?,?,0,?)",
        (operation, value_text(parents), total, value_text(candidate)),
    )


# Copy selected original bytes in bounded pages; overlapping accepted sources are retained as
# receipts
def copy(db: sqlite3.Connection, operation: str, intent: dict[str, Any], cursor: int) -> None:
    query, params = selection(intent)
    rows = db.execute(
        "SELECT * FROM discovery_candidate_files f WHERE f.candidate=? "
        "AND f.position>?" + query + " ORDER BY f.position LIMIT ?",
        (intent["candidate"], cursor, *params, BATCH),
    ).fetchall()
    for row in rows:
        original = json.loads(row["body"])
        accepted = db.execute(
            "SELECT 1 FROM discovery_accepted_files WHERE path=? AND generation=?",
            (original["path"], original["generation"]),
        ).fetchone()
        if accepted:
            continue
        db.execute(
            "INSERT INTO discovery_review_files VALUES (?,?,?,?,NULL,?)",
            (operation, row["position"], row["group_id"], row["body"], row["position"]),
        )
        db.execute(
            "INSERT OR IGNORE INTO discovery_review_groups(operation,id,body) "
            "SELECT ?,id,body FROM discovery_candidate_groups WHERE candidate=? AND id=?",
            (operation, intent["candidate"], row["group_id"]),
        )
    if rows:
        db.execute(
            "UPDATE discovery_review_work SET cursor=? WHERE operation=?",
            (rows[-1]["position"], operation),
        )
    else:
        from cairndex.replicas.discovery_order import reorder

        reorder(db, operation, intent)
        count = db.execute(
            "SELECT COUNT(*) FROM discovery_review_files WHERE operation=?", (operation,)
        ).fetchone()[0]
        if not count:
            raise ReplicaError(
                "These files have already been accepted; review remaining suggestions"
            )
        db.execute(
            "UPDATE discovery_review_work SET phase='verify',cursor=-1,total=? WHERE operation=?",
            (count, operation),
        )


# Each complete evidence choice is tied to the immutable source generation shown in the review
def verify(
    store: CatalogStore,
    db: sqlite3.Connection,
    root: Path,
    operation: str,
    intent: dict[str, Any],
    cursor: int,
) -> None:
    from cairndex.replicas.discovery_verification import verified_file

    if intent.get("verification"):
        job = db.execute(
            "SELECT candidate,state FROM discovery_verifications WHERE id=?",
            (intent["verification"],),
        ).fetchone()
        if not job or tuple(job) != (intent["candidate"], "succeeded"):
            raise ReplicaError("Complete the selected content verification before preparing")
    rows = db.execute(
        "SELECT * FROM discovery_review_files WHERE operation=? AND position>? "
        "ORDER BY position LIMIT ?",
        (operation, cursor, BATCH),
    ).fetchall()
    for row in rows:
        file = json.loads(row["original"])
        if sources.inspect(root, file["path"])["generation"] != file["generation"]:
            raise ReplicaError("Local files changed; run Update before reviewing")
        if intent.get("verification"):
            file = verified_file(db, root, file)
            file["id"] = sources.file_id(
                store.descriptor.library_uuid, store.descriptor.epoch, file
            )
        db.execute(
            "UPDATE discovery_review_files SET body=? WHERE operation=? AND position=?",
            (value_text(file), operation, row["position"]),
        )
    db.execute(
        "UPDATE discovery_review_work SET phase=?,cursor=?,progress=progress+? WHERE operation=?",
        (
            "verify" if rows else "groups",
            rows[-1]["position"] if rows else -1,
            len(rows),
            operation,
        ),
    )


# Group identity hashes the complete ordered member set without loading every member into Python
def identity(db: sqlite3.Connection, operation: str, group: str) -> str:
    digest = hashlib.sha256(b'["group",[')
    separator = b""
    for (value,) in db.execute(
        "SELECT json_extract(body,'$.id') FROM discovery_review_files "
        "WHERE operation=? AND group_id=? ORDER BY json_extract(body,'$.id')",
        (operation, group),
    ):
        digest.update(separator + value_text(value).encode())
        separator = b","
    digest.update(b"]]")
    return base64.b32encode(digest.digest()).decode()[:26]


# All group defaults and collection paths are deterministic for the selected source set
def groups(builder: DiscoveryPreview, intent: dict[str, Any], candidate: dict[str, Any]) -> None:
    from cairndex.replicas.discovery_review import defaults

    db, operation = builder.db, builder.operation
    row = db.execute(
        "SELECT * FROM discovery_review_groups WHERE operation=? AND state='queued' "
        "ORDER BY id LIMIT 1",
        (operation,),
    ).fetchone()
    if row is None:
        db.execute(
            "UPDATE discovery_review_work SET phase='files',cursor=-1,progress=0 WHERE operation=?",
            (operation,),
        )
        return
    group = json.loads(row["body"])
    earliest = db.execute(
        "SELECT MIN(json_extract(body,'$.mtime')) FROM discovery_review_files "
        "WHERE operation=? AND group_id=?",
        (operation, row["id"]),
    ).fetchone()[0]
    stamp = (
        datetime.fromtimestamp(earliest / 1_000_000_000, UTC)
        .replace(tzinfo=None)
        .isoformat(sep=" ")
    )
    target = (
        intent.get("target", group["target"]) if candidate["kind"] == "new" else group["target"]
    )
    if not target and "target" not in intent:
        settled = db.execute(
            "SELECT DISTINCT json_extract(r.body,'$.bundle_id') FROM discovery_candidate_files f "
            "JOIN discovery_accepted_files a ON a.path=json_extract(f.body,'$.path') AND "
            "a.generation=json_extract(f.body,'$.generation') JOIN catalog_rows r "
            "ON r.family='asset_files' AND r.entity=a.file_id WHERE f.candidate=? "
            "AND f.group_id=? LIMIT 2",
            (intent["candidate"], row["id"]),
        ).fetchall()
        if len(settled) == 1:
            target = settled[0][0]
    title = intent.get("title", group["title"]) if candidate["kind"] == "new" else group["title"]
    if not isinstance(title, str) or not title.strip() or len(title) > 512:
        raise ReplicaError("A bundle title is required")
    addition = bool(target)
    if target:
        if not read_row(db, "asset_bundles", target):
            raise ReplicaError("The target bundle is unavailable; review another destination")
        builder.get(key("asset_bundles", target, "$alive"))
    else:
        target = identity(db, operation, row["id"])
        builder.create(
            "asset_bundles",
            defaults(
                "asset_bundles",
                id=target,
                title=title,
                grouping_state="CONFIRMED",
                grouping_source="MANUAL",
                imported_at=stamp,
                created_at=stamp,
                updated_at=stamp,
            ),
        )
    builder.members(target)
    placement = place(
        builder,
        group | {"target": target if addition else None},
        intent,
        candidate,
        target,
        stamp,
    )
    group |= {"stamp": stamp, "addition": addition, "placement": placement, "title": title}
    db.execute(
        "UPDATE discovery_review_groups SET target=?,body=?,state='files' "
        "WHERE operation=? AND id=?",
        (target, value_text(group), operation, row["id"]),
    )


# New files append to complete settled membership; no page can replace an earlier member list
def files(builder: DiscoveryPreview, cursor: int, intent: dict[str, Any]) -> None:
    from cairndex.replicas.discovery_review import defaults

    db, operation = builder.db, builder.operation
    # Custom file order is a review choice; normal pages retain the suggestion's order
    rows = db.execute(
        "SELECT f.*,g.target,g.body AS grouping FROM discovery_review_files f "
        "JOIN discovery_review_groups g ON g.operation=f.operation AND g.id=f.group_id "
        "WHERE f.operation=? AND f.position NOT IN "
        "(SELECT position FROM discovery_review_done WHERE operation=?) "
        "ORDER BY f.sort_order,f.position LIMIT ?",
        (operation, operation, BATCH),
    ).fetchall()
    for row in rows:
        file, group, target = json.loads(row["body"]), json.loads(row["grouping"]), row["target"]
        if db.execute(
            "SELECT 1 FROM catalog_paths WHERE family='asset_files' AND path=?", (file["path"],)
        ).fetchone():
            raise ReplicaError(
                "This path is already cataloged; run Update to reconcile its identity"
            )
        sequence = db.execute(
            "SELECT COALESCE(MAX(sequence),-1)+1 FROM discovery_review_members "
            "WHERE operation=? AND bundle=?",
            (operation, target),
        ).fetchone()[0]
        builder.create(
            "asset_files",
            defaults(
                "asset_files",
                id=file["id"],
                bundle_id=target,
                relative_path=file["path"],
                original_filename=Path(file["path"]).name,
                role=file.get("role", "OTHER"),
                sequence=sequence,
                created_at=group["stamp"],
                updated_at=group["stamp"],
            ),
        )
        builder.put(key("asset_files", file["id"], "$content"), file["evidence"])
        if not group["addition"] and file.get("role") == "COVER":
            builder.put(key("asset_bundles", target, "cover_file_id"), file["id"])
        db.execute("INSERT INTO discovery_review_done VALUES (?,?)", (operation, row["position"]))
    db.execute(
        "UPDATE discovery_review_work SET phase=?,progress=progress+? WHERE operation=?",
        ("files" if rows else "extras", len(rows), operation),
    )


# Directory members and subtitle links advance in pages over the complete settled membership
def extras(builder: DiscoveryPreview) -> None:
    from cairndex.replicas.discovery import media_kind
    from cairndex.replicas.discovery_review import defaults

    db, operation = builder.db, builder.operation
    row = db.execute(
        "SELECT * FROM discovery_review_groups WHERE operation=? AND state<>'complete' "
        "ORDER BY id LIMIT 1",
        (operation,),
    ).fetchone()
    if row is None:
        builder.arrangements()
        db.execute(
            "UPDATE discovery_review_work SET phase='guards',cursor=0 WHERE operation=?",
            (operation,),
        )
        return
    group, target, cursor = json.loads(row["body"]), row["target"], row["cursor"]
    phase = row["state"]
    if phase == "files":
        folders = group["folders"][cursor + 1 : cursor + 1 + BATCH]
        for folder in folders:
            if db.execute(
                "SELECT 1 FROM catalog_rows WHERE family='bundle_directory_members' "
                "AND json_extract(body,'$.bundle_id')=? AND "
                "json_extract(body,'$.directory_path')=?",
                (target, folder),
            ).fetchone():
                continue
            sequence = db.execute(
                "SELECT COALESCE(MAX(sequence),-1)+1 FROM discovery_review_members "
                "WHERE operation=? AND bundle=?",
                (operation, target),
            ).fetchone()[0]
            builder.create(
                "bundle_directory_members",
                defaults(
                    "bundle_directory_members",
                    id=sources.stable_id(["directory", target, folder]),
                    bundle_id=target,
                    directory_path=folder,
                    sequence=sequence,
                    created_at=group["stamp"],
                ),
            )
        cursor += len(folders)
        if len(folders) < BATCH:
            phase, cursor = "videos", -1
    elif phase == "videos":
        videos = group.get("videos", [])
        members = db.execute(
            "SELECT rowid,id FROM discovery_review_members WHERE operation=? "
            "AND bundle=? AND family='asset_files' AND rowid>? ORDER BY rowid LIMIT ?",
            (operation, target, cursor, BATCH),
        ).fetchall()
        for member in members:
            path = builder.get(key("asset_files", member["id"], "relative_path"))
            if media_kind(path).value == "video":
                videos.append(member["id"])
                if len(videos) > 1:
                    break
        group["videos"] = videos
        cursor = members[-1]["rowid"] if members else cursor
        if len(videos) > 1:
            phase = "complete"
        elif len(members) < BATCH:
            phase, cursor = ("subtitles" if videos else "complete"), -1
    else:
        members = db.execute(
            "SELECT position,body FROM discovery_review_files WHERE operation=? "
            "AND group_id=? AND position>? ORDER BY position LIMIT ?",
            (operation, row["id"], cursor, BATCH),
        ).fetchall()
        for member in members:
            file = json.loads(member["body"])
            suffix = Path(file["path"]).suffix.lower()
            if suffix in (".srt", ".vtt"):
                builder.create(
                    "subtitle_tracks",
                    defaults(
                        "subtitle_tracks",
                        id=sources.stable_id(["track", target, file["id"]]),
                        bundle_id=target,
                        video_file_id=group["videos"][0],
                        source_file_id=file["id"],
                        embedded_index=None,
                        format=suffix[1:],
                        created_at=group["stamp"],
                        updated_at=group["stamp"],
                    ),
                )
        cursor = members[-1]["position"] if members else cursor
        if len(members) < BATCH:
            phase = "complete"
    db.execute(
        "UPDATE discovery_review_groups SET state=?,cursor=?,body=? WHERE operation=? AND id=?",
        (phase, cursor, value_text(group), operation, row["id"]),
    )


# Mandatory lifetime guards capture the same opening frontier as the values they protect
def guards(builder: DiscoveryPreview, cursor: int) -> None:
    db, operation = builder.db, builder.operation
    rows = db.execute(
        "SELECT rowid,unit,value FROM discovery_review_values WHERE operation=? "
        "AND rowid>? ORDER BY rowid LIMIT ?",
        (operation, cursor, BATCH),
    ).fetchall()
    for row in rows:
        for guard in builder.store.required_guards(db, row["unit"], row["value"]):
            if guard not in builder.values:
                builder.values[guard] = "true"
                db.execute(
                    "UPDATE discovery_review_values SET cohort=NULL WHERE operation=? AND unit=?",
                    (operation, guard),
                )
    db.execute(
        "UPDATE discovery_review_work SET phase=?,cursor=? WHERE operation=?",
        ("guards" if rows else "finish", rows[-1]["rowid"] if rows else 0, operation),
    )


# One worker step resumes a persisted phase without changing the original selection or bases
def step(store: CatalogStore, db: sqlite3.Connection, root: Path, row: sqlite3.Row) -> None:
    operation, intent = row["id"], json.loads(row["intent"])
    work = db.execute(
        "SELECT * FROM discovery_review_work WHERE operation=?", (operation,)
    ).fetchone()
    if work is None:
        begin(store, db, operation, intent)
        return
    builder = DiscoveryPreview(store, db, operation)
    phase, cursor = work["phase"], work["cursor"]
    if phase == "copy":
        copy(db, operation, intent, cursor)
    elif phase == "verify":
        verify(store, db, root, operation, intent, cursor)
    elif phase == "groups":
        groups(builder, intent, json.loads(work["header"]))
    elif phase == "files":
        files(builder, cursor, intent)
    elif phase == "extras":
        extras(builder)
    elif phase == "guards":
        guards(builder, cursor)
    else:
        from cairndex.replicas.discovery_commit import finish

        finish(builder, root, intent, work)
