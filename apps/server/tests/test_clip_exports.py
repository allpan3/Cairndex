"""Clip exports: validation, the encode task, and the endpoints (plan 1 §10)."""

import base64
import io
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy.orm import Session

from cairndex.api.v1 import exports as exports_api
from cairndex.core.errors import CapacityError, ValidationError
from cairndex.domain.enums import FileRole, MediaKind
from cairndex.media import exports
from cairndex.media.exports import ExportManager, GifParams
from cairndex.persistence.models import AssetFile
from cairndex.services import bundles as bundle_service

_FFMPEG = shutil.which("ffmpeg")
requires_ffmpeg = pytest.mark.skipif(_FFMPEG is None, reason="ffmpeg not installed")


def _make_video(path: Path, *, duration: int = 6) -> None:
    assert _FFMPEG is not None
    subprocess.run(
        [
            _FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=duration={duration}:size=320x180:rate=10",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def _video_file(
    session: Session, library_root: Path, *, name: str = "movie.mp4", duration: float = 6.0
) -> AssetFile:
    bundle = bundle_service.create_bundle(session, title=name)
    asset_file = bundle_service.add_file(
        session,
        bundle.id,
        relative_path=name,
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    asset_file.tech_metadata = {"duration": duration, "width": 320, "height": 180}
    session.flush()
    return asset_file


def _params(**overrides: object) -> GifParams:
    base = {"start_s": 1.0, "end_s": 3.0, "width": 480, "fps": 12}
    base.update(overrides)
    return GifParams(**base)  # type: ignore[arg-type]


def _settled(manager: ExportManager, export_id: str, library_id: str = "lib") -> str:
    """Wait for the worker thread to reach a terminal state."""
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        export = manager.get(export_id, library_id=library_id)
        assert export is not None
        if export.status in ("done", "failed"):
            return export.status
        time.sleep(0.01)
    raise AssertionError("export never settled")


# --- validation -------------------------------------------------------------


def test_defaults_fill_in_width_and_fps() -> None:
    params = exports.validated_gif_params(
        start_s=1.0, end_s=4.0, width=None, fps=None, duration=60.0
    )
    assert params.width == exports.DEFAULT_WIDTH
    assert params.fps == exports.DEFAULT_FPS
    assert params.duration == pytest.approx(3.0)


# 15 is the rate people reach for in a GIF, and the owner asked for it as the
# default (2026-08-15) knowing it is not one the format holds exactly: a whole
# number of centiseconds per frame means only 100/n survives, so 15 becomes a
# 7cs delay and plays at 14.29 — measured, along with 12→12.5 and 30→33.33.
# 4.7% is well under what anyone notices, and the client prints the real rate.
def test_the_default_frame_rate_is_the_conventional_one() -> None:
    assert exports.DEFAULT_FPS == 15
    assert exports.MIN_FPS <= exports.DEFAULT_FPS <= exports.MAX_FPS
    # What it will really play at, from the same rounding ffmpeg does.
    assert 100 / round(100 / exports.DEFAULT_FPS) == pytest.approx(14.29, abs=0.01)


# Raised from plan 1 §10's sketched 15 once the format was measured rather than
# guessed at: 20 and 25 are both exact and smoother, and 50 is the last rate
# whose delay (2cs) is not in the range historic viewers reinterpret.
def test_the_rate_ceiling_admits_the_exact_rates_above_fifteen() -> None:
    assert exports.MAX_FPS == 50
    for rate in (20, 25, 50):
        params = exports.validated_gif_params(
            start_s=0.0, end_s=2.0, width=None, fps=rate, duration=60.0
        )
        assert params.fps == rate
    with pytest.raises(ValidationError, match="fps"):
        exports.validated_gif_params(start_s=0.0, end_s=2.0, width=None, fps=60, duration=60.0)


# Raised from 720 so the client's "Original" can mean it for a 1080p source,
# but still bounded: a GIF is one indexed frame per frame, and 4K would run to
# hundreds of megabytes for a thirty-second clip.
def test_the_width_ceiling_admits_1080p_and_stops_there() -> None:
    assert exports.MAX_WIDTH == 1920
    exports.validated_gif_params(start_s=0.0, end_s=2.0, width=1920, fps=None, duration=60.0)
    with pytest.raises(ValidationError, match="width"):
        exports.validated_gif_params(start_s=0.0, end_s=2.0, width=3840, fps=None, duration=60.0)


def test_rejects_a_range_that_is_inverted_empty_or_too_long() -> None:
    with pytest.raises(ValidationError, match="end must come after"):
        exports.validated_gif_params(start_s=5.0, end_s=2.0, width=None, fps=None, duration=60.0)
    with pytest.raises(ValidationError, match="end must come after"):
        exports.validated_gif_params(start_s=5.0, end_s=5.0, width=None, fps=None, duration=60.0)
    with pytest.raises(ValidationError, match="at most"):
        exports.validated_gif_params(
            start_s=0.0,
            end_s=exports.MAX_CLIP_SECONDS + 1,
            width=None,
            fps=None,
            duration=600.0,
        )


def test_rejects_width_and_fps_outside_the_caps() -> None:
    with pytest.raises(ValidationError, match="width"):
        exports.validated_gif_params(
            start_s=0.0, end_s=2.0, width=exports.MAX_WIDTH + 1, fps=None, duration=60.0
        )
    with pytest.raises(ValidationError, match="fps"):
        exports.validated_gif_params(
            start_s=0.0, end_s=2.0, width=None, fps=exports.MAX_FPS + 1, duration=60.0
        )


# The client's duration comes from a probe that can sit a hair short of the real
# stream, so an out-point at the very end is trimmed rather than refused.
def test_trims_an_end_past_the_probed_duration() -> None:
    params = exports.validated_gif_params(
        start_s=8.0, end_s=12.0, width=None, fps=None, duration=10.0
    )
    assert params.end_s == pytest.approx(10.0)


def test_refuses_a_start_beyond_the_video() -> None:
    with pytest.raises(ValidationError, match="starts after"):
        exports.validated_gif_params(start_s=30.0, end_s=32.0, width=None, fps=None, duration=10.0)


# `scale=W:-2` needs an even width to derive an even height; an odd one fails
# deep in the filter graph instead of here.
def test_rounds_an_odd_width_down_to_even() -> None:
    params = exports.validated_gif_params(
        start_s=0.0, end_s=2.0, width=481, fps=None, duration=60.0
    )
    assert params.width == 480


# --- the ffmpeg command -----------------------------------------------------


def test_command_seeks_accurately_and_decodes_once() -> None:
    args = exports.build_gif_command(Path("/src.mp4"), Path("/out.gif"), _params())
    joined = " ".join(args)

    # Input seek, but *without* `-noaccurate_seek`: unlike a contact sheet, a
    # clip's in-point is the exact frame the owner placed.
    assert args.index("-ss") < args.index("-i")
    assert "-noaccurate_seek" not in args
    assert "-t" in args

    # One decode feeding both palette passes, not two runs over the source.
    assert "split[a][b]" in joined
    assert "palettegen" in joined and "paletteuse" in joined
    assert joined.count("-i ") == 1
    assert "-an" in args


def test_command_carries_the_requested_size_and_rate() -> None:
    args = exports.build_gif_command(Path("/src.mp4"), Path("/out.gif"), _params(width=320, fps=15))
    joined = " ".join(args)
    assert "fps=15" in joined
    assert "scale=320:-2" in joined


# --- naming -----------------------------------------------------------------


# A display title still carries the source's extension, so the naive stem names
# the artifact `clip.mp4.gif`.
def test_the_stem_drops_the_source_extension() -> None:
    assert exports_api._safe_stem("clip.mp4") == "clip"
    assert exports_api._safe_stem("a movie.mkv") == "a movie"
    # A dot that is not an extension belongs to the name.
    assert exports_api._safe_stem("Scene 2.5 rework") == "Scene 2.5 rework"
    assert exports_api._safe_stem("no extension") == "no extension"
    # What a filename cannot hold goes, and nothing left still names something.
    assert exports_api._safe_stem("a/b:c*d?.mkv") == "a b c d"
    assert exports_api._safe_stem("") == "clip"


# --- the manager ------------------------------------------------------------


def test_runs_the_encode_and_reports_done(tmp_path: Path) -> None:
    encoded: list[tuple[Path, Path, GifParams]] = []

    def runner(source: Path, dest: Path, params: GifParams) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"GIF89a")
        encoded.append((source, dest, params))

    manager = ExportManager(exports_dir=tmp_path, runner=runner, start_reaper=False)
    export = manager.create(
        library_id="lib",
        file_id="f1",
        source_path=Path("/src.mp4"),
        params=_params(),
        filename="clip.gif",
    )

    assert _settled(manager, export.id) == "done"
    assert export.output_path.read_bytes() == b"GIF89a"
    assert export.progress == 1.0
    assert len(encoded) == 1
    manager.shutdown()


# ffmpeg's stderr names the input path, and a library path is user data
# (AGENTS.md §privacy) — the reported reason must not carry it.
def test_a_failure_is_reported_without_leaking_the_path(tmp_path: Path) -> None:
    def runner(source: Path, dest: Path, params: GifParams) -> None:
        raise exports.ExportError(f"Error opening input file {source}: no such file")

    manager = ExportManager(exports_dir=tmp_path, runner=runner, start_reaper=False)
    export = manager.create(
        library_id="lib",
        file_id="f1",
        source_path=Path("/private/library/secret name.mp4"),
        params=_params(),
        filename="clip.gif",
    )

    assert _settled(manager, export.id) == "failed"
    assert export.error is not None
    assert "secret name" not in export.error
    assert "/private/library" not in export.error
    manager.shutdown()


def test_bounds_concurrent_exports(tmp_path: Path) -> None:
    release = threading.Event()

    def runner(source: Path, dest: Path, params: GifParams) -> None:
        release.wait(timeout=5.0)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"GIF89a")

    manager = ExportManager(
        exports_dir=tmp_path, max_concurrent=1, runner=runner, start_reaper=False
    )
    manager.create(
        library_id="lib",
        file_id="f1",
        source_path=Path("/a.mp4"),
        params=_params(),
        filename="a.gif",
    )
    with pytest.raises(CapacityError):
        manager.create(
            library_id="lib",
            file_id="f2",
            source_path=Path("/b.mp4"),
            params=_params(),
            filename="b.gif",
        )
    release.set()
    manager.shutdown()


