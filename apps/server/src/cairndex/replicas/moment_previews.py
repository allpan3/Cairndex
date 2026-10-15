"""Portable moment previews: a poster frame and a span clip in the private cache.

The legacy previews (``media/moment_previews.py``) explain why these exist and
why a request never waits for one. This module keeps that contract for a
portable library: a missing preview answers 404 and queues one bounded
background build. The encode reads the source through a pinned descriptor of
the observed generation, and the result is published only when that generation
is still current. The cache name holds the generation and the marked times, so
a changed source or another span never serves old bytes.
"""

import logging
import os
from pathlib import Path
from typing import Literal

from cairndex.core.abort import OperationAborted, abort_scope
from cairndex.core.errors import DomainError, NotFoundError, ValidationError
from cairndex.core.paths import PathSafetyError
from cairndex.domain.enums import MediaKind
from cairndex.media import moment_previews as encode
from cairndex.ownership.lifecycle import lifecycle
from cairndex.replicas.media import ReplicaMedia, generation, open_source
from cairndex.scanning.media_types import classify

logger = logging.getLogger(__name__)

Kind = Literal["poster", "clip"]


def request(media: ReplicaMedia, moment_id: str, kind: Kind) -> Path | None:
    """Return the current preview, or queue it and return None."""
    moment = media.row("moments", moment_id)
    start, end = float(moment["start_s"]), moment["end_s"]
    if kind == "clip" and end is None:
        raise NotFoundError("Only range moments have a preview clip")
    file_id = moment["file_id"]
    path = media.row("asset_files", file_id)["relative_path"]
    media_kind = classify(path)
    if media_kind is None or media_kind[0] != MediaKind.VIDEO:
        raise NotFoundError("Moment previews are made from video files")
    # One open and fstat names the current generation, without a probe or a write
    try:
        with open_source(media.root, path) as handle:
            token = generation(path, os.fstat(handle))
    except (OSError, PathSafetyError, ValidationError) as error:
        raise NotFoundError(
            "Media unavailable on this device; make the local file readable and retry"
        ) from error
    if kind == "poster":
        fingerprint = encode.poster_fingerprint(token, start)
        dest = media.cache("moment-previews", moment_id, fingerprint, "-poster.jpg")
    else:
        fingerprint = encode.clip_fingerprint(token, start, float(end))
        dest = media.cache("moment-previews", moment_id, fingerprint, "-clip.mp4")
    if encode.is_current(dest, fingerprint):
        return dest

    library_id = media.library_id

    def make(temp: Path) -> None:
        from cairndex.replicas import service

        if not service.serving(library_id, media.store):
            raise OperationAborted  # Released or reopened since the request
        with (
            lifecycle.work(library_id),
            abort_scope(lambda: lifecycle.blocked(library_id)),
            media.input_scope({file_id: token}),
        ):
            source = media.validate(file_id, token)
            if kind == "poster":
                encode._encode_poster(source, temp, at=start)
            else:
                duration = min(max(float(end) - start, 0.0), encode.MAX_CLIP_SECONDS)
                encode._encode_clip(source, temp, start=start, duration=duration)
        media.validate(file_id, token)

    def build() -> None:
        try:
            encode._build(dest, fingerprint, make)
        except (DomainError, OperationAborted) as error:
            # A changed or released source keeps the storyboard tile; the next hover retries.
            # Only the type is logged, because a message can quote the path.
            logger.info("portable moment preview skipped: %s", type(error).__name__)

    encode.schedule(dest, build)
    return None
