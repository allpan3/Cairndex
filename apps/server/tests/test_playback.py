"""Direct playback: capability detection, range streaming, and VTT subtitles."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import event, select
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileRole, GroupingSource, GroupingState, MediaKind
from cairndex.main import create_app
from cairndex.media import playback
from cairndex.media.playback import _srt_to_vtt, assess_playability
from cairndex.persistence.models import AssetBundle, AssetFile, PlaybackProgress
from cairndex.registry import library_package as pkg
from cairndex.registry import services as registry_service
from cairndex.registry.engine import get_registry_engine, get_registry_sessionmaker
from cairndex.registry.library_engine import get_library_sessionmaker
from cairndex.services import bundles as bundle_service
from cairndex.services import playback_progress as progress_service
from cairndex.services import subtitles as sub_service

# --- capability detection ----------------------------------------------------


# Resume cards accept only positive, unfinished scalar progress
def test_resume_position_scalar_predicate() -> None:
    assert progress_service.resume_position(12.0, False) == 12.0
    assert progress_service.resume_position(None, False) is None
    assert progress_service.resume_position(0.0, False) is None
    assert progress_service.resume_position(-1.0, False) is None
    assert progress_service.resume_position(12.0, True) is None


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


def test_stream_releases_db_connection_before_body(
    isolated_client: TestClient,
    registry_session: Session,
    library_id: str,
    session: Session,
    library_root: Path,
) -> None:
    """Regression: the content session must be released before the body streams.

    A ``yield`` session dependency stays checked out until the response body
    finishes, so a streaming ``FileResponse`` used to pin a per-library (and
    registry) connection for the whole transfer. Under drag-seek, overlapping
    range requests then exhausted the QueuePool and new requests timed out (30s)
    with a ``QueuePool`` 500. The fix scopes resolution and releases the
    connection before streaming — so mid-transfer, none is checked out.
    """
    # A large body so the FileResponse streams in chunks and the response can be
    # held open mid-transfer (small bodies buffer and complete before we sample).
    payload = b"\x00\x01\x02\x03" * (1024 * 1024)  # 4 MiB
    (library_root / "big.mp4").write_bytes(payload)
    bundle = bundle_service.create_bundle(session, title="Big")
    video = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="big.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    session.commit()

    # The pool of the *real* per-library engine that isolated_client resolves to.
    library = registry_service.get_library(registry_session, library_id)
    engine = get_library_sessionmaker(library).kw["bind"]

    base = f"/api/v1/libraries/{library_id}"
    assert engine.pool.checkedout() == 0

    with isolated_client.stream("GET", f"{base}/files/{video.id}/stream") as resp:
        assert resp.status_code == 200
        # Body not yet consumed: pre-fix this was 1 (session pinned for the whole
        # transfer); post-fix the connection is already back in the pool.
        assert engine.pool.checkedout() == 0
        body = resp.read()

    assert len(body) == len(payload)
    assert engine.pool.checkedout() == 0


def test_stream_releases_registry_connection_before_body(
    library_root: Path,
    session: Session,
) -> None:
    """Invariant: streaming must not check out a *registry* connection either.

    ``get_library_access`` used to take the ``get_registry_db`` yield dependency.
    Yield-dep teardown runs only after the response body finishes — and on a
    client abort (task cancellation) it does not run at all, stranding the
    connection until GC. Drag-seeking aborts dozens of in-flight range requests,
    so the registry QueuePool (size 5 + overflow 10) drained: new gates blocked
    30s at resolution and ``/stream`` 500ed mid-drag, which the browser's demuxer
    surfaced as a fatal media error. The fix scopes the registry session inside
    the (sync, cancellation-immune) dependency itself.

    The cancellation strand can't be reproduced deterministically in-process
    (refcounting GC returns the connection immediately here; it was verified
    live with an abort-storm against a real server). What this test locks in is
    the design that makes the strand impossible: through the real, unoverridden
    dependency chain, neither pool has a connection checked out once the
    response begins streaming — there is nothing left for a cancelled body to
    strand.
    """
    with get_registry_sessionmaker()() as reg:
        library = registry_service.register_existing_library(reg, root_path=str(library_root))
        reg.commit()
        library_id = library.id

    payload = b"\x00\x01\x02\x03" * (1024 * 1024)  # 4 MiB
    (library_root / "big.mp4").write_bytes(payload)
    bundle = bundle_service.create_bundle(session, title="Big")
    video = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="big.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    session.commit()

    app = create_app()  # no dependency overrides: the real gate + real pools
    registry_pool = get_registry_engine().pool
    with (
        TestClient(app) as raw_client,
        raw_client.stream("GET", f"/api/v1/libraries/{library_id}/files/{video.id}/stream") as resp,
    ):
        assert resp.status_code == 200
        # Body not yet consumed: pre-fix the registry connection was pinned
        # for the whole transfer; post-fix both pools are already drained.
        assert registry_pool.checkedout() == 0
        library_engine = get_library_sessionmaker(library).kw["bind"]
        assert library_engine.pool.checkedout() == 0
        body = resp.read()

    assert len(body) == len(payload)
    assert registry_pool.checkedout() == 0


# Keep old probed rows valid when M1 metadata keys are absent
def test_playback_manifest_accepts_legacy_tech_metadata(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    bundle, video = _bundle_with_media(session, library_root)
    video.tech_metadata = {"width": 640, "height": 360, "duration": 5.0, "video_codec": "h264"}
    session.commit()
    base = f"/api/v1/libraries/{library_id}"

    body = client.get(f"{base}/bundles/{bundle.id}/playback").json()
    video_item = body["videos"][0]
    assert video_item["width"] == 640
    assert video_item["height"] == 360
    assert video_item["duration"] == 5.0
    assert len(video_item["subtitles"]) == 1


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


def test_progress_put_upserts_clamps_and_marks_completion(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    bundle, video = _bundle_with_media(session, library_root)
    image = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="poster.png",
        role=FileRole.IMAGE,
        media_kind=MediaKind.IMAGE,
    )
    session.commit()
    base = f"/api/v1/libraries/{library_id}"

    first = client.put(
        f"{base}/files/{video.id}/progress", json={"position_s": 94, "duration_s": 100}
    )
    assert first.status_code == 200
    assert first.json() == {"position_s": 94.0, "duration_s": 100.0, "completed": False}

    second = client.put(
        f"{base}/files/{video.id}/progress", json={"position_s": 150, "duration_s": 100}
    )
    assert second.status_code == 200
    assert second.json() == {"position_s": 100.0, "duration_s": 100.0, "completed": True}
    assert len(session.scalars(select(PlaybackProgress)).all()) == 1

    boundary = client.put(
        f"{base}/files/{video.id}/progress", json={"position_s": 95, "duration_s": 100}
    )
    assert boundary.json()["completed"] is True
    assert session.get(PlaybackProgress, video.id).bundle_id == bundle.id

    beacon = client.post(
        f"{base}/files/{video.id}/progress", json={"position_s": 10, "duration_s": 100}
    )
    assert beacon.status_code == 200
    assert beacon.json()["completed"] is False

    unknown_duration = client.put(
        f"{base}/files/{video.id}/progress", json={"position_s": 999, "duration_s": None}
    )
    assert unknown_duration.status_code == 200
    assert unknown_duration.json() == {
        "position_s": 999.0,
        "duration_s": None,
        "completed": False,
    }

    image_progress = client.put(
        f"{base}/files/{image.id}/progress", json={"position_s": 1, "duration_s": 10}
    )
    assert image_progress.status_code == 422


def test_playback_manifest_embeds_progress_with_one_progress_query(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    bundle, video = _bundle_with_media(session, library_root)
    part = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="part2.mp4",
        role=FileRole.VIDEO_PART,
        media_kind=MediaKind.VIDEO,
    )
    session.add(
        PlaybackProgress(
            file_id=video.id,
            bundle_id=bundle.id,
            position_s=12,
            duration_s=100,
            completed=False,
            updated_at=datetime(2026, 7, 6, tzinfo=UTC),
        )
    )
    session.commit()
    statements: list[str] = []

    def capture(_conn: object, _cursor: object, statement: str, *_args: object) -> None:
        if "playback_progress" in statement.lower():
            statements.append(statement)

    event.listen(session.get_bind(), "before_cursor_execute", capture)
    try:
        body = client.get(f"/api/v1/libraries/{library_id}/bundles/{bundle.id}/playback").json()
    finally:
        event.remove(session.get_bind(), "before_cursor_execute", capture)

    by_id = {item["file_id"]: item for item in body["videos"]}
    assert by_id[video.id]["progress"] == {
        "position_s": 12.0,
        "duration_s": 100.0,
        "completed": False,
    }
    assert by_id[part.id]["progress"] is None
    assert len(statements) == 1
    assert " IN " in statements[0].upper()


def test_continue_watching_orders_paginates_and_excludes_completed(
    client: TestClient, library_id: str, session: Session
) -> None:
    now = datetime(2026, 7, 6, 12, tzinfo=UTC)

    def video_bundle(title: str, file_name: str, *, position: float, completed: bool, age: int):
        bundle = bundle_service.create_bundle(session, title=title)
        video = bundle_service.add_file(
            session,
            bundle.id,
            relative_path=file_name,
            role=FileRole.PRIMARY_VIDEO,
            media_kind=MediaKind.VIDEO,
        )
        session.add(
            PlaybackProgress(
                file_id=video.id,
                bundle_id=bundle.id,
                position_s=position,
                duration_s=100,
                completed=completed,
                updated_at=now - timedelta(minutes=age),
            )
        )
        return bundle, video

    old, _old_file = video_bundle("Old", "old.mp4", position=10, completed=False, age=20)
    newest_a, a_file = video_bundle("Newest A", "a.mp4", position=10, completed=False, age=0)
    newest_b, b_file = video_bundle("Newest B", "b.mp4", position=10, completed=False, age=0)
    video_bundle("Done", "done.mp4", position=99, completed=True, age=0)
    video_bundle("Zero", "zero.mp4", position=0, completed=False, age=0)
    session.commit()
    expected = [newest_a.id, newest_b.id] if a_file.id < b_file.id else [newest_b.id, newest_a.id]

    page = client.get(f"/api/v1/libraries/{library_id}/continue-watching?limit=2").json()
    assert page["total"] == 3
    assert [item["id"] for item in page["items"]] == expected
    assert page["items"][0]["title"].startswith("Newest")
    assert page["items"][0]["progress"]["file_id"] in {a_file.id, b_file.id}
    assert page["items"][0]["progress"]["position_s"] == 10.0
    assert page["items"][0]["progress"]["duration_s"] == 100.0

    second = client.get(f"/api/v1/libraries/{library_id}/continue-watching?limit=2&offset=2").json()
    assert [item["id"] for item in second["items"]] == [old.id]


def test_progress_cascades_when_file_is_deleted(session: Session, library_root: Path) -> None:
    bundle, video = _bundle_with_media(session, library_root)
    session.add(
        PlaybackProgress(
            file_id=video.id,
            bundle_id=bundle.id,
            position_s=10,
            duration_s=100,
            completed=False,
            updated_at=datetime(2026, 7, 6, tzinfo=UTC),
        )
    )
    session.commit()

    session.delete(video)
    session.commit()

    assert session.get(PlaybackProgress, video.id) is None


def test_progress_bundle_id_tracks_asset_file_reparent(
    session: Session, library_root: Path
) -> None:
    bundle, video = _bundle_with_media(session, library_root)
    target = bundle_service.create_bundle(session, title="Target")
    session.add(
        PlaybackProgress(
            file_id=video.id,
            bundle_id=bundle.id,
            position_s=10,
            duration_s=100,
            completed=False,
            updated_at=datetime(2026, 7, 6, tzinfo=UTC),
        )
    )
    session.commit()

    video.bundle_id = target.id
    session.commit()

    row = session.get(PlaybackProgress, video.id)
    assert row is not None
    assert row.bundle_id == target.id


def test_progress_cascades_when_provisional_bundle_is_deleted_through_api(
    client: TestClient, library_id: str, session: Session
) -> None:
    bundle = AssetBundle(
        title="Loose",
        grouping_state=GroupingState.PROVISIONAL,
        grouping_source=GroupingSource.SCAN_SUGGESTION,
    )
    session.add(bundle)
    session.flush()
    video = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="loose.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    session.add(
        PlaybackProgress(
            file_id=video.id,
            bundle_id=bundle.id,
            position_s=10,
            duration_s=100,
            completed=False,
            updated_at=datetime(2026, 7, 6, tzinfo=UTC),
        )
    )
    session.commit()

    resp = client.delete(f"/api/v1/libraries/{library_id}/bundles/{bundle.id}")
    assert resp.status_code == 204

    session.expire_all()
    assert session.get(AssetFile, video.id) is None
    assert session.get(PlaybackProgress, video.id) is None


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
    vtt = playback.vtt_cache_path(library_root, track_id)
    assert vtt.exists()
    # Cached inside the library's portable .cairndex/cache/subtitles (phase 8).
    assert vtt.is_relative_to(pkg.cache_dir(library_root) / "subtitles")
