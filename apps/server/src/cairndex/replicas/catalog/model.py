"""Lossless authored units and explicit structural boundaries for the complete catalog"""

import json
import math
import re
from collections.abc import Iterable, Iterator, Mapping
from decimal import Decimal
from typing import Any

from sqlalchemy import JSON, Boolean, Enum, Float, Integer, String

from cairndex.persistence import models as _models  # noqa: F401
from cairndex.persistence.base import Base
from cairndex.replicas.inventory import INVENTORY
from cairndex.replicas.protocol import ReplicaError, canonical

AUTHORED = {
    name: spec["authored"].split() for name, spec in INVENTORY.items() if "authored" in spec
}
IDENTITIES = {
    name: tuple(column.name for column in Base.metadata.tables[name].primary_key)
    for name in AUTHORED
}
COMPOSITES: dict[str, dict[str, tuple[str, ...]]] = {
    "moments": {"$span": ("bundle_id", "file_id", "start_s", "end_s")},
    "smart_folders": {"$filter": ("filter_version", "filter_json")},
    "subtitle_tracks": {
        "$source": ("bundle_id", "video_file_id", "source_file_id", "embedded_index")
    },
}
PLACEMENT: dict[str, tuple[str, ...]] = {
    "asset_files": ("bundle_id", "role", "sequence"),
    "bundle_directory_members": ("bundle_id", "sequence"),
    "tags": ("parent_id", "sort_order"),
    "collections": ("parent_id", "sort_order"),
}
TOKEN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
Cell = str | int | float | None
Row = dict[str, Any]


# Wire values encode SQLite cells, keeping embedded JSON text and numeric precision intact
def value_text(value: Any) -> str:
    return canonical(value).decode()


# Normalize user-entered outer JSON while rejecting ambiguous keys and nonfinite numbers
def normalize_value(raw: str) -> str:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for name, value in items:
            if name in result:
                raise ValueError("duplicate value key")
            result[name] = value
        return result

    try:
        return value_text(json.loads(raw, object_pairs_hook=pairs))
    except (ValueError, TypeError, RecursionError) as error:
        raise ReplicaError("Invalid metadata value; private draft retained") from error


# Duplicate JSON keys and nonfinite numbers cannot be interpreted without losing intent
def exact_json(raw: str) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise ReplicaError("Duplicate opaque metadata keys require recovery")
            result[key] = value
        return result

    def constant(_: str) -> Any:
        raise ReplicaError("Nonfinite metadata requires recovery")

    try:
        return json.loads(
            raw, parse_float=Decimal, object_pairs_hook=pairs, parse_constant=constant
        )
    except (ValueError, RecursionError) as error:
        raise ReplicaError("Invalid opaque metadata requires recovery") from error


# Composite edge identities remain stable without depending on mutable labels or paths
def entity_id(family: str, row: Mapping[str, Any]) -> str:
    values = [row[column] for column in IDENTITIES[family]]
    if not all(isinstance(value, str) and TOKEN.fullmatch(value) for value in values):
        raise ReplicaError("Unsupported stable catalog identity")
    return "~".join(values)


# Keys contain only validated family, stable identity and field names
def key(family: str, identity: str, field: str) -> str:
    return f"{family}/{identity}/{field}"


# Reject unknown units even when their values happen to resemble a known family
def split_key(unit: str) -> tuple[str, str, str]:
    parts = unit.split("/")
    if len(parts) != 3:
        raise ReplicaError("Invalid catalog unit")
    family, identity, field = parts
    if family not in AUTHORED:
        raise ReplicaError("Unsupported catalog family; upgrade required")
    if field == "$forest" and family in ("tags", "collections") and identity == "_":
        return family, identity, field
    ids = identity.split("~")
    if len(ids) != len(IDENTITIES[family]) or not all(TOKEN.fullmatch(part) for part in ids):
        raise ReplicaError("Invalid catalog identity")
    if field not in fields(family) and not (family == "asset_files" and field == "$content"):
        raise ReplicaError("Unsupported catalog field; upgrade required")
    return family, identity, field


# Relationship/order composites replace only their exact member columns
def fields(family: str) -> set[str]:
    excluded = set(IDENTITIES[family]) | set(PLACEMENT.get(family, ()))
    composites = COMPOSITES.get(family, {})
    excluded.update(column for columns in composites.values() for column in columns)
    result = set(AUTHORED[family]) - excluded | set(composites) | {"$alive"}
    if family == "asset_bundles":
        result.add("$members")
    return result


