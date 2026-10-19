"""Rank bounded indexed catalog candidates with the established bundling rules."""

import json
import sqlite3
from typing import Any

from pydantic import Field

from cairndex.domain.enums import MediaKind
from cairndex.grouping.suggester import FileObservation, _assign_roles, _stem
from cairndex.manual_bundling import suggest as rules
from cairndex.replicas.catalog.manual_sources import Selection
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.protocol import ReplicaError, checksum
from cairndex.scanning.media_types import classify, is_hidden_relative_path

CAP = 200


class SeedSelection(Selection):
    limit: int = Field(default=30, ge=1, le=50)


def kind(path: str) -> MediaKind:
    result = classify(path)
    return result[0] if result else MediaKind.OTHER


def seeds(db: sqlite3.Connection, selected: SeedSelection) -> list[FileObservation]:
    result = []
    for identity in selected.file_ids:
        row = read_row(db, "asset_files", identity)
        bundle = read_row(db, "asset_bundles", row["bundle_id"]) if row else None
        if (
            not row
            or not bundle
            or (bundle["grouping_state"], bundle["grouping_source"])
            != ("PROVISIONAL", "SCAN_SUGGESTION")
            or is_hidden_relative_path(row["relative_path"])
        ):
            raise ReplicaError("Choose current Unbundled files for suggestions")
        result.append(FileObservation(identity, row["relative_path"], kind(row["relative_path"])))
    for path in selected.relative_paths:
        if not classify(path):
            raise ReplicaError("Choose supported media files for suggestions")
        if db.execute(
            "SELECT 1 FROM catalog_paths WHERE family='asset_files' AND path=?", (path,)
        ).fetchone():
            raise ReplicaError("A selected path is already linked; refresh the files")
        result.append(FileObservation("path_" + checksum(path.encode())[:40], path, kind(path)))
    return result


def context(files: list[FileObservation], title: str | None = None) -> rules._Context:
    return rules._file_context(
        [(file.relative_path, file.media_kind) for file in files], title=title
    )


def bundle_files(db: sqlite3.Connection, bundle: str, preferred: set[str]) -> list[FileObservation]:
    # Prefer the seed's enclosing folders before bounding a large bundle's context.
    rows = db.execute(
        "SELECT f.entity,p.path FROM catalog_rows f JOIN catalog_paths p "
        "ON p.owner='asset_files/'||f.entity WHERE f.family='asset_files' "
        "AND json_extract(f.body,'$.bundle_id')=? "
        "ORDER BY p.parent IN (SELECT value FROM json_each(?)) DESC,p.path,f.entity LIMIT ?",
        (bundle, json.dumps(sorted(preferred)), CAP),
    )
    return [
        FileObservation(row[0], row[1], kind(row[1]))
        for row in rows
        if not is_hidden_relative_path(row[1])
    ]


def targets(db: sqlite3.Connection, selected: SeedSelection) -> list[dict[str, Any]]:
    source = seeds(db, selected)
    ctx = context(source)
    enclosing = {parent for directory in ctx.dirs for parent in rules._ancestors(directory)}
    candidates: set[str] = set()
    for parent in sorted(enclosing):
        candidates.update(
            row[0]
            for row in db.execute(
                "SELECT DISTINCT b.entity FROM catalog_paths p JOIN catalog_rows f "
                "ON f.family='asset_files' AND f.entity=p.entity JOIN catalog_rows b "
                "ON b.family='asset_bundles' AND b.entity=json_extract(f.body,'$.bundle_id') "
                "WHERE p.parent=? AND p.family='asset_files' "
                "AND json_extract(b.body,'$.grouping_state')='CONFIRMED' ORDER BY b.entity LIMIT ?",
                (parent, CAP - len(candidates)),
            )
        )
        if len(candidates) >= CAP:
            break
    match = rules._or_match(ctx.tokens)
    if match:
        candidates.update(
            row[0]
            for row in db.execute(
                "SELECT s.bundle_id FROM catalog_search s JOIN catalog_rows b "
                "ON b.family='asset_bundles' AND b.entity=s.bundle_id "
                "WHERE catalog_search MATCH ? "
                "AND json_extract(b.body,'$.grouping_state')='CONFIRMED' "
                "ORDER BY rank,s.bundle_id LIMIT ?",
                (match, CAP),
            )
        )
        candidates.update(
            row[0]
            for row in db.execute(
                "SELECT DISTINCT b.entity FROM catalog_suggestion_paths s "
                "JOIN catalog_rows f ON f.family='asset_files' AND f.entity=s.file_id "
                "JOIN catalog_rows b ON b.family='asset_bundles' "
                "AND b.entity=json_extract(f.body,'$.bundle_id') "
                "WHERE catalog_suggestion_paths MATCH ? "
                "AND json_extract(b.body,'$.grouping_state')='CONFIRMED' "
                "ORDER BY b.entity LIMIT ?",
                (match, CAP),
            )
        )
    suggestions: list[dict[str, Any]] = []
    for identity in sorted(candidates):
        bundle = read_row(db, "asset_bundles", identity)
        assert bundle is not None
        target = context(bundle_files(db, identity, enclosing), bundle["title"])
        scores = [rules._score(file.relative_path, file.media_kind, target) for file in source]
        best = max(
            (score for score in scores if score is not None),
            key=lambda score: score[0],
            default=None,
        )
        if best:
            suggestions.append(
                {
                    "bundle_id": identity,
                    "title": bundle["title"],
                    "confidence": round(best[0], 3),
                    "reason": best[1],
                }
            )
    return sorted(
        suggestions,
        key=lambda item: (-item["confidence"], (item["title"] or "").casefold(), item["bundle_id"]),
    )[: selected.limit]


