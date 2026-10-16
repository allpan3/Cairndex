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
        # Rows a transfer moved to another bundle; their stored references are stale
        self.rehomed: set[tuple[str, str]] = set()

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
                if current_family == "asset_bundles" and (source_family, source_id) in self.rehomed:
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
        self.rehomed.update(("asset_files", identity) for identity in moved_files)
        self.rehomed.update(
            (item["family"], item["id"])
            for item in selected
            if item["family"] == "bundle_directory_members"
        )
        for owner in dependents:
            family, identity = owner.split("/", 1)
            row = read_row(self.db, family, identity)
            if row is None or family not in ("moments", "subtitle_tracks"):
                continue
            if self.values.get(key(family, identity, "$alive")) == "false":
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
            self.rehomed.add((family, identity))

    def order(self, command: dict[str, Any]) -> None:
        """Rewrite one scope's manual order: a moved block, or a chosen sort.

        The move is resolved against the complete scope, never the client's loaded
        page, and only positions that change are written, as in the legacy browser.
        A collection orders its own memberships; without one, the order is global.
        """
        from cairndex.replicas.catalog.browse import scope_order

        collection = command.get("collection")
        if collection is not None and read_row(self.db, "collections", collection) is None:
            raise ReplicaError("Reorder target is unavailable")
        if "moved" in command:
            ids = scope_order(self.db, collection, "manual", "asc")
            moved = set(command["moved"])
            moving = [identity for identity in ids if identity in moved]
            before = command.get("before")
            if len(moving) != len(moved) or before in moved:
                raise ReplicaError("Reorder selection changed; refresh the bundles")
            rest = [identity for identity in ids if identity not in moved]
            at = rest.index(before) if before in rest else len(rest)
            ids = rest[:at] + moving + rest[at:]
        else:
            sort = command["sort"]
            if sort not in ("title", "rating", "date_added", "file_count"):
                raise ReplicaError("Unsupported clean-up order")
            ids = scope_order(self.db, collection, sort, "desc" if command["descending"] else "asc")
        for position, identity in enumerate(ids):
            unit = (
                key("asset_bundle_collections", f"{identity}~{collection}", "sort_order")
                if collection
                else key("asset_bundles", identity, "manual_order")
            )
            if self.db.execute("SELECT 1 FROM catalog_holds WHERE unit=?", (unit,)).fetchone():
                raise ReplicaError("The manual order needs metadata review first")
            current = self.db.execute(
                "SELECT value FROM catalog_units WHERE unit=?", (unit,)
            ).fetchone()
            if current is None or current[0] != value_text(position):
                self.put(unit, position)
        if not self.values:
            raise ReplicaError("The bundles are already in this order")

    def delete_tree(self, family: str, identity: str) -> None:
        """Delete a tag or collection with every descendant, as the legacy tag delete did.

        Descendants go first, deepest first, so no child is moved up to a parent
        that the same preview deletes.
        """
        if family not in ("tags", "collections"):
            raise ReplicaError("Only a tag or collection hierarchy can be deleted as a tree")
        children: dict[str | None, list[str]] = {}
        for item in self.get(key(family, "_", "$forest")):
            children.setdefault(item["parent_id"], []).append(item["id"])
        order: list[str] = []
        pending = [identity]
        while pending:
            current = pending.pop()
            order.append(current)
            pending.extend(children.get(current, []))
        for current in reversed(order):
            self.delete(family, current)

    def group_tag(self, command: dict[str, Any]) -> bool:
        """Add a tag to a tag group, restoring a deleted membership, or remove it.

        Returns whether the save restores a tombstone, which needs explicit recovery.
        """
        group, tag, assigned = command["group"], command["tag"], command["assigned"]
        if type(assigned) is not bool:
            raise ReplicaError("Unsupported membership choice")
        if read_row(self.db, "tag_groups", group) is None or read_row(self.db, "tags", tag) is None:
            raise ReplicaError("Membership target is unavailable")
        identity = f"{group}~{tag}"
        unit = key("tag_group_memberships", identity, "$alive")
        if self.db.execute("SELECT 1 FROM catalog_holds WHERE unit=?", (unit,)).fetchone():
            raise ReplicaError("Membership changed or requires conflict review; refresh choices")
        existing = self.db.execute(
            "SELECT value FROM catalog_units WHERE unit=?", (unit,)
        ).fetchone()
        if not assigned:
            if not existing or existing[0] != "true":
                raise ReplicaError("Membership is already absent; refresh choices")
            self.delete("tag_group_memberships", identity)
        elif existing and existing[0] == "true":
            raise ReplicaError("Membership is already present; refresh choices")
        elif existing:
            # Explicit Add restores only this stable pair, as a bundle membership does
            self.put(unit, True)
            return True
        else:
            last = self.db.execute(
                "SELECT max(json_extract(body,'$.sort_order')) FROM catalog_rows "
                "WHERE family='tag_group_memberships' AND json_extract(body,'$.group_id')=?",
                (group,),
            ).fetchone()[0]
            self.create(
                "tag_group_memberships",
                {"group_id": group, "tag_id": tag, "sort_order": 0 if last is None else last + 1},
            )
        return False

    def collect_directory(self, command: dict[str, Any]) -> None:
        """Create a collection holding every bundle under one folder, in one commit.

        A collection that exists without its members is worse than none, so the
        collection and its memberships are one preview, as in legacy. The new
        collection goes last among its siblings.
        """
        from cairndex.replicas.catalog.browse import directory_bundles
        from cairndex.replicas.catalog.controls import creation

        name, parent = command["name"], command.get("parent")
        if not isinstance(name, str) or not name.strip():
            raise ReplicaError("A collection needs a name")
        if parent is not None and read_row(self.db, "collections", parent) is None:
            raise ReplicaError("The parent collection is unavailable")
        bundles = directory_bundles(self.db, command["directory"])
        row = {column: json.loads(raw) for column, raw in creation("collections")["cells"].items()}
        siblings = [
            item["sort_order"]
            for item in self.get("collections/_/$forest")
            if item["parent_id"] == parent
        ]
        row |= {
            "name": name.strip(),
            "parent_id": parent,
            "sort_order": max(siblings, default=-1) + 1,
        }
        self.create("collections", row)
        for position, bundle in enumerate(bundles):
            self.create(
                "asset_bundle_collections",
                {"bundle_id": bundle, "collection_id": row["id"], "sort_order": position},
            )

    def dissolve(self, identity: str) -> None:
        """Delete a bundle and return its files to Unbundled, keeping their identities.

        Each file moves into its own staged one-file bundle, as discovery stages it,
        and its moments follow it. A subtitle pairing of two files cannot follow
        both, so it is deleted, as the legacy delete did. A bundle that is already
        an Unbundled staging bundle is deleted with its file, which is how a loose
        file leaves the catalog.
        """
        from pathlib import PurePosixPath

        from cairndex.replicas.catalog.controls import creation

        bundle = read_row(self.db, "asset_bundles", identity)
        if bundle is None:
            raise ReplicaError("Deletion target is already absent")
        staged = (bundle["grouping_state"], bundle["grouping_source"]) == (
            "PROVISIONAL",
            "SCAN_SUGGESTION",
        )
        if not staged:
            for (source,) in self.db.execute(
                "SELECT source FROM catalog_references WHERE target=?",
                (f"asset_bundles/{identity}",),
            ).fetchall():
                family, track = source.split("/", 1)
                row = read_row(self.db, family, track) if family == "subtitle_tracks" else None
                if row and len({row["video_file_id"], row["source_file_id"]} - {None}) > 1:
                    self.delete(family, track)
            for member in self.get(key("asset_bundles", identity, "$members")):
                if member["family"] != "asset_files":
                    continue
                file = read_row(self.db, "asset_files", member["id"])
                if file is None:
                    raise ReplicaError("Catalog arrangement is unavailable")
                name = file["original_filename"]
                row = {
                    column: json.loads(raw)
                    for column, raw in creation("asset_bundles")["cells"].items()
                }
                row |= {
                    "title": PurePosixPath(name).stem or name,
                    "grouping_state": "PROVISIONAL",
                    "grouping_source": "SCAN_SUGGESTION",
                }
                self.create("asset_bundles", row)
                self.transfer(identity, row["id"], [f"asset_files/{member['id']}"])
        self.delete("asset_bundles", identity)

    def bundle_files(self, command: dict[str, Any]) -> None:
        """Bundle Unbundled files as legacy manual bundling did, keeping their identities.

        Without a target, a selected file's staging bundle becomes the confirmed bundle,
        so its identity survives, and roles follow the grouping heuristic. With a target,
        the files join that confirmed bundle after its members, with addition roles.
        Staging bundles the move empties are deleted, and each new subtitle file is
        linked to the video it names, as legacy did.
        """
        from pathlib import PurePosixPath

        from cairndex.core.time import utcnow
        from cairndex.domain.enums import FileRole, MediaKind
        from cairndex.grouping.suggester import (
            SUGGESTER_RULE_VERSION,
            FileObservation,
            _addition_roles,
            _assign_roles,
        )
        from cairndex.media.subtitles import format_for_path, is_subtitle_path, parse_subtitle_name
        from cairndex.replicas.catalog.controls import creation
        from cairndex.replicas.discovery import media_kind

        files, target, title = command.get("files"), command.get("target"), command.get("title")
        if (
            not isinstance(files, list)
            or not 0 < len(files) <= 100
            or not all(isinstance(identity, str) for identity in files)
            or len(set(files)) != len(files)
        ):
            raise ReplicaError("Select 1 to 100 distinct Unbundled files")
        if title is not None and (not isinstance(title, str) or len(title) > 1024):
            raise ReplicaError("A bundle title has at most 1024 characters")
        rows: dict[str, Row] = {}
        for identity in files:
            row = read_row(self.db, "asset_files", identity)
            bundle = read_row(self.db, "asset_bundles", row["bundle_id"]) if row else None
            staged = ("PROVISIONAL", "SCAN_SUGGESTION")
            if not bundle or (bundle["grouping_state"], bundle["grouping_source"]) != staged:
                raise ReplicaError("Only Unbundled files can be bundled; refresh the files")
            assert row is not None
            rows[identity] = row
        observed = [
            FileObservation(identity, row["relative_path"], media_kind(row["relative_path"]))
            for identity, row in rows.items()
        ]

        def files_of(bundle: str) -> list[str]:
            members = self.get(key("asset_bundles", bundle, "$members"))
            return [member["id"] for member in members if member["family"] == "asset_files"]

        if target is None:
            proposed = _assign_roles(observed)
            # Reuse a staging bundle only when no unselected file would come along
            target = next(
                (
                    rows[item.asset_file_id]["bundle_id"]
                    for item in proposed
                    if set(files_of(rows[item.asset_file_id]["bundle_id"])) <= set(files)
                ),
                None,
            )
            if target is None:
                row = {
                    column: json.loads(raw)
                    for column, raw in creation("asset_bundles")["cells"].items()
                }
                self.create("asset_bundles", row)
                target = row["id"]
            cover = next((p.asset_file_id for p in proposed if p.role is FileRole.COVER), None)
            fields = {
                "grouping_state": "CONFIRMED",
                "grouping_source": "MANUAL",
                "grouping_rule_version": SUGGESTER_RULE_VERSION,
                "confirmed_at": utcnow().replace(tzinfo=None).isoformat(sep=" "),
                "cover_file_id": cover,
            }
            if title and title.strip():
                fields["title"] = title.strip()
            elif not self.get(key("asset_bundles", target, "title")):
                fields["title"] = PurePosixPath(
                    rows[proposed[0].asset_file_id]["relative_path"]
                ).stem
        else:
            bundle = read_row(self.db, "asset_bundles", target)
            if bundle is None or bundle["grouping_state"] != "CONFIRMED":
                raise ReplicaError("Choose a confirmed bundle to add the files to")
            proposed = _addition_roles(observed)
            fields = {}
        sources = []
        for item in proposed:
            source = rows[item.asset_file_id]["bundle_id"]
            if source != target:
                self.transfer(source, target, [f"asset_files/{item.asset_file_id}"])
                sources.append(source)
        unit = key("asset_bundles", target, "$members")
        placed = {item.asset_file_id: item for item in proposed}
        members = self.get(unit)
        chosen = [m for m in members if m["family"] == "asset_files" and m["id"] in placed]
        for member in chosen:
            member["role"] = placed[member["id"]].role.name
        if fields:
            # A new bundle takes the proposed order, and anything else follows it
            for member in chosen:
                member["sequence"] = placed[member["id"]].sequence
            rest = [member for member in members if member not in chosen]
            for index, member in enumerate(rest):
                member["sequence"] = len(proposed) + index
        self.put(unit, sorted(members, key=lambda member: member["sequence"]))
        for field, value in fields.items():
            self.put(key("asset_bundles", target, field), value)
        for source in dict.fromkeys(sources):
            if not self.get(key("asset_bundles", source, "$members")):
                self.delete("asset_bundles", source)

        # Link each new subtitle file to the video in its folder with the stem it names
        videos: dict[tuple[str, str], str] = {}
        for identity in files_of(target):
            path = (rows.get(identity) or read_row(self.db, "asset_files", identity) or {}).get(
                "relative_path"
            )
            if path and media_kind(path) is MediaKind.VIDEO:
                videos.setdefault(
                    (str(PurePosixPath(path).parent), PurePosixPath(path).stem), identity
                )
        subtitles = [file for file in observed if is_subtitle_path(file.relative_path)]
        for order, file in enumerate(subtitles):
            if self.db.execute(
                "SELECT 1 FROM catalog_rows WHERE family='subtitle_tracks' "
                "AND json_extract(body,'$.source_file_id')=?",
                (file.asset_file_id,),
            ).fetchone():
                continue
            path = PurePosixPath(file.relative_path)
            parsed = parse_subtitle_name(path.name)
            track = {
                column: json.loads(raw)
                for column, raw in creation("subtitle_tracks")["cells"].items()
            }
            track |= {
                "bundle_id": target,
                "source_file_id": file.asset_file_id,
                "video_file_id": videos.get((str(path.parent), parsed.video_stem)),
                "language": parsed.language,
                "is_forced": int(parsed.is_forced),
                "format": format_for_path(file.relative_path),
                "sort_order": order,
            }
            self.create("subtitle_tracks", track)

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
        if family == "moments":
            # A transfer moves moments with their file, so the two bundle IDs always agree
            file = read_row(self.db, "asset_files", row["file_id"])
            if file is None or file["bundle_id"] != row["bundle_id"]:
                raise ReplicaError("A moment must be marked on a file of its bundle")
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
        if family not in EDGES:
            raise ReplicaError("Unsupported membership choice")
        return self.edge("asset_bundles", command["bundle"], family, EDGES[family], command)

    def moment_tag(self, command: dict[str, Any]) -> bool:
        """Change one moment tag; an added tag also becomes a bundle tag (ADR-0025)."""
        moment = read_row(self.db, "moments", command["moment"])
        if moment is None:
            raise ReplicaError("Membership target is unavailable")
        recover = self.edge("moments", command["moment"], "tags", "moment_tags", command)
        if not command["assigned"]:
            # Removal stays on the moment: a bundle tag does not record where it came from
            return recover
        unit = key("asset_bundle_tags", f"{moment['bundle_id']}~{command['target']}", "$alive")
        if self.db.execute("SELECT 1 FROM catalog_holds WHERE unit=?", (unit,)).fetchone():
            raise ReplicaError("Membership changed or requires conflict review; refresh choices")
        existing = self.db.execute(
            "SELECT value FROM catalog_units WHERE unit=?", (unit,)
        ).fetchone()
        if existing is None:
            self.create(
                "asset_bundle_tags", {"bundle_id": moment["bundle_id"], "tag_id": command["target"]}
            )
        elif existing[0] == "false":
            self.put(unit, True)
            return True
        return recover

    # One explicit edge change with the observed bases the owner saw; stale choices are refused
    def edge(
        self, owner_family: str, owner: str, family: str, edge: str, command: dict[str, Any]
    ) -> bool:
        if type(command.get("assigned")) is not bool:
            raise ReplicaError("Unsupported membership choice")
        target = command["target"]
        identity = f"{owner}~{target}"
        unit = key(edge, identity, "$alive")
        expected = {
            unit,
            key(owner_family, owner, "$alive"),
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
            read_row(self.db, owner_family, owner) is None
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
        owner_column = "moment_id" if owner_family == "moments" else "bundle_id"
        row = {owner_column: owner, "tag_id" if family == "tags" else "collection_id": target}
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
        if action == "bulk":
            from cairndex.replicas.catalog.selection import bulk

            recover = bulk(builder, command)
        elif action == "membership":
            recover = builder.membership(command)
        elif action == "moment_tag":
            recover = builder.moment_tag(command)
        elif action == "delete":
            if command.get("cascade"):
                builder.delete_tree(command["family"], command["entity"])
            else:
                builder.delete(command["family"], command["entity"])
        elif action == "group_tag":
            recover = builder.group_tag(command)
        elif action == "collect_directory":
            builder.collect_directory(command)
        elif action == "order":
            builder.order(command)
        elif action == "bundle_files":
            builder.bundle_files(command)
        elif action == "dissolve":
            from cairndex.replicas.catalog.selection import CatalogSelectionRequest

            for identity in CatalogSelectionRequest.model_validate({"ids": command["ids"]}).ids:
                builder.dissolve(identity)
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