# Validate cell types without round-tripping JSON columns through binary floating point
def validate_cell(family: str, column: str, value: Any) -> None:
    model = Base.metadata.tables[family].c[column]
    if value is None:
        if not model.nullable:
            raise ReplicaError("Required catalog value is null")
        return
    kind = model.type
    if isinstance(kind, JSON):
        if not isinstance(value, str):
            raise ReplicaError("Opaque metadata must preserve its exact JSON text")
        parsed = exact_json(value)
        if (
            column == "notes"
            and parsed is not None
            and not (isinstance(parsed, list) and all(isinstance(note, str) for note in parsed))
        ):
            raise ReplicaError("Notes must be an ordered list or null")
    elif isinstance(kind, Enum):
        if value not in kind.enums:
            raise ReplicaError("Unsupported catalog enum; upgrade required")
    elif isinstance(kind, Boolean):
        if type(value) is not int or value not in (0, 1):
            raise ReplicaError("Boolean SQLite cells must be zero or one")
    elif isinstance(kind, Integer):
        if type(value) is not int or not -(2**63) <= value < 2**63:
            raise ReplicaError("Integer outside the supported SQLite range")
    elif isinstance(kind, Float):
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ReplicaError("Invalid numeric catalog value")
    elif not isinstance(value, str):
        raise ReplicaError("Invalid catalog text value")
    elif isinstance(kind, String) and kind.length and len(value) > kind.length:
        raise ReplicaError("Catalog text exceeds the supported length")
    if column in ("relative_path", "directory_path") and (
        not isinstance(value, str)
        or "\\" in value
        or "\x00" in value
        or (
            value.startswith("/")
            or re.match(r"^[A-Za-z]:", value)
            or any(part in (".", "..") for part in value.split("/"))
        )
    ):
        raise ReplicaError("Catalog paths must remain library relative")
    if column == "rating" and not 0 <= value <= 5:
        raise ReplicaError("Rating must be between zero and five")


