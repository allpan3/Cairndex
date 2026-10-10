"""Prepared discovery decisions revalidate bytes and retain their opening causal bases"""

import json
import sqlite3
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cairndex.core.errors import DomainError
from cairndex.replicas import discovery_sources as sources
from cairndex.replicas.catalog.commands import Preview, validate_preview
from cairndex.replicas.catalog.controls import creation
from cairndex.replicas.catalog.model import key, value_text
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.catalog.protocol import UnitChange
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.discovery import media_kind
from cairndex.replicas.discovery_state import capable
from cairndex.replicas.protocol import ReplicaError, checksum
from cairndex.scanning.media_types import classify


# Default cells match the existing authored schema and contain no filesystem observations
def defaults(family: str, **values: Any) -> dict[str, Any]:
    return {field: json.loads(raw) for field, raw in creation(family)["cells"].items()} | values


# Every preview pins the exact candidate and selected file order before any catalog write
def build(
    store: CatalogStore, db: sqlite3.Connection, root: Path, intent: dict[str, Any]
) -> dict[str, Any]:
    candidate = db.execute(
        "SELECT * FROM discovery_candidates WHERE id=? AND state='pending'", (intent["candidate"],)
    ).fetchone()
    if not candidate:
        raise ReplicaError("Discovery candidate changed; run Update and review again")
    body = json.loads(candidate["body"])
    files = body["files"]
    if intent.get("files") is not None:
        by_id = {f["id"]: f for f in files}
        chosen = intent["files"]
        if len(chosen) != len(set(chosen)) or not set(chosen) <= by_id.keys():
            raise ReplicaError("Review files must come from the displayed candidate")
        files = [by_id[identity] for identity in chosen]
    if not files:
        raise ReplicaError("Choose at least one file per review")
    for file in files:
        if sources.inspect(root, file["path"])["generation"] != file["generation"]:
            raise ReplicaError("Local files changed; run Update before reviewing")
    if intent.get("verification"):
        from cairndex.replicas.discovery_verification import verified_file

        verified = db.execute(
            "SELECT candidate,state FROM discovery_verifications WHERE id=?",
            (intent["verification"],),
        ).fetchone()
        if not verified or tuple(verified) != (intent["candidate"], "succeeded"):
            raise ReplicaError("Complete the selected content verification before preparing")
        files = [verified_file(db, root, file) for file in files]
        if body["kind"] == "new":
            files = [
                file
                | {
                    "id": sources.file_id(
                        store.descriptor.library_uuid, store.descriptor.epoch, file
                    )
                }
                for file in files
            ]
    builder = Preview(store, db)
    if body["kind"] == "repair":
        selected_choice = db.execute(
            "SELECT body FROM discovery_candidate_choices WHERE candidate=? AND file_id=?",
            (intent["candidate"], intent.get("repair_file")),
        ).fetchone()
        old = (
            json.loads(selected_choice[0])
            if selected_choice
            else next(
                (
                    choice
                    for choice in body["choices"]
                    if choice["file_id"] == intent.get("repair_file")
                ),
                None,
            )
        )
        if (
            not old
            or not sources.absent(root, old["path"])
            or old["evidence"] != files[0]["evidence"]
        ):
            raise ReplicaError("Choose a still-missing identity with matching content evidence")
        from cairndex.replicas.discovery import current_path

        if not current_path(store, db, old["file_id"], old["basis"]):
            raise ReplicaError("The missing file location changed; review it again")
        if {
            tip["event"] for tip in store.tips(db, key("asset_files", old["file_id"], "$content"))
        } != set(old["content_basis"]):
            raise ReplicaError("The missing file content choice changed; review it again")
        builder.put(key("asset_files", old["file_id"], "relative_path"), files[0]["path"])
        builder.put(key("asset_files", old["file_id"], "$content"), files[0]["evidence"])
        files = [files[0] | {"id": old["file_id"]}]
    elif body["kind"] in ("replacement", "verification"):
        if body["kind"] == "verification" and (
            not intent.get("verification") or files[0]["evidence"] != body["expected"]
        ):
            raise ReplicaError(
                "Verify this local copy completely; different bytes need a new replacement review"
            )
        if body["kind"] == "replacement" and not intent.get("use_replacement"):
            raise ReplicaError(
                "Explicitly choose replacement bytes or leave this candidate pending"
            )
        identity = body["file_id"]
        if "basis" in body and any(
            set(body[basis])
            != {tip["event"] for tip in store.tips(db, key("asset_files", identity, field))}
            for field, basis in (("relative_path", "basis"), ("$content", "content_basis"))
        ):
            raise ReplicaError(
                "The catalog identity changed; run Update and review its current choice"
            )
        row = read_row(db, "asset_files", identity)
        if not row or row["relative_path"] != files[0]["path"]:
            raise ReplicaError("The replacement target moved; review its current location")
        builder.put(key("asset_files", identity, "relative_path"), files[0]["path"])
        builder.put(key("asset_files", identity, "$content"), files[0]["evidence"])
    else:
        title = intent.get("title", body["title"])
        if not isinstance(title, str) or not title.strip() or len(title) > 512:
            raise ReplicaError("A bundle title is required")
        target = intent.get("target", body["target"])
        stamp = (
            datetime.fromtimestamp(min(f["mtime"] for f in files) / 1_000_000_000, UTC)
            .replace(tzinfo=None)
            .isoformat(sep=" ")
        )
        if target:
            bundle = read_row(db, "asset_bundles", target)
            if not bundle:
                raise ReplicaError("The target bundle is unavailable; review another destination")
        else:
            target = sources.stable_id(["group", sorted(f["id"] for f in files)])
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
        member_key = key("asset_bundles", target, "$members")
        sequence = max((m["sequence"] for m in builder.get(member_key)), default=-1) + 1
        for index, file in enumerate(files):
            owner = db.execute(
                (
                    "SELECT owner FROM catalog_unique_values WHERE "
                    "namespace='asset_files/relative_path' AND value=?"
                ),
                (value_text([file["path"]]),),
            ).fetchone()
            if owner:
                raise ReplicaError(
                    "This path is already cataloged; run Update to reconcile its identity"
                )
            builder.create(
                "asset_files",
                defaults(
                    "asset_files",
                    id=file["id"],
                    bundle_id=target,
                    relative_path=file["path"],
                    original_filename=Path(file["path"]).name,
                    role=file.get("role", "OTHER"),
                    sequence=sequence + index,
                    created_at=stamp,
                    updated_at=stamp,
                ),
            )
            builder.put(key("asset_files", file["id"], "$content"), file["evidence"])
        # Existing covers and subtitle choices remain authored; only fresh groups gain a suggestion
        if not intent.get("target", body["target"]):
            cover = next((f for f in files if f.get("role") == "COVER"), None)
            if cover:
                builder.put(key("asset_bundles", target, "cover_file_id"), cover["id"])
        add_subtitles(builder, target, files, stamp)
    receipt = builder.receipt()
    validate_preview(store, db, receipt)
    return {
        "catalog": receipt,
        "files": files,
        "candidate": intent["candidate"],
        "kind": body["kind"],
        "old": old if body["kind"] == "repair" else None,
        "title": intent.get("title", body["title"]),
        "target": intent.get("target", body["target"]),
    }


