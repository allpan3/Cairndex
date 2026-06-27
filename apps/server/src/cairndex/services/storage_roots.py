"""Storage-root domain service.

HTTP-agnostic CRUD over storage roots. A storage root is owner-configured
infrastructure (a trusted server-side mount point), so its ``canonical_path``
is validated to be absolute and stored normalized — but it is distinct from
the per-request relative paths that ``core.paths`` guards.
"""

from pathlib import Path

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.time import utcnow
from cairndex.domain.enums import StorageRootStatus
from cairndex.persistence.models import StorageRoot
from cairndex.services.pagination import keyset_page


def _normalize_canonical_path(raw: str) -> str:
    candidate = raw.strip()
    if not candidate:
        raise ValidationError("canonical_path must not be empty")
    path = Path(candidate)
    if not path.is_absolute():
        raise ValidationError("canonical_path must be an absolute server path")
    # Lexically normalize (collapse '.', '..', duplicate separators). Do not
    # require the path to exist — a NAS mount may be temporarily unavailable.
    return Path(path).resolve(strict=False).as_posix()


def _probe_status(canonical_path: str) -> StorageRootStatus:
    p = Path(canonical_path)
    return StorageRootStatus.AVAILABLE if p.is_dir() else StorageRootStatus.UNAVAILABLE


def create_storage_root(
    session: Session,
    *,
    name: str,
    canonical_path: str,
    read_only: bool = True,
    create_if_missing: bool = False,
) -> StorageRoot:
    name = name.strip()
    if not name:
        raise ValidationError("name must not be empty")
    normalized_path = _normalize_canonical_path(canonical_path)

    if create_if_missing and not Path(normalized_path).exists():
        try:
            Path(normalized_path).mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ValidationError(f"could not create directory {normalized_path!r}: {exc}") from exc

    root = StorageRoot(
        name=name,
        canonical_path=normalized_path,
        read_only=read_only,
        status=_probe_status(normalized_path),
    )
    session.add(root)
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError(f"a storage root named {name!r} already exists") from exc
    return root


_MAX_SUGGESTIONS = 50


def suggest_paths(prefix: str) -> list[str]:
    """Directory autocompletions for an absolute path prefix (owner setup only).

    Lists real directories the server process can see — the host filesystem, or
    only up to the image root inside a container. This intentionally lists server
    directories *outside* any storage root, so it is owner-configuration tooling,
    not a general browse API: it returns directories only, never file contents,
    and is capped. An empty/relative prefix lists the filesystem root.
    """
    if "\x00" in prefix:
        raise ValidationError("null byte in path")

    raw = prefix.strip()
    if not raw or not raw.startswith("/"):
        base, partial = Path("/"), ""
    elif raw.endswith("/"):
        base, partial = Path(raw), ""
    else:
        p = Path(raw)
        base, partial = p.parent, p.name

    try:
        children = sorted(
            entry
            for entry in base.iterdir()
            if not entry.name.startswith(".") and entry.name.lower().startswith(partial.lower())
        )
    except OSError:
        return []  # unreadable/nonexistent base — nothing to suggest

    out: list[str] = []
    for entry in children:
        try:
            if entry.is_dir():
                out.append(entry.as_posix())
        except OSError:
            continue  # skip entries we can't stat (e.g. permission denied)
        if len(out) >= _MAX_SUGGESTIONS:
            break
    return out


def get_storage_root(session: Session, root_id: str) -> StorageRoot:
    root = session.get(StorageRoot, root_id)
    if root is None:
        raise NotFoundError(f"storage root {root_id!r} not found")
    return root


def list_storage_roots(
    session: Session, *, limit: int, cursor: str | None
) -> tuple[list[StorageRoot], str | None]:
    return keyset_page(session, select(StorageRoot), StorageRoot.id, limit, cursor)


def update_storage_root(
    session: Session,
    root_id: str,
    *,
    name: str | None = None,
    canonical_path: str | None = None,
    read_only: bool | None = None,
) -> StorageRoot:
    root = get_storage_root(session, root_id)
    if name is not None:
        cleaned = name.strip()
        if not cleaned:
            raise ValidationError("name must not be empty")
        root.name = cleaned
    if canonical_path is not None:
        root.canonical_path = _normalize_canonical_path(canonical_path)
        root.status = _probe_status(root.canonical_path)
    if read_only is not None:
        root.read_only = read_only
    root.updated_at = utcnow()
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError("a storage root with that name already exists") from exc
    return root


def delete_storage_root(session: Session, root_id: str) -> None:
    """Delete a storage root (metadata only).

    Refused if any asset file is still linked to it (the DB enforces RESTRICT);
    the caller must unlink/remove those bundles first.
    """
    root = get_storage_root(session, root_id)
    session.delete(root)
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError("storage root still has linked files; remove them first") from exc
