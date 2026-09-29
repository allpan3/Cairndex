"""Library registry domain service (ADR-0008).

HTTP-agnostic operations over registered libraries: create a new library
package, register an existing one, probe a candidate path, list/get registry
rows, and deregister one. The registry is server-local runtime state; a
library's content metadata lives in its own ``library.db`` and is never
modified here — deregistering removes the row and nothing on disk.
"""

import errno
import logging
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, DomainError, NotFoundError, ValidationError
from cairndex.core.time import utcnow
from cairndex.domain.enums import LibraryStatus
from cairndex.registry import library_package as pkg
from cairndex.registry.models import RegisteredLibrary
from cairndex.replicas.protocol import PackageFormatError

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
    """Report availability only for a supported portable package"""
    try:
        manifest = pkg.read_manifest(root)
        ok = root.is_dir() and manifest.replica is not None
    except ValidationError:
        ok = False
    except (DomainError, OSError, UnicodeError):
        ok = False
    return LibraryStatus.AVAILABLE if ok else LibraryStatus.UNAVAILABLE


def _insert(session: Session, *, manifest: pkg.LibraryManifest, root: Path) -> RegisteredLibrary:
    library = RegisteredLibrary(
        library_uuid=manifest.library_uuid,
        name=manifest.display_name,
        root_path=root.as_posix(),
        manifest_path=pkg.manifest_path(root).as_posix(),
        status=_probe_status(root),
        schema_version=manifest.format_version,
        package_format=manifest.package_format,
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

    from cairndex.core.config import get_settings
    from cairndex.replicas.catalog.creation import create

    try:
        create(root, get_settings().data_dir.resolve(), name)
    except OSError as exc:
        if exc.errno in {errno.ENOTSUP, errno.EOPNOTSUPP, errno.ENOSYS}:
            raise ValidationError(
                "Library storage does not support exclusive metadata publication. "
                "Creation is incomplete; source files remain unchanged."
            ) from exc
        raise ValidationError(
            "Library storage could not complete creation. Check storage availability, "
            "permissions and free space. Incomplete metadata is retained for review."
        ) from exc
    manifest = pkg.read_manifest(root)
    existing = session.scalar(
        select(RegisteredLibrary).where(RegisteredLibrary.library_uuid == manifest.library_uuid)
    )
    if existing:
        return existing
    return _insert(session, manifest=manifest, root=root)


def register_existing_library(session: Session, *, root_path: str) -> RegisteredLibrary:
    """Register an existing library directory (validates its marker)."""
    root = _normalize_root(root_path)
    if not root.is_dir():
        raise ValidationError(f"root path {root.as_posix()!r} is not an existing directory")

    manifest = pkg.detect(root)  # raises ValidationError if the marker is broken
    if manifest is None:
        raise ValidationError(f"{root.as_posix()!r} is not a Cairndex library (no marker found)")
    if manifest.replica is None:
        raise PackageFormatError(
            "Legacy library format is not supported. Convert a separate copy before opening."
        )

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
    if manifest is not None and manifest.replica is None:
        raise PackageFormatError(
            "Legacy library format is not supported. Convert a separate copy before opening."
        )
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
    if library.package_format == pkg.FORMAT:
        raise PackageFormatError(
            "Legacy library format is not supported. Convert a separate copy before opening."
        )
    if pkg.manifest_path(Path(library.root_path)).exists():
        try:
            manifest = pkg.read_manifest(Path(library.root_path))
        except (ValidationError, OSError, UnicodeError):
            pass  # Preserve existing locked/unavailable behavior for unreadable manifests
        else:
            if manifest.library_uuid != library.library_uuid:
                raise ConflictError("Registered library identity changed")
            if manifest.package_format != library.package_format:
                raise PackageFormatError("Registered library format changed; recovery required")
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
    """Drain and close under ownership, then remove only the registration

    Source media and content metadata remain intact. Same-run grouping plans
    remain in the server-local store; ADR-0022 discards them at server startup.
    Running jobs stop at a cooperative boundary before the row is deleted;
    queued jobs cascade with the registration. Incomplete draining is retryable
    """
    from cairndex.ownership.lifecycle import lifecycle

    library = session.get(RegisteredLibrary, library_id)
    if library is None:
        raise NotFoundError(f"library {library_id!r} not found")
    lifecycle.close(library_id)

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
