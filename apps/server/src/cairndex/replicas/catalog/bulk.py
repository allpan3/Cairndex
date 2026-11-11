"""Selections larger than one request change in durable batches of 100 bundles.

The browser stages the selection in bounded pages, each bundle with the bases the
owner reviewed. The worker then applies one batch per pass, and each batch is its
own event with its own retry identity. A batch commits its event, the outcome of
each staged bundle and the job's progress in one transaction, so a restart resumes
at the next batch and Cancel stops after the current one.

A bundle whose bases changed since review is left untouched and reported, so the
owner can review it again. A change to the shared tag or collection itself stops
the whole operation, since every remaining batch would be deciding against a
target the owner did not see.
"""

import json
import sqlite3
from typing import Any, Literal

from pydantic import Field, model_validator

from cairndex.core.errors import DomainError
from cairndex.replicas.catalog.commands import Preview, validate_preview
from cairndex.replicas.catalog.inspector import EDGES
from cairndex.replicas.catalog.model import key, value_text
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.catalog.protocol import UnitChange
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import Digest, ReplicaError, StrictModel, Token

BATCH = 100
PAGE = 500

Bases = dict[str, list[Digest]]


class CatalogBulkItem(StrictModel):
    id: Token
    # A bundle's own units only: its lifetime and the field or edge the change writes
    observed: Bases = Field(max_length=2)

    @model_validator(mode="after")
    def own_units(self) -> "CatalogBulkItem":
        prefixes = (
            f"asset_bundles/{self.id}/",
            f"asset_bundle_tags/{self.id}~",
            f"asset_bundle_collections/{self.id}~",
        )
        if not all(unit.startswith(prefixes) for unit in self.observed):
            raise ValueError("A staged basis must belong to its bundle")
        return self


class CatalogBulkStage(StrictModel):
    start: int = Field(ge=0)
    items: list[CatalogBulkItem] = Field(min_length=1, max_length=PAGE)


class CatalogBulkStaged(StrictModel):
    staged: int


class CatalogBulkUnchanged(StrictModel):
    items: list[str]
    next_start: int | None


class BulkChange(StrictModel):
    """The one change every batch applies, with the shared target's reviewed basis."""

    action: Literal["bulk", "dissolve"]
    field: Literal["title", "rating", "tags", "collections"] | None = None
    value: str | float | None = None
    target: Token | None = None
    assigned: bool | None = None
    observed: Bases = Field(default_factory=dict, max_length=1)

    @model_validator(mode="after")
    def complete(self) -> "BulkChange":
        if self.action == "dissolve":
            valid = self.field is None and self.value is None and not self.observed
            valid = valid and self.target is None and self.assigned is None
        elif self.field in EDGES:
            valid = self.target is not None and self.assigned is not None and self.value is None
            valid = valid and set(self.observed) == {self.target_unit}
        else:
            valid = self.field is not None and self.target is None and self.assigned is None
            valid = valid and not self.observed
        if not valid:
            raise ValueError("Complete bulk change intent is required")
        return self

    @property
    def target_unit(self) -> str:
        return key(str(self.field), str(self.target), "$alive")

    def units(self, bundle: str) -> set[str]:
        """The units a staged bundle's reviewed bases must cover."""
        if self.action == "dissolve":
            return set()
        own = key("asset_bundles", bundle, "$alive")
        if self.field in EDGES:
            return {own, key(EDGES[str(self.field)], f"{bundle}~{self.target}", "$alive")}
        return {own, key("asset_bundles", bundle, str(self.field))}


class BulkIntent(StrictModel):
    change: BulkChange
    total: int = Field(ge=1)


class BulkProgress(StrictModel):
    total: int = Field(ge=1)
    applied: int = Field(default=0, ge=0)
    skipped: int = Field(default=0, ge=0)
    batches: int = Field(default=0, ge=0)
    # The shared target's tips the next batch expects: the reviewed basis, then each
    # batch's own event. Anything else is someone else's change to the target.
    target: list[Digest] | None = None


