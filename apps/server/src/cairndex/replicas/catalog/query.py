"""Run the established filter compiler against committed private catalog rows."""

import json
import sqlite3
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects import sqlite

from cairndex.filters.ast import FilterExpression
from cairndex.filters.compiler import CatalogFilterContext, compile_expression
from cairndex.persistence.models import AssetBundle
from cairndex.replicas.catalog.model import AUTHORED


def descendants(db: sqlite3.Connection, family: str, identities: list[str]) -> list[str]:
    result: set[str] = set()
    for identity in identities:
        result.update(
            row[0]
            for row in db.execute(
                "WITH RECURSIVE tree(id) AS (SELECT entity FROM catalog_rows "
                "WHERE family=? AND entity=? UNION SELECT c.entity FROM catalog_rows c "
                "JOIN tree ON json_extract(c.body,'$.parent_id')=tree.id WHERE c.family=?) "
                "SELECT id FROM tree",
                (family, identity, family),
            )
        )
    return sorted(result)


# These query-local relations expose authored columns only. They do not create a
# legacy database, ORM session, or a second projection that can diverge on edits.
TABLES = ("asset_bundles", "asset_files", "asset_bundle_tags", "asset_bundle_collections")
RELATIONS = ",".join(
    family
    + " AS (SELECT "
    + ",".join(f"json_extract(body,'$.{column}') AS {column}" for column in AUTHORED[family])
    + f" FROM catalog_rows WHERE family='{family}')"
    for family in TABLES
)


def matching(db: sqlite3.Connection, expression: FilterExpression) -> tuple[str, list[Any]]:
    context = CatalogFilterContext(lambda family, ids: descendants(db, family, ids))
    predicate = compile_expression(context, expression)
    compiled = (
        select(AssetBundle.id)
        .where(predicate)
        .compile(dialect=sqlite.dialect(), compile_kwargs={"render_postcompile": True})
    )
    # Date parameters use the same SQLite representation as the legacy compiler.
    values = []
    for name in compiled.positiontup or []:
        value = compiled.params[name]
        processor = compiled._bind_processors.get(name)
        try:
            values.append(processor(value) if callable(processor) else value)
        except ValueError as error:
            from cairndex.core.errors import ValidationError

            raise ValidationError("Invalid filter value; dates require a timezone") from error
    return f"WITH {RELATIONS} {compiled}", values


def saved_filter(db: sqlite3.Connection, identity: str) -> FilterExpression:
    from cairndex.core.errors import NotFoundError

    row = db.execute(
        "SELECT body FROM catalog_rows WHERE family='smart_folders' AND entity=?", (identity,)
    ).fetchone()
    if row is None:
        raise NotFoundError("Smart Collection is unavailable; refresh the library")
    value = json.loads(row[0])
    return FilterExpression.model_validate_json(value["filter_json"])
