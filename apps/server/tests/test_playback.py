"""Direct playback: capability detection, range streaming, and VTT subtitles."""

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileRole, MediaKind
from cairndex.media import playback
from cairndex.media.playback import _srt_to_vtt, assess_playability
from cairndex.services import bundles as bundle_service
from cairndex.services import storage_roots as root_service
from cairndex.services import subtitles as sub_service


# --- capability detection ----------------------------------------------------
def test_assess_playability_by_container_and_codec(session: Session) -> None:
    root = root_service.create_storage_root(session, name="r", canonical_path="/mnt/r")
    bundle = bundle_service.create_bundle(session, title="m")

    def vid(path: str, meta: dict | None = None):
        f = bundle_service.add_file(
            session,
            bundle.id,
            storage_root_id=root.id,
            relative_path=path,
            role=FileRole.PRIMARY_VIDEO,
            media_kind=MediaKind.VIDEO,
        )
        f.tech_metadata = meta
        return f

    assert assess_playability(vid("a.mp4", {"video_codec": "h264"})).playable
    assert assess_playability(vid("b.mp4")).playable  # unknown codec → optimistic
    mkv = assess_playability(vid("c.mkv", {"video_codec": "h264"}))
    assert not mkv.playable and "container" in mkv.reason.lower()
    hevc = assess_playability(vid("d.mp4", {"video_codec": "hevc"}))
    assert not hevc.playable and "hevc" in hevc.reason.lower()


def test_srt_to_vtt_conversion() -> None:
    srt = "1\n00:00:01,000 --> 00:00:04,500\nHello\n"
    vtt = _srt_to_vtt(srt)
    assert vtt.startswith("WEBVTT\n\n")
    assert "00:00:01.000 --> 00:00:04.500" in vtt
    assert "," not in vtt.splitlines()[2]


# --- streaming + manifest + subtitles (on-disk) ------------------------------
def _bundle_with_media(session: Session, tmp_path: Path):
    media = tmp_path / "lib"
    media.mkdir()
    (media / "movie.mp4").write_bytes(bytes(range(256)) * 4)  # 1024 deterministic bytes
    (media / "movie.en.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\nHi\n", encoding="utf-8")

    root = root_service.create_storage_root(session, name="lib", canonical_path=str(media))
    bundle = bundle_service.create_bundle(session, title="Movie")
    video = bundle_service.add_file(
        session,
        bundle.id,
        storage_root_id=root.id,
        relative_path="movie.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    bundle_service.add_file(
        session,
        bundle.id,
        storage_root_id=root.id,
        relative_path="movie.en.srt",
        role=FileRole.SUBTITLE,
        media_kind=MediaKind.SUBTITLE,
    )
    sub_service.auto_link_external_subtitles(session, bundle.id)
    session.commit()
    return bundle, video


def test_stream_supports_range_requests(
    client: TestClient, session: Session, tmp_path: Path
) -> None:
    _bundle, video = _bundle_with_media(session, tmp_path)

    full = client.get(f"/api/v1/files/{video.id}/stream")
    assert full.status_code == 200
    assert len(full.content) == 1024
    assert full.headers.get("accept-ranges") == "bytes"

    partial = client.get(f"/api/v1/files/{video.id}/stream", headers={"Range": "bytes=0-9"})
    assert partial.status_code == 206
    assert partial.headers["content-range"] == "bytes 0-9/1024"
    assert len(partial.content) == 10


def test_file_content_serves_image_with_guessed_mime(
    client: TestClient, session: Session, tmp_path: Path
) -> None:
    media = tmp_path / "lib"
    media.mkdir()
    (media / "photo.png").write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(range(64)))
    root = root_service.create_storage_root(session, name="lib", canonical_path=str(media))
    bundle = bundle_service.create_bundle(session, title="Album")
    image = bundle_service.add_file(
        session,
        bundle.id,
        storage_root_id=root.id,
        relative_path="photo.png",
        role=FileRole.IMAGE,
        media_kind=MediaKind.IMAGE,
    )
    session.commit()

    resp = client.get(f"/api/v1/files/{image.id}/content")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"
    assert resp.content.startswith(b"\x89PNG")

    missing = client.get("/api/v1/files/does-not-exist/content")
    assert missing.status_code == 404


def test_playback_manifest_lists_videos_and_subtitles(
    client: TestClient, session: Session, tmp_path: Path
) -> None:
    bundle, video = _bundle_with_media(session, tmp_path)

    body = client.get(f"/api/v1/bundles/{bundle.id}/playback").json()
    assert len(body["videos"]) == 1
    v = body["videos"][0]
    assert v["file_id"] == video.id
    assert v["playable"] is True
    assert v["stream_url"] == f"/api/v1/files/{video.id}/stream"
    assert len(v["subtitles"]) == 1
    track = v["subtitles"][0]
    assert track["kind"] == "external"
    assert track["language"] == "en"
    assert track["src"] == f"/api/v1/subtitles/{track['id']}/vtt"


def test_subtitle_vtt_endpoint_converts_srt(
    client: TestClient, session: Session, tmp_path: Path
) -> None:
    bundle, _video = _bundle_with_media(session, tmp_path)
    tracks = sub_service.list_tracks(session, bundle.id)
    track_id = tracks[0].id

    resp = client.get(f"/api/v1/subtitles/{track_id}/vtt")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/vtt")
    assert resp.text.startswith("WEBVTT")
    assert "00:00:01.000 --> 00:00:02.000" in resp.text
    # Cached under the app data dir, not beside the original.
    assert playback.vtt_cache_path(track_id).exists()