def nearby(
    db: sqlite3.Connection, source: list[FileObservation], title: str | None, limit: int
) -> list[dict[str, Any]]:
    ctx = context(source, title)
    candidate_rows: dict[str, str] = {}
    excluded = {file.asset_file_id for file in source}
    # Equality/range probes use catalog_path_parent; no source directory is read.
    for directory in sorted(ctx.dirs):
        if not directory:
            continue
        for row in db.execute(
            "SELECT p.entity,p.path FROM catalog_paths p JOIN catalog_rows f "
            "ON f.family='asset_files' AND f.entity=p.entity JOIN catalog_rows b "
            "ON b.family='asset_bundles' AND b.entity=json_extract(f.body,'$.bundle_id') "
            "WHERE p.family='asset_files' AND (p.parent=? OR (p.parent>=? AND p.parent<?)) "
            "AND json_extract(b.body,'$.grouping_state')='PROVISIONAL' "
            "AND json_extract(b.body,'$.grouping_source')='SCAN_SUGGESTION' "
            "ORDER BY p.path,p.entity LIMIT ?",
            (directory, directory + "/", directory + "0", CAP),
        ):
            if row[0] not in excluded and not is_hidden_relative_path(row[1]):
                candidate_rows[row[0]] = row[1]
        if len(candidate_rows) >= CAP:
            break
    match = rules._or_match(ctx.tokens)
    if match:
        for row in db.execute(
            "SELECT p.entity,p.path FROM catalog_search s JOIN catalog_rows b "
            "ON b.family='asset_bundles' AND b.entity=s.bundle_id JOIN catalog_rows f "
            "ON f.family='asset_files' AND json_extract(f.body,'$.bundle_id')=b.entity "
            "JOIN catalog_paths p ON p.owner='asset_files/'||f.entity "
            "WHERE catalog_search MATCH ? "
            "AND json_extract(b.body,'$.grouping_state')='PROVISIONAL' "
            "AND json_extract(b.body,'$.grouping_source')='SCAN_SUGGESTION' "
            "ORDER BY rank,p.path,p.entity LIMIT ?",
            (match, CAP),
        ):
            if row[0] not in excluded and not is_hidden_relative_path(row[1]):
                candidate_rows[row[0]] = row[1]
        for row in db.execute(
            "SELECT s.file_id,s.path FROM catalog_suggestion_paths s "
            "JOIN catalog_rows f ON f.family='asset_files' AND f.entity=s.file_id "
            "JOIN catalog_rows b ON b.family='asset_bundles' "
            "AND b.entity=json_extract(f.body,'$.bundle_id') "
            "WHERE catalog_suggestion_paths MATCH ? "
            "AND json_extract(b.body,'$.grouping_state')='PROVISIONAL' "
            "AND json_extract(b.body,'$.grouping_source')='SCAN_SUGGESTION' "
            "ORDER BY rank,s.path,s.file_id LIMIT ?",
            (match, CAP),
        ):
            if row[0] not in excluded and not is_hidden_relative_path(row[1]):
                candidate_rows[row[0]] = row[1]
    suggestions: list[dict[str, Any]] = []
    for identity, path in candidate_rows.items():
        media = kind(path)
        scored = rules._score(path, media, ctx)
        if scored:
            suggestions.append(
                {
                    "file_id": identity,
                    "relative_path": path,
                    "media_kind": media,
                    "confidence": round(scored[0], 3),
                    "reason": scored[1],
                }
            )
    return sorted(
        suggestions, key=lambda item: (-item["confidence"], item["relative_path"], item["file_id"])
    )[:limit]


def draft(db: sqlite3.Connection, selected: SeedSelection) -> dict[str, Any]:
    source = seeds(db, selected)
    first = next((file for file in source if file.media_kind == MediaKind.VIDEO), source[0])
    paths = {file.asset_file_id: file.relative_path for file in source}
    return {
        "proposed_title": _stem(first.relative_path),
        "roles": [
            {
                "file_id": role.asset_file_id,
                "relative_path": paths[role.asset_file_id],
                "role": role.role,
                "sequence": role.sequence,
            }
            for role in _assign_roles(source)
        ],
        "additional": nearby(db, source, None, selected.limit),
    }


def files_for(db: sqlite3.Connection, bundle: str, limit: int) -> list[dict[str, Any]]:
    row = read_row(db, "asset_bundles", bundle)
    if row is None or row["grouping_state"] != "CONFIRMED":
        raise ReplicaError("Choose a confirmed bundle for suggestions")
    return nearby(db, bundle_files(db, bundle, set()), row["title"], limit)
