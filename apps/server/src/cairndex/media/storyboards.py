"""Storyboard generation and cached trickplay artifact lookup."""

import logging
import math
import re
import shutil
import tempfile
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from cairndex.core.config import Settings, get_settings
from cairndex.core.errors import NotFoundError
from cairndex.core.paths import PathSafetyError, resolve_within_root
from cairndex.domain.enums import FileAvailability, MediaKind
from cairndex.media import derived_cache
from cairndex.media.ffmpeg_exec import FfmpegError, ffmpeg_exe, run_ffmpeg
from cairndex.persistence.engine import library_root_for_session
from cairndex.persistence.models import AssetFile
from cairndex.registry import library_package

logger = logging.getLogger(__name__)

STORYBOARD_INDEX_CACHE_CONTROL = "no-cache"
STORYBOARD_CACHE_CONTROL = derived_cache.IMMUTABLE_CACHE_CONTROL
STORYBOARD_FORMAT_VERSION = 2
STORYBOARD_TILE_WIDTH = 320
STORYBOARD_GRID_COLUMNS = 5
STORYBOARD_GRID_ROWS = 5
STORYBOARD_TILES_PER_SHEET = STORYBOARD_GRID_COLUMNS * STORYBOARD_GRID_ROWS

ProgressFn = Callable[[int, int | None], None]

_SHEET_STEM = re.compile(r"^sb_\d{3}$")
_ANSI_ESCAPE = re.compile(r"\x1b(?:[@-_]|\[[0-?]*[ -/]*[@-~])")
_FINGERPRINT_NOTE = "NOTE cairndex-quick-fingerprint:"
_JPEG_SOF_MARKERS = {
    0xC0,
    0xC1,
    0xC2,
    0xC3,
    0xC5,
    0xC6,
    0xC7,
    0xC9,
    0xCA,
    0xCB,
    0xCD,
    0xCE,
    0xCF,
}


# ffmpeg was unavailable or failed to produce a storyboard
class StoryboardError(RuntimeError):
    """ffmpeg was unavailable or failed to produce a storyboard."""


@dataclass(frozen=True)
class StoryboardCue:
    """One storyboard VTT cue and its tile crop rectangle."""

    start: float
    end: float
    sheet: int
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class StoryboardFileResult:
    """Per-file storyboard generation result."""

    status: Literal["generated", "skipped", "failed"]
    path: Path | None = None
    reason: str | None = None


@dataclass(frozen=True)
class StoryboardSummary:
    """Library-wide storyboard generation summary."""

    generated: int
    skipped: int
    failed: int


# Compute the target sampling interval for a video's storyboard
def storyboard_interval(duration: float) -> float:
    return max(2.0, min(30.0, duration / 300.0))


# Return the deterministic cache directory for one file's storyboard artifacts
def storyboard_cache_dir(library_root: Path, file_id: str) -> Path:
    return library_package.cache_dir(library_root) / "storyboards" / file_id[:2] / file_id


# Return the cached WebVTT index path for one file
def storyboard_index_path(library_root: Path, file_id: str) -> Path:
    return storyboard_cache_dir(library_root, file_id) / "index.vtt"