def test_an_export_is_scoped_to_its_library(tmp_path: Path) -> None:
    manager = ExportManager(
        exports_dir=tmp_path,
        runner=lambda s, d, p: d.parent.mkdir(parents=True, exist_ok=True) or d.write_bytes(b"G"),
        start_reaper=False,
    )
    export = manager.create(
        library_id="lib-a",
        file_id="f1",
        source_path=Path("/a.mp4"),
        params=_params(),
        filename="a.gif",
    )
    _settled(manager, export.id, "lib-a")

    assert manager.get(export.id, library_id="lib-a") is not None
    assert manager.get(export.id, library_id="lib-b") is None
    manager.shutdown()


def test_reaping_drops_finished_artifacts_past_the_ttl(tmp_path: Path) -> None:
    now = [1000.0]
    manager = ExportManager(
        exports_dir=tmp_path,
        ttl_seconds=60.0,
        runner=lambda s, d, p: d.parent.mkdir(parents=True, exist_ok=True) or d.write_bytes(b"G"),
        clock=lambda: now[0],
        start_reaper=False,
    )
    export = manager.create(
        library_id="lib",
        file_id="f1",
        source_path=Path("/a.mp4"),
        params=_params(),
        filename="a.gif",
    )
    _settled(manager, export.id)
    directory = export.output_path.parent

    now[0] += 30.0
    assert manager.reap() == 0
    assert directory.exists()

    now[0] += 60.0
    assert manager.reap() == 1
    assert not directory.exists()
    assert manager.get(export.id, library_id="lib") is None
    manager.shutdown()


