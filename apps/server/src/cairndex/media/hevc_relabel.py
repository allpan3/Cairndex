"""Relabelling ``hev1`` HEVC as ``hvc1`` in place, without re-encoding.

HEVC in MP4 carries one of two four-character codes, and they differ only in
where the parameter sets (VPS/SPS/PPS) are allowed to live: ``hvc1`` promises
they are complete in the sample description, while ``hev1`` allows them in-band
and to change. AVFoundation — Safari, and so the desktop shell's WKWebView —
plays only ``hvc1``. It refuses ``hev1`` outright, at every colour depth, while
MediaSource accepts it (measured against WKWebView, 2026-08-16).

That single refusal is why an ``hev1`` file needs an HLS remux session at all:
MSE is the only route to a decoder that will take it, and HLS is the only route
to MSE. Everything downstream — an ffmpeg process, session lifetimes, the idle
reaper, keepalives, segment holes, transcode disk — exists because of it.

But the conversion is *five bytes*. Encoding identical content with
``-tag:v hvc1`` and ``-tag:v hev1`` produces files differing only in:

- the sample-entry four-character code (2 bytes: the codes share ``h`` and ``1``);
- ``array_completeness`` on each NAL array in ``hvcC`` (1 byte each), which the
  ``hvc1`` form sets to say the parameter sets are complete in the header.

So when a file already carries its parameter sets in ``hvcC`` — which is what
encoders write either way — the whole remux is byte-equivalent to patching those
offsets and serving the original ``mdat`` untouched. This module finds them.

**The guard is load-bearing.** Claiming ``hvc1`` for a stream that genuinely
varies its parameter sets in-band is a lie that breaks playback partway through,
which is far worse than a remux. So this returns ``None`` unless all three
parameter-set arrays are present in the header with at least one NAL each.

Deliberately narrow, like ``mp4_index``: plain progressive MP4/MOV, first video
track, and ``None`` for anything it cannot read confidently. Offsets are absolute
in the file, because the caller patches bytes while streaming.
"""

from __future__ import annotations

import struct
from collections import OrderedDict
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

# `moov` is single-digit MB even for long files; anything past this is not what
# we think it is, and the caller can fall back to a remux. Mirrors mp4_index.
_MAX_MOOV_BYTES = 128 * 1024 * 1024
_CONTAINER_BRANDS = frozenset({b"ftyp", b"moov", b"mdat", b"free", b"skip", b"wide", b"pnot"})

# A VisualSampleEntry's fixed fields, before its child boxes (`hvcC` among them).
_VISUAL_SAMPLE_ENTRY_FIELDS = 78
# `hvcC` fixed fields before `numOfArrays`; the arrays follow that byte.
_HVCC_FIXED_FIELDS = 22
# HEVC NAL unit types for the parameter sets a complete `hvc1` header must carry.
_VPS, _SPS, _PPS = 32, 33, 34
_REQUIRED_ARRAYS = frozenset({_VPS, _SPS, _PPS})
# Set in `array_completeness` to say "these are all of them, none arrive in-band".
_ARRAY_COMPLETE = 0x80


@dataclass(frozen=True)
class HevcRelabel:
    """Absolute file offsets that turn an ``hev1`` track into an ``hvc1`` one."""

    # Offset of the four-character code itself; four bytes, `hev1` -> `hvc1`.
    tag_offset: int
    # One offset per *parameter-set* array header byte (VPS/SPS/PPS), each of
    # which gains _ARRAY_COMPLETE. Other arrays are left alone.
    array_offsets: tuple[int, ...]

    def apply(self, data: bytes, start: int) -> bytes:
        """Return ``data`` (a chunk beginning at file offset ``start``) patched."""
        end = start + len(data)
        out = bytearray(data)
        for index, byte in enumerate(b"hvc1"):
            offset = self.tag_offset + index
            if start <= offset < end:
                out[offset - start] = byte
        for offset in self.array_offsets:
            if start <= offset < end:
                out[offset - start] |= _ARRAY_COMPLETE
        return bytes(out)


def _read_box_header(fh: BinaryIO, offset: int, limit: int) -> tuple[bytes, int, int] | None:
    """``(type, payload_offset, box_end)`` for the box at ``offset``."""
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
        size = limit - offset
    if size < header or offset + size > limit:
        return None
    return type_, offset + header, offset + size


def _find_moov(fh: BinaryIO, file_size: int) -> tuple[int, int] | None:
    """``(payload_offset, end)`` of ``moov``, reading headers only."""
    offset = 0
    saw_known = False
    while offset < file_size:
        box = _read_box_header(fh, offset, file_size)
        if box is None:
            return None
        type_, payload, end = box
        if type_ in _CONTAINER_BRANDS:
            saw_known = True
        elif not saw_known:
            return None  # not an MP4 family file at all
        if type_ == b"moov":
            return (payload, end) if end - payload <= _MAX_MOOV_BYTES else None
        offset = end
    return None