# New subtitle sidecars attach only when the selected group has a unique video target
def add_subtitles(builder: Preview, target: str, files: list[dict[str, Any]], stamp: str) -> None:
    videos = [f for f in files if media_kind(f["path"]).value == "video"]
    if not videos:
        for member in builder.get(key("asset_bundles", target, "$members")):
            row = read_row(builder.db, member["family"], member["id"])
            if (
                member["family"] == "asset_files"
                and row
                and classify(row["relative_path"])
                and media_kind(row["relative_path"]).value == "video"
            ):
                videos.append({"id": row["id"], "path": row["relative_path"]})
    if len(videos) != 1:
        return
    for file in files:
        suffix = Path(file["path"]).suffix.lower()
        if suffix not in (".srt", ".vtt"):
            continue
        builder.create(
            "subtitle_tracks",
            defaults(
                "subtitle_tracks",
                id=sources.stable_id(["track", target, file["id"]]),
                bundle_id=target,
                video_file_id=videos[0]["id"],
                source_file_id=file["id"],
                embedded_index=None,
                format=suffix[1:],
                created_at=stamp,
                updated_at=stamp,
            ),
        )


# A retry validates the original preview and never silently recaptures newer authored bases
def revalidate(root: Path, prepared: dict[str, Any]) -> None:
    for file in prepared["files"]:
        if sources.inspect(root, file["path"])["generation"] != file["generation"]:
            raise ReplicaError("Files changed after review; run Update and prepare again")
    if prepared["old"] and not sources.absent(root, prepared["old"]["path"]):
        raise ReplicaError("The original file is present again; review the copy separately")


