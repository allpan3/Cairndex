"""Independent synthetic replicas prove local media isolation and generation fencing"""

import hashlib
import shutil

import pytest

from cairndex.devtools.replica_media_fixture import create_playable
from cairndex.registry.library_package import read_manifest
from cairndex.replicas import service
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.media import ReplicaMedia
from cairndex.replicas.transport import Transport

CAPS = {
    "protocols": ["hls"],
    "containers": ["mp4", "webm"],
    "video_codecs": ["h264", "vp9"],
    "audio_codecs": ["aac", "opus"],
}


# Generate playable bytes once, then give every test independent copies and private stores
@pytest.fixture(scope="module")
def specimen(tmp_path_factory):
    return create_playable(parent=tmp_path_factory.mktemp("replica-media"), duration=75)


# The HTTP server and the other device share only immutable package artifacts
@pytest.fixture
def media_api(specimen, tmp_path, raw_client):
    roots = [tmp_path / "A", tmp_path / "B"]
    for root in roots:
        shutil.copytree(specimen, root)
    response = raw_client.post("/api/v1/libraries/register", json={"root_path": str(roots[0])})
    assert response.status_code == 201, response.text
    identity = response.json()["id"]
    base = f"/api/v1/libraries/{identity}"
    raw_client.get(base + "/replica/status")
    for _ in range(15):
        service.exchange(identity)
    store = service._handles[identity][0]
    assert isinstance(store, CatalogStore)
    peer = CatalogStore(tmp_path / "private-B", read_manifest(roots[1]).replica)
    transport = Transport(roots[1], peer)
    for _ in range(15):
        transport.tick()
    yield raw_client, base, store, ReplicaMedia(peer, roots[1], "peer"), roots
    transport.close()


# Compare authored rows/event bytes independently of runtime delivery receipts
def authored(store):
    with store.connection(readonly=True) as db:
        return (
            list(map(tuple, db.execute("SELECT id,raw FROM events ORDER BY id"))),
            list(map(tuple, db.execute("SELECT * FROM catalog_rows ORDER BY family,entity"))),
        )


# Different local availability, probes, cursors and progress never become shared metadata
def test_media_is_private_and_restart_retains_progress(media_api):
    client, base, store, peer, roots = media_api
    snapshots = authored(store), authored(peer.store)
    (roots[1] / "Playback/movie.mp4").unlink()
    hashes = {
        p: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in roots[0].joinpath("Playback").iterdir()
    }
    local = client.get(base + "/replica/media/files/media-direct").json()
    assert local["state"] == "available"
    assert local["file"]["tech_metadata"]["video_codec"] == "h264"
    assert peer.file("media-direct", inspect=True).availability.value == "missing"
    body = {"position_s": 22, "duration_s": 75, "source_generation": local["generation"]}
    assert client.put(base + "/files/media-direct/progress", json=body).status_code == 200
    assert (
        client.put(
            base + "/replica/media/bundles/bundle-000001/cursor", json={"file_id": "media-direct"}
        ).status_code
        == 204
    )
    assert client.post(base + "/ownership/release").status_code == 200
    assert client.post(base + "/ownership/reopen").status_code == 200
    reopened = client.get(base + "/replica/media/files/media-direct").json()
    assert reopened["playback"]["progress"]["position_s"] == 22
    assert (
        client.get(base + "/replica/media/bundles/bundle-000001").json()["cursor"] == "media-direct"
    )
    assert peer.progress("media-direct", local["generation"]) is None
    # Release retires the old handle; verify the reopened production handle's unchanged history
    reopened_store = service._handles[base.split("/")[-1]][0]
    assert authored(reopened_store) == snapshots[0]
    assert authored(peer.store) == snapshots[1]
    assert all(
        hashlib.sha256(path.read_bytes()).hexdigest() == digest for path, digest in hashes.items()
    )
    assert not (roots[0] / ".cairndex/library.db").exists()
    assert not (roots[0] / ".cairndex/locks").exists()


