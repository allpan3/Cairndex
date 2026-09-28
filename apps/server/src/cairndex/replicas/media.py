"""Device-local media observations over validated catalog rows, without legacy SQL"""

import hashlib
import json
import mimetypes
import os
import sqlite3
import stat
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from pathlib import Path
from threading import BoundedSemaphore
from typing import Any

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.core.paths import PathSafetyError, normalize_relative_path, resolve_within_root
from cairndex.domain.enums import FileAvailability, FileRole, MediaKind
from cairndex.media.ffprobe import PROBE_VERSION, ProbeError, normalize_metadata, run_ffprobe
from cairndex.persistence.models import AssetFile, SubtitleTrack
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError
from cairndex.scanning.media_types import classify

_PROBE_SLOTS = BoundedSemaphore(2)

SCHEMA = """
CREATE TABLE IF NOT EXISTS local_media (
    file_id TEXT PRIMARY KEY, generation TEXT, state TEXT NOT NULL,
    metadata TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS local_progress (
    file_id TEXT PRIMARY KEY, generation TEXT NOT NULL, position REAL NOT NULL,
    duration REAL, completed INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS local_cursors (bundle_id TEXT PRIMARY KEY, file_id TEXT NOT NULL);
"""


# Generation identifies observed bytes, never a shared content hash or discovery transaction
def generation(path: str, info: os.stat_result) -> str:
    values = [path, info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]
    return hashlib.sha256(json.dumps(values).encode()).hexdigest()


