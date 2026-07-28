"""Read an MP4's keyframe index directly, without demuxing the media.

A ``-c:v copy`` remux playlist has to know where the source's keyframes are,
because copy-mux can only cut where one already exists (ADR-0014). ffprobe can
answer that, but it demuxes the file front to back to do it: on a 4 GB 1080p
HEVC source on a network volume, ~20 s of pure I/O, inside the playback-decision
request the client abandons after 15 s. So a large file could not start at all.

MP4 already stores the answer. The ``moov`` box carries, per track, a
sync-sample table (``stss``) listing which samples are keyframes and a
time-to-sample table (``stts``) giving each sample's duration — everything
needed to turn sample numbers into timestamps. ``moov`` is typically a few MB
and can be seeked to directly, so this reads megabytes instead of gigabytes.
Measured on that same file: ``moov`` is 4.2 MB at the very end, and parsing it
is ~0.1 s against ffprobe's ~20 s, for the same 487 timestamps.

Deliberately narrow: it understands plain progressive MP4/MOV and returns
``None`` for anything else — fragmented MP4, a missing ``stss``, an unreadable
or implausible box layout — so the caller falls back to ffprobe rather than
this file growing into a second demuxer.
"""

from __future__ import annotations

import struct
from collections.abc import Iterator
from pathlib import Path
from typing import BinaryIO

# A sane ceiling on the index we will pull into memory. Real ``moov`` boxes are
# single-digit MB even for long files; anything past this is either pathological
# or not what we think it is, and ffprobe can have it.
_MAX_MOOV_BYTES = 128 * 1024 * 1024
# Guards a malformed/hostile header from becoming a giant allocation before the
# size checks below get a chance to run.
_MAX_TABLE_ENTRIES = 50_000_000
_CONTAINER_BRANDS = frozenset({b"ftyp", b"moov", b"mdat", b"free", b"skip", b"wide", b"pnot"})


class _Box:
    __slots__ = ("type", "offset", "size", "header")

    def __init__(self, type_: bytes, offset: int, size: int, header: int) -> None:
        self.type = type_
        self.offset = offset
        self.size = size
        self.header = header

    @property
    def payload_offset(self) -> int:
        return self.offset + self.header

    @property
    def payload_size(self) -> int:
        return self.size - self.header


def _read_box_header(fh: BinaryIO, offset: int, limit: int) -> _Box | None:
    """Parse one box header at ``offset``, or ``None`` if it is not usable."""
    if offset + 8 > limit:
        return None
    fh.seek(offset)
    head = fh.read(8)
    if len(head) < 8:
        return None
    size = struct.unpack(">I", head[:4])[0]
    type_ = head[4:8]
    header = 8
    if size == 1:
        ext = fh.read(8)
        if len(ext) < 8:
            return None
        size = struct.unpack(">Q", ext)[0]
        header = 16
    elif size == 0:
        # "extends to end of file" — legal, and the last box either way.
        size = limit - offset
    if size < header or offset + size > limit:
        return None
    return _Box(type_, offset, size, header)


def _find_moov(fh: BinaryIO, file_size: int) -> _Box | None:
    """Walk top-level boxes for ``moov``, reading headers only.

    ``moov`` sits at the end as often as the front (only "faststart" files move
    it forward), and either way this seeks past ``mdat`` rather than reading it.
    """
    offset = 0
    seen_known = False
    while offset < file_size:
        box = _read_box_header(fh, offset, file_size)
        if box is None:
            return None
        if box.type in _CONTAINER_BRANDS:
            seen_known = True
        elif not seen_known:
            # First box was not anything an MP4 starts with — not our format.
            return None
        if box.type == b"moov":
            return box
        offset += box.size
    return None


def _iter_children(data: bytes, start: int, end: int) -> Iterator[tuple[bytes, int, int]]:
    """Yield ``(type, payload_start, payload_end)`` for boxes within a payload."""
    offset = start
    while offset + 8 <= end:
        size = struct.unpack(">I", data[offset : offset + 4])[0]
        type_ = data[offset + 4 : offset + 8]
        header = 8
        if size == 1:
            if offset + 16 > end:
                return
            size = struct.unpack(">Q", data[offset + 8 : offset + 16])[0]
            header = 16
        elif size == 0:
            size = end - offset
        if size < header or offset + size > end:
            return
        yield type_, offset + header, offset + size
        offset += size


def _find_child(data: bytes, start: int, end: int, want: bytes) -> tuple[int, int] | None:
    for type_, child_start, child_end in _iter_children(data, start, end):
        if type_ == want:
            return child_start, child_end
    return None