# Range bytes, private preview/subtitle cache placement and authored moment/track choices agree
def test_direct_bytes_derivatives_and_authored_choices(media_api):
    client, base, store, _, roots = media_api
    before = authored(store)
    local = client.get(base + "/replica/media/files/media-direct").json()
    token = local["generation"]
    response = client.get(
        base + f"/files/media-direct/stream?source_generation={token}",
        headers={"Range": "bytes=8-135"},
    )
    assert response.status_code == 206
    assert response.content == (roots[0] / "Playback/movie.mp4").read_bytes()[8:136]
    assert "no-store" in response.headers["cache-control"]
    decision = client.post(
        base + "/files/media-direct/playback-decision",
        json={"caps": CAPS, "source_generation": token},
    ).json()
    assert decision["method"] == "direct"
    assert token in decision["stream_url"]
    subtitle = client.get(base + "/subtitles/media-track/vtt")
    assert subtitle.status_code == 200 and "Synthetic local captions" in subtitle.text
    assert client.get(base + "/files/media-preview/preview?size=640").status_code == 200
    assert (
        client.get(base + "/bundles/bundle-000001/files/media-direct/thumbnail").status_code == 200
    )
    page = client.get(base + "/replica/media/bundles/bundle-000001?limit=2").json()
    assert len(page["files"]) == 2 and page["next_offset"] == 2
    assert page["moments"][0]["start_s"] == 42
    # The catalog's naive stored timestamps are UTC, and the API says so
    assert page["files"][0]["created_at"].endswith("Z")
    assert page["moments"][0]["created_at"].endswith("Z")
    assert list((store.path.parent / "cache").rglob("*.vtt"))
    assert list((store.path.parent / "cache").rglob("*.webp"))
    assert not (roots[0] / ".cairndex/cache").exists()
    assert authored(store) == before


# Recovery is a local recheck, not a scan, metadata deletion or a mutation of the other device
def test_missing_file_retry_and_generation_replacement(media_api):
    client, base, store, _, roots = media_api
    source = roots[0] / "Playback/movie.mp4"
    before = authored(store)
    local = client.get(base + "/replica/media/files/media-direct").json()
    source.rename(source.with_suffix(".waiting"))
    missing = client.get(base + "/replica/media/files/media-direct").json()
    assert missing["state"] == "unavailable"
    assert (
        client.get(base + "/replica/catalog/entities/asset_files/media-direct").status_code == 200
    )
    source.with_suffix(".waiting").rename(source)
    recovered = client.get(base + "/replica/media/files/media-direct").json()
    assert recovered["state"] == "available"
    replacement = source.with_suffix(".replacement")
    shutil.copyfile(source, replacement)
    replacement.replace(source)
    changed = client.get(base + "/replica/media/files/media-direct").json()
    assert changed["generation"] != local["generation"]
    assert (
        client.get(
            base + f"/files/media-direct/stream?source_generation={local['generation']}"
        ).status_code
        == 409
    )
    assert (
        client.put(
            base + "/files/media-direct/progress",
            json={"position_s": 33, "source_generation": local["generation"]},
        ).status_code
        == 409
    )
    assert (
        client.put(base + "/files/media-direct/progress", json={"position_s": 33}).status_code
        == 422
    )
    assert authored(store) == before


# An unavailable root and symlink escapes fail without modifying the validated catalog
@pytest.mark.parametrize("kind", ["file-link", "directory-link", "fifo"])
def test_source_path_boundaries(media_api, tmp_path, kind):
    client, base, store, _, roots = media_api
    before = authored(store)
    source = roots[0] / "Playback/movie.mp4"
    outside = tmp_path / "outside.mp4"
    shutil.copyfile(source, outside)
    if kind == "directory-link":
        folder = roots[0] / "Playback"
        folder.rename(roots[0] / "moved")
        folder.symlink_to(tmp_path, target_is_directory=True)
    else:
        source.unlink()
        if kind == "file-link":
            source.symlink_to(outside)
        else:
            import os

            os.mkfifo(source)
    local = client.get(base + "/replica/media/files/media-direct").json()
    assert local["state"] == "unavailable"
    assert client.get(base + "/files/media-direct/stream").status_code == 404
    assert authored(store) == before


