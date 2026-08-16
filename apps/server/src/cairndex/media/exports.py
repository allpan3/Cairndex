"""Clip exports: an animated GIF cut from a marked span of one video.

The second slice of the M11 export family (plan 1 §10), after contact sheets.

**Why this one is a task and the contact sheet is a plain GET.** A contact
sheet seeks to sixteen keyframes and costs the same whatever the video's
length. A GIF has to decode a *contiguous* span — up to thirty seconds of it —
and that cost scales with the source's resolution and with how fast the
library's storage can feed it. On a 4K source over a network mount it can
comfortably outlast the desktop shell's 30-second relay read timeout, which is
the exact failure that made long contact sheets unusable before they were
rewritten to seek (owner, 2026-07-27). So generation runs in a worker and every
HTTP request returns immediately: create, poll, download.

Artifacts live under ``{data_dir}/exports/{export_id}/`` rather than in the
library cache. They are not derived *state* worth keeping — the parameter space
is continuous, so caching them would accumulate megabytes per marked span with
no prospect of a hit. They are reaped on a TTL and dropped after a successful
download.

Interactive and in-process (ADR-0014's posture, not registry jobs): a running
scan must not queue-block a ten-second export.
"""

from __future__ import annotations

import base64
import binascii
import io
import shutil
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Literal

from PIL import Image

from cairndex.core.errors import CapacityError, ValidationError
from cairndex.media.ffmpeg_exec import FfmpegError, ffmpeg_exe, run_ffmpeg

ExportKind = Literal["gif"]
ExportStatus = Literal["pending", "running", "done", "failed"]
WatermarkCorner = Literal["top-left", "top-right", "bottom-left", "bottom-right"]

# Caps from plan 1 §10. A GIF is an uncompressed-ish format with a 256-colour
# palette per frame: these bounds are what keep one export a few megabytes and
# a few seconds of work rather than an unbounded ask.
MAX_CLIP_SECONDS = 30.0
MIN_CLIP_SECONDS = 0.1
# Raised from plan 1 §10's 720 so an "Original" size can mean it (owner,
# 2026-08-15): a 1080p source is the common case here, and capping it at 720
# would make that label a lie. 1920 rather than unbounded because a GIF is one
# indexed frame per frame — at 4K a thirty-second clip runs to hundreds of
# megabytes, which is not an export anyone wants by accident. Duration remains
# the tighter bound on how much work one request can ask for.
MAX_WIDTH = 1920
MIN_WIDTH = 120
# Raised from plan 1 §10's sketched 15 on 2026-08-15, after measuring what a
# GIF can actually represent. 50 fps is a 2-centisecond delay; below that a
# delay of 1cs is the value historic viewers reinterpret as 10cs, so 50 is the
# last rate that plays as written.
MAX_FPS = 50
MIN_FPS = 5
DEFAULT_WIDTH = 480
# 15, the rate people actually reach for in a GIF (owner, 2026-08-15).
#
# Not one the format holds exactly: a GIF stores each frame's delay in whole
# centiseconds, so only 100/n survives — 5, 10, 20, 25, 50. 15 rounds to a 7cs
# delay and plays at 14.29, running 4.7% long. Measured, along with 12→12.5 and
# 30→33.33; the drift is well under what anyone notices, and the client prints
# the real rate beside the choice rather than hiding it.
DEFAULT_FPS = 15

# Longer than the caps should ever need, short enough that a wedged ffmpeg is
# reported rather than held open forever.
FFMPEG_TIMEOUT = 300.0

# The client renders the watermark and sends the pixels, because these ffmpeg
# builds have no `drawtext` — it needs freetype and font discovery, the same
# reason the contact sheet's header is composed in the browser. Half a megabyte
# is far more than the couple of kilobytes a text mark costs and leaves room for
# the image mark that comes next, while keeping a create request small.
MAX_WATERMARK_BYTES = 512 * 1024
# A mark wider than the widest output could never be placed inside a frame.
MAX_WATERMARK_DIMENSION = MAX_WIDTH
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# How long a finished artifact survives if nobody downloads it.
DEFAULT_TTL_SECONDS = 3600.0
_REAP_INTERVAL = 300.0

Clock = Callable[[], float]


class ExportError(RuntimeError):
    """ffmpeg was unavailable or failed to produce the artifact."""


@dataclass(frozen=True)
class GifParams:
    """A validated GIF request. Construct through :func:`validated_gif_params`."""

    start_s: float
    end_s: float
    width: int
    fps: int
    corner: WatermarkCorner = "bottom-right"
    #: Where the rendered mark was written, filled in by the manager once it
    #: knows the artifact directory. None when the export carries no mark.
    watermark_path: Path | None = None

    @property
    def duration(self) -> float:
        return self.end_s - self.start_s