# Reaping a still-encoding export would delete the directory out from under a
# running ffmpeg, however long it has been going.
def test_reaping_leaves_a_running_export_alone(tmp_path: Path) -> None:
    now = [1000.0]
    release = threading.Event()
    manager = ExportManager(
        exports_dir=tmp_path,
        ttl_seconds=1.0,
        runner=lambda s, d, p: release.wait(timeout=5.0),
        clock=lambda: now[0],
        start_reaper=False,
    )
    export = manager.create(
        library_id="lib",
        file_id="f1",
        source_path=Path("/a.mp4"),
        params=_params(),
        filename="a.gif",
    )

    now[0] += 3600.0
    assert manager.reap() == 0
    assert manager.get(export.id, library_id="lib") is not None
    release.set()
    manager.shutdown()


def test_discard_removes_the_artifact_directory(tmp_path: Path) -> None:
    manager = ExportManager(
        exports_dir=tmp_path,
        runner=lambda s, d, p: d.parent.mkdir(parents=True, exist_ok=True) or d.write_bytes(b"G"),
        start_reaper=False,
    )
    export = manager.create(
        library_id="lib",
        file_id="f1",
        source_path=Path("/a.mp4"),
        params=_params(),
        filename="a.gif",
    )
    _settled(manager, export.id)

    manager.discard(export.id)
    assert not export.output_path.parent.exists()
    assert manager.get(export.id, library_id="lib") is None
    manager.shutdown()


