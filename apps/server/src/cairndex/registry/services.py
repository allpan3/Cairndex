"""Library registry domain service (ADR-0008).

HTTP-agnostic operations over registered libraries: create a new library
package, register an existing one, and list/get registry rows. The registry is
server-local runtime state; a library's content metadata lives in its own
``library.db`` and is not touched here.
"""

from pathlib import Path

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.time import utcnow
from cairndex.domain.enums import LibraryStatus
from cairndex.registry import library_package as pkg
from cairndex.registry.models import RegisteredLibrary


def _normalize_root(raw: str) -> Path:
    candidate = raw.strip()
    if not candidate:
        raise ValidationError("root_path must not be empty")
    if "\x00" in candidate:
        raise ValidationError("null byte in path")
    path = Path(candidate)
    if not path.is_absolute():
        raise ValidationError("root_path must be an absolute server path")
    # Lexically normalize; do not require existence (a NAS mount may be offline).
    return Path(path).resolve(strict=False)


def _probe_status(root: Path) -> LibraryStatus:
    """A library is available when its root, marker DB, and manifest all exist."""
    ok = root.is_dir() and pkg.db_path(root).is_file() and pkg.manifest_path(root).is_file()
    return LibraryStatus.AVAILABLE if ok else LibraryStatus.UNAVAILABLE


def _insert(session: Session, *, manifest: pkg.LibraryManifest, root: Path) -> RegisteredLibrary:
    library = RegisteredLibrary(
        library_uuid=manifest.library_uuid,
        name=manifest.display_name,
        root_path=root.as_posix(),
        manifest_path=pkg.manifest_path(root).as_posix(),
        status=_probe_status(root),
        schema_version=manifest.format_version,
    )
    session.add(library)
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError("a library with that path or identity is already registered") from exc
    return library


def create_library(
    session: Session, *, root_path: str, display_name: str, create_if_missing: bool = False
) -> RegisteredLibrary:
    """Create a new library package under ``root_path`` and register it."""
    name = display_name.strip()
    if not name:
        raise ValidationError("display_name must not be empty")
    root = _normalize_root(root_path)

    if not root.exists():
        if not create_if_missing:
            raise ValidationError(f"root path {root.as_posix()!r} does not exist")
        try:
            root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ValidationError(f"could not create {root.as_posix()!r}: {exc}") from exc
    elif not root.is_dir():
        raise ValidationError(f"root path {root.as_posix()!r} is not a directory")

    if pkg.detect(root) is not None:
        raise ConflictError(f"{root.as_posix()!r} is already a Cairndex library")

    manifest = pkg.create_package(root, name)
    return _insert(session, manifest=manifest, root=root)


def register_existing_library(session: Session, *, root_path: str) -> RegisteredLibrary:
    """Register an existing library directory (validates its marker)."""
    root = _normalize_root(root_path)
    if not root.is_dir():
        raise ValidationError(f"root path {root.as_posix()!r} is not an existing directory")

    manifest = pkg.detect(root)  # raises ValidationError if the marker is broken
    if manifest is None:
        raise ValidationError(f"{root.as_posix()!r} is not a Cairndex library (no marker found)")
    if not pkg.db_path(root).is_file():
        raise ValidationError(f"library at {root.as_posix()!r} is missing its {pkg.DB_NAME}")

    return _insert(session, manifest=manifest, root=root)


def get_library(session: Session, library_id: str) -> RegisteredLibrary:
    library = session.get(RegisteredLibrary, library_id)
    if library is None:
        raise NotFoundError(f"library {library_id!r} not found")
    # Re-probe so a freshly fetched row reflects current mount availability.
    status = _probe_status(Path(library.root_path))
    if status != library.status:
        library.status = status
        library.updated_at = utcnow()
        session.flush()
    return library


def list_libraries(session: Session) -> list[RegisteredLibrary]:
    """All registered libraries, newest first, with availability re-probed."""
    stmt = select(RegisteredLibrary).order_by(RegisteredLibrary.id.desc())
    libraries = list(session.scalars(stmt))
    changed = False
    for library in libraries:
        status = _probe_status(Path(library.root_path))
        if status != library.status:
            library.status = status
            library.updated_at = utcnow()
            changed = True
    if changed:
        session.flush()
    return libraries
