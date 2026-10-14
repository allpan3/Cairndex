"""Portable storyboards: one bounded background generator over pinned local sources.

A storyboard of a long video can take a minute of decoding, so it is never made
inside a request. The viewer asks for the storyboard of the generation it has
observed, and one daemon thread per server makes the newest waiting request
first. Requests are runtime state only: the private cache is the durable
result, and a restart loses nothing that the next viewer request cannot ask for
again.
"""

import json
import logging
import os
import shutil
import tempfile
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from cairndex.core.abort import OperationAborted, abort_scope
from cairndex.core.config import get_settings
from cairndex.core.errors import DomainError, LibraryLeaseError, NotFoundError, ValidationError
from cairndex.core.paths import PathSafetyError
from cairndex.domain.enums import MediaKind
from cairndex.media import derived_cache
from cairndex.media import storyboards as boards
from cairndex.media.ffmpeg_exec import FfmpegError
from cairndex.ownership.lifecycle import lifecycle
from cairndex.replicas.media import ReplicaMedia, generation, open_source
from cairndex.replicas.protocol import ReplicaError
from cairndex.scanning.media_types import classify

logger = logging.getLogger(__name__)

# Viewer requests waiting beyond this drop the oldest; its viewer asks again
WAITING_LIMIT = 8
# Remembered failures, so a poll does not restart a storyboard that cannot be
# made; one expires so that a source that becomes readable again gets a retry
FAILURE_LIMIT = 256
FAILURE_SECONDS = 300.0

State = Literal["ready", "queued", "running", "failed", "unavailable"]
Key = tuple[str, str, str]


@dataclass(frozen=True)
class StoryboardState:
    """What one observed source generation's storyboard is doing."""

    state: State
    url: str | None = None
    message: str | None = None


# The storyboard directory is keyed by source generation, format and sampling
def directory(media: ReplicaMedia, file_id: str, token: str) -> Path:
    return media.cache("storyboards", file_id, boards.storyboard_cache_key(token), "")


def _current(path: Path, token: str) -> bool:
    return derived_cache.is_current(path / "index.vtt", boards.storyboard_cache_key(token))


def _url(media: ReplicaMedia, file_id: str, token: str) -> str:
    version = boards.storyboard_version_param(token)
    return f"/api/v1/libraries/{media.library_id}/files/{file_id}/storyboard.vtt?v={version}"


# One open and fstat names the current generation without probing or writing
def _observed(media: ReplicaMedia, file_id: str) -> tuple[str, str]:
    row = media.row("asset_files", file_id)
    try:
        with open_source(media.root, row["relative_path"]) as handle:
            return row["relative_path"], generation(row["relative_path"], os.fstat(handle))
    except (OSError, PathSafetyError, ValidationError) as error:
        raise NotFoundError(
            "Media unavailable on this device; make the local file readable and retry"
        ) from error


def _duration(media: ReplicaMedia, file_id: str, token: str) -> float | None:
    with media.store.connection(readonly=True) as db:
        row = db.execute(
            "SELECT generation, metadata FROM local_media WHERE file_id=?", (file_id,)
        ).fetchone()
    if row is None or row[0] != token or not row[1]:
        return None
    value = json.loads(row[1]).get("duration")
    return float(value) if isinstance(value, (int, float)) and value > 0 else None


def _generate(media: ReplicaMedia, file_id: str, token: str) -> None:
    source, asset = media.resolve_file(file_id, probe=True)
    if asset.quick_fingerprint != token:
        raise ReplicaError("Local video changed; reopen it to make a current storyboard")
    duration = boards._duration(asset)
    if duration is None:
        raise ReplicaError("Local video details are unavailable; reopen it when it is readable")
    dest = directory(media, file_id, token)
    if _current(dest, token):
        return
    temp = Path(tempfile.mkdtemp(prefix=f"{dest.name}.tmp-", dir=dest.parent))
    try:
        boards.build_into(
            source,
            temp,
            duration,
            token,
            sampling=get_settings().storyboard_sampling,
            scope=lambda: media.input_scope({file_id: token}),
        )
        media.validate(file_id, token)
        # Only this thread writes storyboards, so a directory here is an old
        # unreadable remnant rather than a finished one being replaced.
        shutil.rmtree(dest, ignore_errors=True)
        temp.rename(dest)
    finally:
        shutil.rmtree(temp, ignore_errors=True)


# A failure message reaches the viewer, and ffmpeg's stderr can quote the path
def _safe_reason(error: Exception) -> str:
    if isinstance(error, DomainError):
        return error.message
    return "The storyboard could not be generated."


