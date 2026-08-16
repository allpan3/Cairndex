"""Scan/probe/thumbnail trigger endpoints and fast-add with grouping (ADR-0008)."""

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from cairndex.domain.enums import Grouping, JobStatus
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.registry.models import JobQueueEntry
from cairndex.scanning.fast_add import fast_add


def _media_tree(root: Path) -> None:
    (root / "movie").mkdir(parents=True)
    (root / "movie" / "part1.mkv").write_text("v1")
    (root / "movie" / "part2.mkv").write_text("v2")
    (root / "movie" / "cover.jpg").write_text("c")
    (root / "loose.mp4").write_text("v3")
    (root / "readme.txt").write_text("ignored")


def test_scan_trigger_enqueues_job(client: TestClient, library_id: str, library_root: Path) -> None:
    _media_tree(library_root)
    resp = client.post(f"/api/v1/libraries/{library_id}/jobs/scan")
    assert resp.status_code == 202
    body = resp.json()
    assert body["job_type"] == "scan"
    assert body["status"] == "queued"
    assert body["library_id"] == library_id

    assert client.get(f"/api/v1/jobs/{body['id']}").status_code == 200


def test_probe_thumbnail_and_storyboard_triggers(client: TestClient, library_id: str) -> None:
    probe = client.post(f"/api/v1/libraries/{library_id}/jobs/probe")
    assert probe.json()["job_type"] == "probe"
    thumb = client.post(f"/api/v1/libraries/{library_id}/jobs/thumbnails")
    assert thumb.json()["job_type"] == "thumbnail"
    storyboard = client.post(f"/api/v1/libraries/{library_id}/jobs/storyboards")
    assert storyboard.json()["job_type"] == "storyboard"


def test_storyboard_trigger_dedupes_queued_job(client: TestClient, library_id: str) -> None:
    first = client.post(f"/api/v1/libraries/{library_id}/jobs/storyboards").json()
    second = client.post(f"/api/v1/libraries/{library_id}/jobs/storyboards").json()
    assert second["id"] == first["id"]


def test_storyboard_trigger_does_not_dedupe_running_job(
    client: TestClient, registry_session: Session, library_id: str
) -> None:
    first = client.post(f"/api/v1/libraries/{library_id}/jobs/storyboards").json()
    job = registry_session.get(JobQueueEntry, first["id"])
    assert job is not None
    job.status = JobStatus.RUNNING
    registry_session.commit()

    second = client.post(f"/api/v1/libraries/{library_id}/jobs/storyboards").json()
    assert second["id"] != first["id"]
    assert second["status"] == "queued"


def test_scan_trigger_defaults_to_suggesting_grouping(client: TestClient, library_id: str) -> None:
    body = client.post(f"/api/v1/libraries/{library_id}/jobs/scan").json()
    assert body["payload"]["suggest_grouping"] is True


def test_scan_trigger_can_ask_for_discovery_only(client: TestClient, library_id: str) -> None:
    """ "Scan new files" must not carry the grouping pass (owner-reported, 2026-08-15)."""
    body = client.post(
        f"/api/v1/libraries/{library_id}/jobs/scan", params={"suggest_grouping": "false"}
    ).json()
    assert body["payload"]["suggest_grouping"] is False


def test_scan_trigger_unknown_library_404(client: TestClient) -> None:
    assert client.post("/api/v1/libraries/01000000000000000000000000/jobs/scan").status_code == 404


def test_fast_add_per_file_grouping(session: Session, library_root: Path) -> None:
    _media_tree(library_root)
    result = fast_add(session, paths=["movie/part1.mkv", "loose.mp4"], grouping=Grouping.PER_FILE)
    assert result.files_linked == 2
    assert result.bundles_created == 2
    assert session.scalar(select(func.count()).select_from(AssetBundle)) == 2


def test_fast_add_single_bundle_expands_directory(session: Session, library_root: Path) -> None:
    _media_tree(library_root)
    result = fast_add(
        session,
        paths=["movie"],
        grouping=Grouping.SINGLE_BUNDLE,
        bundle_title="My Movie",
    )
    assert result.files_linked == 3
    assert result.bundles_created == 1
    assert session.scalar(select(func.count()).select_from(AssetBundle)) == 1
    titles = session.scalars(select(AssetBundle.title)).all()
    assert titles == ["My Movie"]


def test_fast_add_single_bundle_links_external_subtitle(
    session: Session, library_root: Path
) -> None:
    """Grouping a video with its sidecar .srt links them (ADR-0009 phase 6)."""
    (library_root / "doc").mkdir()
    (library_root / "doc" / "film.mkv").write_text("v")
    (library_root / "doc" / "film.en.srt").write_text("s")
    result = fast_add(session, paths=["doc"], grouping=Grouping.SINGLE_BUNDLE)

    assert result.subtitles_linked == 1
    from cairndex.persistence.models import SubtitleTrack

    track = session.scalars(select(SubtitleTrack)).one()
    video = session.scalars(
        select(AssetFile).where(AssetFile.relative_path == "doc/film.mkv")
    ).one()
    srt = session.scalars(
        select(AssetFile).where(AssetFile.relative_path == "doc/film.en.srt")
    ).one()
    assert track.source_file_id == srt.id
    assert track.video_file_id == video.id
    assert track.language == "en"


def test_fast_add_is_idempotent(session: Session, library_root: Path) -> None:
    _media_tree(library_root)
    fast_add(session, paths=["loose.mp4"])
    again = fast_add(session, paths=["loose.mp4"])  # already linked
    assert again.files_linked == 0
    assert again.skipped == 1
    assert session.scalar(select(func.count()).select_from(AssetFile)) == 1


def test_fast_add_rejects_traversal(client: TestClient, library_id: str) -> None:
    resp = client.post(
        f"/api/v1/libraries/{library_id}/fast-add",
        json={"paths": ["../../etc/passwd"]},
    )
    assert resp.status_code == 422
