"""One local directory plus retained catalog paths; no authored writes or discovery."""

import errno
import json
import mimetypes
import os
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from cairndex.api.schemas.file_browser import FileBrowserEntryRead, FileBrowserListingRead
from cairndex.core.errors import ValidationError
from cairndex.core.paths import PathSafetyError, normalize_relative_path, resolve_within_root
from cairndex.replicas.media import ReplicaMedia
from cairndex.scanning.media_types import classify, is_hidden_relative_path


def visible(path: str) -> bool:
    return not is_hidden_relative_path(path)


@contextmanager
def directory_handle(root: Path, path: str) -> Iterator[int]:
    handles = []
    try:
        handles.append(os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
        for part in path.split("/") if path else []:
            handles.append(
                os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=handles[-1])
            )
        yield handles[-1]
    finally:
        for handle in reversed(handles):
            os.close(handle)


def list_directory(media: ReplicaMedia, path: str) -> FileBrowserListingRead:
    try:
        relative = normalize_relative_path(path) if path else ""
        if relative:
            resolve_within_root(media.root, relative)
    except PathSafetyError as error:
        raise ValidationError("Invalid library-relative directory") from error
    if not visible(relative):
        raise ValidationError("Hidden directories are unavailable")
    entries: dict[str, FileBrowserEntryRead] = {}
    with media.store.connection(readonly=True) as db:
        rows = db.execute(
            "SELECT p.path,p.entity,c.body FROM catalog_paths p JOIN catalog_rows c "
            "ON c.family=p.family AND c.entity=p.entity "
            "WHERE p.parent=? AND p.family='asset_files' ORDER BY p.path",
            (relative,),
        )
        for row in rows:
            if visible(row["path"]):
                body = json.loads(row["body"])
                entries[row["path"]] = entry(row["path"], "file", row["entity"], body["bundle_id"])
        for row in db.execute(
            "SELECT path FROM catalog_directories WHERE parent=? ORDER BY path", (relative,)
        ):
            if visible(row["path"]):
                entries[row["path"]] = entry(row["path"], "directory")
    try:
        with directory_handle(media.root, relative) as handle, os.scandir(handle) as children:
            for child in children:
                child_path = f"{relative}/{child.name}" if relative else child.name
                if not visible(child_path):
                    continue
                try:
                    info = child.stat(follow_symlinks=False)
                except OSError:
                    continue
                if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                    continue
                kind = "directory" if stat.S_ISDIR(info.st_mode) else "file"
                value = entries.get(child_path)
                if value is None or value.kind != kind:
                    value = entry(child_path, kind)
                    entries[child_path] = value
                value.local_state = "observed"
                value.size_bytes = info.st_size if kind == "file" else None
                value.modified_at = datetime.fromtimestamp(info.st_mtime, UTC)
                value.created_at = datetime.fromtimestamp(
                    getattr(info, "st_birthtime", info.st_ctime), UTC
                )
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise ValidationError(
                "Directory links and non-directory paths are unavailable"
            ) from error
        # Catalog presence is independent of local bytes or directory access.
        return FileBrowserListingRead(
            path=relative,
            entries=list(entries.values()),
            missing_files_updated=0,
            local_state="unavailable",
        )
    for value in entries.values():
        if value.local_state == "unknown":
            value.local_state = "unavailable"
    return FileBrowserListingRead(
        path=relative,
        entries=sorted(
            entries.values(),
            key=lambda item: (item.kind != "directory", item.name.casefold(), item.relative_path),
        ),
        missing_files_updated=0,
        local_state="observed",
    )


def entry(
    path: str, kind: str, identity: str | None = None, bundle: str | None = None
) -> FileBrowserEntryRead:
    classification = classify(path) if kind == "file" else None
    media_kind = str(classification[0]) if classification else None
    return FileBrowserEntryRead(
        name=path.rsplit("/", 1)[-1],
        relative_path=path,
        kind=kind,
        size_bytes=None,
        modified_at=None,
        created_at=None,
        extension=Path(path).suffix.lstrip(".") or None,
        mime_type=mimetypes.guess_type(path)[0],
        media_kind=media_kind,
        supported=bool(identity and media_kind in ("image", "video")),
        linked=identity is not None,
        bundle_id=bundle,
        file_id=identity,
        container=None,
        video_codec=None,
        video_codec_tag=None,
        audio_codec=None,
        duration=None,
        resume_position=None,
        unbundled=False,
        local_state="unknown",
    )
