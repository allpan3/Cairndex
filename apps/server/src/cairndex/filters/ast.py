"""The versioned, JSON-serializable filter AST (docs/filter-language.md).

One canonical model backs both the simple toolbar filters and Smart Collections.
It is validated by Pydantic on the way in and compiled to parameterized
SQLAlchemy by ``filters.compiler`` — raw values never reach SQL as text.

Node shapes are disambiguated structurally (``extra="forbid"`` + Pydantic's
smart union): logical nodes carry ``op``; predicate nodes carry ``field``.
"""

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

FILTER_VERSION = 1


class _Node(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AndNode(_Node):
    op: Literal["and"]
    children: list["FilterNode"]


class OrNode(_Node):
    op: Literal["or"]
    children: list["FilterNode"]


class NotNode(_Node):
    op: Literal["not"]
    child: "FilterNode"


class PredicateNode(_Node):
    field: str
    operator: str
    value: Any = None
    # Tag/collection predicates may expand a parent to its descendants.
    include_descendants: bool = False


FilterNode = Annotated[
    AndNode | OrNode | NotNode | PredicateNode,
    Field(union_mode="smart"),
]


class FilterExpression(BaseModel):
    """A complete, versioned filter expression (the stored/transmitted form)."""

    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    root: FilterNode | None = None  # null/empty = match everything


AndNode.model_rebuild()
OrNode.model_rebuild()
NotNode.model_rebuild()