def stage(store: CatalogStore, operation: str, request: CatalogBulkStage) -> CatalogBulkStaged:
    """Stage one page; resending an identical page is a no-op, so a lost reply can retry."""
    with store.connection() as db:
        if db.execute("SELECT 1 FROM catalog_jobs WHERE id=?", (operation,)).fetchone():
            raise ReplicaError("This bulk change has already started")
        for offset, item in enumerate(request.items):
            position, observed = request.start + offset, value_text(item.observed)
            prior = db.execute(
                "SELECT bundle,observed FROM catalog_bulk_items WHERE operation=? AND position=?",
                (operation, position),
            ).fetchone()
            if prior is not None:
                if tuple(prior) != (item.id, observed):
                    raise ReplicaError("Retry identity was reused for a different selection")
                continue
            try:
                db.execute(
                    "INSERT INTO catalog_bulk_items VALUES (?, ?, ?, ?, NULL)",
                    (operation, position, item.id, observed),
                )
            except sqlite3.IntegrityError as error:
                raise ReplicaError("Select each bundle once") from error
        staged = db.execute(
            "SELECT COUNT(*) FROM catalog_bulk_items WHERE operation=?", (operation,)
        ).fetchone()[0]
    return CatalogBulkStaged(staged=staged)


def admit(db: sqlite3.Connection, operation: str, body: dict[str, Any]) -> None:
    """Accept a job only for a complete staged selection; its pages are then frozen."""
    intent = BulkIntent.model_validate(body)
    count, last = db.execute(
        "SELECT COUNT(*),MAX(position) FROM catalog_bulk_items WHERE operation=?", (operation,)
    ).fetchone()
    if (count, last) != (intent.total, intent.total - 1):
        raise ReplicaError("The staged selection is incomplete; start the change again")
    # Only the latest finished operation's unchanged list stays readable, and a
    # selection staged but never started is abandoned once another one starts.
    db.execute(
        "DELETE FROM catalog_bulk_items WHERE operation!=? AND operation NOT IN "
        "(SELECT id FROM catalog_jobs WHERE state IN ('queued','running'))",
        (operation,),
    )


def unchanged(store: CatalogStore, operation: str, start: int, limit: int) -> CatalogBulkUnchanged:
    """Bundles the operation left as they were: changed since review, or never reached."""
    with store.connection(readonly=True) as db:
        if not db.execute("SELECT 1 FROM catalog_jobs WHERE id=?", (operation,)).fetchone():
            raise ReplicaError("Catalog job is unavailable")
        rows = db.execute(
            "SELECT position,bundle FROM catalog_bulk_items WHERE operation=? AND position>=? "
            "AND (outcome IS NULL OR outcome='skipped') ORDER BY position LIMIT ?",
            (operation, start, limit + 1),
        ).fetchall()
    return CatalogBulkUnchanged(
        items=[row["bundle"] for row in rows[:limit]],
        next_start=rows[limit]["position"] if len(rows) > limit else None,
    )


def _tips(store: CatalogStore, db: sqlite3.Connection, unit: str) -> list[str]:
    return [tip["event"] for tip in store.tips(db, unit)]


def _held(db: sqlite3.Connection, units: set[str]) -> bool:
    return any(
        db.execute("SELECT 1 FROM catalog_holds WHERE unit=?", (unit,)).fetchone() for unit in units
    )


