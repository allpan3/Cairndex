"""Contact sheets: a grid of evenly spaced frames from one video (plan 1 §10).

The first slice of the M11 export family the owner asked for (2026-07-27). The
server produces the *frame grid only* — evenly sampled frames tiled into one
JPEG with ffmpeg, cached like every other derived asset. The metadata header
(title, size, duration, codecs) is composed by the client on a canvas: it
already holds every value it wants to print, and drawing text here would drag
in font discovery (`drawtext` needs a fontfile and a freetype build) for output
the browser renders better anyway.

Generated on demand and cached under ``.cairndex/cache/contact-sheets/`` keyed
by file id, grid shape, and the source's quick fingerprint — the same
regenerate-when-the-bytes-change rule as previews.

Frames are taken by seeking to each one, not by decoding the video and
sampling. The difference is the whole cost model: sampling with ``fps=1/n``
decodes every frame between the first sample and the last, so the work scales
with the video's *duration* — measured at 24s for a twelve-minute 4K file, and
proportionally worse from there, which is what made long videos fail behind the
desktop shell's relay timeout (owner, 2026-07-27). Seeking to each frame costs
the same whatever the video's length: the same file takes 1.9s, and so does one
ten times longer.
"""

from pathlib import Path

from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.core.paths import resolve_within_root
from cairndex.domain.enums import MediaKind
from cairndex.media import derived_cache
from cairndex.media.ffmpeg_exec import FfmpegError, ffmpeg_exe, run_ffmpeg
from cairndex.persistence.engine import library_root_for_session
from cairndex.persistence.models import AssetFile
from cairndex.registry import library_package

# Bounded grid parameters: enough range for a dense sheet without letting a
# request ask for arbitrary amounts of decode work.
MIN_COLS, MAX_COLS = 2, 6
MIN_ROWS, MAX_ROWS = 2, 10
# Sheet pixel widths a client may ask for (the height follows the aspect).
SHEET_WIDTHS = (1280, 1600, 2048)

CACHE_CONTROL = derived_cache.IMMUTABLE_CACHE_CONTROL

# Sampling starts a beat in and stops short of the end: frame zero is usually a
# black lead-in or a studio card, and the final seconds credits/black again. The
# trim is a *fraction with a ceiling*: 4% of a two-minute clip is a few seconds,
# but 4% of a feature is minutes of the film simply missing from the sheet
# (owner, 2026-07-27).
_EDGE_TRIM_FRACTION = 0.04
_EDGE_TRIM_MAX_SECONDS = 5.0

# Black gutter around each cell, so neighbouring frames stay distinguishable.
_CELL_GUTTER = 4


class ContactSheetError(Exception):
    """ffmpeg was unavailable or failed to produce a sheet."""


def sheet_cache_path(library_root: Path, file_id: str, cols: int, rows: int, width: int) -> Path:
    return (
        library_package.cache_dir(library_root)
        / "contact-sheets"
        / file_id[:2]
        / f"{file_id}_{cols}x{rows}_{width}.jpg"
    )


def _validated(cols: int, rows: int, width: int) -> tuple[int, int, int]:
    if not (MIN_COLS <= cols <= MAX_COLS and MIN_ROWS <= rows <= MAX_ROWS):
        raise ValidationError(
            f"grid must be {MIN_COLS}–{MAX_COLS} columns by {MIN_ROWS}–{MAX_ROWS} rows"
        )
    if width not in SHEET_WIDTHS:
        raise ValidationError(f"width must be one of {SHEET_WIDTHS}")
    return cols, rows, width


def frame_times(duration: float, cols: int, rows: int) -> list[float]:
    """The instant each cell is sampled from, left to right and top to bottom.

    Shared with the caller so the client can label every cell without repeating
    the sampling rule — the label and the frame come from one definition.
    """
    frames = cols * rows
    trim = min(duration * _EDGE_TRIM_FRACTION, _EDGE_TRIM_MAX_SECONDS)
    span = max(duration - 2 * trim, 0.001)
    interval = span / frames
    # Each cell stands for one slice of the video and is taken from the *middle*
    # of its slice. Sampling the slice's leading edge instead left the final
    # slice unrepresented — the last frame landed a whole interval before the
    # end, so on a long video several minutes never appeared at all.
    return [trim + (index + 0.5) * interval for index in range(frames)]


