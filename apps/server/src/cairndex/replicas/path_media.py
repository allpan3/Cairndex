"""Read unindexed library media without inventing catalog identities."""

import mimetypes
import os
from collections import OrderedDict
from collections.abc import Iterator
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
from threading import Lock
from typing import Any

from PIL import Image

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.core.paths import PathSafetyError, normalize_relative_path
from cairndex.domain.enums import MediaKind
from cairndex.media.ffprobe import ProbeError, normalize_metadata, run_ffprobe
from cairndex.replicas.media import (
    _FILE_LOCKS,
    _PROBE_SLOTS,
    ReplicaMedia,
    generation,
    open_source,
)
from cairndex.replicas.protocol import ReplicaError
from cairndex.scanning.media_types import classify

# An observation and its following playback decision share one bounded probe.
# Values are runtime-only and keyed by the observed source generation.
_PROBES: OrderedDict[tuple[str, str, str], dict[str, Any]] = OrderedDict()
_PROBES_LOCK = Lock()
_PROBE_LIMIT = 128


class PathMedia:
    def __init__(self, media: ReplicaMedia, path: str, expected: str | None = None) -> None:
        self.media = media
        try:
            self.relative = normalize_relative_path(path)
        except PathSafetyError as error:
            raise ValidationError("Choose a relative file path inside this library") from error
        self.path = media.root / self.relative
        try:
            with open_source(media.root, self.relative) as handle:
                self.info = os.fstat(handle)
                self.token = generation(self.relative, self.info)
        except (OSError, PathSafetyError) as error:
            raise NotFoundError("Local file is unavailable; make it readable and retry") from error
        if expected is not None and self.token != expected:
            raise ReplicaError("Local media changed; reopen the file")
        classification = classify(self.relative.rsplit("/", 1)[-1])
        self.kind = classification[0] if classification else MediaKind.OTHER
        self.mime = mimetypes.guess_type(self.relative)[0] or "application/octet-stream"

    def validate(self) -> None:
        try:
            with open_source(self.media.root, self.relative) as handle:
                if generation(self.relative, os.fstat(handle)) != self.token:
                    raise ReplicaError("Local media changed; reopen the file")
        except (OSError, PathSafetyError) as error:
            raise NotFoundError("Local file is unavailable; make it readable and retry") from error

    @contextmanager
    def input_scope(self) -> Iterator[None]:
        from cairndex.media.inputs import inherited_inputs

        with open_source(self.media.root, self.relative) as handle:
            if generation(self.relative, os.fstat(handle)) != self.token:
                raise ReplicaError("Local media changed; reopen the file")
            with inherited_inputs({self.path: handle}):
                yield
            self.validate()

    def metadata(self) -> dict[str, Any]:
        key = str(self.media.store.path), self.relative, self.token
        with _FILE_LOCKS[hash(key) % len(_FILE_LOCKS)]:
            self.validate()
            with _PROBES_LOCK:
                cached = _PROBES.get(key)
                if cached is not None:
                    _PROBES.move_to_end(key)
                    return deepcopy(cached)
            try:
                if self.kind in (MediaKind.VIDEO, MediaKind.AUDIO):
                    if not _PROBE_SLOTS.acquire(timeout=0.1):
                        raise ProbeError("Local probes are busy")
                    try:
                        with self.input_scope():
                            result = normalize_metadata(run_ffprobe(self.path, timeout=10))
                    finally:
                        _PROBE_SLOTS.release()
                elif self.kind == MediaKind.IMAGE:
                    with open_source(self.media.root, self.relative) as handle:
                        if generation(self.relative, os.fstat(handle)) != self.token:
                            raise ReplicaError("Local media changed; reopen the file")
                        with os.fdopen(os.dup(handle), "rb") as source, Image.open(source) as image:
                            result = {"width": image.width, "height": image.height}
                else:
                    raise ValidationError("Only video, audio and image files can be previewed")
                self.validate()
            except (OSError, ProbeError, Image.DecompressionBombError) as error:
                raise NotFoundError(
                    "Local media details are unavailable; retry when readable"
                ) from error
            with _PROBES_LOCK:
                _PROBES[key] = result
                while len(_PROBES) > _PROBE_LIMIT:
                    _PROBES.popitem(last=False)
            return deepcopy(result)

    def preview(self, size: int) -> Path:
        from cairndex.media import previews

        if self.kind != MediaKind.IMAGE:
            raise ValidationError("Only images have previews")
        dest = self.media.cache("path-previews", self.relative, self.token, f"-{size}.webp")
        with open_source(self.media.root, self.relative) as handle:
            if generation(self.relative, os.fstat(handle)) != self.token:
                raise ReplicaError("Local media changed; reopen the file")
            result = previews._preview_for_source(
                Path(f"/dev/fd/{handle}"), dest, previews._preview_size(size), self.token
            )
        self.validate()
        return result
