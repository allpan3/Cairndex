"""On-disk ``.cairndex/`` library package handling (ADR-0008).

A Cairndex library is a directory containing a ``.cairndex/`` marker with a
``manifest.json``, a ``library.db`` (all content metadata), and a ``cache/``
directory for portable derived media. This module owns the layout, manifest
format, and create/detect operations — independent of the registry DB so the
package format can be reasoned about on its own.
"""

import json
from dataclasses import dataclass
from pathlib import Path

from cairndex.core.errors import ValidationError
from cairndex.core.ids import new_id
from cairndex.core.time import utcnow
from cairndex.persistence import models  # noqa: F401  (populate content metadata)
from cairndex.persistence.base import Base
from cairndex.persistence.engine import library_engine_scope
from cairndex.replicas.catalog.protocol import CatalogDescriptor
from cairndex.replicas.protocol import PACKAGE_FORMAT, Descriptor, PackageFormatError

MARKER_DIR = ".cairndex"
MANIFEST_NAME = "manifest.json"
DB_NAME = "library.db"
CACHE_DIR = "cache"
# Ownership-lease directory (ADR-0018). Reserved by ADR-0008 decision 9 and
# implemented by ``cairndex.ownership``: a server may serve a library only while
# it holds ``locks/active-owner.json`` inside that library. The directory lives
# in the portable package rather than the registry precisely because the two
# servers in a conflict cannot see each other's registries — the folder is the
# only thing both can observe.
LOCKS_DIR = "locks"
LEASE_NAME = "active-owner.json"
# Trash for guarded deletions (ADR-0013 §3.2). Inside the package, not the host
# OS trash: the server runs in containers and on NAS mounts where a per-mount
# trash is unreliable or absent, and an in-package trash travels with the
# library when it is copied or moved, which is the ADR-0008 portability
# guarantee applied to deletions. Already excluded from scans and grouping,
# because everything under `.cairndex/` is.
TRASH_DIR = "trash"
# Portable derived-cache categories. Writers resolve their target under
# ``cache_dir(root)/<category>`` (ADR-0008 phase 8): thumbnails and converted
# WebVTT subtitles land here; storyboards are reserved for later.
CACHE_SUBDIRS = ("thumbnails", "subtitles", "storyboards")

FORMAT = "cairndex.library"
FORMAT_VERSION = 1


@dataclass(frozen=True)
class LibraryManifest:
    """Parsed contents of a library's ``.cairndex/manifest.json``."""

    library_uuid: str
    display_name: str
    format_version: int
    db: str
    content_root: str
    created_at: str
    package_format: str = FORMAT
    replica: Descriptor | CatalogDescriptor | None = None


def marker_dir(root: Path) -> Path:
    return root / MARKER_DIR


def manifest_path(root: Path) -> Path:
    return marker_dir(root) / MANIFEST_NAME


def db_path(root: Path) -> Path:
    return marker_dir(root) / DB_NAME


def cache_dir(root: Path) -> Path:
    return marker_dir(root) / CACHE_DIR


def locks_dir(root: Path) -> Path:
    return marker_dir(root) / LOCKS_DIR


def trash_dir(root: Path) -> Path:
    return marker_dir(root) / TRASH_DIR


def lease_path(root: Path) -> Path:
    return locks_dir(root) / LEASE_NAME


