"""Explicit background reconstruction of retained causal branches into private recovery copies"""

import json
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

from cairndex.replicas.catalog.commands import Preview, validate_preview
from cairndex.replicas.catalog.model import PLACEMENT, key
from cairndex.replicas.catalog.projection import read_row, references
from cairndex.replicas.catalog.protocol import Root, decode
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError


# Only an explicit recovery job reconstructs ancestry; ordinary reads and saves use indexes
def reconstruct(store: CatalogStore, event: str) -> CatalogStore:
    directory = Path(tempfile.mkdtemp(prefix="recovery-", dir=store.path.parent)).resolve()
    branch = CatalogStore(directory, store.descriptor)
    with store.connection() as source:
        roots = source.execute(
            "WITH RECURSIVE ancestry(id) AS (SELECT ? UNION SELECT p.parent FROM "
            "catalog_parents p JOIN ancestry a ON p.child=a.id) "
            "SELECT e.id,e.raw FROM ancestry a JOIN events e ON e.id=a.id",
            (event,),
        ).fetchall()
        if not roots or not any(row["id"] == store.descriptor.genesis for row in roots):
            raise ReplicaError("Recovery branch is missing its complete seed ancestry")
        for row in roots:
            _, root = decode(row["raw"], store.descriptor)
            if not isinstance(root, Root):
                raise ReplicaError("Recovery selection must name an authored catalog event")
            tail: str | None = root.last
            while tail is not None:
                part = source.execute(
                    "SELECT p.previous,e.raw FROM catalog_parts p JOIN events e "
                    "ON e.id=p.id WHERE p.id=?",
                    (tail,),
                ).fetchone()
                if part is None:
                    raise ReplicaError("Recovery payload is incomplete")
                branch.ingest(part["raw"])
                tail = part["previous"]
            branch.ingest(row["raw"])
    with branch.connection() as db:
        count = db.execute("SELECT COUNT(*) FROM inbox").fetchone()[0]
    for _ in range(count + 1):
        branch.import_batch()
        state = branch.status()
        if state["blocked"]:
            raise ReplicaError("Retained branch requires upgrade or recovery review")
        if state["ready"] and not state["waiting"]:
            return branch
    raise ReplicaError("Retained branch is waiting for causal dependencies")


# Restore the chosen stable identity and necessary relationships into a reviewable scoped preview
def recover_preview(store: CatalogStore, event: str, family: str, identity: str) -> dict[str, Any]:
    branch = reconstruct(store, event)
    with branch.connection() as prior, store.connection() as current:
        builder = Preview(store, current)
        pending = [(family, identity, True)]
        included: set[tuple[str, str]] = set()
        placement_only: set[tuple[str, str]] = set()
        while pending:
            target_family, target_id, explicit = pending.pop()
            if (target_family, target_id) in included:
                continue
            included.add((target_family, target_id))
            selected = read_row(prior, target_family, target_id)
            if selected is None:
                raise ReplicaError("The selected branch does not contain a live recovery target")
            present = read_row(current, target_family, target_id)
            if not explicit and present is not None:
                continue
            if prior.execute(
                "SELECT 1 FROM catalog_units u JOIN catalog_holds h ON h.unit=u.unit "
                "WHERE u.family=? AND u.entity=? LIMIT 1",
                (target_family, target_id),
            ).fetchone():
                raise ReplicaError(
                    "Selected branch has unresolved alternatives; choose a resolved version"
                )
            if (target_family, target_id) not in placement_only:
                for unit, raw in prior.execute(
                    "SELECT unit,value FROM catalog_units WHERE family=? AND entity=?",
                    (target_family, target_id),
                ):
                    builder.values[unit] = raw
            if target_family == "collections" and selected["cover_bundle_id"]:
                recover_cover_membership(prior, current, selected, pending, placement_only)
            for reference in references(target_family, selected):
                ref_family, ref_id = reference.split("/", 1)
                pending.append((ref_family, ref_id, False))
            if target_family in ("asset_files", "bundle_directory_members"):
                old_place = current.execute(
                    "SELECT body FROM catalog_placements WHERE family=? AND entity=?",
                    (target_family, target_id),
                ).fetchone()
                if old_place:
                    old_bundle = json.loads(old_place[0])["bundle_id"]
                    old_unit = key("asset_bundles", old_bundle, "$members")
                    if old_bundle != selected["bundle_id"] and target_family == "asset_files":
                        recover_file_dependents(builder, selected, pending, placement_only)
                        for field in ("cover_file_id", "primary_file_id"):
                            unit = key("asset_bundles", old_bundle, field)
                            if builder.get(unit) == target_id:
                                builder.put(unit, None)
                    builder.put(
                        old_unit,
                        [
                            item
                            for item in builder.get(old_unit)
                            if (item["family"], item["id"]) != (target_family, target_id)
                        ],
                    )
                new_unit = key("asset_bundles", selected["bundle_id"], "$members")
                if current.execute(
                    "SELECT 1 FROM catalog_units WHERE unit=?", (new_unit,)
                ).fetchone():
                    members = builder.get(new_unit)
                else:
                    members = []
                member = {
                    "id": target_id,
                    "family": target_family,
                    "sequence": selected["sequence"],
                }
                if target_family == "asset_files":
                    member["role"] = selected["role"]
                builder.put(
                    new_unit,
                    [
                        item
                        for item in members
                        if (item["family"], item["id"]) != (target_family, target_id)
                    ]
                    + [member],
                )
            if target_family in ("tags", "collections"):
                forest = key(target_family, "_", "$forest")
                builder.put(
                    forest,
                    [item for item in builder.get(forest) if item["id"] != target_id]
                    + [{column: selected[column] for column in ("id", *PLACEMENT[target_family])}],
                )
            if target_family == "asset_bundles":
                members = builder.get(key(target_family, target_id, "$members"))
                pending.extend((item["family"], item["id"], True) for item in members)
            # Recover relationships removed by a cascade, while preserving independently live rows
            for (source,) in prior.execute(
                "SELECT source FROM catalog_references WHERE target=?",
                (f"{target_family}/{target_id}",),
            ):
                source_family, source_id = source.split("/", 1)
                if read_row(current, source_family, source_id) is None:
                    pending.append((source_family, source_id, False))
        scope = store.scope(current, builder.values)
        for unit in scope - set(builder.values):
            tips = store.tips(current, unit)
            if len({tip["value"] for tip in tips}) > 1:
                original = prior.execute(
                    "SELECT value FROM catalog_units WHERE unit=?", (unit,)
                ).fetchone()
                if original is None or original[0] is None:
                    raise ReplicaError("Recovery requires an additional explicit structural choice")
                builder.values[unit] = original[0]
            else:
                saved = current.execute(
                    "SELECT value FROM catalog_units WHERE unit=?", (unit,)
                ).fetchone()
                if saved and saved[0] is not None:
                    builder.values[unit] = saved[0]
        receipt = builder.receipt(resolve=True, recover=True)
        validate_preview(store, current, receipt)
        return receipt


