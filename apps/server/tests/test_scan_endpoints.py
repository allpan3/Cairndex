"""Scan/probe/thumbnail trigger endpoints and fast-add with grouping."""

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from cairndex.domain.enums import Grouping
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.scanning.fast_add import fast_add
from cairndex.services import storage_roots as root_service


def _media_tree(tmp_path: Path) -> Path:
    media = tmp_path / "media"
    (media / "movie").mkdir(parents=True)
    (media / "movie" / "part1.mkv").write_text("v1")
    (media / "movie" / "part2.mkv").write_text("v2")
    (media / "movie" / "cover.jpg").write_text("c")
    (media / "loose.mp4").write_text("v3")
    (media / "readme.txt").write_text("ignored")
    return media


def test_scan_trigger_enqueues_job(client: TestClient, tmp_path: Path) -> None:
    media = _media_tree(tmp_path)
    root_id = client.post(
        "/api/v1/storage-roots", json={"name": "m", "canonical_path": str(media)}
    ).json()["id"]

    resp = client.post(f"/api/v1/storage-roots/{root_id}/scan")
    assert resp.status_code == 202
    body = resp.json()
    assert body["type"] == "scan"
    assert body["status"] == "queued"
    assert body["payload"]["storage_root_id"] == root_id

    # The job is visible via the jobs API.
    assert client.get(f"/api/v1/jobs/{body['id']}").status_code == 200


def test_probe_and_thumbnail_triggers(client: TestClient, tmp_path: Path) -> None:
    media = _media_tree(tmp_path)
    root_id = client.post(
        "/api/v1/storage-roots", json={"name": "m", "canonical_path": str(media)}
    ).json()["id"]

    assert client.post(f"/api/v1/storage-roots/{root_id}/probe").json()["type"] == "probe"
    assert client.post(f"/api/v1/storage-roots/{root_id}/thumbnails").json()["type"] == "thumbnail"


def test_scan_trigger_unknown_root_404(client: TestClient) -> None:
    assert client.post("/api/v1/storage-roots/01000000000000000000000000/scan").status_code == 404


def test_fast_add_per_file_grouping(session: Session, tmp_path: Path) -> None:
    media = _media_tree(tmp_path)
    root = root_service.create_storage_root(session, name="m", canonical_path=str(media))
    session.commit()

    result = fast_add(
        session, root.id, paths=["movie/part1.mkv", "loose.mp4"], grouping=Grouping.PER_FILE
    )
    assert result.files_linked == 2
    assert result.bundles_created == 2  # one bundle each
    assert session.scalar(select(func.count()).select_from(AssetBundle)) == 2


def test_fast_add_single_bundle_expands_directory(session: Session, tmp_path: Path) -> None:
    media = _media_tree(tmp_path)
    root = root_service.create_storage_root(session, name="m", canonical_path=str(media))
    session.commit()

    # The directory expands to its 3 media files (txt ignored) in one bundle.
    result = fast_add(
        session,
        root.id,
        paths=["movie"],
        grouping=Grouping.SINGLE_BUNDLE,
        bundle_title="My Movie",
    )
    assert result.files_linked == 3
    assert result.bundles_created == 1
    assert session.scalar(select(func.count()).select_from(AssetBundle)) == 1
    titles = session.scalars(select(AssetBundle.title)).all()
    assert titles == ["My Movie"]


def test_fast_add_is_idempotent(session: Session, tmp_path: Path) -> None:
    media = _media_tree(tmp_path)
    root = root_service.create_storage_root(session, name="m", canonical_path=str(media))
    session.commit()

    fast_add(session, root.id, paths=["loose.mp4"])
    again = fast_add(session, root.id, paths=["loose.mp4"])  # already linked
    assert again.files_linked == 0
    assert again.skipped == 1
    assert session.scalar(select(func.count()).select_from(AssetFile)) == 1


def test_fast_add_rejects_traversal(client: TestClient, tmp_path: Path) -> None:
    media = _media_tree(tmp_path)
    root_id = client.post(
        "/api/v1/storage-roots", json={"name": "m", "canonical_path": str(media)}
    ).json()["id"]
    resp = client.post(
        f"/api/v1/storage-roots/{root_id}/fast-add",
        json={"paths": ["../../etc/passwd"]},
    )
    assert resp.status_code == 422