# --- the endpoints ----------------------------------------------------------


@pytest.fixture
def export_client(client: TestClient, tmp_path: Path) -> "tuple[TestClient, ExportManager]":  # noqa: UP037
    """The API client with a manager wired to a stub encoder."""
    manager = ExportManager(
        exports_dir=tmp_path / "exports",
        runner=lambda s, d, p: (
            d.parent.mkdir(parents=True, exist_ok=True) or d.write_bytes(b"GIF89a-stub")
        ),
        start_reaper=False,
    )
    client.app.dependency_overrides[exports_api.get_manager] = lambda: manager  # type: ignore[union-attr]
    yield client, manager
    client.app.dependency_overrides.pop(exports_api.get_manager, None)  # type: ignore[union-attr]
    manager.shutdown()


def test_endpoint_creates_polls_downloads_and_deletes(
    export_client: "tuple[TestClient, ExportManager]",
    library_id: str,
    session: Session,
    library_root: Path,
) -> None:
    client, manager = export_client
    (library_root / "movie.mp4").write_bytes(b"x")
    asset_file = _video_file(session, library_root)
    session.commit()
    base = f"/api/v1/libraries/{library_id}/files/{asset_file.id}/exports"

    created = client.post(base, json={"kind": "gif", "start_s": 1.0, "end_s": 3.0})
    assert created.status_code == 202, created.text
    export_id = created.json()["export_id"]
    assert created.json()["filename"].endswith(".gif")

    assert _settled(manager, export_id, library_id) == "done"
    polled = client.get(f"{base}/{export_id}")
    assert polled.status_code == 200
    assert polled.json()["status"] == "done"
    assert polled.json()["progress"] == 1.0

    downloaded = client.get(f"{base}/{export_id}/download")
    assert downloaded.status_code == 200
    assert downloaded.headers["content-type"] == "image/gif"
    assert downloaded.headers["cache-control"] == "no-store"
    assert downloaded.content == b"GIF89a-stub"

    assert client.delete(f"{base}/{export_id}").status_code == 204
    assert client.get(f"{base}/{export_id}").status_code == 404


# A half-finished artifact must never be served as if it were the whole clip.
def test_downloading_before_it_is_ready_conflicts(
    client: TestClient, library_id: str, session: Session, library_root: Path, tmp_path: Path
) -> None:
    release = threading.Event()
    manager = ExportManager(
        exports_dir=tmp_path / "exports",
        runner=lambda s, d, p: release.wait(timeout=5.0),
        start_reaper=False,
    )
    client.app.dependency_overrides[exports_api.get_manager] = lambda: manager  # type: ignore[union-attr]
    try:
        (library_root / "movie.mp4").write_bytes(b"x")
        asset_file = _video_file(session, library_root)
        session.commit()
        base = f"/api/v1/libraries/{library_id}/files/{asset_file.id}/exports"

        export_id = client.post(base, json={"start_s": 1.0, "end_s": 3.0}).json()["export_id"]
        assert client.get(f"{base}/{export_id}/download").status_code == 409
    finally:
        release.set()
        client.app.dependency_overrides.pop(exports_api.get_manager, None)  # type: ignore[union-attr]
        manager.shutdown()


def test_endpoint_rejects_a_bad_range_and_a_non_video(
    export_client: "tuple[TestClient, ExportManager]",
    library_id: str,
    session: Session,
    library_root: Path,
) -> None:
    client, _ = export_client
    (library_root / "movie.mp4").write_bytes(b"x")
    asset_file = _video_file(session, library_root)
    image = bundle_service.add_file(
        session,
        asset_file.bundle_id,
        relative_path="cover.jpg",
        role=FileRole.IMAGE,
        media_kind=MediaKind.IMAGE,
    )
    session.commit()
    base = f"/api/v1/libraries/{library_id}/files"

    inverted = client.post(f"{base}/{asset_file.id}/exports", json={"start_s": 4.0, "end_s": 1.0})
    assert inverted.status_code == 422

    not_video = client.post(f"{base}/{image.id}/exports", json={"start_s": 0.0, "end_s": 2.0})
    assert not_video.status_code == 422

    missing = client.post(f"{base}/nope/exports", json={"start_s": 0.0, "end_s": 2.0})
    assert missing.status_code == 404