def sheet_for_file(
    session: Session, file_id: str, *, cols: int = 4, rows: int = 4, width: int = 1600
) -> tuple[Path, list[float]]:
    """The cached contact sheet for one video file, and each cell's timestamp."""
    cols, rows, width = _validated(cols, rows, width)
    asset_file = session.get(AssetFile, file_id)
    if asset_file is None:
        raise NotFoundError(f"file {file_id!r} not found")
    if asset_file.media_kind is not MediaKind.VIDEO:
        raise ValidationError("contact sheets are derived from video files")

    duration = _probed_duration(asset_file)
    if duration is None:
        raise ValidationError("this video has not been probed yet — run Collect metadata")

    times = frame_times(duration, cols, rows)
    library_root = library_root_for_session(session)
    dest = sheet_cache_path(library_root, file_id, cols, rows, width)
    if derived_cache.is_current(dest, asset_file.quick_fingerprint):
        return dest, times

    source = resolve_within_root(library_root, asset_file.relative_path)
    _generate(Path(source), dest, times, cols=cols, rows=rows, width=width)
    derived_cache.write_fingerprint(dest, asset_file.quick_fingerprint)
    return dest, times


def _probed_duration(asset_file: AssetFile) -> float | None:
    value = (asset_file.tech_metadata or {}).get("duration")
    return float(value) if isinstance(value, (int, float)) and value > 0 else None


def _stack_layout(cols: int, rows: int) -> str:
    """`xstack` cell positions for a uniform grid.

    Every cell is scaled to the same size, so each offset is a multiple of the
    first input's width and height — expressed as repeated `w0`/`h0` terms,
    which every ffmpeg build that has `xstack` understands.
    """
    positions = []
    for row in range(rows):
        for col in range(cols):
            x = "+".join(["w0"] * col) if col else "0"
            y = "+".join(["h0"] * row) if row else "0"
            positions.append(f"{x}_{y}")
    return "|".join(positions)


def _generate(
    source: Path, dest: Path, times: list[float], *, cols: int, rows: int, width: int
) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    cell_width = max(width // cols, 2)
    # One input per frame, each seeking straight to its own timestamp. `-ss`
    # before `-i` is an input seek, so ffmpeg jumps to the nearest keyframe
    # instead of decoding everything that came before it. `-noaccurate_seek`
    # keeps it at that keyframe rather than decoding forward to the exact
    # instant: a contact sheet wants a representative frame, not a precise one,
    # and the difference is the entire cost.
    args = [ffmpeg_exe(), "-y"]
    for at in times:
        args += ["-noaccurate_seek", "-ss", f"{at:.3f}", "-i", str(source)]
    # The gutter lives *inside* each cell rather than between them, so the sheet
    # divides exactly into `cols x rows` equal cells. The client labels each one
    # by dividing the image that way, and an outer-only gutter would put every
    # label a little further out of place than the last.
    scales = ";".join(
        f"[{index}:v]scale={cell_width - _CELL_GUTTER}:-2,setsar=1,"
        f"pad=iw+{_CELL_GUTTER}:ih+{_CELL_GUTTER}:{_CELL_GUTTER // 2}:{_CELL_GUTTER // 2}:black"
        f"[c{index}]"
        for index in range(len(times))
    )
    inputs = "".join(f"[c{index}]" for index in range(len(times)))
    layout = _stack_layout(cols, rows)
    args += [
        "-filter_complex",
        f"{scales};{inputs}xstack=inputs={len(times)}:layout={layout}:fill=black[grid]",
        "-map",
        "[grid]",
        "-frames:v",
        "1",
        "-q:v",
        "3",
        str(dest),
    ]
    try:
        run_ffmpeg(args, timeout=180.0)
    except FfmpegError as exc:
        raise ContactSheetError(str(exc)) from exc
    if not dest.exists() or dest.stat().st_size == 0:
        raise ContactSheetError(f"ffmpeg produced no contact sheet for {source}")