def _parse_manifest(raw: str) -> LibraryManifest:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValidationError(f"manifest is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValidationError("manifest must be a JSON object")
    if data.get("format") == PACKAGE_FORMAT:
        if type(data.get("format_version")) is not int:
            raise PackageFormatError("Unsupported replica format version")
        from pydantic import ValidationError as SchemaError

        try:
            descriptor = (
                CatalogDescriptor.model_validate(data)
                if data["format_version"] == 2
                else Descriptor.model_validate(data)
            )
        except SchemaError as exc:
            raise PackageFormatError(
                "Unsupported replica format or capabilities; upgrade required"
            ) from exc
        return LibraryManifest(
            descriptor.library_uuid,
            descriptor.display_name,
            descriptor.format_version,
            "",
            ".",
            "",
            package_format=PACKAGE_FORMAT,
            replica=descriptor,
        )
    if (
        data.get("format") != FORMAT
        or type(data.get("format_version")) is not int
        or data["format_version"] != FORMAT_VERSION
    ):
        raise PackageFormatError("Unsupported library format; upgrade required")
    if data.get("db", DB_NAME) != DB_NAME or data.get("content_root", ".") != ".":
        raise PackageFormatError("Unsupported library storage layout")
    try:
        return LibraryManifest(
            library_uuid=str(data["library_uuid"]),
            display_name=str(data["display_name"]),
            format_version=int(data["format_version"]),
            db=str(data.get("db", DB_NAME)),
            content_root=str(data.get("content_root", ".")),
            created_at=str(data.get("created_at", "")),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ValidationError(f"manifest is missing or has an invalid field: {exc}") from exc


def read_manifest(root: Path) -> LibraryManifest:
    """Read and validate the manifest at ``root``. Raises if absent/invalid."""
    path = manifest_path(root)
    if path.is_symlink() or marker_dir(root).is_symlink():
        raise PackageFormatError("Library metadata must remain inside its root")
    if not path.is_file():
        raise ValidationError(f"no {MARKER_DIR}/{MANIFEST_NAME} found at {root.as_posix()!r}")
    with path.open("rb") as stream:
        raw = stream.read(16_385)
    if len(raw) > 16_384:
        raise PackageFormatError("Library manifest exceeds the supported size")
    try:
        return _parse_manifest(raw.decode("utf-8"))
    except UnicodeError as error:
        raise ValidationError("manifest is not valid UTF-8") from error


def detect(root: Path) -> LibraryManifest | None:
    """Return the manifest if ``root`` is a library, else ``None``.

    ``None`` means "no marker here" (not a library); a present-but-broken marker
    raises ``ValidationError`` rather than being silently treated as absent.
    """
    if not manifest_path(root).exists():
        return None
    return read_manifest(root)


def _init_library_db(target: Path) -> None:
    """Create a library.db with the current content schema + FTS search index."""
    from cairndex.search import ensure_search_schema

    with library_engine_scope(f"sqlite:///{target.as_posix()}") as engine:
        Base.metadata.create_all(engine)
        ensure_search_schema(engine)


def create_package(root: Path, display_name: str) -> LibraryManifest:
    """Create a fresh ``.cairndex/`` package under ``root``.

    Creates the marker dir, ``manifest.json``, an initialized ``library.db``,
    and the ``cache/`` subtree. Refuses if a marker already exists so an
    existing library is never clobbered.
    """
    marker = marker_dir(root)
    if marker.exists():
        raise ValidationError(f"a {MARKER_DIR} marker already exists at {root.as_posix()!r}")

    marker.mkdir(parents=True)
    for sub in CACHE_SUBDIRS:
        (cache_dir(root) / sub).mkdir(parents=True, exist_ok=True)

    manifest = LibraryManifest(
        library_uuid=new_id(),
        display_name=display_name,
        format_version=FORMAT_VERSION,
        db=DB_NAME,
        content_root=".",
        created_at=utcnow().isoformat(),
    )
    manifest_path(root).write_text(
        json.dumps(
            {
                "format": FORMAT,
                "format_version": manifest.format_version,
                "library_uuid": manifest.library_uuid,
                "display_name": manifest.display_name,
                "created_at": manifest.created_at,
                "db": manifest.db,
                "content_root": manifest.content_root,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    _init_library_db(db_path(root))
    return manifest


# Fence unsupported storage before leases, cached engines or source mutation
def require_legacy(root: Path) -> LibraryManifest:
    manifest = read_manifest(root)
    if manifest.package_format != FORMAT:
        raise PackageFormatError("This library supports only the replica bundle metadata workflow")
    return manifest