# Private and authored receipts commit together, including retries after a lost acknowledgement
def apply(
    store: CatalogStore,
    db: sqlite3.Connection,
    root: Path,
    operation: str,
    prepared: dict[str, Any],
) -> str:
    revalidate(root, prepared)
    receipt = prepared["catalog"]
    event = store.save_in(
        db,
        [UnitChange.model_validate(c) for c in receipt["changes"]],
        "discover_" + checksum(operation.encode())[:50],
        **{name: receipt[name] for name in ("parents", "resolve", "recover")},
    )
    from cairndex.replicas.discovery import baseline, repaired_local_state

    for file in prepared["files"]:
        if prepared["old"]:
            repaired_local_state(db, file["id"], prepared["old"], file)
        else:
            baseline(db, file["id"], file)
    db.execute(
        "UPDATE discovery_candidates SET state='accepted' WHERE id=?", (prepared["candidate"],)
    )
    db.execute(
        "UPDATE discovery_reviews SET state='applied',event=?,error=NULL WHERE id=?",
        (event, operation),
    )
    return event


# The existing worker advances one bounded prepare/apply, while HTTP handlers only enqueue intent
def tick(store: CatalogStore, root: Path) -> None:
    deadline = time.monotonic() + 0.05
    for _ in range(32):
        if not step(store, root) or time.monotonic() >= deadline:
            return


# Each persisted phase commits independently; only acceptance authors complete catalog changes
def step(store: CatalogStore, root: Path) -> bool:
    capable(store)
    with store.connection() as db:
        row = db.execute(
            "SELECT * FROM discovery_reviews WHERE state IN "
            "('queued','apply_queued') ORDER BY id LIMIT 1"
        ).fetchone()
        if not row:
            return False
        db.execute("SAVEPOINT discovery_review")
        try:
            candidate = db.execute(
                "SELECT body FROM discovery_candidates WHERE id=?",
                (json.loads(row["intent"])["candidate"],),
            ).fetchone()
            normalized = candidate and json.loads(candidate[0]).get("version") == 2
            if normalized:
                from cairndex.replicas.discovery_commit import revalidate as revalidate_large
                from cairndex.replicas.discovery_prepare import step as prepare_large
                from cairndex.replicas.discovery_preview import DiscoveryPreview

                if row["prepared"]:
                    revalidate_large(
                        DiscoveryPreview(store, db, row["id"]),
                        root,
                        apply=row["state"] == "apply_queued",
                    )
                else:
                    prepare_large(store, db, root, row)
            elif row["state"] == "queued":
                prepared = (
                    json.loads(row["prepared"])
                    if row["prepared"]
                    else build(store, db, root, json.loads(row["intent"]))
                )
                revalidate(root, prepared)
                validate_preview(store, db, prepared["catalog"])
                db.execute(
                    "UPDATE discovery_reviews SET state='ready',prepared=?,error=NULL WHERE id=?",
                    (value_text(prepared), row["id"]),
                )
            else:
                apply(store, db, root, row["id"], json.loads(row["prepared"]))
            store.fault("discovery_before_commit")
            db.execute("RELEASE discovery_review")
        except (OSError, ValueError, DomainError) as error:
            db.execute("ROLLBACK TO discovery_review")
            db.execute("RELEASE discovery_review")
            db.execute(
                "UPDATE discovery_reviews SET state='failed',error=? WHERE id=?",
                (
                    error.message
                    if isinstance(error, DomainError)
                    else "A reviewed file is unavailable or changed; run Update and prepare again",
                    row["id"],
                ),
            )
        return True
