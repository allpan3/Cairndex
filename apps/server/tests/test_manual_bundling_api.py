"""Manual bundling assistant API + the Unbundled browse view, end-to-end over a
real scan (Unbundled staging follow-up to ADR-0009)."""

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.scanning.scanner import scan_library


def _file_ids_in_unbundled(client: TestClient, base: str) -> dict[str, str]:
    """Map relative filename → asset-file id for everything in the Unbundled view.

    The Unbundled view lists one provisional bundle per scan-staged file; the
    file id is read from each bundle's files endpoint.
    """
    page = client.get(f"{base}/bundles/browse", params={"view": "unbundled", "limit": 100})
    assert page.status_code == 200
    result: dict[str, str] = {}
    for item in page.json()["items"]:
        files = client.get(f"{base}/bundles/{item['id']}/files").json()
        for f in files:
            result[f["relative_path"]] = f["id"]
    return result


def _seed(session: Session, root: Path) -> None:
    (root / "movie").mkdir()
    (root / "movie" / "feature.mp4").write_text("v")
    (root / "movie" / "feature.srt").write_text("s")
    (root / "movie" / "cover.jpg").write_text("i")
    scan_library(session, root)
    session.commit()


def test_unbundled_view_and_counts(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed(session, library_root)
    base = f"/api/v1/libraries/{library_id}"

    counts = client.get(f"{base}/bundles/counts").json()
    assert counts["unbundled"] == 3
    assert counts["all"] == 0  # nothing confirmed yet

    unbundled = client.get(f"{base}/bundles/browse", params={"view": "unbundled"}).json()
    assert unbundled["total"] == 3


def test_create_bundle_then_add_files_flow(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed(session, library_root)
    base = f"/api/v1/libraries/{library_id}"
    files = _file_ids_in_unbundled(client, base)

    # Create a confirmed bundle from the feature video alone.
    created = client.post(
        f"{base}/manual-bundling/create-bundle",
        json={"file_ids": [files["movie/feature.mp4"]], "title": "Feature Film"},
    )
    assert created.status_code == 201
    bundle_id = created.json()["bundle_id"]
    assert created.json()["created"] is True

    # It now appears in All and is gone from Unbundled; two files remain unbundled.
    counts = client.get(f"{base}/bundles/counts").json()
    assert counts["all"] == 1 and counts["unbundled"] == 2

    # Suggestions for the new bundle should surface the same-folder sidecars.
    suggested = client.get(f"{base}/manual-bundling/bundles/{bundle_id}/suggest-files").json()[
        "suggestions"
    ]
    suggested_paths = {s["relative_path"] for s in suggested}
    assert "movie/feature.srt" in suggested_paths
    assert "movie/cover.jpg" in suggested_paths

    # Add both sidecars; the subtitle auto-links to the feature video.
    added = client.post(
        f"{base}/manual-bundling/add-files",
        json={
            "target_bundle_id": bundle_id,
            "file_ids": [files["movie/feature.srt"], files["movie/cover.jpg"]],
        },
    )
    assert added.status_code == 200
    body = added.json()
    assert body["files_added"] == 2
    assert body["bundles_removed"] == 2
    assert body["subtitles_linked"] == 1

    # Everything is now in the one confirmed bundle; Unbundled is empty.
    counts = client.get(f"{base}/bundles/counts").json()
    assert counts["all"] == 1 and counts["unbundled"] == 0
    bundle_files = client.get(f"{base}/bundles/{bundle_id}/files").json()
    assert len(bundle_files) == 3


def test_suggest_targets_endpoint(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed(session, library_root)
    base = f"/api/v1/libraries/{library_id}"
    files = _file_ids_in_unbundled(client, base)

    # Confirm the feature as its own bundle, then ask where the subtitle belongs.
    created = client.post(
        f"{base}/manual-bundling/create-bundle",
        json={"file_ids": [files["movie/feature.mp4"]]},
    )
    bundle_id = created.json()["bundle_id"]

    remaining = _file_ids_in_unbundled(client, base)
    targets = client.post(
        f"{base}/manual-bundling/suggest-targets",
        json={"file_ids": [remaining["movie/feature.srt"]]},
    )
    assert targets.status_code == 200
    suggestions = targets.json()["suggestions"]
    assert suggestions and suggestions[0]["bundle_id"] == bundle_id


def test_deleting_a_bundle_returns_files_to_unbundled(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _seed(session, library_root)
    base = f"/api/v1/libraries/{library_id}"
    files = _file_ids_in_unbundled(client, base)

    # Confirm all three files into one bundle → Unbundled empties.
    created = client.post(
        f"{base}/manual-bundling/create-bundle",
        json={"file_ids": list(files.values()), "title": "Feature"},
    )
    bundle_id = created.json()["bundle_id"]
    counts = client.get(f"{base}/bundles/counts").json()
    assert counts["all"] == 1 and counts["unbundled"] == 0

    # Deleting the confirmed bundle dissolves it: the files fall back to Unbundled.
    assert client.delete(f"{base}/bundles/{bundle_id}").status_code == 204
    counts = client.get(f"{base}/bundles/counts").json()
    assert counts["all"] == 0
    assert counts["unbundled"] == 3
    # The same three files are back on disk and re-listed as unbundled.
    for name in ("movie/feature.mp4", "movie/feature.srt", "movie/cover.jpg"):
        assert (library_root / name).exists()
    assert set(_file_ids_in_unbundled(client, base)) == {
        "movie/feature.mp4",
        "movie/feature.srt",
        "movie/cover.jpg",
    }


def test_create_empty_bundle_endpoint(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    created = client.post(f"{base}/manual-bundling/create-empty-bundle", json={"title": "Empty"})
    assert created.status_code == 201
    assert created.json()["created"] is True
    bundle_id = created.json()["bundle_id"]
    fetched = client.get(f"{base}/bundles/{bundle_id}")
    assert fetched.status_code == 200
    assert fetched.json()["title"] == "Empty"