# Actual FFmpeg remux/transcode output is scoped by both library and file and stops at release
@pytest.mark.parametrize(
    "file_id,method", [("media-remux", "remux"), ("media-fallback", "transcode")]
)
def test_hls_generation_file_scope_and_release(media_api, file_id, method):
    client, base, store, _, roots = media_api
    local = client.get(base + f"/replica/media/files/{file_id}").json()
    response = client.post(
        base + f"/files/{file_id}/playback-decision",
        json={"caps": CAPS, "source_generation": local["generation"]},
    )
    assert response.status_code == 200, response.text
    decision = response.json()
    assert decision["method"] == method and decision["session"]
    url = decision["session"]["playlist_url"]
    assert client.get(url).status_code == 200
    assert client.get(url.replace(file_id, "media-direct")).status_code == 422
    source = roots[0] / local["file"]["relative_path"]
    copy = source.with_suffix(".new")
    shutil.copyfile(source, copy)
    copy.replace(source)
    assert client.get(url).status_code == 409
    assert client.get(url).status_code == 404
    assert client.post(base + "/ownership/release").status_code == 200
    assert client.get(base + "/replica/media/files/media-direct").status_code == 409
    assert client.post(base + "/ownership/reopen").status_code == 200


# Media does not make unversioned authored mutations or filesystem discovery available
def test_legacy_mutators_and_discovery_stay_fenced(media_api):
    client, base, _, _, _ = media_api
    assert client.post(base + "/files/media-direct/cover-frame", json={"time": 4}).status_code in (
        409,
        428,
    )
    assert client.get(base + "/file-browser").status_code != 200
    assert client.get(base + "/bundles/bundle-000001").status_code == 409
    assert (
        client.post(base + "/files/media-direct/playback-decision", json={"caps": CAPS}).status_code
        == 422
    )


# Pinned decoder inputs retain the opened bytes even if their cataloged path is swapped
@pytest.mark.parametrize("replacement", ["file", "symlink"])
def test_decoder_inputs_do_not_reopen_replaced_paths(media_api, replacement):
    import os
    import subprocess
    import sys

    from cairndex.media.inputs import command

    _, _, _, peer, roots = media_api
    source = roots[1] / "Playback/movie.mp4"
    original = source.read_bytes()
    token = peer.file("media-direct", inspect=True).quick_fingerprint
    with peer.input_scope({"media-direct": token}):
        source.rename(source.with_suffix(".original"))
        if replacement == "symlink":
            source.symlink_to(roots[1] / "Playback/picture.png")
        else:
            source.write_bytes(b"replacement")
        args, descriptors = command(
            [
                sys.executable,
                "-c",
                "import hashlib,sys; "
                "print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())",
                str(source),
            ]
        )
        result = subprocess.run(args, pass_fds=descriptors, check=True, capture_output=True)
        assert result.stdout.decode().strip() == hashlib.sha256(original).hexdigest()
    for descriptor in descriptors:
        with pytest.raises(OSError):
            os.fstat(descriptor)


# Disconnects close pinned handles and interrupted sources cannot produce a successful full body
@pytest.mark.parametrize("fault", ["disconnect", "truncate"])
def test_stream_interruptions_close_descriptors(media_api, monkeypatch, fault):
    import asyncio
    import os
    from contextlib import contextmanager

    from starlette.requests import ClientDisconnect

    from cairndex.media import replica_stream
    from cairndex.replicas.protocol import ReplicaError

    _, _, _, peer, roots = media_api
    source = roots[1] / "Playback/movie.mp4"
    source.write_bytes(b"x" * (3 * 1024 * 1024))
    token = peer.file("media-direct", inspect=True).quick_fingerprint
    handles, bodies = [], []
    original_open = replica_stream.open_source

    # Retain descriptor numbers for a close check after the response unwinds
    @contextmanager
    def observed_open(*args):
        with original_open(*args) as handle:
            handles.append(handle)
            yield handle

    monkeypatch.setattr(replica_stream, "open_source", observed_open)
    response = replica_stream.ReplicaFileResponse(peer, "media-direct", token, "video/mp4", None)

    async def receive():
        await asyncio.Future()

    async def send(message):
        if message["type"] == "http.response.body" and message.get("body"):
            bodies.append(message["body"])
            if fault == "disconnect":
                raise OSError("synthetic disconnect")
            source.write_bytes(b"short")

    with pytest.raises((ClientDisconnect, ReplicaError, OSError)):
        asyncio.run(response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send))
    assert len(bodies) == 1 and len(bodies[0]) <= 1024 * 1024
    for handle in handles:
        with pytest.raises(OSError):
            os.fstat(handle)