def step(store: CatalogStore) -> bool:
    """Apply the oldest queued bulk operation's next batch; report whether one ran."""
    from cairndex.replicas.catalog.selection import bulk

    # The worker asks on every pass; only a waiting operation takes the writer lock
    with store.connection(readonly=True) as db:
        if not db.execute(
            "SELECT 1 FROM catalog_jobs WHERE state='queued' "
            "AND json_extract(intent,'$.action')='bulk_selection' LIMIT 1"
        ).fetchone():
            return False
    with store.connection() as db:
        if db.execute("SELECT 1 FROM config WHERE key='blocked'").fetchone():
            return False
        if not db.execute("SELECT 1 FROM config WHERE key='catalog_ready'").fetchone():
            return False
        job = db.execute(
            "SELECT id,intent,result FROM catalog_jobs WHERE state='queued' "
            "AND json_extract(intent,'$.action')='bulk_selection' ORDER BY sequence LIMIT 1"
        ).fetchone()
        if job is None:
            return False
        operation = job["id"]
        intent = BulkIntent.model_validate(json.loads(job["intent"])["body"])
        change, membership = intent.change, intent.change.field in EDGES
        progress = (
            BulkProgress.model_validate_json(job["result"])
            if job["result"]
            else BulkProgress(
                total=intent.total,
                target=change.observed[change.target_unit] if membership else None,
            )
        )

        def finish(state: str, error: str | None = None) -> bool:
            db.execute(
                "UPDATE catalog_jobs SET state=?,result=?,error=? WHERE id=?",
                (state, value_text(progress.model_dump()), error, operation),
            )
            return True

        rows = db.execute(
            "SELECT position,bundle,observed FROM catalog_bulk_items "
            "WHERE operation=? AND outcome IS NULL ORDER BY position LIMIT ?",
            (operation, BATCH),
        ).fetchall()
        if not rows:
            return finish("succeeded")
        stopped = f"{progress.applied} of {progress.total} bundles were changed before it stopped."
        if membership:
            noun = "tag" if change.field == "tags" else "collection"
            assert change.field is not None and change.target is not None
            current = _tips(store, db, change.target_unit)
            if (
                read_row(db, change.field, change.target) is None
                or _held(db, {change.target_unit})
                or set(current) != set(progress.target or [])
            ):
                return finish(
                    "failed",
                    f"The {noun} changed elsewhere or needs conflict review. {stopped}",
                )

        ready, skipped, observed = [], [], {}
        for row in rows:
            bases: dict[str, list[str]] = json.loads(row["observed"])
            units = change.units(row["bundle"])
            if set(bases) != units:
                return finish("failed", f"The staged selection is invalid. {stopped}")
            if (
                read_row(db, "asset_bundles", row["bundle"]) is None
                or _held(db, units)
                or any(set(_tips(store, db, unit)) != set(bases[unit]) for unit in units)
            ):
                skipped.append(row["position"])
                continue
            ready.append(row)
            observed.update(bases)

        if ready:
            ids = [row["bundle"] for row in ready]
            db.execute("SAVEPOINT bulk_batch")
            try:
                builder = Preview(store, db)
                recover = False
                if change.action == "dissolve":
                    for identity in ids:
                        builder.dissolve(identity)
                else:
                    if membership:
                        observed[change.target_unit] = list(progress.target or [])
                    recover = bulk(
                        builder,
                        change.model_dump(exclude={"action", "observed"})
                        | {"action": "bulk", "ids": ids, "observed": observed},
                    )
                receipt = builder.receipt(recover=recover)
                validate_preview(store, db, receipt)
                store.save_in(
                    db,
                    [UnitChange.model_validate(item) for item in receipt["changes"]],
                    f"{operation}-{progress.batches}",
                    parents=receipt["parents"],
                    recover=recover,
                )
            except (DomainError, ValueError, KeyError, TypeError) as failure:
                db.execute("ROLLBACK TO bulk_batch")
                db.execute("RELEASE bulk_batch")
                reason = failure.message if isinstance(failure, DomainError) else "Invalid change"
                return finish("failed", f"{reason.rstrip('.')}. {stopped}")
            db.execute("RELEASE bulk_batch")
            if membership:
                progress.target = _tips(store, db, change.target_unit)

        for outcome, positions in (
            ("applied", [row["position"] for row in ready]),
            ("skipped", skipped),
        ):
            db.executemany(
                "UPDATE catalog_bulk_items SET outcome=? WHERE operation=? AND position=?",
                [(outcome, operation, position) for position in positions],
            )
        progress.applied += len(ready)
        progress.skipped += len(skipped)
        progress.batches += 1
        done = progress.applied + progress.skipped == progress.total
        return finish("succeeded" if done else "queued")
