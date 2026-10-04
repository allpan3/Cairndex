"""Model-backed controls for shared family editors and exact text preservation"""

from typing import Any

from sqlalchemy import JSON, Boolean, Enum, Float, Integer

from cairndex.persistence.base import Base
from cairndex.replicas.catalog.model import COMPOSITES, fields


# Controls expose authored values only, with structural units identified for dedicated review
def controls(family: str) -> list[dict[str, Any]]:
    result = []
    for field in sorted(fields(family)):
        nullable, choices, reference = False, [], None
        if field == "$alive":
            kind, label = "lifetime", "Existence"
        elif field.startswith("$"):
            kind = "structure"
            label = {
                "$members": "Files and directory order",
                "$filter": "Saved filter",
                "$span": "Moment range",
                "$source": "Subtitle source",
            }.get(field, field)
        else:
            column = Base.metadata.tables[family].c[field]
            nullable, label = bool(column.nullable), field.replace("_", " ").capitalize()
            if column.foreign_keys:
                kind = "reference"
                reference = next(iter(column.foreign_keys)).column.table.name
            elif isinstance(column.type, Enum):
                kind, choices = "enum", column.type.enums
            elif isinstance(column.type, Boolean):
                kind = "boolean"
            elif isinstance(column.type, (Integer, Float)):
                kind = "number"
            elif isinstance(column.type, JSON):
                kind = "json"
            else:
                kind = "text"
        result.append(
            {
                "field": field,
                "label": label,
                "kind": kind,
                "nullable": nullable,
                "choices": choices,
                "reference_family": reference,
                "columns": list(COMPOSITES.get(family, {}).get(field, ())),
            }
        )
    return result


# New rows receive current authored defaults while relationship choices remain explicit
def creation(family: str) -> dict[str, Any]:
    from cairndex.core.ids import new_id
    from cairndex.core.time import utcnow
    from cairndex.replicas.catalog.model import AUTHORED, value_text

    cells: dict[str, str] = {}
    descriptions = []
    for name in AUTHORED[family]:
        column = Base.metadata.tables[family].c[name]
        nullable = bool(column.nullable)
        choices, reference = [], None
        if name == "id":
            value: Any = new_id()
        elif name.endswith("_at"):
            value = None if nullable else utcnow().replace(tzinfo=None).isoformat(sep=" ")
        elif nullable:
            value = None
        elif isinstance(column.type, Enum):
            value = column.type.enums[0]
        elif isinstance(column.type, Boolean):
            value = 0
        elif isinstance(column.type, (Integer, Float)):
            value = 1 if name in ("version", "filter_version") else 0
        elif isinstance(column.type, JSON):
            value = '{"version":1,"root":null}' if name == "filter_json" else "{}"
        else:
            value = ""
        if column.foreign_keys:
            kind, reference = "reference", next(iter(column.foreign_keys)).column.table.name
        elif isinstance(column.type, Enum):
            kind, choices = "enum", column.type.enums
        elif isinstance(column.type, Boolean):
            kind = "boolean"
        elif isinstance(column.type, (Integer, Float)):
            kind = "number"
        elif isinstance(column.type, JSON):
            kind = "json"
        else:
            kind = "text"
        cells[name] = value_text(value)
        descriptions.append(
            {
                "field": name,
                "label": name.replace("_", " ").capitalize(),
                "nullable": nullable,
                "kind": kind,
                "choices": choices,
                "reference_family": reference,
                "columns": [],
            }
        )
    return {"cells": cells, "controls": descriptions}
