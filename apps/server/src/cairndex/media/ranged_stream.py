"""Range-aware file streaming with an optional byte patch.

``FileResponse`` handles HTTP Range perfectly well and is what every other
read-only route here uses. It cannot help when the bytes on the way out must
differ from the bytes on disk — which is what relabelling ``hev1`` HEVC as
``hvc1`` needs (see ``hevc_relabel``): five bytes of header rewritten, the rest
of a multi-gigabyte file passed through untouched.

So this is deliberately the *smallest* Range implementation that serves a media
element correctly, and nothing more:

- one range per request, which is all a media element ever asks for. A
  multi-range request is answered with the whole body, which is a legal response
  and better than pretending to support something untested;
- an unsatisfiable range gets 416 with the size, so a client can recover;
- the body streams in chunks and never holds the file in memory, because these
  files are measured in gigabytes.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Literal

from starlette.responses import Response, StreamingResponse

# Big enough that a large file is not thousands of reads, small enough that a
# patch near the start is not delayed behind megabytes of buffering.
_CHUNK_BYTES = 256 * 1024

# `bytes=start-end`, `bytes=start-`, or `bytes=-suffix`. Anything else — including
# a comma, which means multiple ranges — deliberately does not match.
_SINGLE_RANGE = re.compile(r"^bytes=(?P<start>\d*)-(?P<end>\d*)$")

# Rewrites one chunk given its absolute offset in the file. See `HevcRelabel.apply`.
BytePatch = Callable[[bytes, int], bytes]


# Three genuinely different outcomes, named rather than encoded in a sentinel.
_Resolved = tuple[int, int] | Literal["all", "unsatisfiable"]


def _resolve_range(header: str | None, size: int) -> _Resolved:
    """``(start, end)`` inclusive, or why no single range applies."""
    if not header:
        return "all"
    match = _SINGLE_RANGE.match(header.strip())
    if match is None:
        return "all"  # multi-range or malformed: the whole body is a legal answer
    raw_start, raw_end = match.group("start"), match.group("end")
    if not raw_start and not raw_end:
        return "all"
    if not raw_start:
        # A suffix range: the last N bytes.
        length = int(raw_end)
        if length == 0:
            return "unsatisfiable"
        return (max(0, size - length), size - 1)
    start = int(raw_start)
    if start >= size:
        return "unsatisfiable"
    end = int(raw_end) if raw_end else size - 1
    return (start, min(end, size - 1))


def _stream(path: Path, start: int, end: int, patch: BytePatch | None) -> Iterator[bytes]:
    remaining = end - start + 1
    offset = start
    with path.open("rb") as fh:
        fh.seek(start)
        while remaining > 0:
            chunk = fh.read(min(_CHUNK_BYTES, remaining))
            if not chunk:
                return  # truncated under us; the client sees a short body
            if patch is not None:
                chunk = patch(chunk, offset)
            offset += len(chunk)
            remaining -= len(chunk)
            yield chunk


def ranged_file_response(
    path: Path,
    *,
    media_type: str,
    size: int,
    range_header: str | None = None,
    patch: BytePatch | None = None,
) -> Response:
    """Serve ``path`` honouring one Range, optionally rewriting bytes on the way.

    ``size`` is passed in rather than stat'd here so the caller can reuse a stat
    it has already paid for, and so the length it advertises cannot disagree with
    the length it serves.
    """
    resolved = _resolve_range(range_header, size)
    common = {"Accept-Ranges": "bytes"}
    if resolved == "unsatisfiable":
        return Response(
            status_code=416,
            headers={**common, "Content-Range": f"bytes */{size}"},
        )
    partial = resolved != "all"
    start, end = resolved if isinstance(resolved, tuple) else (0, size - 1)
    length = end - start + 1
    headers = {**common, "Content-Length": str(length)}
    status = 200
    if partial:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        status = 206
    return StreamingResponse(
        _stream(path, start, end, patch),
        status_code=status,
        media_type=media_type,
        headers=headers,
    )