# A whole empty file is legal while reversed and empty suffix ranges are unsatisfiable
@pytest.mark.parametrize("header,status", [(None, 200), ("bytes=-5", 416), ("bytes=8-2", 416)])
def test_empty_and_reversed_ranges(media_api, header, status):
    client, base, _, _, roots = media_api
    source = roots[0] / "Playback/movie.mp4"
    source.write_bytes(b"" if header != "bytes=8-2" else b"x" * 16)
    result = client.get(
        base + "/files/media-direct/stream", headers={"Range": header} if header else {}
    )
    assert result.status_code == status
    if status == 200:
        assert result.content == b""


# Probe failures are retryable observations and do not leave authored or stale technical metadata
def test_failed_probe_recovers_without_authored_changes(media_api):
    client, base, store, _, roots = media_api
    source = roots[0] / "Playback/movie.mp4"
    original, before = source.read_bytes(), authored(store)
    source.write_bytes(b"unreadable synthetic container")
    failed = client.get(base + "/replica/media/files/media-direct").json()
    assert failed["playback"] is None and failed["message"]
    source.write_bytes(original)
    recovered = client.get(base + "/replica/media/files/media-direct").json()
    assert recovered["playback"]["duration"] > 70
    assert recovered["message"] is None
    assert recovered["generation"] != failed["generation"]
    assert authored(store) == before


# Image readability does not depend on a video probe when the shared image decoder can read it
def test_image_open_does_not_require_ffprobe(media_api, monkeypatch):
    from cairndex.replicas import media

    def unexpected_probe(*_args, **_kwargs):
        raise AssertionError("Image opening must not run a video probe")

    monkeypatch.setattr(media, "run_ffprobe", unexpected_probe)
    client, base, _, _, _ = media_api
    image = client.get(base + "/replica/media/files/media-preview").json()
    assert image["state"] == "available" and image["message"] is None
    assert client.get(base + "/files/media-preview/preview?size=640").status_code == 200


# A contact sheet gives each frame its own pinned input and stays in private storage
def test_contact_sheet_uses_private_cache_and_current_generation(media_api):
    from io import BytesIO

    from PIL import Image

    client, base, store, _, roots = media_api
    before = authored(store)
    url = base + "/files/media-direct/contact-sheet?cols=3&rows=2&width=800"
    response = client.get(url)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/jpeg"
    assert "no-store" in response.headers["cache-control"]
    times = [float(value) for value in response.headers["x-contact-sheet-times"].split(",")]
    assert len(times) == 6 and times == sorted(times) and 0 < times[0] < times[-1] < 75
    with Image.open(BytesIO(response.content)) as sheet:
        # Three whole cells of 800 // 3 pixels each
        assert sheet.width == 798
        # Six separate inputs decode six different test-pattern frames; inputs
        # that moved each other's file offset would fail or repeat frames.
        width, height = sheet.width // 3, sheet.height // 2
        cells = [
            sheet.crop((col * width, row * height, (col + 1) * width, (row + 1) * height))
            .convert("L")
            .tobytes()
            for row in range(2)
            for col in range(3)
        ]
    assert len(set(cells)) == 6
    cached = list((store.path.parent / "cache" / "contact-sheets").rglob("*.jpg"))
    assert len(cached) == 1
    assert not (roots[0] / ".cairndex/cache").exists()
    source = roots[0] / "Playback/movie.mp4"
    copy = source.with_suffix(".new")
    shutil.copyfile(source, copy)
    copy.replace(source)
    assert client.get(url).status_code == 200
    assert len(list((store.path.parent / "cache" / "contact-sheets").rglob("*.jpg"))) == 2
    source.unlink()
    assert client.get(url).status_code == 404
    assert client.get(base + "/files/media-preview/contact-sheet").status_code == 422
    assert authored(store) == before