def _children(data: bytes, start: int, end: int) -> Iterator[tuple[bytes, int, int]]:
    """Yield ``(type, payload_start, box_end)`` for boxes in ``data[start:end]``."""
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


def _child(data: bytes, span: tuple[int, int], want: bytes) -> tuple[int, int] | None:
    for type_, start, end in _children(data, span[0], span[1]):
        if type_ == want:
            return start, end
    return None


def _descend(data: bytes, span: tuple[int, int], path: tuple[bytes, ...]) -> tuple[int, int] | None:
    current: tuple[int, int] | None = span
    for name in path:
        if current is None:
            return None
        current = _child(data, current, name)
    return current


def _array_offsets(data: bytes, hvcc: tuple[int, int]) -> tuple[int, ...] | None:
    """Offsets of each NAL array header byte in ``hvcC``, or None if unusable.

    Returns None unless VPS, SPS and PPS are all present with at least one NAL
    each — see the module docstring on why that guard decides correctness.
    """
    start, end = hvcc
    cursor = start + _HVCC_FIXED_FIELDS
    if cursor + 1 > end:
        return None
    count = data[cursor]
    cursor += 1
    offsets: list[int] = []
    seen: set[int] = set()
    for _ in range(count):
        if cursor + 3 > end:
            return None
        header = data[cursor]
        nal_type = header & 0x3F
        num_nalus = struct.unpack(">H", data[cursor + 1 : cursor + 3])[0]
        if num_nalus == 0:
            return None  # an empty array cannot be "complete"
        if nal_type in _REQUIRED_ARRAYS:
            # Only the parameter sets are claimed complete. SEI and the rest can
            # legitimately arrive in-band, and ffmpeg leaves their bit clear —
            # setting it would assert something untrue about the stream.
            offsets.append(cursor)
        seen.add(nal_type)
        cursor += 3
        for _ in range(num_nalus):
            if cursor + 2 > end:
                return None
            length = struct.unpack(">H", data[cursor : cursor + 2])[0]
            cursor += 2 + length
            if cursor > end:
                return None
    if not _REQUIRED_ARRAYS.issubset(seen):
        return None
    return tuple(offsets)


def find_hevc_relabel(path: Path) -> HevcRelabel | None:
    """Offsets that relabel an ``hev1`` track as ``hvc1``, or ``None``.

    ``None`` means "remux it" — not an MP4, no ``hev1`` sample entry, no
    ``hvcC``, or parameter sets that are not provably complete in the header.
    """
    try:
        file_size = path.stat().st_size
        with path.open("rb") as fh:
            moov = _find_moov(fh, file_size)
            if moov is None:
                return None
            moov_start, moov_end = moov
            fh.seek(moov_start)
            data = fh.read(moov_end - moov_start)
    except OSError:
        return None
    if len(data) != moov_end - moov_start:
        return None

    # Offsets within `data` are relative to `moov_start`; the caller needs them
    # absolute, because it patches bytes as they stream past.
    span = (0, len(data))
    for _type, trak_start, trak_end in _children(data, *span):
        if _type != b"trak":
            continue
        stsd = _descend(data, (trak_start, trak_end), (b"mdia", b"minf", b"stbl", b"stsd"))
        if stsd is None:
            continue
        # `stsd` is a full box: version/flags (4) then entry_count (4).
        entries_start = stsd[0] + 8
        for entry_type, entry_payload, entry_end in _children(data, entries_start, stsd[1]):
            if entry_type != b"hev1":
                continue
            tag_offset = entry_payload - 8 + 4  # the type field of this box
            children_start = entry_payload + _VISUAL_SAMPLE_ENTRY_FIELDS
            hvcc = _child(data, (children_start, entry_end), b"hvcC")
            if hvcc is None:
                return None
            offsets = _array_offsets(data, hvcc)
            if offsets is None:
                return None
            return HevcRelabel(
                tag_offset=moov_start + tag_offset,
                array_offsets=tuple(moov_start + offset for offset in offsets),
            )
    return None


# Relabels already worked out, keyed by identity on disk rather than path alone so
# a replaced file is re-read instead of served stale offsets. The decision and the
# stream route both need the same answer within milliseconds of each other, and
# `moov` is megabytes — parsing it twice per play would be the waste. Bounded and
# in-process, like `probe_service.probe_path`: this is a cache, not a store.
_CACHE_LIMIT = 256
_cache: OrderedDict[tuple[str, int, int], HevcRelabel | None] = OrderedDict()


def relabel_for(path: Path) -> HevcRelabel | None:
    """:func:`find_hevc_relabel`, memoised on the file's identity on disk."""
    try:
        stat = path.stat()
        key = (str(path), stat.st_size, stat.st_mtime_ns)
    except OSError:
        return None
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]
    # Cached even when None: "this needs a remux" is just as worth not re-deriving.
    found = find_hevc_relabel(path)
    _cache[key] = found
    while len(_cache) > _CACHE_LIMIT:
        _cache.popitem(last=False)
    return found
