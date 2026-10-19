"""Pinned-descriptor range reads for local replica bytes with generation checks"""

import os
from collections.abc import Callable, Iterator
from pathlib import Path

from starlette.responses import Response, StreamingResponse
from starlette.types import Receive, Scope, Send

from cairndex.media import hevc_relabel
from cairndex.media.ranged_stream import _CHUNK_BYTES, _resolve_range
from cairndex.replicas.media import ReplicaMedia, generation, open_source
from cairndex.replicas.protocol import ReplicaError


# Open and validate before response headers; always close the descriptor after cancellation
class PinnedFileResponse(Response):
    def __init__(
        self,
        root: Path,
        relative: str,
        token: str,
        mime: str,
        range_header: str | None,
        validate: Callable[[], None],
    ) -> None:
        super().__init__()
        self.root, self.relative, self.token = root, relative, token
        self.mime, self.range_header, self.validate = mime, range_header, validate

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        self.validate()
        with open_source(self.root, self.relative) as handle:
            info = os.fstat(handle)
            if generation(self.relative, info) != self.token:
                raise ReplicaError("Local media changed; retry playback")
            relabel = hevc_relabel.relabel_for(Path(f"/dev/fd/{handle}"))
            size = info.st_size
            resolved = _resolve_range(self.range_header, size)
            headers = {"Cache-Control": "private, no-store", "Accept-Ranges": "bytes"}
            if resolved == "unsatisfiable" or (
                isinstance(resolved, tuple) and resolved[1] < resolved[0]
            ):
                await Response(
                    status_code=416, headers=headers | {"Content-Range": f"bytes */{size}"}
                )(scope, receive, send)
                return
            start, end = resolved if isinstance(resolved, tuple) else (0, size - 1)
            headers["Content-Length"] = str(end - start + 1)
            if resolved != "all":
                headers["Content-Range"] = f"bytes {start}-{end}/{size}"

            # Each chunk retains the source identity and stops on truncation or replacement
            def chunks() -> Iterator[bytes]:
                os.lseek(handle, start, os.SEEK_SET)
                remaining = end - start + 1
                while remaining:
                    self.validate()
                    if generation(self.relative, os.fstat(handle)) != self.token:
                        raise OSError("Local media changed during playback")
                    data = os.read(handle, min(remaining, _CHUNK_BYTES))
                    if not data:
                        raise OSError("Local media read was interrupted")
                    offset = end - remaining + 1
                    remaining -= len(data)
                    yield relabel.apply(data, offset) if relabel else data

            await StreamingResponse(
                chunks(),
                status_code=206 if resolved != "all" else 200,
                media_type=self.mime,
                headers=headers,
            )(scope, receive, send)


class ReplicaFileResponse(PinnedFileResponse):
    def __init__(
        self, media: ReplicaMedia, file_id: str, token: str, mime: str, range_header: str | None
    ) -> None:
        relative = media.row("asset_files", file_id)["relative_path"]

        def validate() -> None:
            media.validate(file_id, token)

        super().__init__(media.root, relative, token, mime, range_header, validate)