# A GIF export pins the observed source and fails rather than encode a replaced file
def test_gif_export_pins_source_and_refuses_changes(media_api, tmp_path):
    import threading
    import time

    from cairndex.api.v1 import exports as exports_api
    from cairndex.media.exports import ExportManager, _run_gif

    client, base, store, _, roots = media_api
    before = authored(store)
    source = roots[0] / "Playback/movie.mp4"
    started, proceed = threading.Event(), threading.Event()
    replace = {"source": False}

    def runner(path, dest, params):
        started.set()
        proceed.wait(timeout=10)
        if replace["source"]:
            copy = source.with_suffix(".new")
            shutil.copyfile(source, copy)
            copy.replace(source)
        _run_gif(path, dest, params)

    manager = ExportManager(exports_dir=tmp_path / "exports", runner=runner, start_reaper=False)
    client.app.dependency_overrides[exports_api.get_manager] = lambda: manager

    def settle(export_id):
        for _ in range(300):
            state = client.get(base + f"/files/media-direct/exports/{export_id}").json()
            if state["status"] in ("done", "failed"):
                return state
            time.sleep(0.05)
        raise AssertionError("export did not finish")

    try:
        body = {"kind": "gif", "start_s": 2.0, "end_s": 3.0, "width": 160, "fps": 5}
        created = client.post(base + "/files/media-direct/exports", json=body)
        assert created.status_code == 202, created.text
        assert created.json()["filename"] == "movie.gif"
        assert started.wait(timeout=10)
        proceed.set()
        export_id = created.json()["export_id"]
        assert settle(export_id)["status"] == "done"
        download = client.get(base + f"/files/media-direct/exports/{export_id}/download")
        assert download.status_code == 200 and download.content.startswith(b"GIF8")
        assert client.delete(base + f"/files/media-direct/exports/{export_id}").status_code == 204

        started.clear()
        proceed.clear()
        replace["source"] = True
        changed = client.post(base + "/files/media-direct/exports", json=body)
        assert changed.status_code == 202, changed.text
        assert started.wait(timeout=10)
        proceed.set()
        failed = settle(changed.json()["export_id"])
        assert failed["status"] == "failed"
        assert "changed" in failed["error"] and str(roots[0]) not in failed["error"]
        assert client.post(base + "/files/media-preview/exports", json=body).status_code == 422
    finally:
        proceed.set()
        client.app.dependency_overrides.pop(exports_api.get_manager, None)
        manager.shutdown()
    assert not (roots[0] / ".cairndex/cache").exists()
    assert authored(store) == before
    status = client.get(base + "/replica/status").json()
    assert status["export_version"] == 1


def _settle_storyboard(client, url, generation):
    import time

    for _ in range(600):
        response = client.post(url, json={"generation": generation})
        assert response.status_code == 200, response.text
        if response.json()["state"] not in ("queued", "running"):
            return response.json()
        time.sleep(0.05)
    raise AssertionError("storyboard did not finish")


# A storyboard is made in the background from the observed generation and is
# served only while that generation is current
def test_storyboard_uses_private_cache_and_current_generation(media_api):
    client, base, store, _, roots = media_api
    before = authored(store)
    request = base + "/replica/media/files/media-direct/storyboard"
    token = client.get(base + "/replica/media/files/media-direct").json()["generation"]
    ready = _settle_storyboard(client, request, token)
    assert ready["state"] == "ready", ready
    url = ready["url"]
    assert url.startswith(base + "/files/media-direct/storyboard.vtt?v=")
    index = client.get(url)
    assert index.status_code == 200 and index.text.startswith("WEBVTT")
    assert "private" in index.headers["cache-control"]
    cue = next(line for line in index.text.splitlines() if line.startswith("storyboard/"))
    sheet_url = base + "/files/media-direct/" + cue.split("#", 1)[0]
    sheet = client.get(sheet_url)
    assert sheet.status_code == 200 and sheet.content.startswith(b"\xff\xd8")
    assert client.get(base + "/files/media-direct/storyboard.vtt").status_code == 404
    assert client.get(base + "/files/media-direct/storyboard.vtt?v=other").status_code == 404
    assert client.get(sheet_url.replace("sb_001", "sb_999")).status_code == 404
    cache = store.path.parent / "cache" / "storyboards"
    assert len([path for path in cache.glob("*/*") if path.is_dir()]) == 1
    assert not (roots[0] / ".cairndex/cache").exists()

    source = roots[0] / "Playback/movie.mp4"
    copy = source.with_suffix(".new")
    shutil.copyfile(source, copy)
    copy.replace(source)
    assert client.get(url).status_code == 404
    assert client.get(sheet_url).status_code == 404
    stale = client.post(request, json={"generation": token}).json()
    assert stale["state"] == "unavailable" and "changed" in stale["message"]
    fresh = client.get(base + "/replica/media/files/media-direct").json()["generation"]
    assert _settle_storyboard(client, request, fresh)["state"] == "ready"
    assert len([path for path in cache.glob("*/*") if path.is_dir()]) == 2
    image = client.post(
        base + "/replica/media/files/media-preview/storyboard", json={"generation": "x"}
    )
    assert image.status_code == 422
    assert authored(store) == before
    assert client.get(base + "/replica/status").json()["storyboard_version"] == 1


