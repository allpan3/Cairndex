"""Request/response shapes for clip exports (plan 1 §10)."""

from typing import Literal

from pydantic import BaseModel, Field

from cairndex.media import exports


class ClipExportCreate(BaseModel):
    """A GIF cut from a marked span of one video.

    The bounds are declared here as well as in ``media/exports`` so they reach
    the OpenAPI document — the client builds its own limits from the generated
    types rather than repeating the numbers. ``media/exports`` stays the
    enforcing copy; a request that slips past these still meets it there.
    """

    kind: Literal["gif"] = "gif"
    start_s: float = Field(ge=0)
    end_s: float = Field(gt=0)
    width: int | None = Field(default=None, ge=exports.MIN_WIDTH, le=exports.MAX_WIDTH)
    fps: int | None = Field(default=None, ge=exports.MIN_FPS, le=exports.MAX_FPS)
    #: The watermark, already rendered, as a bare base64 PNG (no data: prefix).
    #:
    #: Pixels rather than a string because these ffmpeg builds have no
    #: `drawtext`, so the server cannot draw text at all; the client that
    #: composes the snapshot and contact-sheet marks renders this one too, which
    #: is what keeps the same setting looking identical on all three. The image
    #: mark planned next arrives through this same field.
    watermark_png: str | None = Field(default=None, repr=False)
    #: Which corner the mark is placed in. Its inset from the edges is baked
    #: into the image as transparent padding, so no margin is sent.
    watermark_corner: exports.WatermarkCorner = "bottom-right"


class ClipExportRead(BaseModel):
    """An export's state, polled until it is `done` or `failed`."""

    export_id: str
    kind: Literal["gif"]
    status: Literal["pending", "running", "done", "failed"]
    progress: float
    filename: str
    #: Present only on `failed`; a fixed sentence, never ffmpeg's stderr (which
    #: quotes the source path, and paths are user data).
    error: str | None = None