@dataclass
class ClipExport:
    id: str
    library_id: str
    file_id: str
    kind: ExportKind
    params: GifParams
    output_path: Path
    filename: str
    #: The rendered mark, held until the worker can write it beside the artifact
    #: so a request rejected for capacity leaves no directory behind.
    watermark_png: bytes | None = None
    status: ExportStatus = "pending"
    error: str | None = None
    created_at: float = 0.0
    finished_at: float | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def progress(self) -> float:
        """Coarse progress, because ffmpeg's is not worth parsing here.

        A two-pass palette encode reports its own frame counter twice over one
        input; mapping that onto a single bar means tracking which pass is
        running from stderr. The client shows an indeterminate state anyway, so
        three steps carry everything it acts on.
        """
        return {"pending": 0.0, "running": 0.5, "done": 1.0, "failed": 1.0}[self.status]


def validated_gif_params(
    *,
    start_s: float,
    end_s: float,
    width: int | None,
    fps: int | None,
    duration: float | None,
    corner: WatermarkCorner = "bottom-right",
) -> GifParams:
    """Check a requested range and encoding against the caps and the source.

    Validated here rather than in the route so the rules have one home and can
    be unit-tested without HTTP.
    """
    if not (start_s >= 0 and end_s > start_s):
        raise ValidationError("the clip's end must come after its start")
    span = end_s - start_s
    if span < MIN_CLIP_SECONDS:
        raise ValidationError(f"a clip must be at least {MIN_CLIP_SECONDS}s long")
    if span > MAX_CLIP_SECONDS:
        raise ValidationError(f"a clip may be at most {MAX_CLIP_SECONDS:.0f}s long")
    # A range past the end would encode to a shorter GIF than asked for, or to
    # nothing at all; say so rather than returning a surprise.
    if duration is not None and start_s >= duration:
        raise ValidationError("the clip starts after the end of the video")

    resolved_width = DEFAULT_WIDTH if width is None else width
    if not (MIN_WIDTH <= resolved_width <= MAX_WIDTH):
        raise ValidationError(f"width must be between {MIN_WIDTH} and {MAX_WIDTH}")
    resolved_fps = DEFAULT_FPS if fps is None else fps
    if not (MIN_FPS <= resolved_fps <= MAX_FPS):
        raise ValidationError(f"fps must be between {MIN_FPS} and {MAX_FPS}")

    # Trim the range to the source rather than rejecting it: the client's
    # duration comes from a probe that can be a hair short of the real stream.
    end = min(end_s, duration) if duration is not None else end_s
    return GifParams(
        start_s=start_s,
        end_s=end,
        # ffmpeg's `scale` needs an even width to produce an even height with
        # `-2`; an odd request would otherwise fail deep in the filter graph.
        width=resolved_width - (resolved_width % 2),
        fps=resolved_fps,
        corner=corner,
    )


def validated_watermark(encoded: str | None) -> bytes | None:
    """Decode and check a client-rendered watermark, or return None for none.

    The bytes arrive base64 in the create request's JSON rather than as an
    upload: the server has no multipart route and no ``python-multipart``, and a
    text mark is a couple of kilobytes of mostly-transparent PNG.

    Checked here rather than trusted, because these bytes become an ffmpeg
    input: bounded in size, confirmed to be a PNG, and opened by Pillow so a
    malformed file is refused with a clear message instead of failing deep in a
    filter graph as an unexplained encode error.
    """
    if encoded is None or encoded == "":
        return None
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValidationError("the watermark is not valid base64") from exc
    if len(raw) > MAX_WATERMARK_BYTES:
        raise ValidationError(f"a watermark may be at most {MAX_WATERMARK_BYTES // 1024} KB")
    if not raw.startswith(_PNG_MAGIC):
        raise ValidationError("the watermark must be a PNG")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.verify()
            width, height = image.size
    except Exception as exc:  # noqa: BLE001 - any decode failure is one answer
        raise ValidationError("the watermark could not be read as an image") from exc
    if width <= 0 or height <= 0:
        raise ValidationError("the watermark is empty")
    if width > MAX_WATERMARK_DIMENSION or height > MAX_WATERMARK_DIMENSION:
        raise ValidationError(f"a watermark may be at most {MAX_WATERMARK_DIMENSION}px on a side")
    return raw