# Reject symlink components and non-regular files while holding the actual source descriptor
@contextmanager
def open_source(root: Path, relative: str) -> Iterator[int]:
    parts = normalize_relative_path(relative).split("/")
    if any(part.startswith(".") for part in parts):
        raise ValidationError("Hidden library paths cannot be played")
    handles: list[int] = []
    try:
        handles.append(os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
        for index, part in enumerate(parts):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if index < len(parts) - 1:
                flags |= os.O_DIRECTORY
            handles.append(os.open(part, flags, dir_fd=handles[-1]))
        if not stat.S_ISREG(os.fstat(handles[-1]).st_mode):
            raise ValidationError("Only regular local files can be played")
        yield handles[-1]
    finally:
        for handle in reversed(handles):
            os.close(handle)


# A narrow adapter reads authored rows and writes only explicitly private observation tables
class ReplicaMedia:
    # The store already validates the descriptor and private-directory identity
    def __init__(self, store: CatalogStore, root: Path, library_id: str) -> None:
        self.store, self.root, self.library_id = store, root, library_id

    # Pin every input through no-follow directory descriptors for the subprocess lifetime
    @contextmanager
    def input_scope(self, files: dict[str, str | None]) -> Iterator[None]:
        from cairndex.media.inputs import inherited_inputs

        with ExitStack() as stack:
            inputs = {}
            for identity, token in files.items():
                row = self.row("asset_files", identity)
                handle = stack.enter_context(open_source(self.root, row["relative_path"]))
                if generation(row["relative_path"], os.fstat(handle)) != token:
                    raise ReplicaError("Local media changed; retry playback")
                inputs[self.root / row["relative_path"]] = handle
            with inherited_inputs(inputs):
                yield

    # Read one committed authored entity using its family/identity index
    def row(self, family: str, identity: str) -> dict[str, Any]:
        with self.store.connection(readonly=True) as db:
            value = read_row(db, family, identity)
        if value is None:
            raise NotFoundError("Catalog item is unavailable; refresh the catalog")
        return value

    # Discovery evidence fences a changed same-path source before it inherits saved media state
    def check_content(self, identity: str, path: str) -> None:
        if self.store.descriptor.format_version != 3:
            return
        from cairndex.replicas.discovery_sources import inspect

        with self.store.connection(readonly=True) as db:
            value = db.execute(
                "SELECT value FROM catalog_units WHERE unit=?",
                (f"asset_files/{identity}/$content",),
            ).fetchone()
            prior = db.execute(
                "SELECT body FROM discovery_baselines WHERE file_id=?", (identity,)
            ).fetchone()
        baseline = json.loads(prior[0]) if prior else None
        expected = (
            json.loads(value[0])
            if value and value[0]
            else (baseline["evidence"] if baseline and baseline["path"] == path else None)
        )
        if expected is not None and inspect(self.root, path, baseline)["evidence"] != expected:
            raise NotFoundError(
                "Different local content at this path; run Update and review its identity"
            )

    # Local observations never establish shared presence or overwrite authored choices
    def file(self, identity: str, *, inspect: bool = False, probe: bool = False) -> AssetFile:
        row = self.row("asset_files", identity)
        kind = classify(row["relative_path"])
        with self.store.connection(readonly=True) as db:
            cached = db.execute("SELECT * FROM local_media WHERE file_id=?", (identity,)).fetchone()
        token = cached["generation"] if cached else None
        state = cached["state"] if cached else "unknown"
        metadata = json.loads(cached["metadata"]) if cached and cached["metadata"] else None
        size: int | None = None
        if inspect or probe:
            try:
                self.check_content(identity, row["relative_path"])
                with open_source(self.root, row["relative_path"]) as handle:
                    info = os.fstat(handle)
                    current = generation(row["relative_path"], info)
                    size = info.st_size
                if current != token:
                    metadata = None
                token, state = current, "available"
            except (OSError, PathSafetyError, ValidationError):
                token, state, metadata = None, "unavailable", None
            error = None
            if (
                probe
                and kind is not None
                and kind[0] == MediaKind.IMAGE
                and state == "available"
                and not metadata
            ):
                from PIL import Image, UnidentifiedImageError

                try:
                    with open_source(self.root, row["relative_path"]) as handle:
                        if generation(row["relative_path"], os.fstat(handle)) != token:
                            raise ReplicaError("Local image changed; retry inspection")
                        with os.fdopen(os.dup(handle), "rb") as source, Image.open(source) as image:
                            metadata = {"width": image.width, "height": image.height}
                    self.validate(identity, token)
                except (
                    OSError,
                    UnidentifiedImageError,
                    Image.DecompressionBombError,
                    ReplicaError,
                ):
                    metadata = None
                    error = "Local image details are unavailable; retry when it is readable"
            if (
                probe
                and kind is not None
                and kind[0] == MediaKind.VIDEO
                and state == "available"
                and (not metadata or metadata.get("probe_version") != PROBE_VERSION)
            ):
                try:
                    path = resolve_within_root(self.root, row["relative_path"])
                    if not _PROBE_SLOTS.acquire(timeout=0.1):
                        raise ProbeError("Local media probes are busy; retry shortly")
                    try:
                        with self.input_scope({identity: token}):
                            metadata = normalize_metadata(run_ffprobe(path, timeout=10))
                    finally:
                        _PROBE_SLOTS.release()
                    self.validate(identity, token)
                except (OSError, ProbeError, PathSafetyError, ReplicaError):
                    metadata = None
                    error = "Local media could not be read or probed; retry when it is readable"
            with self.store.connection() as db:
                db.execute(
                    "INSERT OR REPLACE INTO local_media VALUES (?, ?, ?, ?, ?)",
                    (identity, token, state, json.dumps(metadata) if metadata else None, error),
                )
        return AssetFile(
            **(row | {"role": FileRole[row["role"]]}),
            media_kind=kind[0] if kind else MediaKind.OTHER,
            mime_type=mimetypes.guess_type(row["relative_path"])[0],
            availability=FileAvailability.AVAILABLE
            if state == "available"
            else FileAvailability.MISSING,
            quick_fingerprint=token,
            size_bytes=size,
            tech_metadata=metadata,
        )

    def catalog_file(self, db: sqlite3.Connection, identity: str) -> AssetFile:
        """Read playlist metadata from the caller's snapshot without observing bytes."""
        row = read_row(db, "asset_files", identity)
        if row is None:
            raise NotFoundError("Catalog file is unavailable")
        kind = classify(row["relative_path"])
        return AssetFile(
            **(row | {"role": FileRole[row["role"]]}),
            media_kind=kind[0] if kind else MediaKind.OTHER,
            mime_type=mimetypes.guess_type(row["relative_path"])[0],
            availability=FileAvailability.MISSING,
        )

    # Validate the opening generation before every byte/cache/session/progress operation
    def validate(self, file_id: str, expected: str | None) -> Path:
        row = self.row("asset_files", file_id)
        try:
            with open_source(self.root, row["relative_path"]) as handle:
                current = generation(row["relative_path"], os.fstat(handle))
            if expected is not None and current != expected:
                raise ReplicaError("Local media changed; retry to open the current file")
            return resolve_within_root(self.root, row["relative_path"])
        except (OSError, PathSafetyError) as error:
            raise NotFoundError(
                "Media unavailable on this device; make the local file readable and retry"
            ) from error

    # Media services receive detached values, never an ORM session capable of authored writes
    def resolve_file(self, identity: str, *, probe: bool = False) -> tuple[Path, AssetFile]:
        asset = self.file(identity, inspect=True, probe=probe)
        if asset.availability != FileAvailability.AVAILABLE:
            raise NotFoundError(
                "Media unavailable on this device; make the local file readable and retry"
            )
        return self.validate(identity, asset.quick_fingerprint), asset

    # Reuse the reverse-reference index instead of scanning the complete catalog
    def related(self, family: str, target: str) -> list[dict[str, Any]]:
        with self.store.connection(readonly=True) as db:
            return [
                json.loads(row[0])
                for row in db.execute(
                    "SELECT c.body FROM catalog_references r JOIN catalog_rows c "
                    "ON r.source=c.family || '/' || c.entity WHERE r.target=? AND c.family=?",
                    (target, family),
                )
            ]

    # Cataloged embedded/external choices remain authored; probes never discover or replace tracks
    def tracks(self, file_id: str) -> list[SubtitleTrack]:
        asset = self.row("asset_files", file_id)
        rows = self.related("subtitle_tracks", f"asset_bundles/{asset['bundle_id']}")
        tracks = [SubtitleTrack(**row) for row in rows if row["video_file_id"] in (None, file_id)]
        return sorted(tracks, key=lambda track: (track.sort_order, track.id))

    # Private cache names include both source generation and authored derivation inputs
    def cache(self, kind: str, identity: str, token: str, suffix: str) -> Path:
        digest = hashlib.sha256(f"{identity}:{token}".encode()).hexdigest()
        base = self.store.path.parent / "cache"
        dest = base / kind / digest[:2] / f"{digest}{suffix}"
        if dest.resolve() != dest or any(parent.is_symlink() for parent in dest.parents):
            raise ReplicaError("Private media cache must not be symlinked")
        dest.parent.mkdir(parents=True, exist_ok=True)
        return dest

    # Resume belongs to the observed bytes on this device and survives server restart
    def progress(self, file_id: str, token: str | None) -> dict[str, Any] | None:
        with self.store.connection(readonly=True) as db:
            row = db.execute(
                "SELECT position,duration,completed FROM local_progress "
                "WHERE file_id=? AND generation=?",
                (file_id, token),
            ).fetchone()
        return dict(position_s=row[0], duration_s=row[1], completed=bool(row[2])) if row else None

    # Missing generation is rejected for replica writes while legacy payloads remain compatible
    def save_progress(
        self, file_id: str, token: str | None, position: float, duration: float | None
    ) -> dict[str, Any]:
        from cairndex.services.playback_progress import clamp_position, is_completed

        if not token:
            raise ValidationError("Replica progress requires the observed source generation")
        self.validate(file_id, token)
        position = clamp_position(position, duration)
        completed = is_completed(position, duration)
        with self.store.connection() as db:
            db.execute(
                "INSERT OR REPLACE INTO local_progress VALUES (?, ?, ?, ?, ?)",
                (file_id, token, position, duration, completed),
            )
        return dict(position_s=position, duration_s=duration, completed=completed)