def _descend(data: bytes, start: int, end: int, path: tuple[bytes, ...]) -> tuple[int, int] | None:
    span: tuple[int, int] | None = (start, end)
    for name in path:
        if span is None:
            return None
        span = _find_child(data, span[0], span[1], name)
    return span


def _u32_table(data: bytes, start: int, end: int, *, columns: int) -> list[tuple[int, ...]] | None:
    """Parse a full-box table of ``columns`` big-endian u32s per entry."""
    if start + 8 > end:
        return None
    count = struct.unpack(">I", data[start + 4 : start + 8])[0]
    if count > _MAX_TABLE_ENTRIES:
        return None
    body = start + 8
    stride = 4 * columns
    if body + count * stride > end:
        return None
    fmt = ">" + "I" * columns
    return [
        struct.unpack(fmt, data[body + i * stride : body + (i + 1) * stride]) for i in range(count)
    ]


def _timescale(data: bytes, mdia_start: int, mdia_end: int) -> int | None:
    span = _find_child(data, mdia_start, mdia_end, b"mdhd")
    if span is None:
        return None
    start, end = span
    if start + 4 > end:
        return None
    version = data[start]
    # v0: [version/flags 4][created 4][modified 4][timescale 4][duration 4]
    # v1 widens created/modified/duration to 8 bytes; timescale stays u32.
    offset = start + 4 + (16 if version == 1 else 8)
    if offset + 4 > end:
        return None
    scale = struct.unpack(">I", data[offset : offset + 4])[0]
    return scale or None


def _is_video_track(data: bytes, mdia_start: int, mdia_end: int) -> bool:
    span = _find_child(data, mdia_start, mdia_end, b"hdlr")
    if span is None:
        return False
    start, end = span
    # [version/flags 4][predefined 4][handler type 4]
    return end - start >= 12 and data[start + 8 : start + 12] == b"vide"


def _decode_times(data: bytes, stbl_start: int, stbl_end: int) -> list[int] | None:
    """Per-sample decode timestamps, from the time-to-sample table."""
    span = _find_child(data, stbl_start, stbl_end, b"stts")
    if span is None:
        return None
    entries = _u32_table(data, span[0], span[1], columns=2)
    if entries is None:
        return None
    times: list[int] = []
    running = 0
    for count, delta in entries:
        if count > _MAX_TABLE_ENTRIES or len(times) + count > _MAX_TABLE_ENTRIES:
            return None
        for _ in range(count):
            times.append(running)
            running += delta
    return times


def _composition_offsets(data: bytes, stbl_start: int, stbl_end: int) -> list[int]:
    """Per-sample composition offsets (``ctts``), empty when the box is absent.

    Presentation order differs from decode order whenever B-frames are used, and
    the playlist has to speak in presentation time — the same clock ffmpeg cuts
    on. Version 1 offsets are signed.
    """
    span = _find_child(data, stbl_start, stbl_end, b"ctts")
    if span is None:
        return []
    start, end = span
    if start + 8 > end:
        return []
    version = data[start]
    count = struct.unpack(">I", data[start + 4 : start + 8])[0]
    if count > _MAX_TABLE_ENTRIES:
        return []
    body = start + 8
    if body + count * 8 > end:
        return []
    offsets: list[int] = []
    for i in range(count):
        run, raw = struct.unpack(">II", data[body + i * 8 : body + (i + 1) * 8])
        value = struct.unpack(">i", struct.pack(">I", raw))[0] if version == 1 else raw
        if run > _MAX_TABLE_ENTRIES or len(offsets) + run > _MAX_TABLE_ENTRIES:
            return []
        offsets.extend([value] * run)
    return offsets


def _sync_samples(data: bytes, stbl_start: int, stbl_end: int) -> list[int] | None:
    """1-based sample numbers that are keyframes, from ``stss``."""
    span = _find_child(data, stbl_start, stbl_end, b"stss")
    if span is None:
        # No sync table means *every* sample is a sync sample. That is legal, but
        # it is also what an all-intra or a fragmented file looks like, and the
        # resulting "every frame is a cut point" playlist is not what the caller
        # wants — let ffprobe arbitrate.
        return None
    entries = _u32_table(data, span[0], span[1], columns=1)
    if entries is None:
        return None
    return [entry[0] for entry in entries]


