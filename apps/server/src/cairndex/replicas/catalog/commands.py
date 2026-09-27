"""Reviewable catalog operations with complete transfers, cascades and observed draft bases"""

import json
import sqlite3
from collections.abc import MutableMapping
from typing import Any

from cairndex.persistence.base import Base
from cairndex.replicas.catalog.model import (
    AUTHORED,
    PLACEMENT,
    Row,
    key,
    row_units,
    split_key,
    value_text,
)
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.catalog.protocol import UnitChange
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError


# Background previews capture all affected values before the user submits an explicit save
class Preview:
    # A private writer transaction gives the complete preview one consistent observed basis
    def __init__(self, store: CatalogStore, db: sqlite3.Connection) -> None:
        self.store, self.db = store, db
        self.values: MutableMapping[str, str] = {}

    # Stage a complete unit while keeping its original observed revisions for the receipt
    def put(self, unit: str, value: Any) -> None:
        split_key(unit)
        self.values[unit] = value_text(value)

    # Read staged arrangements first so a cascade can update one membership repeatedly
    def get(self, unit: str) -> Any:
        if unit in self.values:
            return json.loads(self.values[unit])
        row = self.db.execute("SELECT value FROM catalog_units WHERE unit=?", (unit,)).fetchone()
        if row is None or row[0] is None:
            raise ReplicaError("Catalog arrangement is unavailable")
        return json.loads(row[0])

    # Independent unchanged fields remain outside a structural choice
    def row(self, family: str, row: Row) -> None:
        for unit, raw in row_units(family, row):
            prior = self.db.execute(
                "SELECT value FROM catalog_units WHERE unit=?", (unit,)
            ).fetchone()
            if prior is None or prior[0] != raw:
                self.values[unit] = raw

    # Delete references according to the current catalog schema, retaining all tombstoned values
    def delete(self, family: str, identity: str) -> None:
        pending = [(family, identity)]
        deleted: set[tuple[str, str]] = set()
        while pending:
            current_family, current_id = pending.pop()
            if (current_family, current_id) in deleted:
                continue
            deleted.add((current_family, current_id))
            row = read_row(self.db, current_family, current_id)
            if row is None:
                raise ReplicaError("Deletion target is already absent")
            self.put(key(current_family, current_id, "$alive"), False)
            if current_family == "asset_bundles":
                self.put(key(current_family, current_id, "$members"), [])
            if current_family in ("asset_files", "bundle_directory_members"):
                membership = key("asset_bundles", row["bundle_id"], "$members")
                self.put(
                    membership,
                    [
                        item
                        for item in self.get(membership)
                        if (item["family"], item["id"]) != (current_family, current_id)
                    ],
                )
            if current_family in ("tags", "collections"):
                forest = key(current_family, "_", "$forest")
                items = self.get(forest)
                for item in items:
                    if item["parent_id"] == current_id:
                        item["parent_id"] = row["parent_id"]
                self.put(forest, [item for item in items if item["id"] != current_id])
            sources = self.db.execute(
                "SELECT source FROM catalog_references WHERE target=?",
                (f"{current_family}/{current_id}",),
            ).fetchall()
            for (source,) in sources:
                source_family, source_id = source.split("/", 1)
                source_row = read_row(self.db, source_family, source_id)
                if source_row is None or (source_family, source_id) in deleted:
                    continue
                cascade = False
                for column in Base.metadata.tables[source_family].columns:
                    for foreign in column.foreign_keys:
                        if (
                            foreign.column.table.name != current_family
                            or source_row[column.name] != current_id
                        ):
                            continue
                        if foreign.ondelete == "CASCADE" or source_family == "subtitle_tracks":
                            cascade = True
                        elif column.name not in PLACEMENT.get(source_family, ()):
                            source_row[column.name] = None
                if cascade:
                    pending.append((source_family, source_id))
                else:
                    self.row(source_family, source_row)
        self.clear_removed_covers(deleted)
        # Values belonging to a deleted entity remain retained, rather than becoming edits to it
        for unit in list(self.values):
            unit_family, unit_id, field = split_key(unit)
            if (unit_family, unit_id) in deleted and field not in ("$alive", "$members"):
                del self.values[unit]

    # Deletion previews include covers invalidated by removing the last membership in a tree
    def clear_removed_covers(self, deleted: set[tuple[str, str]]) -> None:
        bundles = {
            identity.split("~", 1)[0]
            for family, identity in deleted
            if family == "asset_bundle_collections"
        }
        if not bundles:
            return
        parents = {item["id"]: item["parent_id"] for item in self.get("collections/_/$forest")}
        for bundle in bundles:
            covered = set()
            covers = []
            for (source,) in self.db.execute(
                "SELECT source FROM catalog_references WHERE target=?", (f"asset_bundles/{bundle}",)
            ):
                family, identity = source.split("/", 1)
                if (family, identity) in deleted:
                    continue
                if family == "collections":
                    covers.append(identity)
                elif family == "asset_bundle_collections":
                    parent = identity.split("~", 1)[1]
                    while parent is not None:
                        covered.add(parent)
                        parent = parents.get(parent)
            for collection in set(covers) - covered:
                self.put(key("collections", collection, "cover_bundle_id"), None)

    # Cross-bundle transfers include dependent moments, subtitle sources and source cover clearing
    def transfer(self, source: str, target: str, members: list[str]) -> None:
        if source == target or not members or len(members) != len(set(members)):
            raise ReplicaError("Transfer requires distinct bundles and selected members")
        source_key, target_key = (
            key("asset_bundles", identity, "$members") for identity in (source, target)
        )
        origin, destination = self.get(source_key), self.get(target_key)
        selected = [item for item in origin if f"{item['family']}/{item['id']}" in members]
        if len(selected) != len(members):
            raise ReplicaError("Transfer selection no longer belongs to the source bundle")
        moved_files = {item["id"] for item in selected if item["family"] == "asset_files"}
        for item in selected:
            if item["family"] == "bundle_directory_members":
                directory = read_row(self.db, item["family"], item["id"])
                if directory:
                    for member in origin:
                        file = read_row(self.db, member["family"], member["id"])
                        if (
                            member["family"] == "asset_files"
                            and file
                            and (
                                file["relative_path"].startswith(directory["directory_path"] + "/")
                            )
                            and member["id"] not in moved_files
                        ):
                            selected.append(member)
                            moved_files.add(member["id"])
        selected_ids = {(item["family"], item["id"]) for item in selected}
        self.put(
            source_key,
            [item for item in origin if (item["family"], item["id"]) not in selected_ids],
        )
        sequence = max((item["sequence"] for item in destination), default=-1) + 1
        self.put(
            target_key,
            destination
            + [item | {"sequence": sequence + index} for index, item in enumerate(selected)],
        )
        for field in ("cover_file_id", "primary_file_id"):
            unit = key("asset_bundles", source, field)
            if self.get(unit) in moved_files:
                self.put(unit, None)
        dependents = {
            row[0]
            for identity in moved_files
            for row in self.db.execute(
                "SELECT source FROM catalog_references WHERE target=?", (f"asset_files/{identity}",)
            )
        }
        for owner in dependents:
            family, identity = owner.split("/", 1)
            row = read_row(self.db, family, identity)
            if row is None or family not in ("moments", "subtitle_tracks"):
                continue
            if family == "subtitle_tracks" and any(
                row[field] and row[field] not in moved_files
                for field in ("video_file_id", "source_file_id")
            ):
                raise ReplicaError(
                    "Transfer must include every file used by the subtitle selection"
                )
            row["bundle_id"] = target
            self.row(family, row)

    # Creation requires every authored field plus an explicit complete placement when applicable
    def create(self, family: str, row: Row) -> None:
        if family not in AUTHORED:
            raise ReplicaError("Unsupported catalog family")
        from cairndex.replicas.catalog.model import entity_id

        identity = entity_id(family, row)
        if self.db.execute(
            "SELECT 1 FROM catalog_units WHERE family=? AND entity=? LIMIT 1",
            (family, identity),
        ).fetchone():
            raise ReplicaError("Catalog identity already exists; edit or explicitly recover it")
        self.row(family, row)
        if family == "asset_bundles":
            self.put(key(family, row["id"], "$members"), [])
        elif family in ("asset_files", "bundle_directory_members"):
            unit = key("asset_bundles", row["bundle_id"], "$members")
            member = {"family": family, "id": row["id"], "sequence": row["sequence"]}
            if family == "asset_files":
                member["role"] = row["role"]
            self.put(unit, self.get(unit) + [member])
        elif family in ("tags", "collections"):
            unit = key(family, "_", "$forest")
            self.put(
                unit,
                self.get(unit)
                + [{field: row[field] for field in ("id", "parent_id", "sort_order")}],
            )

    def membership(self, command: dict[str, Any]) -> bool:
        """Prepare one explicit edge change; retain cascades and refuse stale choices."""
        from cairndex.replicas.catalog.inspector import EDGES

        family = command["family"]
        if family not in EDGES or type(command.get("assigned")) is not bool:
            raise ReplicaError("Unsupported membership choice")
        bundle, target = command["bundle"], command["target"]
        edge = EDGES[family]
        identity = f"{bundle}~{target}"
        unit = key(edge, identity, "$alive")
        expected = {
            unit,
            key("asset_bundles", bundle, "$alive"),
            key(family, target, "$alive"),
        }
        observed = command["observed"]
        if set(observed) != expected or any(
            set(observed[item]) != {tip["event"] for tip in self.store.tips(self.db, item)}
            or self.db.execute("SELECT 1 FROM catalog_holds WHERE unit=?", (item,)).fetchone()
            for item in expected
        ):
            raise ReplicaError("Membership changed or requires conflict review; refresh choices")
        if (
            read_row(self.db, "asset_bundles", bundle) is None
            or read_row(self.db, family, target) is None
        ):
            raise ReplicaError("Membership target is unavailable")
        existing = self.db.execute(
            "SELECT value FROM catalog_units WHERE unit=?", (unit,)
        ).fetchone()
        if not command["assigned"]:
            if not existing or existing[0] != "true":
                raise ReplicaError("Membership is already absent; refresh choices")
            self.delete(edge, identity)
            return False
        if existing:
            if existing[0] != "false":
                raise ReplicaError("Membership is already present; refresh choices")
            # Explicit Add restores only this stable pair, never either referenced object.
            self.put(unit, True)
            return True
        row = {"bundle_id": bundle, "tag_id" if family == "tags" else "collection_id": target}
        if family == "collections":
            row["sort_order"] = 0
        self.create(edge, row)
        return False

    # Conflict choices always show the full dependency scope and preserve rejected branches
    def choose(self, unit: str, choices: dict[str, str], observed: dict[str, list[str]]) -> None:
        scope = self.store.scope(self.db, [unit])
        if set(observed) != scope or any(
            set(observed[target]) != {tip["event"] for tip in self.store.tips(self.db, target)}
            for target in scope
        ):
            raise ReplicaError("Conflict review is stale; review the current alternatives")
        if not set(choices).issubset(scope):
            raise ReplicaError("Choice includes an unrelated conflict unit")
        for target in scope:
            if target in choices:
                self.values[target] = choices[target]
                continue
            tips = self.store.tips(self.db, target)
            current = self.db.execute(
                "SELECT value FROM catalog_units WHERE unit=?", (target,)
            ).fetchone()
            if len({tip["value"] for tip in tips}) > 1 or current is None or current[0] is None:
                raise ReplicaError(
                    "Choose every conflicting value in the complete structural scope"
                )
            self.values[target] = current[0]

    # Preview values capture mandatory guards and bases; the later save never invents them
    def receipt(self, *, resolve: bool = False, recover: bool = False) -> dict[str, Any]:
        values = dict(self.values)
        for unit, raw in list(values.items()):
            for guard in self.store.required_guards(self.db, unit, raw):
                if values.get(guard) == "false" and unit.endswith("/$members") and raw == "[]":
                    continue
                values.setdefault(guard, "true")
        changes = [
            UnitChange(
                unit=unit,
                value=raw,
                basis=[tip["event"] for tip in self.store.tips(self.db, unit)],
                cohort="domain" if unit in self.values else None,
            )
            for unit, raw in sorted(values.items())
        ]
        return {
            "changes": [change.model_dump() for change in changes],
            "resolve": resolve,
            "recover": recover,
            "parents": [
                row[0]
                for row in self.db.execute("SELECT event FROM catalog_frontier ORDER BY event")
            ],
        }


