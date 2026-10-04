"""Bounded selection reads and causal bulk previews over authored metadata."""

import json
from typing import Any, Literal

from pydantic import Field, field_validator

from cairndex.replicas.catalog.commands import Preview
from cairndex.replicas.catalog.inspector import EDGES, MembershipFamily
from cairndex.replicas.catalog.model import key
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError, StrictModel, Token


class CatalogSelectionRequest(StrictModel):
    ids: list[Token] = Field(min_length=1, max_length=100)

    @field_validator("ids")
    @classmethod
    def unique(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("Select each bundle once")
        return value


class CatalogSelectionItem(StrictModel):
    id: str
    title: str | None
    rating: float | None
    observed: dict[str, list[str]]
    held: bool


class CatalogSelectionRead(StrictModel):
    items: list[CatalogSelectionItem]


class CatalogBulkMembershipRequest(CatalogSelectionRequest):
    family: MembershipFamily
    after: str = Field(default="", max_length=256)
    q: str = Field(default="", max_length=1000)
    limit: int = Field(default=30, ge=1, le=50)


class CatalogBulkMembershipChoice(StrictModel):
    id: str
    name: str
    assigned_count: int
    observed: dict[str, list[str]]
    held: bool


class CatalogBulkMembershipPage(StrictModel):
    items: list[CatalogBulkMembershipChoice]
    next_cursor: str | None


class CatalogBulkCommand(CatalogSelectionRequest):
    action: Literal["bulk"]
    field: Literal["title", "rating", "tags", "collections"]
    value: str | float | None = None
    target: Token | None = None
    assigned: bool | None = None
    observed: dict[str, list[str]]


def observed(builder: Preview, units: list[str]) -> tuple[dict[str, list[str]], bool]:
    bases = {unit: [tip["event"] for tip in builder.store.tips(builder.db, unit)] for unit in units}
    held = any(
        builder.db.execute("SELECT 1 FROM catalog_holds WHERE unit=?", (unit,)).fetchone()
        for unit in units
    )
    return bases, held


def selection(store: CatalogStore, request: CatalogSelectionRequest) -> CatalogSelectionRead:
    with store.connection(readonly=True) as db:
        builder = Preview(store, db)
        items = []
        for identity in request.ids:
            row = read_row(db, "asset_bundles", identity)
            if row is None:
                raise ReplicaError("A selected bundle is unavailable; refresh the selection")
            bases, held = observed(
                builder,
                [key("asset_bundles", identity, field) for field in ("$alive", "title", "rating")],
            )
            items.append(
                CatalogSelectionItem(
                    id=identity,
                    title=row["title"],
                    rating=row["rating"],
                    observed=bases,
                    held=held,
                )
            )
        return CatalogSelectionRead(items=items)


def choices(
    store: CatalogStore, request: CatalogBulkMembershipRequest
) -> CatalogBulkMembershipPage:
    with store.connection(readonly=True) as db:
        builder = Preview(store, db)
        for identity in request.ids:
            if read_row(db, "asset_bundles", identity) is None:
                raise ReplicaError("A selected bundle is unavailable; refresh the selection")
        rows = db.execute(
            "SELECT entity,body FROM catalog_rows WHERE family=? AND entity>? "
            "AND instr(lower(json_extract(body,'$.name')),lower(?))>0 ORDER BY entity LIMIT ?",
            (request.family, request.after, request.q, request.limit + 1),
        ).fetchall()
        items = []
        for row in rows[: request.limit]:
            target = row["entity"]
            units = [key(request.family, target, "$alive")]
            count = 0
            for identity in request.ids:
                units.extend(
                    [
                        key("asset_bundles", identity, "$alive"),
                        key(EDGES[request.family], f"{identity}~{target}", "$alive"),
                    ]
                )
                count += read_row(db, EDGES[request.family], f"{identity}~{target}") is not None
            bases, held = observed(builder, units)
            items.append(
                CatalogBulkMembershipChoice(
                    id=target,
                    name=json.loads(row["body"])["name"],
                    assigned_count=count,
                    observed=bases,
                    held=held,
                )
            )
        return CatalogBulkMembershipPage(
            items=items,
            next_cursor=rows[request.limit - 1]["entity"] if len(rows) > request.limit else None,
        )


def bulk(builder: Preview, raw: dict[str, Any]) -> bool:
    """Validate displayed bases for every target before preparing one atomic receipt."""
    command = CatalogBulkCommand.model_validate(raw)
    family = command.field
    membership = family in EDGES
    units = [key("asset_bundles", identity, "$alive") for identity in command.ids]
    if membership:
        if command.target is None or command.assigned is None or command.value is not None:
            raise ReplicaError("Complete membership intent is required")
        units += [key(family, command.target, "$alive")]
        units += [
            key(EDGES[family], f"{identity}~{command.target}", "$alive") for identity in command.ids
        ]
    else:
        if command.target is not None or command.assigned is not None:
            raise ReplicaError("Unexpected scalar membership intent")
        if family == "title" and (not isinstance(command.value, str) or not command.value.strip()):
            raise ReplicaError("Enter a title for the selected bundles")
        if (
            family == "rating"
            and command.value is not None
            and (
                not isinstance(command.value, (int, float))
                or not 0 <= command.value <= 5
                or command.value * 2 != int(command.value * 2)
            )
        ):
            raise ReplicaError("Rating must use half-star steps from zero to five")
        units += [key("asset_bundles", identity, family) for identity in command.ids]
    bases, held = observed(builder, units)
    if (
        held
        or set(bases) != set(command.observed)
        or any(set(basis) != set(command.observed[unit]) for unit, basis in bases.items())
    ):
        raise ReplicaError(
            "Selected metadata changed or requires conflict review; refresh the review"
        )
    recover = False
    for identity in command.ids:
        if read_row(builder.db, "asset_bundles", identity) is None:
            raise ReplicaError("A selected bundle is unavailable")
        builder.put(key("asset_bundles", identity, "$alive"), True)
        if not membership:
            builder.put(key("asset_bundles", identity, family), command.value)
            continue
        target = command.target
        assert target is not None
        edge = EDGES[family]
        pair = f"{identity}~{target}"
        current = read_row(builder.db, edge, pair) is not None
        if current == command.assigned:
            # Guard unchanged edges too; concurrent removal must not escape the batch review.
            unit = key(edge, pair, "$alive")
            builder.put(unit, current)
            continue
        one = [
            key("asset_bundles", identity, "$alive"),
            key(family, target, "$alive"),
            key(edge, pair, "$alive"),
        ]
        recover = (
            builder.membership(
                {
                    "bundle": identity,
                    "family": family,
                    "target": target,
                    "assigned": command.assigned,
                    "observed": {unit: bases[unit] for unit in one},
                }
            )
            or recover
        )
    if membership:
        assert command.target is not None
        if read_row(builder.db, family, command.target) is None:
            raise ReplicaError("Membership target is unavailable")
        builder.put(key(family, command.target, "$alive"), True)
    return recover
