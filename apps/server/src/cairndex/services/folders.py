"""Folder domain service: hierarchical virtual collections (AGENTS.md §4.7)."""

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.time import utcnow
from cairndex.persistence.models import Folder
from cairndex.services.hierarchy import descendant_ids, is_descendant
from cairndex.services.pagination import keyset_page


def get_folder(session: Session, folder_id: str) -> Folder:
    folder = session.get(Folder, folder_id)
    if folder is None:
        raise NotFoundError(f"folder {folder_id!r} not found")
    return folder


def _require_parent(session: Session, parent_id: str | None) -> None:
    if parent_id is not None and session.get(Folder, parent_id) is None:
        raise ValidationError(f"parent folder {parent_id!r} does not exist")


def create_folder(session: Session, *, name: str, parent_id: str | None = None) -> Folder:
    name = name.strip()
    if not name:
        raise ValidationError("name must not be empty")
    _require_parent(session, parent_id)

    folder = Folder(name=name, parent_id=parent_id)
    session.add(folder)
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError(
            f"a sibling folder named {name!r} already exists under this parent"
        ) from exc
    return folder


def list_folders(
    session: Session, *, limit: int, cursor: str | None
) -> tuple[list[Folder], str | None]:
    return keyset_page(session, select(Folder), Folder.id, limit, cursor)


def update_folder(
    session: Session,
    folder_id: str,
    *,
    name: str | None = None,
    parent_id: str | None = None,
    set_parent: bool = False,
) -> Folder:
    folder = get_folder(session, folder_id)

    if name is not None:
        cleaned = name.strip()
        if not cleaned:
            raise ValidationError("name must not be empty")
        folder.name = cleaned

    if set_parent:
        if parent_id == folder_id:
            raise ValidationError("a folder cannot be its own parent")
        if parent_id is not None:
            _require_parent(session, parent_id)
            if is_descendant(session, Folder, candidate_id=parent_id, of_id=folder_id):
                raise ValidationError("cannot move a folder under its own descendant")
        folder.parent_id = parent_id

    folder.updated_at = utcnow()
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError("a sibling folder with that name already exists") from exc
    return folder


def delete_folder(session: Session, folder_id: str) -> None:
    """Delete a folder (metadata only). Children float to root (DB SET NULL);
    bundle memberships cascade — no bundle or file is deleted."""
    session.delete(get_folder(session, folder_id))
    session.flush()


def folder_descendant_ids(
    session: Session, folder_id: str, *, include_self: bool = True
) -> list[str]:
    get_folder(session, folder_id)
    return descendant_ids(session, Folder, folder_id, include_self=include_self)