# Format a WebVTT timestamp with millisecond precision
def _timestamp(seconds: float) -> str:
    millis = int(round(seconds * 1000))
    hours, rem = divmod(millis, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


# Render the constrained storyboard WebVTT format consumed by web and TV clients
def render_vtt(cues: Iterable[StoryboardCue], quick_fingerprint: str | None) -> str:
    version = storyboard_version_param(quick_fingerprint)
    lines = ["WEBVTT", "", f"{_FINGERPRINT_NOTE} {quick_fingerprint or ''}", ""]
    for cue in cues:
        lines.append(f"{_timestamp(cue.start)} --> {_timestamp(cue.end)}")
        lines.append(
            f"storyboard/sb_{cue.sheet:03d}.jpg?v={version}"
            f"#xywh={cue.x},{cue.y},{cue.width},{cue.height}"
        )
        lines.append("")
    return "\n".join(lines)


# Combine the source fingerprint and storyboard format for sidecar validation
def storyboard_cache_key(quick_fingerprint: str | None) -> str:
    return f"sb{STORYBOARD_FORMAT_VERSION}:{quick_fingerprint or ''}"


# Return a URL-safe token that invalidates sheets when sampling semantics change
def storyboard_version_param(quick_fingerprint: str | None) -> str:
    return derived_cache.version_param(storyboard_cache_key(quick_fingerprint))


# Return True when the cached index was generated for the current quick fingerprint
def is_current_index(library_root: Path, file_id: str, quick_fingerprint: str | None) -> bool:
    index = storyboard_index_path(library_root, file_id)
    return derived_cache.is_current(index, storyboard_cache_key(quick_fingerprint))


# Extract a float duration from probed tech metadata
def _metadata_duration(meta: dict[str, Any] | None) -> float | None:
    if meta is None:
        return None
    value = meta.get("duration")
    if isinstance(value, (int, float)) and math.isfinite(value) and value > 0:
        return float(value)
    return None


# Extract an asset file's probed duration
def _duration(asset_file: AssetFile) -> float | None:
    return _metadata_duration(asset_file.tech_metadata or {})


# Decide whether a file has the minimum metadata needed for storyboard generation
def _normal_ineligibility(
    asset_file: AssetFile, settings: Settings, *, enforce_min_duration: bool
) -> str | None:
    if not settings.storyboards:
        return "storyboards disabled"
    if asset_file.media_kind is not MediaKind.VIDEO:
        return "not a video"
    if asset_file.availability is not FileAvailability.AVAILABLE:
        return "file unavailable"
    duration = _duration(asset_file)
    if duration is None:
        return "duration unavailable"
    if enforce_min_duration and duration < settings.storyboard_min_duration:
        return "below minimum duration"
    return None


# Resolve shared cached-artifact context and feature visibility checks
def _cached_context(
    session: Session, file_id: str, settings: Settings | None = None
) -> tuple[AssetFile, Path, Path]:
    settings = settings or get_settings()
    if not settings.storyboards:
        raise NotFoundError("storyboards are disabled")
    asset_file = session.get(AssetFile, file_id)
    if asset_file is None:
        raise NotFoundError(f"file {file_id!r} not found")
    library_root = library_root_for_session(session)
    cache_dir = storyboard_cache_dir(library_root, file_id)
    return asset_file, library_root, cache_dir


# Return the cached WebVTT index when present and current
def cached_index_for_file(session: Session, file_id: str) -> Path:
    asset_file, library_root, cache_dir = _cached_context(session, file_id)
    index = cache_dir / "index.vtt"
    if not is_current_index(library_root, file_id, asset_file.quick_fingerprint):
        raise NotFoundError("storyboard index not found")
    return index


# Return a cached sheet by validated name; sheets are atomic siblings of index.vtt
def cached_sheet_for_file(session: Session, file_id: str, sheet_name: str) -> Path:
    _asset_file, _library_root, cache_dir = _cached_context(session, file_id)
    if not _SHEET_STEM.fullmatch(sheet_name):
        raise NotFoundError("storyboard sheet not found")
    sheet = cache_dir / f"{sheet_name}.jpg"
    if not sheet.exists():
        raise NotFoundError("storyboard sheet not found")
    return sheet


# Return the manifest storyboard URL only when a current cached index exists
def storyboard_url_for_file(session: Session, library_id: str, asset_file: AssetFile) -> str | None:
    if not get_settings().storyboards:
        return None
    library_root = library_root_for_session(session)
    if not is_current_index(library_root, asset_file.id, asset_file.quick_fingerprint):
        return None
    version = storyboard_version_param(asset_file.quick_fingerprint)
    return f"/api/v1/libraries/{library_id}/files/{asset_file.id}/storyboard.vtt?v={version}"


# Scale ffmpeg's deadline to the source duration while keeping a sane floor
def _storyboard_timeout(duration: float) -> float:
    return max(120.0, duration / 4.0)


# Generate tiled storyboard sheets in one ffmpeg pass
def _generate_sheets(
    source: Path, output_dir: Path, interval: float, duration: float
) -> int | None:
    # showinfo reports each sampled frame before tile pads the final sheet, so
    # its final n value is the real tile count without a second decode pass
    # Anchoring and upward rounding select the frame active at each VTT cue start
    vf = (
        f"fps=1/{interval:g}:start_time=0:round=up,"
        f"scale={STORYBOARD_TILE_WIDTH}:-2,showinfo,tile=5x5"
    )
    try:
        stderr = run_ffmpeg(
            [
                ffmpeg_exe(),
                "-y",
                "-i",
                str(source),
                "-vf",
                vf,
                "-q:v",
                "5",
                str(output_dir / "sb_%03d.jpg"),
            ],
            timeout=_storyboard_timeout(duration),
            stderr_limit=400,
        )
    except FfmpegError as exc:
        raise StoryboardError(str(exc)) from exc
    clean_stderr = _ANSI_ESCAPE.sub("", stderr)
    frames = [int(value) for value in re.findall(r"showinfo[^\n]*\bn:\s*(\d+)", clean_stderr)]
    return max(frames) + 1 if frames else None


# Read JPEG dimensions from SOF metadata without adding an image dependency
def _jpeg_dimensions(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        raise StoryboardError(f"{path.name} is not a JPEG")
    offset = 2
    while offset + 4 <= len(data):
        if data[offset] != 0xFF:
            offset += 1
            continue
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            break
        marker = data[offset]
        offset += 1
        if marker in (0xD8, 0xD9):
            continue
        if offset + 2 > len(data):
            break
        length = int.from_bytes(data[offset : offset + 2], "big")
        if length < 2 or offset + length > len(data):
            break
        if marker in _JPEG_SOF_MARKERS:
            if length < 7:
                break
            height = int.from_bytes(data[offset + 3 : offset + 5], "big")
            width = int.from_bytes(data[offset + 5 : offset + 7], "big")
            if width <= 0 or height <= 0:
                break
            return width, height
        offset += length
    raise StoryboardError(f"could not read dimensions from {path.name}")


# Build cues from the sheets ffmpeg actually emitted
def _build_cues_from_sheets(
    *,
    duration: float,
    interval: float,
    sheets: list[Path],
    sheet_width: int,
    sheet_height: int,
    frame_count: int,
) -> list[StoryboardCue]:
    tile_width = sheet_width // STORYBOARD_GRID_COLUMNS
    tile_height = sheet_height // STORYBOARD_GRID_ROWS
    if tile_width <= 0 or tile_height <= 0:
        raise StoryboardError("invalid storyboard sheet dimensions")
    nominal_cues = max(1, math.ceil(duration / interval))
    cue_count = min(nominal_cues, frame_count, len(sheets) * STORYBOARD_TILES_PER_SHEET)
    cues: list[StoryboardCue] = []
    for index in range(cue_count):
        sheet = (index // STORYBOARD_TILES_PER_SHEET) + 1
        within = index % STORYBOARD_TILES_PER_SHEET
        column = within % STORYBOARD_GRID_COLUMNS
        row = within // STORYBOARD_GRID_COLUMNS
        start = index * interval
        cues.append(
            StoryboardCue(
                start=start,
                end=min(start + interval, duration),
                sheet=sheet,
                x=column * tile_width,
                y=row * tile_height,
                width=tile_width,
                height=tile_height,
            )
        )
    if not cues:
        raise StoryboardError("ffmpeg produced no usable storyboard cues")
    return cues


# Atomically replace one file's storyboard artifact directory
def _replace_cache_dir(cache_dir: Path, temp_dir: Path) -> None:
    cache_dir.parent.mkdir(parents=True, exist_ok=True)
    old_dir = cache_dir.with_name(f"{cache_dir.name}.old")
    if old_dir.exists():
        shutil.rmtree(old_dir)
    if cache_dir.exists():
        cache_dir.rename(old_dir)
    temp_dir.rename(cache_dir)
    if old_dir.exists():
        shutil.rmtree(old_dir)


# Generate or reuse one file's storyboard artifacts
def generate_for_file(
    session: Session, file_id: str, *, force: bool = False
) -> StoryboardFileResult:
    settings = get_settings()
    asset_file = session.get(AssetFile, file_id)
    if asset_file is None:
        raise NotFoundError(f"file {file_id!r} not found")
    reason = _normal_ineligibility(asset_file, settings, enforce_min_duration=False)
    if reason is not None:
        return StoryboardFileResult("skipped", reason=reason)

    duration = _duration(asset_file)
    assert duration is not None
    library_root = library_root_for_session(session)
    cache_dir = storyboard_cache_dir(library_root, file_id)
    if not force and is_current_index(library_root, file_id, asset_file.quick_fingerprint):
        return StoryboardFileResult("skipped", path=cache_dir / "index.vtt", reason="cache current")

    temp_dir: Path | None = None
    try:
        source = Path(resolve_within_root(library_root, asset_file.relative_path))
        interval = storyboard_interval(duration)
        cache_dir.parent.mkdir(parents=True, exist_ok=True)
        temp_dir = Path(tempfile.mkdtemp(prefix=f"{cache_dir.name}.tmp-", dir=cache_dir.parent))
        frame_count = _generate_sheets(source, temp_dir, interval, duration)
        sheets = sorted(temp_dir.glob("sb_*.jpg"))
        if not sheets:
            raise StoryboardError("ffmpeg produced no storyboard sheets")
        if frame_count is None:
            frame_count = len(sheets) * STORYBOARD_TILES_PER_SHEET
            logger.warning(
                "ffmpeg showinfo frame count unavailable; using storyboard sheet capacity"
            )
        sheet_width, sheet_height = _jpeg_dimensions(sheets[0])
        cues = _build_cues_from_sheets(
            duration=duration,
            interval=interval,
            sheets=sheets,
            sheet_width=sheet_width,
            sheet_height=sheet_height,
            frame_count=frame_count,
        )
        (temp_dir / "index.vtt").write_text(
            render_vtt(cues, asset_file.quick_fingerprint),
            encoding="utf-8",
        )
        derived_cache.write_fingerprint(
            temp_dir / "index.vtt", storyboard_cache_key(asset_file.quick_fingerprint)
        )
        _replace_cache_dir(cache_dir, temp_dir)
        temp_dir = None
    except (StoryboardError, FfmpegError, OSError, PathSafetyError) as exc:
        if temp_dir is not None and temp_dir.exists():
            shutil.rmtree(temp_dir, ignore_errors=True)
        return StoryboardFileResult("failed", reason=str(exc))
    return StoryboardFileResult("generated", path=cache_dir / "index.vtt")


# Count library files that are candidates for storyboard skip/generate decisions
def _candidate_count(session: Session) -> int:
    return (
        session.scalar(
            select(func.count())
            .select_from(AssetFile)
            .where(
                AssetFile.media_kind == MediaKind.VIDEO,
                AssetFile.availability == FileAvailability.AVAILABLE,
            )
        )
        or 0
    )


# Generate storyboards for eligible videos in one streaming pass over file ids
def generate_for_library(
    session: Session,
    *,
    force: bool = False,
    on_progress: ProgressFn | None = None,
) -> StoryboardSummary:
    settings = get_settings()
    library_root = library_root_for_session(session)
    total = _candidate_count(session)
    generated = skipped = failed = 0
    stmt = (
        select(AssetFile.id, AssetFile.quick_fingerprint, AssetFile.tech_metadata)
        .where(
            AssetFile.media_kind == MediaKind.VIDEO,
            AssetFile.availability == FileAvailability.AVAILABLE,
        )
        .order_by(AssetFile.id)
    )

    rows = session.execute(stmt).yield_per(20)
    for index, row in enumerate(rows, start=1):
        if on_progress is not None:
            on_progress(index - 1, total)  # cancellation check before each file
        duration = _metadata_duration(row.tech_metadata or {})
        if (
            not settings.storyboards
            or duration is None
            or duration < settings.storyboard_min_duration
            or (not force and is_current_index(library_root, row.id, row.quick_fingerprint))
        ):
            skipped += 1
        else:
            result = generate_for_file(session, row.id, force=force)
            if result.status == "generated":
                generated += 1
            elif result.status == "failed":
                failed += 1
            else:
                skipped += 1
        if on_progress is not None:
            on_progress(index, total)

    if on_progress is not None:
        on_progress(total, total)
    return StoryboardSummary(generated=generated, skipped=skipped, failed=failed)
