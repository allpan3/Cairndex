"""Indexed catalog edits, complete structural choices and private durable editor work"""

import json
import sqlite3
from collections.abc import Iterable
from typing import Any

from cairndex.replicas.catalog import projection
from cairndex.replicas.catalog.constraints import cohorts
from cairndex.replicas.catalog.model import AUTHORED, key, split_key, structural_targets, value_text
from cairndex.replicas.catalog.protocol import Root, UnitChange, decode, payload
from cairndex.replicas.catalog.storage import CatalogStorage
from cairndex.replicas.protocol import MAX_CANDIDATES, ReplicaError, checksum
from cairndex.replicas.store import recovered_intent, retry_receipt


# Active revisions and structural cohorts preserve alternatives without a timestamp winner
class CatalogStore(CatalogStorage):
    # Read a bounded revision set using the catalog's active-unit index
    def tips(self, db: sqlite3.Connection, unit: str) -> list[sqlite3.Row]:
        return db.execute(
            "SELECT event,value FROM catalog_revisions WHERE unit=? AND active=1 ORDER BY event",
            (unit,),
        ).fetchall()

    # A field's lifetime and each referenced target must have an explicit observed guard
    def required_guards(self, db: sqlite3.Connection, unit: str, raw: str) -> set[str]:
        from cairndex.persistence.base import Base
        from cairndex.replicas.catalog.model import COMPOSITES

        family, entity, field = split_key(unit)
        value = json.loads(raw)
        if field == "$alive" and (value is False or "~" not in entity):
            return set()
        result = {key(family, entity, "$alive")} if entity != "_" and field != "$alive" else set()
        cells = value if field in COMPOSITES.get(family, {}) else {field: value}
        if field == "$members":
            result.update(key(item["family"], item["id"], "$alive") for item in value)
        elif field == "$forest":
            result.update(key(family, item["id"], "$alive") for item in value)
        else:
            for column_name, cell in cells.items():
                column = Base.metadata.tables[family].c.get(column_name)
                if column is not None and cell is not None:
                    result.update(
                        key(foreign.column.table.name, cell, "$alive")
                        for foreign in column.foreign_keys
                    )
            # Composite edge identity columns are references even though they are immutable
            if "~" in entity:
                from cairndex.replicas.catalog.model import IDENTITIES

                for column_name, cell in zip(IDENTITIES[family], entity.split("~"), strict=True):
                    column = Base.metadata.tables[family].c[column_name]
                    result.update(
                        key(foreign.column.table.name, cell, "$alive")
                        for foreign in column.foreign_keys
                    )
        return result

    # Expand only active atomic dependencies; independent scalar conflicts keep their own scope
    def scope(self, db: sqlite3.Connection, units: Iterable[str]) -> set[str]:
        result, pending = set(units), list(units)
        live: dict[str, bool] = {}

        # Retained tombstoned fields do not become active relationship obligations
        def relevant(candidate: str) -> bool:
            family, entity, field = split_key(candidate)
            if field in ("$alive", "$forest"):
                return True
            lifetime = key(family, entity, "$alive")
            if lifetime not in live:
                projected = db.execute(
                    "SELECT value FROM catalog_units WHERE unit=?", (lifetime,)
                ).fetchone()
                live[lifetime] = bool(projected and projected[0] == "true") or any(
                    tip["value"] == "true" for tip in self.tips(db, lifetime)
                )
            return live[lifetime]

        while pending:
            unit = pending.pop()
            more = {
                row[0]
                for row in db.execute(
                    "SELECT DISTINCT b.unit FROM catalog_cohorts a JOIN catalog_cohorts b "
                    "ON a.event=b.event AND a.cohort=b.cohort "
                    "JOIN catalog_revisions ra ON ra.event=a.event AND ra.unit=a.unit "
                    "AND ra.active=1 "
                    "JOIN catalog_revisions rb ON rb.event=b.event AND rb.unit=b.unit "
                    "AND rb.active=1 "
                    "WHERE a.unit=? AND EXISTS (SELECT 1 FROM catalog_revisions r "
                    "JOIN catalog_cohorts c ON c.event=r.event AND c.unit=r.unit "
                    "WHERE r.event=a.event AND c.cohort=a.cohort AND r.active=1 AND c.anchor=1)",
                    (unit,),
                )
            }
            if (
                self.descriptor.format_version == 3
                and unit.startswith("asset_files/")
                and unit.endswith("/relative_path")
            ):
                values = {tip["value"] for tip in self.tips(db, unit)}
                projected = db.execute(
                    "SELECT value FROM catalog_units WHERE unit=?", (unit,)
                ).fetchone()
                if projected and projected[0] is not None:
                    values.add(projected[0])
                for value in values:
                    claims = {
                        row[0]
                        for row in db.execute(
                            "SELECT unit FROM catalog_revisions WHERE value=? AND active=1 "
                            "AND unit LIKE 'asset_files/%/relative_path'",
                            (value,),
                        )
                    }
                    if len(claims) > 1:
                        more.update(claims)
                        more.update(
                            key("asset_files", split_key(claim)[1], "$alive") for claim in claims
                        )
            targets = {
                row[0]
                for row in db.execute(
                    "SELECT c.target FROM catalog_claims c JOIN catalog_revisions r "
                    "ON r.event=c.event AND r.unit=c.unit WHERE c.unit=? AND r.active=1 "
                    "UNION SELECT target FROM catalog_projected_claims WHERE unit=?",
                    (unit, unit),
                )
            }
            if unit == "collections/_/$forest":
                targets.update(
                    row[0]
                    for row in db.execute(
                        "SELECT c.target FROM catalog_claims c JOIN catalog_revisions r "
                        "ON r.event=c.event AND r.unit=c.unit WHERE c.kind='collection_cover' "
                        "AND r.active=1 UNION SELECT target FROM catalog_projected_claims "
                        "WHERE kind='collection_cover'"
                    )
                )
            for target in targets:
                collection_claims = db.execute(
                    "SELECT c.unit,c.kind FROM catalog_claims c JOIN catalog_revisions r "
                    "ON r.event=c.event AND r.unit=c.unit WHERE c.target=? AND r.active=1 "
                    "AND c.kind IN ('collection_cover','collection_member') UNION "
                    "SELECT unit,kind FROM catalog_projected_claims WHERE target=? "
                    "AND kind IN ('collection_cover','collection_member')",
                    (target, target),
                ).fetchall()
                if any(row[1] == "collection_cover" for row in collection_claims):
                    more.update(row[0] for row in collection_claims)
                    more.add("collections/_/$forest")
                owners = db.execute(
                    "SELECT c.unit FROM catalog_claims c JOIN catalog_revisions r "
                    "ON r.event=c.event AND r.unit=c.unit WHERE c.target=? AND c.kind='owner' "
                    "AND r.active=1 UNION SELECT unit FROM catalog_projected_claims "
                    "WHERE target=? AND kind='owner' LIMIT 2",
                    (target, target),
                ).fetchall()
                if len(owners) > 1:
                    more.update(
                        row[0]
                        for row in db.execute(
                            "SELECT c.unit FROM catalog_claims c JOIN catalog_revisions r "
                            "ON r.event=c.event AND r.unit=c.unit WHERE c.target=? AND r.active=1 "
                            "UNION SELECT unit FROM catalog_projected_claims WHERE target=?",
                            (target, target),
                        )
                    )
            if unit.endswith("/$alive") and len({row["value"] for row in self.tips(db, unit)}) > 1:
                more.update(
                    row[0]
                    for row in db.execute(
                        "SELECT DISTINCT g.unit FROM catalog_guards g JOIN catalog_revisions r "
                        "ON r.event=g.event AND r.unit=g.unit WHERE g.target=? AND r.active=1",
                        (unit,),
                    )
                )
            for (target,) in db.execute(
                "SELECT DISTINCT g.target FROM catalog_guards g JOIN catalog_revisions r "
                "ON r.event=g.event AND r.unit=g.unit WHERE g.unit=? AND r.active=1",
                (unit,),
            ):
                if len({row["value"] for row in self.tips(db, target)}) > 1:
                    more.add(target)
            for candidate in more - result:
                if not relevant(candidate):
                    continue
                result.add(candidate)
                pending.append(candidate)
        return result

    # Ingest checks complete observed bases before accepting any local or remote event
    def apply_edit(self, db: sqlite3.Connection, identity: str, root: Root, *, local: bool) -> bool:
        rows = db.execute("SELECT * FROM catalog_staging ORDER BY unit").fetchall()
        changed = {row["unit"] for row in rows}
        guards: dict[str, set[str]] = {}
        for row in rows:
            unit, value, basis = row["unit"], row["value"], json.loads(row["basis"])
            family, entity, field = split_key(unit)
            tips = self.tips(db, unit)
            exists = db.execute("SELECT 1 FROM catalog_units WHERE unit=?", (unit,)).fetchone()
            if not exists and basis:
                return False
            if exists and not basis:
                # Concurrent same-pair edge creation combines, but observed identities need bases
                placeholders = ",".join("(?)" for _ in root.parents)
                observed = db.execute(
                    f"WITH RECURSIVE ancestors(event) AS (VALUES {placeholders} UNION "
                    "SELECT p.parent FROM catalog_parents p JOIN ancestors a ON p.child=a.event) "
                    "SELECT 1 FROM catalog_revisions r JOIN ancestors a ON a.event=r.event "
                    "WHERE r.unit=? LIMIT 1",
                    (*root.parents, unit),
                ).fetchone()
                if (local and self.descriptor.format_version != 3) or observed:
                    raise ReplicaError("Existing catalog units require an observed basis")
            if not basis and field != "$forest" and key(family, entity, "$alive") not in changed:
                raise ReplicaError("New catalog identity needs its complete lifetime")
            for revision in basis:
                if not db.execute("SELECT 1 FROM events WHERE id=?", (revision,)).fetchone():
                    return False
                if not db.execute(
                    "SELECT 1 FROM catalog_revisions WHERE event=? AND unit=?", (revision, unit)
                ).fetchone():
                    raise ReplicaError("Observed revision belongs to another catalog unit")
            if len({tip["event"] for tip in tips} - set(basis)) >= MAX_CANDIDATES:
                return False
            if local and root.resolve and set(basis) != {tip["event"] for tip in tips}:
                raise ReplicaError("Conflict review is stale; review the current alternatives")
            if field == "$alive" and value == "true" and not root.recover:
                for revision in basis:
                    previous = db.execute(
                        "SELECT value FROM catalog_revisions WHERE event=? AND unit=?",
                        (revision, unit),
                    ).fetchone()[0]
                    if previous == "false":
                        raise ReplicaError("An observed deletion requires explicit recovery")
            guards[unit] = self.required_guards(db, unit, value)
            for guard in guards[unit]:
                supplied = db.execute(
                    "SELECT value FROM catalog_staging WHERE unit=?", (guard,)
                ).fetchone()
                if (
                    supplied is not None
                    and supplied[0] == "false"
                    and field == "$members"
                    and value == "[]"
                ):
                    continue
                if supplied is None or supplied[0] != "true":
                    # A deletion cascade clears references without resurrecting its target
                    if field == "$alive" and value == "false":
                        continue
                    raise ReplicaError("Every edit and reference requires its observed live basis")
        if local and root.resolve:
            expected = self.scope(db, changed)
            if not expected.issubset(changed):
                raise ReplicaError("Structural choice must include its complete reviewed scope")
        prior_scopes = [self.scope(db, [unit]) for unit in changed]
        atomic_groups = cohorts(self, db, rows)
        for row in rows:
            family, entity, field = split_key(row["unit"])
            db.execute(
                "INSERT OR IGNORE INTO catalog_units VALUES (?, ?, ?, ?, NULL)",
                (row["unit"], family, entity, field),
            )
            for basis in json.loads(row["basis"]):
                db.execute(
                    "UPDATE catalog_revisions SET active=0 WHERE unit=? AND event=?",
                    (row["unit"], basis),
                )
            db.execute(
                "INSERT INTO catalog_revisions VALUES (?, ?, ?, 1)",
                (identity, row["unit"], row["value"]),
            )
            db.executemany(
                "INSERT INTO catalog_claims VALUES (?, ?, ?, ?)",
                (
                    (row["unit"], identity, target, kind)
                    for target, kind in structural_targets(row["unit"], row["value"])
                ),
            )
            db.executemany(
                "INSERT INTO catalog_guards VALUES (?, ?, ?)",
                ((identity, row["unit"], target) for target in guards[row["unit"]]),
            )
        # Superseded structural anchors release old dependencies without discarding history
        for members, anchors in atomic_groups:
            cohort = checksum(value_text(sorted(members)).encode())
            db.executemany(
                "INSERT INTO catalog_cohorts VALUES (?, ?, ?, ?)",
                ((identity, unit, int(unit in anchors), cohort) for unit in members),
            )
        # Whole transaction staging lets transfers/cascades validate before any visible commit
        groups: list[set[str]] = []
        remaining = set(changed)
        while remaining:
            group = self.scope(db, [next(iter(remaining))])
            expanded = True
            while expanded:
                before = len(group)
                for prior in prior_scopes:
                    if prior & group:
                        group.update(prior)
                group = self.scope(db, group)
                expanded = before != len(group)
            remaining.difference_update(group)
            groups.append(group)
        for group in groups:
            reason = "Concurrent alternatives require a complete structural choice"
            if all(len({tip["value"] for tip in self.tips(db, unit)}) == 1 for unit in group):
                db.execute("SAVEPOINT projection")
                try:
                    for unit in group:
                        tips = self.tips(db, unit)
                        db.execute(
                            "UPDATE catalog_units SET value=? WHERE unit=?",
                            (tips[0]["value"], unit),
                        )
                    projection.project(db, group)
                    db.executemany(
                        "DELETE FROM catalog_holds WHERE unit=?", ((unit,) for unit in group)
                    )
                    db.execute("RELEASE projection")
                    continue
                except ReplicaError as error:
                    db.execute("ROLLBACK TO projection")
                    db.execute("RELEASE projection")
                    reason = error.message
                    if local:
                        raise
            db.executemany(
                "INSERT OR REPLACE INTO catalog_holds VALUES (?, ?)",
                ((unit, reason) for unit in group),
            )
        return True

    # Explicit operation identities retry exactly the same intent across process crashes
    def save(
        self,
        changes: list[UnitChange],
        operation: str,
        *,
        parents: list[str],
        resolve: bool = False,
        recover: bool = False,
    ) -> str:
        with self.connection() as db:
            identity = self.save_in(
                db, changes, operation, parents=parents, resolve=resolve, recover=recover
            )
        self.fault("save_after_commit")
        return identity

    # Discovery commits its exact catalog receipt and private acknowledgement in one transaction
    def save_in(
        self,
        db: sqlite3.Connection,
        changes: list[UnitChange],
        operation: str,
        *,
        parents: list[str],
        resolve: bool = False,
        recover: bool = False,
    ) -> str:
        intent = value_text(
            {
                "changes": [change.model_dump() for change in changes],
                "resolve": resolve,
                "recover": recover,
                "parents": parents,
            }
        )
        replica = db.execute("SELECT value FROM config WHERE key='replica'").fetchone()[0]
        prior = retry_receipt(db, replica, operation)
        if prior:
            saved_intent = prior["intent"] or recovered_intent(
                db, self.descriptor, prior["id"], intent
            )
            if saved_intent != intent:
                raise ReplicaError("Retry identity was reused for different work")
            if prior["intent"] is None:
                db.execute(
                    "INSERT OR IGNORE INTO recovery_receipts VALUES (?, ?, ?)",
                    (operation, intent, prior["id"]),
                )
            return str(prior["id"])
        if (
            not db.execute("SELECT 1 FROM config WHERE key='catalog_ready'").fetchone()
            or db.execute("SELECT 1 FROM config WHERE key='blocked'").fetchone()
        ):
            raise ReplicaError("Waiting for complete catalog or recovery; draft retained")
        identity = ""
        for identity, raw in payload(
            changes,
            library=self.descriptor.library_uuid,
            epoch=self.descriptor.epoch,
            replica=replica,
            operation=operation,
            resolve=resolve,
            recover=recover,
            parents=parents,
        ):
            _, body = decode(raw, self.descriptor)
            if self.accept(db, identity, body, raw, local=True, intent=intent) == "pending":
                raise ReplicaError("Observed dependencies are missing; draft retained")
        self.fault("save_before_commit")
        return identity

    # Editors preserve their observed causal frontier with drafts and retry identities
    def frontier(self) -> list[str]:
        with self.connection(readonly=True) as db:
            return [
                row[0] for row in db.execute("SELECT event FROM catalog_frontier ORDER BY event")
            ]

    # File Browser reads indexed library-relative catalog paths without opening source files
    def files(self, directory: str = "", after: str = "", limit: int = 30) -> dict[str, Any]:
        from cairndex.replicas.catalog.model import validate_cell

        validate_cell("asset_files", "relative_path", directory)
        with self.connection(readonly=True) as db:
            rows = db.execute(
                "SELECT 'd:'||path AS cursor,path,'directory' AS kind,'' AS family,'' AS entity "
                "FROM catalog_directories WHERE parent=? AND 'd:'||path>? UNION ALL "
                "SELECT 'f:'||path AS cursor,path,'file' AS kind,family,entity FROM catalog_paths "
                "WHERE parent=? AND family='asset_files' AND 'f:'||path>? ORDER BY cursor LIMIT ?",
                (directory, after, directory, after, limit + 1),
            ).fetchall()
            return {
                "items": [dict(row) for row in rows[:limit]],
                "next_cursor": rows[limit - 1]["cursor"] if len(rows) > limit else None,
            }

    # Paginate every family with exact canonical value text and explicit observed revisions
    def entities(
        self, family: str, after: str = "", limit: int = 30, *, deleted: bool = False
    ) -> dict[str, Any]:
        if family not in AUTHORED:
            raise ReplicaError("Unsupported catalog family")
        with self.connection(readonly=True) as db:
            identities = db.execute(
                "SELECT entity FROM catalog_units WHERE family=? AND field='$alive' "
                "AND entity>? AND (? OR value='true' OR EXISTS "
                "(SELECT 1 FROM catalog_holds h WHERE h.unit=catalog_units.unit)) "
                "ORDER BY entity LIMIT ?",
                (family, after, int(deleted), limit + 1),
            ).fetchall()
            items = [self.entity_in(db, family, row[0], summary=True) for row in identities[:limit]]
            return {
                "items": items,
                "next_cursor": identities[limit - 1][0] if len(identities) > limit else None,
            }

    # One editor snapshot includes field candidates and the lifetime bases its save must retain
    def entity_in(
        self, db: sqlite3.Connection, family: str, identity: str, *, summary: bool = False
    ) -> dict[str, Any]:
        fields: dict[str, Any] = {}
        observed: dict[str, list[str]] = {}
        for row in db.execute(
            "SELECT unit,field,value FROM catalog_units WHERE family=? AND entity=? "
            "AND (?=0 OR field IN ('$alive','title','name','display_title','comment','label',"
            "'directory_path')) ORDER BY field",
            (family, identity, int(summary)),
        ):
            tips = self.tips(db, row["unit"])
            candidates: dict[str, list[str]] = {}
            for tip in tips:
                candidates.setdefault(tip["value"], []).append(tip["event"])
            held = db.execute(
                "SELECT reason FROM catalog_holds WHERE unit=?", (row["unit"],)
            ).fetchone()
            basis = [tip["event"] for tip in tips]
            observed[row["unit"]] = basis
            fields[row["field"]] = {
                "unit": row["unit"],
                "value": row["value"],
                "basis": basis,
                "candidates": [
                    {"value": value, "revisions": ids} for value, ids in candidates.items()
                ],
                "held": held[0] if held else None,
                "components": {
                    column: value_text(cell) for column, cell in json.loads(row["value"]).items()
                }
                if row["field"] in ("$span", "$source", "$filter") and row["value"]
                else {},
            }
            if row["value"] is not None:
                for guard in self.required_guards(db, row["unit"], row["value"]):
                    observed[guard] = [tip["event"] for tip in self.tips(db, guard)]
        return {
            "family": family,
            "id": identity,
            "has_conflicts": bool(
                db.execute(
                    "SELECT 1 FROM catalog_units u JOIN catalog_holds h "
                    "ON h.unit=u.unit WHERE u.family=? AND u.entity=? LIMIT 1",
                    (family, identity),
                ).fetchone()
            ),
            "fields": fields,
            "observed": observed,
            "parents": [
                row[0] for row in db.execute("SELECT event FROM catalog_frontier ORDER BY event")
            ],
        }

    # An exact entity read avoids scanning any paginated catalog window
    def entity(self, family: str, identity: str) -> dict[str, Any]:
        split_key(key(family, identity, "$forest" if identity == "_" else "$alive"))
        with self.connection(readonly=True) as db:
            result = self.entity_in(db, family, identity)
            if not result["fields"]:
                raise ReplicaError("Catalog identity is unavailable")
            return result

    # Retained values and structural scope are read independently from an editor's private draft
    def history(self, unit: str, after: str = "", limit: int = 30) -> dict[str, Any]:
        split_key(unit)
        with self.connection(readonly=True) as db:
            rows = db.execute(
                "SELECT event,value,active FROM catalog_revisions WHERE unit=? AND event>? "
                "ORDER BY event LIMIT ?",
                (unit, after, limit + 1),
            ).fetchall()
            return {
                "items": [dict(row) for row in rows[:limit]],
                "next_cursor": rows[limit - 1]["event"] if len(rows) > limit else None,
                "scope": sorted(self.scope(db, [unit])),
            }

    # Draft receipts prevent delayed requests from resurrecting discarded editor generations
    def draft(self, identity: str, owner: str, revision: int, body: dict[str, Any]) -> None:
        raw = value_text(body)
        with self.connection() as db:
            receipt = db.execute(
                "SELECT revision FROM draft_receipts WHERE id=?", (identity,)
            ).fetchone()
            if receipt and revision <= receipt[0]:
                return
            prior = db.execute("SELECT * FROM drafts WHERE id=?", (identity,)).fetchone()
            if prior and (
                prior["bundle"] != owner
                or revision < prior["revision"]
                or (revision == prior["revision"] and raw != prior["body"])
            ):
                raise ReplicaError("A newer editor draft is already retained")
            db.execute(
                "INSERT OR REPLACE INTO drafts VALUES (?, ?, ?, ?)",
                (identity, owner, revision, raw),
            )

    # Catalog drafts share the proven monotonic dismissal receipts of the bounded workflow
    def dismiss_draft(self, identity: str, revision: int) -> None:
        with self.connection() as db:
            db.execute(
                "INSERT INTO draft_receipts VALUES (?, ?) ON CONFLICT(id) DO UPDATE "
                "SET revision=MAX(revision,excluded.revision)",
                (identity, revision),
            )
            db.execute("DELETE FROM drafts WHERE id=? AND revision<=?", (identity, revision))

    # Recover every editor's private work through bounded owner-scoped pages
    def drafts(self, owner: str, after: str = "", limit: int = 30) -> dict[str, Any]:
        with self.connection(readonly=True) as db:
            rows = db.execute(
                "SELECT * FROM drafts WHERE bundle=? AND id>? ORDER BY id LIMIT ?",
                (owner, after, limit + 1),
            ).fetchall()
            return {
                "items": [
                    {"id": row["id"], "revision": row["revision"], "body": json.loads(row["body"])}
                    for row in rows[:limit]
                ],
                "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None,
            }