# The full-decode fallback runs a second decoder over the same pinned generation
def test_storyboard_fallback_pass_reads_the_pinned_source(media_api, monkeypatch):
    from cairndex.media import storyboards as boards

    client, base, _, _, _ = media_api
    passes = []
    real = boards._generate_sheets

    def counted(*args, **kwargs):
        passes.append(kwargs.get("sampling"))
        return real(*args, **kwargs)

    monkeypatch.setattr(boards, "_MIN_KEYFRAME_SAMPLES", 10**6)
    monkeypatch.setattr(boards, "_generate_sheets", counted)
    request = base + "/replica/media/files/media-direct/storyboard"
    token = client.get(base + "/replica/media/files/media-direct").json()["generation"]
    ready = _settle_storyboard(client, request, token)
    assert ready["state"] == "ready", ready
    assert passes == ["keyframe", "exact"]
    index = client.get(ready["url"]).text
    assert index.count("#xywh=") >= 30


# A failure reports a fixed sentence once and is not restarted by every poll
def test_storyboard_failure_hides_decoder_output(media_api, monkeypatch):
    from cairndex.media import storyboards as boards

    client, base, _, _, roots = media_api
    calls = []

    def fail(source, *args, **kwargs):
        calls.append(source)
        raise boards.StoryboardError(f"ffmpeg could not read {source}")

    monkeypatch.setattr(boards, "build_into", fail)
    request = base + "/replica/media/files/media-direct/storyboard"
    token = client.get(base + "/replica/media/files/media-direct").json()["generation"]
    failed = _settle_storyboard(client, request, token)
    assert failed == {
        "state": "failed",
        "url": None,
        "message": "The storyboard could not be generated.",
    }
    assert _settle_storyboard(client, request, token)["state"] == "failed"
    assert len(calls) == 1
    assert str(roots[0]) not in str(failed)


# Release takes a running storyboard away; Reopen lets the viewer ask again
def test_storyboard_release_aborts_running_work(media_api, monkeypatch):
    import threading
    import time

    from cairndex.core.abort import OperationAborted, aborted
    from cairndex.media import storyboards as boards

    client, base, store, _, _ = media_api
    started = threading.Event()
    real = boards.build_into

    def wait_for_abort(*args, **kwargs):
        started.set()
        for _ in range(200):
            if aborted():
                raise OperationAborted
            time.sleep(0.05)
        raise AssertionError("release did not abort the storyboard")

    monkeypatch.setattr(boards, "build_into", wait_for_abort)
    request = base + "/replica/media/files/media-direct/storyboard"
    token = client.get(base + "/replica/media/files/media-direct").json()["generation"]
    assert client.post(request, json={"generation": token}).json()["state"] == "queued"
    assert started.wait(timeout=10)
    assert client.post(base + "/ownership/release").status_code == 200
    assert client.post(base + "/ownership/reopen").status_code == 200
    monkeypatch.setattr(boards, "build_into", real)
    token = client.get(base + "/replica/media/files/media-direct").json()["generation"]
    assert _settle_storyboard(client, request, token)["state"] == "ready"
    assert not list((store.path.parent / "cache" / "storyboards").glob("*/*.tmp-*"))