def test_an_export_is_not_reachable_through_another_library(
    export_client: "tuple[TestClient, ExportManager]",
    library_id: str,
    session: Session,
    library_root: Path,
) -> None:
    client, manager = export_client
    (library_root / "movie.mp4").write_bytes(b"x")
    asset_file = _video_file(session, library_root)
    session.commit()
    base = f"/api/v1/libraries/{library_id}/files/{asset_file.id}/exports"
    export_id = client.post(base, json={"start_s": 1.0, "end_s": 3.0}).json()["export_id"]
    _settled(manager, export_id, library_id)

    # Same id, a library the caller has not opened: not found, not served.
    other = client.get(f"/api/v1/libraries/other-library/files/{asset_file.id}/exports/{export_id}")
    assert other.status_code == 404


@requires_ffmpeg
def test_real_ffmpeg_produces_a_playable_gif(tmp_path: Path) -> None:
    source = tmp_path / "movie.mp4"
    _make_video(source)
    dest = tmp_path / "out" / "clip.gif"

    exports._run_gif(source, dest, _params(start_s=1.0, end_s=3.0, width=160, fps=10))

    data = dest.read_bytes()
    assert data.startswith(b"GIF89a")
    # Logical screen width sits at bytes 6-7, little-endian.
    assert int.from_bytes(data[6:8], "little") == 160
    # More than one image block means it actually animates.
    assert data.count(b"\x21\xf9\x04") > 1


# --- the watermark ----------------------------------------------------------


def _png(width: int = 60, height: int = 20, colour: str = "#ff0000") -> bytes:
    """A solid PNG, standing in for the tile the client renders."""
    buffer = io.BytesIO()
    Image.new("RGBA", (width, height), colour).save(buffer, format="PNG")
    return buffer.getvalue()


def _encoded(**kwargs: object) -> str:
    return base64.b64encode(_png(**kwargs)).decode()  # type: ignore[arg-type]


def test_no_watermark_leaves_the_command_exactly_as_it_was() -> None:
    args = exports.build_gif_command(Path("/src.mp4"), Path("/out.gif"), _params())
    joined = " ".join(args)
    assert joined.count("-i ") == 1
    assert "overlay" not in joined


def test_a_watermark_is_overlaid_before_the_palette_is_generated() -> None:
    # The palette is built from the frames it will be applied to; a mark added
    # after `paletteuse` would have no colours of its own reserved.
    args = exports.build_gif_command(
        Path("/src.mp4"), Path("/out.gif"), _params(watermark_path=Path("/wm.png"))
    )
    joined = " ".join(args)
    graph = args[args.index("-filter_complex") + 1]

    assert joined.count("-i ") == 2
    assert graph.index("overlay") < graph.index("palettegen")
    # The mark is a second input, added after the seek so it is not itself
    # trimmed to the clip's range.
    assert args.index("/wm.png") > args.index("/src.mp4")
    assert args.index("-t") < args.index("/src.mp4")


@pytest.mark.parametrize(
    ("corner", "expected"),
    [
        ("bottom-right", r"overlay=x=max(0\,W-w):y=max(0\,H-h)"),
        ("top-right", r"overlay=x=max(0\,W-w):y=0"),
        ("bottom-left", r"overlay=x=0:y=max(0\,H-h)"),
        ("top-left", "overlay=x=0:y=0"),
    ],
)
def test_each_corner_is_computed_at_filter_time(corner: str, expected: str) -> None:
    # `W`/`H` rather than baked numbers, so the scaler rounding the height to an
    # even number of lines cannot shift the mark off its corner.
    args = exports.build_gif_command(
        Path("/src.mp4"),
        Path("/out.gif"),
        _params(corner=corner, watermark_path=Path("/wm.png")),
    )
    assert expected in args[args.index("-filter_complex") + 1]


def test_a_watermark_is_decoded_and_measured() -> None:
    assert exports.validated_watermark(_encoded()) == _png()
    assert exports.validated_watermark(None) is None
    # An empty string is "no mark", not a malformed one.
    assert exports.validated_watermark("") is None


def test_a_watermark_that_is_not_an_image_is_refused() -> None:
    with pytest.raises(ValidationError, match="base64"):
        exports.validated_watermark("not base64!!")
    with pytest.raises(ValidationError, match="must be a PNG"):
        exports.validated_watermark(base64.b64encode(b"GIF89a nope").decode())
    # PNG magic, then nothing a decoder can use — refused here with a clear
    # reason rather than failing deep in a filter graph as an encode error.
    with pytest.raises(ValidationError, match="could not be read"):
        exports.validated_watermark(base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32).decode())


