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
from cairndex.persistence.engine import create_app_engine

MARKER_DIR = ".cairndex"
MANIFEST_NAME = "manifest.json"
DB_NAME = "library.db"
CACHE_DIR = "cache"
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


def marker_dir(root: Path) -> Path:
    return root / MARKER_DIR


def manifest_path(root: Path) -> Path:
    return marker_dir(root) / MANIFEST_NAME


def db_path(root: Path) -> Path:
    return marker_dir(root) / DB_NAME


def cache_dir(root: Path) -> Path:
    return marker_dir(root) / CACHE_DIR


def _parse_manifest(raw: str) -> LibraryManifest:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValidationError(f"manifest is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValidationError("manifest must be a JSON object")
    if data.get("format") != FORMAT:
        raise ValidationError(f"manifest format must be {FORMAT!r}")
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
    if not path.is_file():
        raise ValidationError(f"no {MARKER_DIR}/{MANIFEST_NAME} found at {root.as_posix()!r}")
    return _parse_manifest(path.read_text(encoding="utf-8"))


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

    engine = create_app_engine(database_url=f"sqlite:///{target.as_posix()}")
    try:
        Base.metadata.create_all(engine)
        ensure_search_schema(engine)
    finally:
        engine.dispose()


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
