"""Benchmark storyboard sampling against synthetic videos of known GOP length.

Storyboard cost is dominated by how much of a video ffmpeg has to decode, and
that depends on the source's keyframe spacing — so the fixtures state their GOP
explicitly rather than leaving it to the encoder. Generates them once with
ffmpeg (no user media is read), then times each sampling mode end to end,
reporting wall clock, the tiles and cues produced, and sheet bytes.

    uv run python -m cairndex.devtools.benchmark_storyboards \\
        --fixtures-dir /tmp/cairndex-storyboard-fixtures --json /tmp/sb.json

The numbers this produces are recorded in docs/performance.md. Rerun it after
any change to the sampling filters, and note that a local SSD flatters full
decoding: on a network-mounted library the read is the other half of the cost.
"""

import argparse
import json
import shutil
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from cairndex.media import storyboards
from cairndex.media.tool_paths import ffmpeg_path


@dataclass(frozen=True)
class Fixture:
    name: str
    codec: str
    duration: int
    width: int
    height: int
    fps: int
    gop_seconds: int


@dataclass(frozen=True)
class Measurement:
    fixture: str
    sampling: str
    seconds: float
    tiles: int
    cues: int
    sheet_kib: float


FIXTURES = (
    Fixture("h264-gop2s", "libx264", 300, 1280, 720, 30, 2),
    Fixture("h264-gop10s", "libx264", 300, 1280, 720, 30, 10),
    Fixture("hevc-gop5s", "libx265", 300, 1280, 720, 30, 5),
)


def _ffmpeg() -> str:
    exe = ffmpeg_path()
    if exe is None:
        raise SystemExit("ffmpeg not found")
    return exe


def _encode(fixture: Fixture, dest: Path) -> None:
    if dest.exists():
        return
    subprocess.run(
        [
            _ffmpeg(),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=duration={fixture.duration}:"
            f"size={fixture.width}x{fixture.height}:rate={fixture.fps}",
            "-c:v",
            fixture.codec,
            "-preset",
            "veryfast",
            "-g",
            str(fixture.gop_seconds * fixture.fps),
            "-pix_fmt",
            "yuv420p",
            str(dest),
        ],
        check=True,
        capture_output=True,
    )


def _measure(fixture: Fixture, source: Path, sampling: storyboards.SamplingMode) -> Measurement:
    duration = float(fixture.duration)
    interval = storyboards.storyboard_interval(duration)
    with tempfile.TemporaryDirectory(prefix="cairndex-sb-bench-") as raw:
        out = Path(raw)
        started = time.monotonic()
        times = storyboards._sample_sheets(source, out, interval, duration, sampling)
        elapsed = time.monotonic() - started
        sheets = sorted(out.glob("sb_*.jpg"))
        width, height = storyboards._jpeg_dimensions(sheets[0])
        cues = storyboards._build_cues(
            duration=duration,
            interval=interval,
            times=times,
            sheets=sheets,
            sheet_width=width,
            sheet_height=height,
        )
        return Measurement(
            fixture=fixture.name,
            sampling=sampling,
            seconds=round(elapsed, 2),
            tiles=len(times or []),
            cues=len(cues),
            sheet_kib=round(sum(sheet.stat().st_size for sheet in sheets) / 1024, 1),
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures-dir", type=Path, required=True)
    parser.add_argument("--json", type=Path, default=None)
    parser.add_argument("--keep-fixtures", action="store_true")
    args = parser.parse_args()

    args.fixtures_dir.mkdir(parents=True, exist_ok=True)
    results: list[Measurement] = []
    try:
        for fixture in FIXTURES:
            source = args.fixtures_dir / f"{fixture.name}.mp4"
            _encode(fixture, source)
            size_mib = source.stat().st_size / 1024 / 1024
            print(f"\n{fixture.name}  {fixture.duration}s  {size_mib:.0f} MiB")
            for sampling in ("keyframe", "exact"):
                result = _measure(fixture, source, sampling)
                results.append(result)
                print(
                    f"  {result.sampling:9s} {result.seconds:7.2f}s"
                    f"  tiles={result.tiles:4d}  cues={result.cues:4d}"
                    f"  sheets={result.sheet_kib:8.1f} KiB"
                )
                if result.tiles and result.cues != result.tiles:
                    print("    note: cue count differs from tile count (sheet capacity cap)")
    finally:
        if not args.keep_fixtures:
            shutil.rmtree(args.fixtures_dir, ignore_errors=True)

    if args.json:
        args.json.write_text(
            json.dumps([asdict(result) for result in results], indent=2), encoding="utf-8"
        )


if __name__ == "__main__":
    main()
