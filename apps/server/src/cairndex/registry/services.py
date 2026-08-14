"""Library registry domain service (ADR-0008).

HTTP-agnostic operations over registered libraries: create a new library
package, register an existing one, probe a candidate path, list/get registry
rows, and deregister one. The registry is server-local runtime state; a
library's content metadata lives in its own ``library.db`` and is never
modified here — deregistering removes the row and nothing on disk.
"""

import logging
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.time import utcnow
from cairndex.domain.enums import LibraryStatus
from cairndex.registry import library_package as pkg
from cairndex.registry.models import RegisteredLibrary

logger = logging.getLogger(__name__)


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


@dataclass(frozen=True)
class PathProbe:
    """What the add-library flow needs to know about a candidate path.

    Answers the three questions the unified "Add library" step asks before it
    does anything: is there a folder there, is it already a Cairndex library,
    and does this server already have it registered. Everything is read-only —
    probing creates nothing.
    """

    exists: bool
    is_library: bool
    # The registry id when this server already has this folder (matched by path,
    # or by portable uuid for a library that moved). Selecting it is then the
    # whole action; registering again would only 409.
    already_registered_id: str | None
    # The library's own name, so registering an existing library adopts the name
    # it travels with rather than one derived from its current folder.
    manifest_display_name: str | None
    # The basename, which prefills the name field when a plain folder is about to
    # become a library. Empty for a filesystem root, which has no basename.
    folder_name: str


def probe_path(session: Session, root_path: str) -> PathProbe:
    """Classify a candidate library path without changing anything.

    Same owner-setup trust level as :func:`suggest_paths`: it reports on an
    absolute server path the owner typed, and reveals only whether a directory
    is there and whether it carries a library marker. A present-but-broken
    marker raises rather than reporting "not a library" — the honest answer is
    the parse error, not an invitation to create a second library over it.
    """
    root = _normalize_root(root_path)
    manifest = pkg.detect(root) if root.is_dir() else None
    registered = session.scalars(
        select(RegisteredLibrary).where(RegisteredLibrary.root_path == root.as_posix())
    ).first()
    if registered is None and manifest is not None:
        # A library that moved keeps its portable uuid, so the row we already
        # have for it is under the *old* path. Registering would fail the unique
        # uuid constraint; selecting the existing row is what the user wants.
        registered = session.scalars(
            select(RegisteredLibrary).where(RegisteredLibrary.library_uuid == manifest.library_uuid)
        ).first()
    return PathProbe(
        exists=root.exists(),
        is_library=manifest is not None,
        already_registered_id=registered.id if registered is not None else None,
        manifest_display_name=manifest.display_name if manifest is not None else None,
        folder_name=root.name,
    )


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


def deregister_library(session: Session, library_id: str) -> None:
    """Remove a library from this server's registry. **Metadata-only.**

    Deletes the registry row and nothing else: the library folder, its
    ``.cairndex/`` package, its ``library.db``, and every media file are left
    exactly as they are (AGENTS.md file-safety rules). Re-adding the same folder
    later restores everything the user cares about, because none of it lives in
    the registry (ADR-0018 §1).

    Two things are cleaned up on the way out, both server-runtime state:

    - the ownership lease is released, which ADR-0018 §3 lists alongside clean
      shutdown as a release trigger — a server that no longer serves a library
      must not keep holding it, or the next machine to open the folder meets a
      takeover prompt for a library nobody is serving;
    - the cached content engine is disposed, which closes the last connection so
      SQLite folds the WAL back into a single consistent file (ADR-0018 §6);
    - the library's grouping plans are deleted, because ADR-0022 moved them into
      *this server's* data directory, where nothing else would ever remove them.
      A re-added folder regenerates its plan, which is what a plan is for.

    Queued jobs for the library go with the row through the ``ON DELETE
    CASCADE`` on ``job_queue``. A job already *running* stops at its next
    checkpoint, because the released lease makes its ownership check fail.
    """
    # Imported here rather than at module scope: the registry is the lower layer
    # (ownership's manager reads the server identity *from* it at build time),
    # so a top-level import would be a cycle waiting to happen.
    from cairndex.ownership import get_lease_manager
    from cairndex.persistence.engine import discard_plans_database
    from cairndex.registry import library_package as pkg
    from cairndex.registry.library_engine import dispose_library_engine

    library = session.get(RegisteredLibrary, library_id)
    if library is None:
        raise NotFoundError(f"library {library_id!r} not found")

    try:
        get_lease_manager().release(library_id)
    except Exception:  # noqa: BLE001 — an unreachable mount must not block removal
        # The lease then ages out to stale, which is recoverable with a
        # confirmation; refusing to deregister a library on an offline NAS would
        # leave the user no way to clean up their own list.
        logger.warning("could not release the lease for library %s", library_id, exc_info=True)
    dispose_library_engine(library_id)
    # After disposing the engine, so no connection still holds the file.
    discard_plans_database(pkg.db_path(Path(library.root_path)))

    session.delete(library)
    session.flush()


_MAX_SUGGESTIONS = 50


@dataclass(frozen=True)
class PathSuggestion:
    """One directory autocompletion, marked when it is already a library."""

    path: str
    # Whether the directory carries a ``.cairndex/manifest.json``. The add-library
    # menu badges these, so the owner can see which folder is the library before
    # committing to it instead of finding out from an error.
    is_library: bool


def suggest_paths(prefix: str) -> list[PathSuggestion]:
    """Directory autocompletions for an absolute path prefix (owner setup only).

    Lists real directories the server process can see — the host filesystem, or
    only up to the image root inside a container. Returns directories only, never
    file contents, and is capped. An empty/relative prefix lists the filesystem
    root. Used by the add-library form to pick a library root.

    Each returned directory is stat-ed once for its library marker. The list is
    capped at ``_MAX_SUGGESTIONS``, so that is a bounded 50 extra stats on a
    typing-latency path, not a scan.
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

    out: list[PathSuggestion] = []
    for entry in children:
        try:
            if entry.is_dir():
                out.append(
                    PathSuggestion(
                        path=entry.as_posix(),
                        is_library=pkg.manifest_path(entry).is_file(),
                    )
                )
        except OSError:
            continue  # skip entries we can't stat (e.g. permission denied)
        if len(out) >= _MAX_SUGGESTIONS:
            break
    return out
