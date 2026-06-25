"""Adjacency-list hierarchy helpers (ADR-0002).

Tags and folders both use a ``parent_id`` self-reference. Descendant
expansion (for the "include descendants" toggle on tag/folder selection and
filters) is done with a SQLite recursive CTE.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.persistence.models import Folder, Tag

type HierarchyModel = type[Tag] | type[Folder]


def descendant_ids(
    session: Session,
    model: HierarchyModel,
    root_id: str,
    *,
    include_self: bool = True,
) -> list[str]:
    """Return ``root_id`` and all transitive descendant ids (recursive CTE)."""
    anchor = select(model.id.label("id")).where(model.id == root_id).cte(recursive=True)
    children = select(model.id).join(anchor, model.parent_id == anchor.c.id)
    cte = anchor.union_all(children)

    ids = list(session.scalars(select(cte.c.id)))
    if not include_self:
        ids = [i for i in ids if i != root_id]
    return ids


def is_descendant(
    session: Session, model: HierarchyModel, *, candidate_id: str, of_id: str
) -> bool:
    """True if ``candidate_id`` is ``of_id`` or below it — used for cycle checks."""
    return candidate_id in descendant_ids(session, model, of_id, include_self=True)