def test_an_oversized_watermark_is_refused() -> None:
    with pytest.raises(ValidationError, match="KB"):
        # Noise, because a solid image of this size compresses far below the cap.
        payload = b"\x89PNG\r\n\x1a\n" + os.urandom(exports.MAX_WATERMARK_BYTES + 1)
        exports.validated_watermark(base64.b64encode(payload).decode())

    with pytest.raises(ValidationError, match="on a side"):
        exports.validated_watermark(_encoded(width=exports.MAX_WATERMARK_DIMENSION + 2, height=4))


def test_the_mark_is_written_beside_the_artifact_and_reaped_with_it(tmp_path: Path) -> None:
    seen: dict[str, Path | None] = {}

    def runner(source: Path, dest: Path, params: GifParams) -> None:
        seen["watermark"] = params.watermark_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"GIF89a")

    manager = ExportManager(exports_dir=tmp_path, runner=runner, start_reaper=False)
    export = manager.create(
        library_id="lib",
        file_id="file",
        source_path=Path("/src.mp4"),
        params=_params(),
        filename="clip.gif",
        watermark_png=_png(),
    )
    assert _settled(manager, export.id) == "done"

    mark = seen["watermark"]
    assert mark is not None and mark.exists()
    assert mark.parent == export.output_path.parent
    assert mark.read_bytes() == _png()

    # Dropped with the artifact it belongs to, not left behind in the data dir.
    manager.discard(export.id)
    assert not mark.exists()


def test_a_capacity_refusal_leaves_no_directory_behind(tmp_path: Path) -> None:
    release = threading.Event()
    manager = ExportManager(
        exports_dir=tmp_path,
        max_concurrent=1,
        runner=lambda s, d, p: release.wait(timeout=5.0),
        start_reaper=False,
    )
    first = manager.create(
        library_id="lib",
        file_id="file",
        source_path=Path("/src.mp4"),
        params=_params(),
        filename="clip.gif",
        watermark_png=_png(),
    )
    # Let the accepted export's worker finish writing its own mark first, so
    # what follows is measured against a settled directory instead of racing
    # the thread that is still creating one.
    deadline = time.monotonic() + 5.0
    while not (first.output_path.parent / "watermark.png").exists():
        assert time.monotonic() < deadline, "the first mark was never written"
        time.sleep(0.01)
    before = set(tmp_path.iterdir())

    with pytest.raises(CapacityError):
        manager.create(
            library_id="lib",
            file_id="file",
            source_path=Path("/src.mp4"),
            params=_params(),
            filename="clip.gif",
            watermark_png=_png(),
        )

    # The mark is held in memory until a worker can write it, so a refused
    # request never creates an artifact directory.
    assert set(tmp_path.iterdir()) == before
    release.set()


@requires_ffmpeg
def test_real_ffmpeg_burns_the_mark_into_the_corner(tmp_path: Path) -> None:
    source = tmp_path / "movie.mp4"
    _make_video(source)
    mark = tmp_path / "wm.png"
    # Bright green, a colour testsrc2 does not put in this corner, so finding it
    # in the output means the overlay ran and the palette kept it.
    mark.write_bytes(_png(width=40, height=12, colour="#00ff00"))

    plain = tmp_path / "plain" / "clip.gif"
    marked = tmp_path / "marked" / "clip.gif"
    exports._run_gif(source, plain, _params(start_s=1.0, end_s=2.0, width=160, fps=10))
    exports._run_gif(
        source,
        marked,
        _params(start_s=1.0, end_s=2.0, width=160, fps=10, watermark_path=mark),
    )

    assert marked.read_bytes().startswith(b"GIF89a")
    assert marked.read_bytes() != plain.read_bytes()

    with Image.open(marked) as gif:
        frame = gif.convert("RGB")
    width, height = frame.size
    # Inside the bottom-right corner the mark occupies, and clear of its edge.
    red, green, blue = frame.getpixel((width - 20, height - 6))  # type: ignore[misc]
    assert green > 200 and red < 80 and blue < 80

    with Image.open(plain) as gif:
        unmarked = gif.convert("RGB")
    assert unmarked.getpixel((width - 20, height - 6)) != (red, green, blue)
