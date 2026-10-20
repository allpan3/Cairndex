"""Unindexed paths use scoped, generation-fenced reads without catalog identities."""

import shutil
import time

import pytest

from cairndex.replicas import service
from tests.test_replica_media import CAPS, authored
from tests.test_replica_media import media_api as media_api
from tests.test_replica_media import specimen as specimen


@pytest.fixture
def path_api(media_api):
    client, base, store, peer, roots = media_api
    deadline = time.monotonic() + 20
    while not store.status()["ready"] and time.monotonic() < deadline:
        service.exchange(base.rsplit("/", 1)[-1])
        time.sleep(0.01)
    assert store.status()["ready"]
    shutil.copyfile(roots[0] / "Playback/movie.mp4", roots[0] / "Playback/loose.mp4")
    return client, base, store, roots[0]


def test_path_observation_and_ranges_have_no_catalog_or_resume_identity(path_api):
    client, base, store, root = path_api
    before = authored(store)
    directory = client.get(base + "/replica/media/directory", params={"path": "Playback"}).json()
    entry = next(value for value in directory["entries"] if value["name"] == "loose.mp4")
    assert entry["supported"] and not entry["linked"]
    response = client.get(base + "/replica/media/path", params={"path": "Playback/loose.mp4"})
    assert response.status_code == 200, response.text
    observed = response.json()
    assert observed["entry"]["file_id"] is None
    assert observed["entry"]["bundle_id"] is None
    assert observed["entry"]["duration"] > 0
    assert observed["entry"]["resume_position"] is None
    read = client.get(
        base + "/file",
        params={"path": "Playback/loose.mp4", "source_generation": observed["generation"]},
        headers={"Range": "bytes=8-31"},
    )
    assert read.status_code == 206
    assert read.content == (root / "Playback/loose.mp4").read_bytes()[8:32]
    assert read.headers["cache-control"] == "private, no-store"
    assert authored(store) == before
    with store.connection(readonly=True) as db:
        assert db.execute("SELECT COUNT(*) FROM local_progress").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM local_cursors").fetchone()[0] == 0


def test_path_observation_and_decision_share_one_generation_probe(path_api, monkeypatch):
    from cairndex.replicas import path_media

    client, base, _, _ = path_api
    original = path_media.run_ffprobe
    calls = []

    def probe(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(path_media, "run_ffprobe", probe)
    observed = client.get(
        base + "/replica/media/path", params={"path": "Playback/loose.mp4"}
    ).json()
    decision = client.post(
        base + "/file-browser/playback-decision",
        json={
            "path": "Playback/loose.mp4",
            "source_generation": observed["generation"],
            "caps": CAPS,
        },
    )
    assert decision.status_code == 200, decision.text
    assert observed["generation"] in decision.json()["stream_url"]
    assert decision.json()["progress"] is None
    assert calls == [1]


def test_changed_path_refuses_old_stream_preview_and_playback_decision(path_api):
    client, base, _, root = path_api
    observed = client.get(
        base + "/replica/media/path", params={"path": "Playback/loose.mp4"}
    ).json()
    (root / "Playback/loose.mp4").write_bytes(b"changed synthetic bytes")
    params = {"path": "Playback/loose.mp4", "source_generation": observed["generation"]}
    assert client.get(base + "/file", params=params).status_code >= 400
    decision = client.post(base + "/file-browser/playback-decision", json=params | {"caps": CAPS})
    assert decision.status_code >= 400


@pytest.mark.parametrize(
    "path", ["../outside.mp4", "/outside.mp4", ".hidden.mp4", "link.mp4", "a\x00.mp4"]
)
def test_unindexed_routes_refuse_unsafe_sources(path_api, tmp_path, path):
    client, base, _, root = path_api
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"synthetic outside bytes")
    (root / "link.mp4").symlink_to(outside)
    (root / ".hidden.mp4").write_bytes(b"synthetic hidden bytes")
    response = client.get(base + "/replica/media/path", params={"path": path})
    assert response.status_code in {400, 404, 409, 422}, response.text
    response = client.get(base + "/file", params={"path": path})
    assert response.status_code in {400, 404, 409, 422}, response.text


def test_unindexed_image_previews_stay_private_and_refuse_stale_generations(path_api):
    client, base, store, root = path_api
    shutil.copyfile(root / "Playback/preview.tiff", root / "Playback/loose.tiff")
    before = authored(store)
    observed = client.get(
        base + "/replica/media/path", params={"path": "Playback/loose.tiff"}
    ).json()
    params = {
        "path": "Playback/loose.tiff",
        "source_generation": observed["generation"],
        "size": 1600,
    }
    preview = client.get(base + "/file/preview", params=params)
    assert preview.status_code == 200, preview.text
    assert preview.headers["content-type"] == "image/webp"
    assert preview.headers["cache-control"] == "private, no-store"
    assert list(store.path.parent.glob("cache/path-previews/*/*.webp"))
    assert not (root / ".cairndex/cache").exists()
    (root / "Playback/loose.tiff").write_bytes(b"changed synthetic image")
    assert client.get(base + "/file/preview", params=params).status_code >= 400
    assert authored(store) == before


def test_path_hls_artifacts_revalidate_source_and_portable_teardown_works(path_api):
    client, base, store, root = path_api
    before = authored(store)
    params = {"path": "Playback/loose.mp4", "caps": CAPS, "force_hls": True}
    for method in ("DELETE", "POST"):
        response = client.post(base + "/file-browser/playback-decision", json=params)
        assert response.status_code == 200, response.text
        session = response.json()["session"]["id"]
        route = base + f"/file-browser/playback-sessions/{session}"
        assert client.get(route + "/index.m3u8").status_code == 200
        target = route + ("/teardown" if method == "POST" else "")
        assert client.request(method, target).status_code == 204
    response = client.post(base + "/file-browser/playback-decision", json=params)
    session = response.json()["session"]["id"]
    (root / "Playback/loose.mp4").write_bytes(b"changed synthetic video")
    route = base + f"/file-browser/playback-sessions/{session}"
    assert client.get(route + "/index.m3u8").status_code >= 400
    assert client.get(route + "/index.m3u8").status_code == 404
    assert authored(store) == before


def test_unindexed_audio_remains_openable_without_a_catalog_identity(path_api):
    import wave

    client, base, store, root = path_api
    before = authored(store)
    with wave.open(str(root / "Playback/loose.wav"), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\x00\x00" * 8000)
    response = client.get(base + "/replica/media/path", params={"path": "Playback/loose.wav"})
    assert response.status_code == 200, response.text
    observed = response.json()
    assert observed["entry"]["media_kind"] == "audio"
    assert observed["entry"]["supported"]
    assert observed["entry"]["duration"] > 0
    assert observed["entry"]["file_id"] is None
    read = client.get(
        base + "/file",
        params={
            "path": "Playback/loose.wav",
            "source_generation": observed["generation"],
        },
    )
    assert read.status_code == 200
    assert read.content == (root / "Playback/loose.wav").read_bytes()
    assert authored(store) == before