# Moving a recovered file repairs live span/source ownership without reverting scalar edits
def recover_file_dependents(
    builder: Preview,
    selected: dict[str, Any],
    pending: list[tuple[str, str, bool]],
    placement_only: set[tuple[str, str]],
) -> None:
    for (source,) in builder.db.execute(
        "SELECT source FROM catalog_references WHERE target=?", (f"asset_files/{selected['id']}",)
    ):
        family, identity = source.split("/", 1)
        if family not in ("moments", "subtitle_tracks"):
            continue
        live = read_row(builder.db, family, identity)
        if live is None:
            continue
        live["bundle_id"] = selected["bundle_id"]
        builder.row(family, live)
        if family == "subtitle_tracks":
            for column in ("video_file_id", "source_file_id"):
                file_id = live[column]
                related = read_row(builder.db, "asset_files", file_id) if file_id else None
                if (
                    related
                    and related["bundle_id"] != selected["bundle_id"]
                    and file_id != selected["id"]
                ):
                    placement_only.add(("asset_files", file_id))
                    pending.append(("asset_files", file_id, True))


# A retained ancestor cover recovers a supporting membership and only its necessary parent path
def recover_cover_membership(
    prior: sqlite3.Connection,
    current: sqlite3.Connection,
    selected: dict[str, Any],
    pending: list[tuple[str, str, bool]],
    placement_only: set[tuple[str, str]],
) -> None:
    from cairndex.replicas.catalog.projection import validate_collection_cover

    try:
        validate_collection_cover(current, selected["id"], selected["cover_bundle_id"])
        return
    except ReplicaError:
        pass
    for (source,) in prior.execute(
        "SELECT source FROM catalog_references WHERE target=? ORDER BY source",
        (f"asset_bundles/{selected['cover_bundle_id']}",),
    ):
        family, identity = source.split("/", 1)
        if family != "asset_bundle_collections":
            continue
        parent = identity.split("~", 1)[1]
        chain = []
        while parent is not None and parent != selected["id"]:
            chain.append(parent)
            row = read_row(prior, "collections", parent)
            parent = row["parent_id"] if row else None
        if parent == selected["id"]:
            pending.append((family, identity, False))
            for collection in chain:
                if read_row(current, "collections", collection) is not None:
                    placement_only.add(("collections", collection))
                pending.append(("collections", collection, True))
            return
    raise ReplicaError("Retained cover has no recoverable collection membership")