# Structural units carry complete arrangements; scalar units retain independent bases
def validate_unit(unit: str, raw: str) -> Any:
    family, _, field = split_key(unit)
    try:
        value = json.loads(raw)
        if value_text(value) != raw:
            raise ReplicaError("Catalog value is not canonical")
    except (ValueError, TypeError, RecursionError) as error:
        raise ReplicaError("Invalid catalog value") from error
    if field == "$content":
        if (
            not isinstance(value, dict)
            or set(value) != {"algorithm", "size", "digest"}
            or value["algorithm"] not in ("sha256", "sample-sha256-v1")
            or type(value["size"]) is not int
            or value["size"] < 0
            or not isinstance(value["digest"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", value["digest"])
        ):
            raise ReplicaError("Invalid content identity evidence")
    elif field == "$alive":
        if type(value) is not bool:
            raise ReplicaError("Invalid entity lifetime")
    elif field in ("$members", "$forest"):
        if not isinstance(value, list):
            raise ReplicaError("A complete ordered arrangement is required")
        seen: set[str] = set()
        parents: dict[str, str | None] = {}
        for item in value:
            expected = {"id", "parent_id", "sort_order"}
            if field == "$members":
                if not isinstance(item, dict) or item.get("family") not in (
                    "asset_files",
                    "bundle_directory_members",
                ):
                    raise ReplicaError("Invalid ordered member")
                expected = {"id", "family", "sequence"}
                if item["family"] == "asset_files":
                    expected.add("role")
                    validate_cell("asset_files", "role", item.get("role"))
            if not isinstance(item, dict) or set(item) != expected:
                raise ReplicaError("Unsupported structural member; upgrade required")
            identity = item["id"]
            if not isinstance(identity, str) or not TOKEN.fullmatch(identity) or identity in seen:
                raise ReplicaError("Duplicate or invalid structural identity")
            seen.add(identity)
            validate_cell(
                family if field == "$forest" else item["family"],
                "sort_order" if field == "$forest" else "sequence",
                item["sort_order"] if field == "$forest" else item["sequence"],
            )
            if field == "$forest":
                parents[identity] = item["parent_id"]
        for identity in parents:
            chain: set[str] = set()
            parent: str | None = identity
            while parent is not None:
                if parent in chain or parent not in parents:
                    raise ReplicaError("Hierarchy is cyclic or incomplete")
                chain.add(parent)
                parent = parents[parent]
    elif field in COMPOSITES.get(family, {}):
        columns = COMPOSITES[family][field]
        if not isinstance(value, dict) or set(value) != set(columns):
            raise ReplicaError("Incomplete composite catalog value")
        for column, cell in value.items():
            validate_cell(family, column, cell)
        if field == "$span" and (
            value["start_s"] < 0
            or (value["end_s"] is not None and value["end_s"] <= value["start_s"])
        ):
            raise ReplicaError("Invalid moment range")
        if field == "$filter":
            validate_filter(value)
        if field == "$source" and (
            (value["source_file_id"] is None) == (value["embedded_index"] is None)
            or value["embedded_index"] is not None
            and value["video_file_id"] is None
        ):
            raise ReplicaError("Subtitle selection requires one valid source")
    else:
        validate_cell(family, field, value)
    return value


# Compile the full allowlisted AST while preserving the original opaque source text
def validate_filter(value: Row) -> None:
    from pydantic import ValidationError
    from sqlalchemy.orm import Session

    from cairndex.core.errors import ValidationError as FilterError
    from cairndex.filters.ast import FilterExpression
    from cairndex.filters.compiler import compile_expression

    if value["filter_version"] != 1:
        raise ReplicaError("Unsupported filter version; upgrade required")
    try:
        expression = FilterExpression.model_validate(json.loads(value["filter_json"]))
        # Descendant expansion is a query optimization, not a different operator contract
        pending: list[Any] = [expression.root]
        while pending:
            node = pending.pop()
            if hasattr(node, "include_descendants"):
                node.include_descendants = False
            pending.extend(getattr(node, "children", []))
            if hasattr(node, "child"):
                pending.append(node.child)
        with Session() as session:
            compile_expression(session, expression)
    except (ValidationError, FilterError, ValueError, TypeError) as error:
        raise ReplicaError("Unsupported saved filter; upgrade or recovery required") from error


# Row mapping emits no observations, progress, plans, credentials or recovery records
def row_units(family: str, row: Row) -> Iterator[tuple[str, str]]:
    if set(row) != set(AUTHORED[family]):
        raise ReplicaError("Incomplete authored row or unsupported field")
    identity = entity_id(family, row)
    for column, cell in row.items():
        validate_cell(family, column, cell)
    for field in sorted(fields(family) - {"$members"}):
        value: Any = row.get(field)
        if field == "$alive":
            value = True
        elif field in COMPOSITES.get(family, {}):
            value = {column: row[column] for column in COMPOSITES[family][field]}
        unit, raw = key(family, identity, field), value_text(value)
        validate_unit(unit, raw)
        yield unit, raw


# Ordered membership preserves duplicate sequence values and directory/file identity separately
def member_units(bundle: str, rows: Iterable[tuple[str, Row]]) -> tuple[str, str]:
    members = []
    for family, row in rows:
        member = {"family": family, "id": row["id"], "sequence": row["sequence"]}
        if family == "asset_files":
            member["role"] = row["role"]
        members.append(member)
    members.sort(key=lambda item: (item["sequence"], item["family"], item["id"]))
    return key("asset_bundles", bundle, "$members"), value_text(members)


# Ownership claims and file-dependent controls form indexed domain constraints across candidates
def structural_targets(unit: str, raw: str) -> set[tuple[str, str]]:
    family, identity, field = split_key(unit)
    value = json.loads(raw)
    if family == "collections" and field == "cover_bundle_id" and value:
        return {(f"asset_bundles/{value}", "collection_cover")}
    if family == "asset_bundle_collections" and field == "$alive" and value:
        return {(f"asset_bundles/{identity.split('~', 1)[0]}", "collection_member")}
    if field == "$members":
        return {(f"{item['family']}/{item['id']}", "owner") for item in value}
    if field in ("$span", "$source"):
        return {
            (f"asset_files/{cell}", "reference")
            for column, cell in value.items()
            if cell is not None and column in ("file_id", "video_file_id", "source_file_id")
        }
    if family == "asset_bundles" and field in ("cover_file_id", "primary_file_id") and value:
        return {(f"asset_files/{value}", "reference")}
    return set()


# Reconstruct exact authored rows using only each entity's units and structural placement
def restore_row(
    family: str, identity: str, values: Mapping[str, str], placement: Row
) -> Row | None:
    if set(values) - ({"$content"} if family == "asset_files" else set()) != fields(family):
        raise ReplicaError("Catalog entity is incomplete")
    if not json.loads(values["$alive"]):
        return None
    row: Row = dict(zip(IDENTITIES[family], identity.split("~"), strict=True))
    row.update(placement)
    for field, raw in values.items():
        value = validate_unit(key(family, identity, field), raw)
        if field in COMPOSITES.get(family, {}):
            row.update(value)
        elif not field.startswith("$"):
            row[field] = value
    if set(row) != set(AUTHORED[family]):
        raise ReplicaError("Catalog placement is incomplete")
    return row