def _overlay_position(corner: WatermarkCorner) -> str:
    """Where the mark sits, as an ffmpeg ``overlay`` expression.

    ``W``/``H`` are the frame's size and ``w``/``h`` the mark's, so the corner is
    computed at filter time and cannot be thrown off by the scaler rounding the
    output height to an even number of lines. ``max(0, …)`` keeps a mark that is
    somehow larger than the frame on screen rather than off its left edge; the
    comma is escaped because a bare one would end the filter.

    The mark's inset from the edges is baked into the tile as transparent
    padding by the client, so there is no margin to add here — every question of
    how the mark is laid out is answered in one place, on the side that drew it.
    """
    right = r"max(0\,W-w)"
    bottom = r"max(0\,H-h)"
    x = right if corner in ("top-right", "bottom-right") else "0"
    y = bottom if corner in ("bottom-left", "bottom-right") else "0"
    return f"overlay=x={x}:y={y}"


def build_gif_command(source: Path, dest: Path, params: GifParams) -> list[str]:
    """The ffmpeg invocation for one GIF.

    Two-pass palette (plan 1 §10) in a *single* run: `split` feeds the same
    decoded frames to `palettegen` and `paletteuse`, so the source is decoded
    once. Running two separate commands would double the expensive half — the
    decode — to save nothing.

    `-ss` before `-i` is an input seek, so ffmpeg jumps near the mark instead of
    decoding everything before it. Unlike the contact sheet this deliberately
    omits `-noaccurate_seek`: a sheet wants a representative frame and can sit
    on the preceding keyframe, whereas a clip's in-point is the frame the owner
    placed to the millisecond, so ffmpeg must decode forward to it.

    A watermark is overlaid *before* `palettegen`, not after: the palette is
    generated from the frames it will be applied to, so a mark added afterwards
    would have no colours of its own reserved and would be quantized to whatever
    the footage happened to need. The mark is a still image, so `overlay` holds
    its single frame for the whole clip.
    """
    scale = f"scale={params.width}:-2:flags=lanczos"
    inputs = [
        "-ss",
        f"{params.start_s:.3f}",
        "-t",
        f"{params.duration:.3f}",
        "-i",
        str(source),
    ]
    # `stats_mode=diff` weights the palette toward what actually changes between
    # frames, which is what a short clip of mostly-static footage needs;
    # `paletteuse` then dithers against it.
    palette = (
        "split[a][b];"
        "[a]palettegen=stats_mode=diff[p];"
        "[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle"
    )
    if params.watermark_path is None:
        # Unlabelled, so ffmpeg takes the only input there is — left exactly as
        # it was before marks existed.
        graph = f"fps={params.fps},{scale},{palette}"
    else:
        # `-ss`/`-t` bind to the input they precede, so the mark is added after
        # them and is not itself seeked or trimmed.
        inputs += ["-i", str(params.watermark_path)]
        graph = (
            f"[0:v]fps={params.fps},{scale}[base];"
            f"[base][1:v]{_overlay_position(params.corner)}[marked];"
            f"[marked]{palette}"
        )
    return [
        ffmpeg_exe(),
        "-y",
        *inputs,
        "-filter_complex",
        graph,
        # An animated GIF with no audio and no stray data streams.
        "-an",
        "-loop",
        "0",
        str(dest),
    ]


def _run_gif(source: Path, dest: Path, params: GifParams) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        run_ffmpeg(build_gif_command(source, dest, params), timeout=FFMPEG_TIMEOUT)
    except FfmpegError as exc:
        raise ExportError(str(exc)) from exc
    if not dest.exists() or dest.stat().st_size == 0:
        raise ExportError("ffmpeg produced no clip")