def _movie_timescale(data: bytes) -> int | None:
    """Timescale of the movie header, the unit edit-list durations are in."""
    span = _find_child(data, 0, len(data), b"mvhd")
    if span is None:
        return None
    start, end = span
    if start + 4 > end:
        return None
    version = data[start]
    offset = start + 4 + (16 if version == 1 else 8)
    if offset + 4 > end:
        return None
    scale = struct.unpack(">I", data[offset : offset + 4])[0]
    return scale or None


def _edit(
    data: bytes, trak_start: int, trak_end: int, movie_scale: int, media_scale: int
) -> tuple[float, float] | None:
    """``(delay, shift)`` seconds from the track's edit list.

    An edit list re-maps media time onto presentation time, and players honour
    it — so a playlist that ignores it is offset against the very timeline
    ffmpeg cuts on. Two forms cover ordinary files: leading *empty* edits
    (``media_time == -1``) insert blank at the front, and the real edit names the
    media time that becomes the start of playback. Presentation time is then
    ``delay + (pts - shift)``.

    Anything more elaborate — several real edits, i.e. a trimmed or spliced
    timeline — returns ``None`` so the caller falls back to ffprobe rather than
    this guessing at splice points.
    """
    edts = _find_child(data, trak_start, trak_end, b"edts")
    if edts is None:
        return (0.0, 0.0)
    elst = _find_child(data, edts[0], edts[1], b"elst")
    if elst is None:
        return (0.0, 0.0)
    start, end = elst
    if start + 8 > end:
        return None
    version = data[start]
    count = struct.unpack(">I", data[start + 4 : start + 8])[0]
    stride = 20 if version == 1 else 12
    body = start + 8
    if count > _MAX_TABLE_ENTRIES or body + count * stride > end:
        return None

    delay_units = 0
    shift_units: int | None = None
    for i in range(count):
        entry = body + i * stride
        if version == 1:
            duration, media_time = struct.unpack(">Qq", data[entry : entry + 16])
        else:
            duration, media_time = struct.unpack(">Ii", data[entry : entry + 8])
        if media_time < 0:
            # Empty edit: blank leader, measured in the *movie* timescale.
            delay_units += duration
            continue
        if shift_units is not None:
            return None  # more than one real edit — not ours to interpret
        shift_units = media_time
    return (delay_units / movie_scale, (shift_units or 0) / media_scale)


def keyframe_times_from_mp4(path: Path) -> list[float] | None:
    """Sorted keyframe presentation times (seconds) for the first video track.

    ``None`` whenever this cannot be answered confidently — not an MP4, no
    ``moov``/``stss``, a fragmented file, an implausible table, or any I/O
    error — so the caller falls back to ffprobe. Never raises for a bad file.
    """
    try:
        file_size = path.stat().st_size
        with path.open("rb") as fh:
            moov = _find_moov(fh, file_size)
            if moov is None or moov.payload_size <= 0:
                return None
            if moov.payload_size > _MAX_MOOV_BYTES:
                return None
            fh.seek(moov.payload_offset)
            data = fh.read(moov.payload_size)
    except OSError:
        return None
    if len(data) < moov.payload_size:
        return None

    movie_scale = _movie_timescale(data)
    if movie_scale is None:
        return None

    for type_, trak_start, trak_end in _iter_children(data, 0, len(data)):
        if type_ != b"trak":
            continue
        mdia = _find_child(data, trak_start, trak_end, b"mdia")
        if mdia is None or not _is_video_track(data, mdia[0], mdia[1]):
            continue
        scale = _timescale(data, mdia[0], mdia[1])
        stbl = _descend(data, mdia[0], mdia[1], (b"minf", b"stbl"))
        if scale is None or stbl is None:
            return None
        edit = _edit(data, trak_start, trak_end, movie_scale, scale)
        if edit is None:
            return None
        delay, shift = edit
        sync = _sync_samples(data, stbl[0], stbl[1])
        decode = _decode_times(data, stbl[0], stbl[1])
        if not sync or not decode:
            return None
        offsets = _composition_offsets(data, stbl[0], stbl[1])
        times: list[float] = []
        for sample in sync:
            index = sample - 1  # stss is 1-based
            if index < 0 or index >= len(decode):
                return None
            pts = decode[index] + (offsets[index] if index < len(offsets) else 0)
            presented = delay + (pts / scale - shift)
            # Samples ahead of the edit's start are trimmed away by the player,
            # so they are not cut points on the timeline the playlist describes.
            if presented >= 0:
                times.append(presented)
        return sorted(times) if times else None
    return None
