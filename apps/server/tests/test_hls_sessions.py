"""HLS session manager (plan 1 §6.2, ADR-0014).

The mechanics — start/serve/wait/far-seek restart/idle-reap/concurrency bound/
teardown — are tested against a **fake ffmpeg**: a stub script that emits segment
files sequentially, launched through the real subprocess machinery so process
kill/restart/teardown are genuinely exercised. The ffmpeg argv builder is unit
tested in isolation, and one slow test drives real ffmpeg over a tiny generated
MKV (skipped when ffmpeg is absent). HTTP wiring is covered end to end with the
stub manager injected via the FastAPI dependency.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import textwrap
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.api.v1.playback_sessions import get_manager
from cairndex.core.errors import CapacityError, ValidationError
from cairndex.domain.enums import FileRole, MediaKind
from cairndex.media import hls
from cairndex.media.hls import (
    BurnSubtitle,
    HlsSession,
    SessionManager,
    SessionParams,
    build_ffmpeg_command,
)
from cairndex.services import bundles as bundle_service

_FFMPEG = shutil.which("ffmpeg")
requires_ffmpeg = pytest.mark.skipif(_FFMPEG is None, reason="ffmpeg not installed")

# A stand-in for ffmpeg: write an init segment, then media segments start_number
# .. count-1 with a delay between each, and stop cleanly on SIGTERM.
_STUB_SOURCE = textwrap.dedent(
    """
    import pathlib, signal, sys, time

    out = pathlib.Path(sys.argv[1])
    start = int(sys.argv[2])
    count = int(sys.argv[3])
    delay = float(sys.argv[4])

    state = {"go": True}

    def _stop(_signum, _frame):
        state["go"] = False

    signal.signal(signal.SIGTERM, _stop)
    out.mkdir(parents=True, exist_ok=True)
    (out / "init.mp4").write_bytes(b"init")
    for i in range(start, count):
        if not state["go"]:
            break
        (out / (str(i) + ".m4s")).write_bytes(("seg" + str(i)).encode())
        time.sleep(delay)
    """
)


@pytest.fixture(scope="session")
def stub_script(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("hls-stub") / "fake_ffmpeg.py"
    path.write_text(_STUB_SOURCE, encoding="utf-8")
    return path


def _stub_builder(stub_script: Path, delay: float) -> hls.CommandBuilder:
    def build(session: HlsSession, start_number: int, _start_s: float) -> list[str]:
        return [
            sys.executable,
            str(stub_script),
            str(session.output_dir),
            str(start_number),
            str(session.segment_count),
            str(delay),
        ]

    return build


ManagerFactory = Callable[..., SessionManager]


@pytest.fixture
def make_manager(tmp_path: Path, stub_script: Path) -> Iterator[ManagerFactory]:
    """Build stub-backed SessionManagers and tear them all down after the test."""
    managers: list[SessionManager] = []

    def factory(*, delay: float = 0.0, **kwargs: object) -> SessionManager:
        kwargs.setdefault("transcode_dir", tmp_path / f"transcode-{len(managers)}")
        kwargs.setdefault("command_builder", _stub_builder(stub_script, delay))
        kwargs.setdefault("start_reaper", False)
        kwargs.setdefault("segment_wait", 5.0)
        manager = SessionManager(**kwargs)  # type: ignore[arg-type]
        managers.append(manager)
        return manager

    yield factory
    for manager in managers:
        manager.shutdown()


def _create(manager: SessionManager, **kwargs: object) -> HlsSession:
    params: dict[str, object] = {
        "library_id": "lib",
        "file_id": "file",
        "source_path": Path("/nonexistent/source.mkv"),
        "duration": 30.0,
        "kind": "remux",
        "params": SessionParams(),
    }
    params.update(kwargs)
    return manager.create_session(**params)  # type: ignore[arg-type]


# --- serving basics ---------------------------------------------------------
def test_create_serves_init_and_segments(make_manager: ManagerFactory) -> None:
    manager = make_manager(delay=0.0)
    session = _create(manager, duration=30.0)  # 5 segments

    init = manager.serve_artifact("lib", session.id, "init.mp4")
    assert init.read_bytes() == b"init"
    assert manager.serve_artifact("lib", session.id, "0.m4s").read_bytes() == b"seg0"
    assert manager.serve_artifact("lib", session.id, "4.m4s").read_bytes() == b"seg4"


def test_out_of_range_and_malformed_segments_404(make_manager: ManagerFactory) -> None:
    manager = make_manager()
    session = _create(manager, duration=30.0)  # indices 0..4
    from cairndex.core.errors import NotFoundError

    with pytest.raises(NotFoundError):
        manager.serve_artifact("lib", session.id, "5.m4s")
    with pytest.raises(NotFoundError):
        manager.serve_artifact("lib", session.id, "not-a-segment")


def test_playlist_is_vod_with_computed_segments(make_manager: ManagerFactory) -> None:
    manager = make_manager()
    session = _create(manager, duration=28.0)  # 5 segments; last is 4 s
    playlist = manager.serve_playlist("lib", session.id)
    lines = playlist.splitlines()

    assert lines[0] == "#EXTM3U"
    assert "#EXT-X-PLAYLIST-TYPE:VOD" in lines
    assert '#EXT-X-MAP:URI="init.mp4"' in lines
    assert lines.count("#EXTINF:6.000,") == 4
    assert "#EXTINF:4.000," in lines  # tail segment shorter than the target
    assert "4.m4s" in lines
    assert lines[-1] == "#EXT-X-ENDLIST"


# --- wait vs restart --------------------------------------------------------
def test_waits_for_segment_within_reach_of_encoder(make_manager: ManagerFactory) -> None:
    manager = make_manager(delay=0.05)
    session = _create(manager, duration=30.0)
    # Segment 3 isn't written yet; the encoder is progressing toward it → wait.
    assert manager.serve_artifact("lib", session.id, "3.m4s").read_bytes() == b"seg3"
    assert session.run_start == 0  # no restart happened


def test_far_forward_seek_restarts_encoder(make_manager: ManagerFactory) -> None:
    manager = make_manager(delay=0.01)
    session = _create(manager, duration=600.0)  # 100 segments
    # Segment 50 is far past the encoder frontier + window → restart at 50.
    assert manager.serve_artifact("lib", session.id, "50.m4s").read_bytes() == b"seg50"
    assert session.run_start == 50


def test_backward_seek_restarts_encoder(make_manager: ManagerFactory) -> None:
    manager = make_manager(delay=0.01)
    session = _create(manager, duration=600.0, start_s=300.0)  # starts at segment 50
    assert session.run_start == 50
    # A segment before the current run can never be produced by it → restart.
    assert manager.serve_artifact("lib", session.id, "10.m4s").read_bytes() == b"seg10"
    assert session.run_start == 10


# --- concurrency + lifecycle ------------------------------------------------
def test_concurrency_bound_raises_then_frees(make_manager: ManagerFactory) -> None:
    manager = make_manager(max_sessions=1)
    first = _create(manager)
    with pytest.raises(CapacityError):
        _create(manager)
    manager.teardown("lib", first.id)
    # Freeing one lets the next session start.
    assert _create(manager) is not None


def test_teardown_kills_process_and_removes_dir(make_manager: ManagerFactory) -> None:
    manager = make_manager(delay=10.0)  # stays alive so kill is observable
    session = _create(manager)
    proc = session.process
    assert proc is not None
    output_dir = session.output_dir

    manager.teardown("lib", session.id)

    assert proc.poll() is not None  # terminated
    assert not output_dir.exists()
    from cairndex.core.errors import NotFoundError

    with pytest.raises(NotFoundError):
        manager.serve_playlist("lib", session.id)


def test_idle_reaper_kills_and_removes(stub_script: Path, tmp_path: Path) -> None:
    now = {"t": 0.0}
    manager = SessionManager(
        transcode_dir=tmp_path / "transcode",
        idle_timeout=60.0,
        command_builder=_stub_builder(stub_script, delay=10.0),
        clock=lambda: now["t"],
        start_reaper=False,
    )
    try:
        session = _create(manager)
        proc = session.process
        assert proc is not None
        output_dir = session.output_dir

        assert manager.reap_idle() == []  # not idle yet
        now["t"] = 100.0
        assert manager.reap_idle() == [session.id]

        assert proc.poll() is not None
        assert not output_dir.exists()
    finally:
        manager.shutdown()


def test_sessions_are_scoped_to_their_library(make_manager: ManagerFactory) -> None:
    manager = make_manager()
    session = _create(manager, library_id="libA")
    from cairndex.core.errors import NotFoundError

    with pytest.raises(NotFoundError):
        manager.serve_playlist("libB", session.id)


def test_duration_required_to_start_a_session(make_manager: ManagerFactory) -> None:
    manager = make_manager()
    with pytest.raises(ValidationError):
        _create(manager, duration=0.0)


# --- ffmpeg argv builder ----------------------------------------------------
def _session(
    tmp: Path,
    *,
    kind: str,
    params: SessionParams,
    source: str = "movie.mkv",
) -> HlsSession:
    return HlsSession(
        id="s",
        library_id="lib",
        file_id="f",
        kind=kind,
        source_path=Path(source),
        output_dir=tmp,
        duration=30.0,
        segment_count=5,
        params=params,
    )


def _value_after(args: list[str], flag: str) -> str:
    return args[args.index(flag) + 1]


def test_ffmpeg_command_remux_copies_video(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(hls, "ffmpeg_exe", lambda: "ffmpeg")
    session = _session(tmp_path, kind="remux", params=SessionParams())
    args = build_ffmpeg_command(session, 0, 0.0)

    assert _value_after(args, "-c:v") == "copy"
    assert _value_after(args, "-c:a") == "aac"  # AAC fallback
    assert _value_after(args, "-hls_segment_type") == "fmp4"
    assert _value_after(args, "-start_number") == "0"
    assert "-ss" not in args  # no input seek at the start


def test_ffmpeg_command_remux_copies_aac_audio(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(hls, "ffmpeg_exe", lambda: "ffmpeg")
    session = _session(tmp_path, kind="remux", params=SessionParams(audio_copy=True))
    args = build_ffmpeg_command(session, 0, 0.0)
    assert _value_after(args, "-c:a") == "copy"


def test_ffmpeg_command_seek_and_audio_map(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(hls, "ffmpeg_exe", lambda: "ffmpeg")
    session = _session(tmp_path, kind="remux", params=SessionParams(audio_stream_index=2))
    args = build_ffmpeg_command(session, 3, 18.0)
    assert _value_after(args, "-ss") == "18"
    assert _value_after(args, "-start_number") == "3"
    assert _value_after(args, "-map") == "0:v:0"
    # the audio map is the second -map
    maps = [args[i + 1] for i, a in enumerate(args) if a == "-map"]
    assert maps == ["0:v:0", "0:2"]


def test_ffmpeg_command_transcode_scales_and_burns_in(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(hls, "ffmpeg_exe", lambda: "ffmpeg")
    params = SessionParams(
        max_height=720,
        burn_subtitle=BurnSubtitle(path=Path("/lib/movie.mkv"), stream_index=2),
        hwaccel="videotoolbox",
    )
    session = _session(tmp_path, kind="transcode", params=params)
    args = build_ffmpeg_command(session, 0, 0.0)

    assert _value_after(args, "-c:v") == "libx264"
    assert _value_after(args, "-force_key_frames") == "expr:gte(t,n_forced*6)"
    assert _value_after(args, "-hwaccel") == "videotoolbox"
    vf = _value_after(args, "-vf")
    assert "scale=-2:'min(ih,720)'" in vf
    assert "subtitles=" in vf and ":si=2" in vf


def test_ffmpeg_command_remux_ignores_hwaccel(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(hls, "ffmpeg_exe", lambda: "ffmpeg")
    session = _session(tmp_path, kind="remux", params=SessionParams(hwaccel="vaapi"))
    args = build_ffmpeg_command(session, 0, 0.0)
    assert "-hwaccel" not in args  # hwaccel decode only matters when transcoding


# --- real ffmpeg integration ------------------------------------------------
def _make_mkv(path: Path, *, duration: int = 15) -> None:
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
            f"testsrc=duration={duration}:size=160x90:rate=10",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={duration}",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


@requires_ffmpeg
def test_real_ffmpeg_remux_and_transcode_produce_segments(tmp_path: Path) -> None:
    source = tmp_path / "movie.mkv"
    try:
        _make_mkv(source, duration=15)
    except subprocess.CalledProcessError:  # pragma: no cover - libx264 unavailable
        pytest.skip("ffmpeg build cannot encode libx264/aac")

    manager = SessionManager(
        transcode_dir=tmp_path / "transcode",
        start_reaper=False,
        segment_wait=30.0,
    )
    try:
        # Remux (copy video, transcode audio to AAC): mkv container isn't
        # directly playable, so this is the common MKV-with-H.264 path.
        remux = manager.create_session(
            library_id="lib",
            file_id="f",
            source_path=source,
            duration=15.0,
            kind="remux",
            params=SessionParams(),
        )
        playlist = manager.serve_playlist("lib", remux.id)
        assert "#EXT-X-ENDLIST" in playlist
        assert manager.serve_artifact("lib", remux.id, "init.mp4").stat().st_size > 0
        assert manager.serve_artifact("lib", remux.id, "0.m4s").stat().st_size > 0
        assert manager.serve_artifact("lib", remux.id, "2.m4s").stat().st_size > 0
        remux_dir = remux.output_dir
        manager.teardown("lib", remux.id)
        assert not remux_dir.exists()

        # Transcode with a height cap → libx264 + scale + exact 6 s keyframes.
        trans = manager.create_session(
            library_id="lib",
            file_id="f",
            source_path=source,
            duration=15.0,
            kind="transcode",
            params=SessionParams(max_height=90),
        )
        assert manager.serve_artifact("lib", trans.id, "init.mp4").stat().st_size > 0
        assert manager.serve_artifact("lib", trans.id, "0.m4s").stat().st_size > 0
    finally:
        manager.shutdown()


# --- HTTP wiring ------------------------------------------------------------
def _video_row(
    session: Session, library_root: Path, *, name: str = "movie.mkv", meta: dict | None = None
) -> str:
    (library_root / name).write_bytes(b"fake video bytes")
    bundle = bundle_service.create_bundle(session, title=name)
    video = bundle_service.add_file(
        session,
        bundle.id,
        relative_path=name,
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    video.tech_metadata = meta or {
        "duration": 28.0,
        "width": 1920,
        "height": 1080,
        "video_codec": "h264",
        "audio_codec": "aac",
    }
    session.commit()
    return video.id


def _use_stub_manager(client: TestClient, manager: SessionManager) -> None:
    client.app.dependency_overrides[get_manager] = lambda: manager  # type: ignore[attr-defined]


def test_decision_non_direct_starts_session_and_serves_it(
    client: TestClient,
    library_id: str,
    session: Session,
    library_root: Path,
    make_manager: ManagerFactory,
) -> None:
    manager = make_manager(delay=0.0)
    _use_stub_manager(client, manager)
    file_id = _video_row(session, library_root)  # mkv → not directly playable
    base = f"/api/v1/libraries/{library_id}/files/{file_id}"

    decision = client.post(
        f"{base}/playback-decision",
        json={"caps": {"containers": ["mp4"], "video_codecs": ["h264"], "audio_codecs": ["aac"]}},
    ).json()
    assert decision["method"] == "remux"
    assert decision["stream_url"] is None
    session_id = decision["session"]["id"]
    playlist_url = decision["session"]["playlist_url"]
    assert playlist_url.endswith(f"/playback-sessions/{session_id}/index.m3u8")

    playlist = client.get(playlist_url)
    assert playlist.status_code == 200
    assert playlist.headers["content-type"].startswith("application/vnd.apple.mpegurl")
    assert playlist.headers["cache-control"] == "no-store"
    assert "#EXT-X-ENDLIST" in playlist.text

    seg_base = f"{base}/playback-sessions/{session_id}"
    assert client.get(f"{seg_base}/init.mp4").content == b"init"
    assert client.get(f"{seg_base}/0.m4s").content == b"seg0"

    assert client.delete(seg_base).status_code == 204
    assert client.get(playlist_url).status_code == 404


def test_session_post_and_capacity_error(
    client: TestClient,
    library_id: str,
    session: Session,
    library_root: Path,
    make_manager: ManagerFactory,
) -> None:
    manager = make_manager(max_sessions=1)
    _use_stub_manager(client, manager)
    file_id = _video_row(session, library_root)
    url = f"/api/v1/libraries/{library_id}/files/{file_id}/playback-sessions"
    caps = {"caps": {"containers": ["mp4"], "video_codecs": ["h264"], "audio_codecs": ["aac"]}}

    first = client.post(url, json=caps)
    assert first.status_code == 201
    body = first.json()
    assert body["kind"] == "remux"  # mkv/h264/aac → copy streams into fMP4
    assert body["playlist_url"].endswith(f"/{body['session_id']}/index.m3u8")

    second = client.post(url, json=caps)
    assert second.status_code == 429
    assert second.json()["code"] == "capacity_exhausted"


def test_unknown_session_playlist_404(
    client: TestClient,
    library_id: str,
    session: Session,
    library_root: Path,
    make_manager: ManagerFactory,
) -> None:
    manager = make_manager()
    _use_stub_manager(client, manager)
    file_id = _video_row(session, library_root)
    resp = client.get(
        f"/api/v1/libraries/{library_id}/files/{file_id}"
        f"/playback-sessions/does-not-exist/index.m3u8"
    )
    assert resp.status_code == 404
