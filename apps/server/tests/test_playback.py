"""Direct playback: capability detection, range streaming, and VTT subtitles."""

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileRole, MediaKind
from cairndex.media import playback
from cairndex.media.playback import _srt_to_vtt, assess_playability
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.services import bundles as bundle_service
from cairndex.services import subtitles as sub_service


# --- capability detection ----------------------------------------------------
def test_assess_playability_by_container_and_codec(session: Session) -> None:
    bundle = bundle_service.create_bundle(session, title="m")

    def vid(path: str, meta: dict | None = None) -> AssetFile:
        f = bundle_service.add_file(
            session,
            bundle.id,
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
def _bundle_with_media(session: Session, library_root: Path) -> tuple[AssetBundle, AssetFile]:
    (library_root / "movie.mp4").write_bytes(bytes(range(256)) * 4)  # 1024 deterministic bytes
    (library_root / "movie.en.srt").write_text(
        "1\n00:00:01,000 --> 00:00:02,000\nHi\n", encoding="utf-8"
    )

    bundle = bundle_service.create_bundle(session, title="Movie")
    video = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="movie.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    bundle_service.add_file(
        session,
        bundle.id,
        relative_path="movie.en.srt",
        role=FileRole.SUBTITLE,
        media_kind=MediaKind.SUBTITLE,
    )
    sub_service.auto_link_external_subtitles(session, bundle.id)
    session.commit()
    return bundle, video


def test_stream_supports_range_requests(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    _bundle, video = _bundle_with_media(session, library_root)
    base = f"/api/v1/libraries/{library_id}"

    full = client.get(f"{base}/files/{video.id}/stream")
    assert full.status_code == 200
    assert len(full.content) == 1024
    assert full.headers.get("accept-ranges") == "bytes"

    partial = client.get(f"{base}/files/{video.id}/stream", headers={"Range": "bytes=0-9"})
    assert partial.status_code == 206
    assert partial.headers["content-range"] == "bytes 0-9/1024"
    assert len(partial.content) == 10


def test_file_content_serves_image_with_guessed_mime(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    (library_root / "photo.png").write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(range(64)))
    bundle = bundle_service.create_bundle(session, title="Album")
    image = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="photo.png",
        role=FileRole.IMAGE,
        media_kind=MediaKind.IMAGE,
    )
    session.commit()
    base = f"/api/v1/libraries/{library_id}"

    resp = client.get(f"{base}/files/{image.id}/content")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"
    assert resp.content.startswith(b"\x89PNG")

    missing = client.get(f"{base}/files/does-not-exist/content")
    assert missing.status_code == 404


def test_playback_manifest_lists_videos_and_subtitles(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    bundle, video = _bundle_with_media(session, library_root)
    base = f"/api/v1/libraries/{library_id}"

    body = client.get(f"{base}/bundles/{bundle.id}/playback").json()
    assert len(body["videos"]) == 1
    v = body["videos"][0]
    assert v["file_id"] == video.id
    assert v["playable"] is True
    assert v["stream_url"] == f"{base}/files/{video.id}/stream"
    assert len(v["subtitles"]) == 1
    track = v["subtitles"][0]
    assert track["kind"] == "external"
    assert track["language"] == "en"
    assert track["src"] == f"{base}/subtitles/{track['id']}/vtt"


def test_subtitle_vtt_endpoint_converts_srt(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    bundle, _video = _bundle_with_media(session, library_root)
    tracks = sub_service.list_tracks(session, bundle.id)
    track_id = tracks[0].id
    base = f"/api/v1/libraries/{library_id}"

    resp = client.get(f"{base}/subtitles/{track_id}/vtt")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/vtt")
    assert resp.text.startswith("WEBVTT")
    assert "00:00:01.000 --> 00:00:02.000" in resp.text
    assert playback.vtt_cache_path(track_id).exists()