class StoryboardQueue:
    """Make storyboards one at a time for whichever servers' viewers asked."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._wake = threading.Condition(self._lock)
        self._waiting: OrderedDict[Key, ReplicaMedia] = OrderedDict()
        self._running: Key | None = None
        self._failed: OrderedDict[Key, tuple[float, str]] = OrderedDict()
        self._swept: set[str] = set()
        self._stop = False
        self._thread: threading.Thread | None = None

    def request(self, media: ReplicaMedia, file_id: str, token: str) -> StoryboardState:
        """Report one generation's storyboard and queue it when it is missing."""
        if not get_settings().storyboards:
            return StoryboardState("unavailable", message="Storyboards are off on this server.")
        path, current = _observed(media, file_id)
        kind = classify(path)
        if kind is None or kind[0] != MediaKind.VIDEO:
            raise ValidationError("Storyboards are made from video files")
        if current != token:
            return StoryboardState(
                "unavailable", message="Local video changed; reopen it to make a current storyboard"
            )
        if _current(directory(media, file_id, token), token):
            return StoryboardState("ready", url=_url(media, file_id, token))
        if _duration(media, file_id, token) is None:
            return StoryboardState(
                "unavailable", message="Local video details are unavailable; reopen the video"
            )
        key = (media.library_id, file_id, token)
        with self._lock:
            failed = self._failed.get(key)
            if failed is not None and time.monotonic() - failed[0] < FAILURE_SECONDS:
                return StoryboardState("failed", message=failed[1])
            self._failed.pop(key, None)
            if key == self._running:
                return StoryboardState("running")
            if self._stop:
                return StoryboardState("unavailable", message="The server is stopping.")
            self._waiting[key] = media
            self._waiting.move_to_end(key)
            while len(self._waiting) > WAITING_LIMIT:
                self._waiting.popitem(last=False)
            if self._thread is None:
                self._thread = threading.Thread(
                    target=self._run, name="replica-storyboards", daemon=True
                )
                self._thread.start()
            self._wake.notify()
        return StoryboardState("queued")

    def _run(self) -> None:
        while True:
            with self._lock:
                while not self._waiting and not self._stop:
                    self._wake.wait()
                if self._stop:
                    return
                key, media = self._waiting.popitem(last=True)
                self._running = key
            _, file_id, token = key
            failure: str | None = None
            try:
                self._make(media, file_id, token)
            except (OperationAborted, LibraryLeaseError):
                pass  # Release or shutdown took the work away; a later request retries
            except (DomainError, boards.StoryboardError, FfmpegError, OSError) as error:
                failure = _safe_reason(error)
                logger.info("portable storyboard failed: %s", type(error).__name__)
            except Exception as error:  # noqa: BLE001 - one storyboard must not stop the queue
                # Only the type is logged: a message or traceback can quote the path
                failure = "The storyboard could not be generated."
                logger.error("portable storyboard failed: %s", type(error).__name__)
            with self._lock:
                self._running = None
                if failure is not None:
                    self._failed[key] = (time.monotonic(), failure)
                    while len(self._failed) > FAILURE_LIMIT:
                        self._failed.popitem(last=False)

    def _make(self, media: ReplicaMedia, file_id: str, token: str) -> None:
        library_id = media.library_id
        from cairndex.replicas import service

        if not service.serving(library_id, media.store):
            return  # Released or reopened since the request; its viewer asks again
        with (
            lifecycle.work(library_id),
            abort_scope(lambda: self._stop or lifecycle.blocked(library_id)),
        ):
            if library_id not in self._swept:
                _sweep(media)
                self._swept.add(library_id)
            _generate(media, file_id, token)

    def stop(self) -> None:
        """Stop admission and abort the storyboard being made."""
        with self._lock:
            self._stop = True
            self._waiting.clear()
            self._wake.notify_all()
            thread = self._thread
        if thread is not None:
            thread.join(timeout=15)


# A process stopped mid-storyboard leaves its temporary directory behind
def _sweep(media: ReplicaMedia) -> None:
    root = media.store.path.parent / "cache" / "storyboards"
    for path in root.glob("*/*.tmp-*"):
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)


_queue_lock = threading.Lock()
_queue: StoryboardQueue | None = None


def get_queue() -> StoryboardQueue:
    """Return the server's storyboard queue, creating it on first use."""
    global _queue
    with _queue_lock:
        if _queue is None:
            _queue = StoryboardQueue()
        return _queue


def shutdown_queue() -> None:
    """Stop the server's storyboard queue so no decoder outlives the process."""
    global _queue
    with _queue_lock:
        queue, _queue = _queue, None
    if queue is not None:
        queue.stop()


# A served storyboard must belong to the generation that is current now
def _served_directory(media: ReplicaMedia, file_id: str, version: str | None) -> Path:
    _, token = _observed(media, file_id)
    # The query value arrives decoded, so it is the cache key itself
    if version != boards.storyboard_cache_key(token):
        raise NotFoundError("storyboard not found")
    path = directory(media, file_id, token)
    if not _current(path, token):
        raise NotFoundError("storyboard not found")
    return path


def index(media: ReplicaMedia, file_id: str, version: str | None) -> Path:
    """Return the current generation's index; a stale version is absent."""
    return _served_directory(media, file_id, version) / "index.vtt"


def sheet(media: ReplicaMedia, file_id: str, name: str, version: str | None) -> Path:
    """Return one sheet of the current generation's storyboard."""
    if not boards._SHEET_STEM.fullmatch(name):
        raise NotFoundError("storyboard sheet not found")
    # Rebuild the name from its number, so the path holds no request text
    path = _served_directory(media, file_id, version) / f"sb_{int(name[3:]):03d}.jpg"
    if not path.is_file():
        raise NotFoundError("storyboard sheet not found")
    return path