class ExportManager:
    """In-process registry of bounded, TTL-reaped clip exports."""

    def __init__(
        self,
        *,
        exports_dir: Path,
        max_concurrent: int = 2,
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
        runner: Callable[[Path, Path, GifParams], None] = _run_gif,
        clock: Clock = time.monotonic,
        start_reaper: bool = True,
    ) -> None:
        self.exports_dir = exports_dir
        self.max_concurrent = max_concurrent
        self.ttl_seconds = ttl_seconds
        self._runner = runner
        self._clock = clock
        self._exports: dict[str, ClipExport] = {}
        self._lock = threading.Lock()
        self._threads: set[threading.Thread] = set()
        self._reaper: threading.Thread | None = None
        self._stop = threading.Event()
        self.exports_dir.mkdir(parents=True, exist_ok=True)
        if start_reaper:
            self._start_reaper()

    def create(
        self,
        *,
        library_id: str,
        file_id: str,
        source_path: Path,
        params: GifParams,
        filename: str,
        watermark_png: bytes | None = None,
    ) -> ClipExport:
        """Register an export and start encoding it in the background."""
        export_id = uuid.uuid4().hex
        output_path = self.exports_dir / export_id / filename
        export = ClipExport(
            id=export_id,
            library_id=library_id,
            file_id=file_id,
            kind="gif",
            params=params,
            output_path=output_path,
            filename=filename,
            watermark_png=watermark_png,
            created_at=self._clock(),
        )
        with self._lock:
            running = sum(1 for e in self._exports.values() if e.status in ("pending", "running"))
            if running >= self.max_concurrent:
                raise CapacityError(
                    f"at most {self.max_concurrent} exports can be generated at once"
                )
            self._exports[export_id] = export

        thread = threading.Thread(
            target=self._encode,
            args=(export, source_path),
            name=f"clip-export-{export_id[:8]}",
            daemon=True,
        )
        with self._lock:
            self._threads.add(thread)
        thread.start()
        return export

    def _encode(self, export: ClipExport, source_path: Path) -> None:
        with export.lock:
            export.status = "running"
        try:
            params = export.params
            if export.watermark_png is not None:
                # Beside the artifact, so the same rmtree that drops a finished
                # or reaped export takes the mark with it.
                export.output_path.parent.mkdir(parents=True, exist_ok=True)
                mark = export.output_path.parent / "watermark.png"
                mark.write_bytes(export.watermark_png)
                params = replace(params, watermark_path=mark)
            self._runner(source_path, export.output_path, params)
        except Exception as exc:  # noqa: BLE001 - reported to the caller as state
            with export.lock:
                export.status = "failed"
                # ffmpeg's stderr can name the source path; the message reaches a
                # UI and the logs, and paths are user data (AGENTS.md §privacy).
                export.error = _safe_reason(exc)
                export.finished_at = self._clock()
        else:
            with export.lock:
                export.status = "done"
                export.finished_at = self._clock()
        finally:
            with self._lock:
                self._threads.discard(threading.current_thread())

    def get(self, export_id: str, *, library_id: str) -> ClipExport | None:
        """Look an export up, scoped to the library that created it."""
        with self._lock:
            export = self._exports.get(export_id)
        if export is None or export.library_id != library_id:
            return None
        return export

    def discard(self, export_id: str) -> None:
        """Drop one export and its directory (after a successful download)."""
        with self._lock:
            export = self._exports.pop(export_id, None)
        if export is not None:
            shutil.rmtree(export.output_path.parent, ignore_errors=True)

    def reap(self) -> int:
        """Drop artifacts past their TTL. Returns how many went."""
        now = self._clock()
        with self._lock:
            stale = [
                export
                for export in self._exports.values()
                # An export still encoding is never stale, however long it has
                # taken: reaping it would delete the directory out from under a
                # running ffmpeg.
                if export.status in ("done", "failed")
                and now - (export.finished_at or export.created_at) > self.ttl_seconds
            ]
            for export in stale:
                self._exports.pop(export.id, None)
        for export in stale:
            shutil.rmtree(export.output_path.parent, ignore_errors=True)
        return len(stale)

    def _start_reaper(self) -> None:
        def loop() -> None:
            while not self._stop.wait(_REAP_INTERVAL):
                try:
                    self.reap()
                except Exception:  # noqa: BLE001 - a reaper must not die
                    continue

        self._reaper = threading.Thread(target=loop, name="clip-export-reaper", daemon=True)
        self._reaper.start()

    def shutdown(self) -> None:
        """Stop the reaper and drop every artifact this process created."""
        self._stop.set()
        if self._reaper is not None:
            self._reaper.join(timeout=2.0)
            self._reaper = None
        with self._lock:
            exports = list(self._exports.values())
            self._exports.clear()
        for export in exports:
            shutil.rmtree(export.output_path.parent, ignore_errors=True)


def _safe_reason(exc: Exception) -> str:
    """A failure message safe to show and to log.

    ffmpeg's stderr quotes the input path, and a library path is user data. The
    detail that matters to the owner is which stage failed, not where the file
    lives, so the reason is reduced to a fixed sentence.
    """
    if isinstance(exc, ExportError | FfmpegError):
        return "The clip could not be encoded."
    return "The clip export failed."


# Lazily-created singleton bound to config; tests construct their own manager
# with a fake runner and clock, so the singleton stays out of unit tests.
_default_manager: ExportManager | None = None
_manager_lock = threading.Lock()


def get_export_manager() -> ExportManager:
    global _default_manager
    with _manager_lock:
        if _default_manager is None:
            from cairndex.core.config import get_settings

            settings = get_settings()
            _default_manager = ExportManager(
                exports_dir=settings.data_dir / "exports",
                max_concurrent=settings.export_max_concurrent,
                ttl_seconds=settings.export_ttl_seconds,
            )
        return _default_manager


def shutdown_export_manager() -> None:
    global _default_manager
    with _manager_lock:
        manager = _default_manager
        _default_manager = None
    if manager is not None:
        manager.shutdown()