# Operations are built in background jobs; the HTTP route only queues their bounded command
def preview(store: CatalogStore, command: dict[str, Any]) -> dict[str, Any]:
    with store.connection() as db:
        builder = Preview(store, db)
        action = command.get("action")
        recover = command.get("recover", False)
        if action == "membership":
            recover = builder.membership(command)
        elif action == "delete":
            builder.delete(command["family"], command["entity"])
        elif action == "transfer":
            builder.transfer(command["source"], command["target"], command["members"])
        elif action == "create":
            row = command.get("row")
            if row is None:
                row = {column: json.loads(raw) for column, raw in command["cells"].items()}
            builder.create(command["family"], row)
        elif action == "reorder":
            unit = command["unit"]
            _, _, field = split_key(unit)
            if field not in ("$members", "$forest"):
                raise ReplicaError("Reorder requires a complete arrangement")
            items = builder.get(unit)
            selected = next((item for item in items if item["id"] == command["entity"]), None)
            if selected is None:
                raise ReplicaError("Reorder target is unavailable")
            old = items.index(selected)
            new = max(0, min(len(items) - 1, old + int(command.get("offset", 0))))
            items.insert(new, items.pop(old))
            if field == "$forest" and "parent" in command:
                selected["parent_id"] = command["parent"]
            for index, item in enumerate(items):
                item["sequence" if field == "$members" else "sort_order"] = index
            builder.put(unit, items)
        elif action == "arrange":
            family, _, field = split_key(command["unit"])
            if field not in ("$forest", "$members"):
                raise ReplicaError("Arrangement requires a complete membership or hierarchy")
            builder.put(command["unit"], command["value"])
        elif action == "choose":
            builder.choose(command["unit"], command["choices"], command["observed"])
        else:
            raise ReplicaError("Unsupported catalog command")
        receipt = builder.receipt(resolve=action == "choose", recover=recover)
        validate_preview(store, db, receipt)
        return receipt


# A preview validates the complete operation transactionally before it can be approved
def validate_preview(store: CatalogStore, db: sqlite3.Connection, receipt: dict[str, Any]) -> None:
    from uuid import uuid4

    from cairndex.replicas.catalog.protocol import decode, payload

    db.execute("SAVEPOINT reviewed_preview")
    try:
        for identity, raw in payload(
            [UnitChange.model_validate(change) for change in receipt["changes"]],
            library=store.descriptor.library_uuid,
            epoch=store.descriptor.epoch,
            replica="preview",
            operation=uuid4().hex,
            parents=receipt["parents"],
            resolve=receipt["resolve"],
            recover=receipt["recover"],
        ):
            _, body = decode(raw, store.descriptor)
            if store.accept(db, identity, body, raw, local=True) == "pending":
                raise ReplicaError("Preview dependencies are unavailable")
    finally:
        db.execute("ROLLBACK TO reviewed_preview")
        db.execute("RELEASE reviewed_preview")
