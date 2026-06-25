"""Asset-bundle acceptance tests (Phase 1).

Verifies the bundle is metadata-only and non-destructive: linking/unlinking
files and deleting bundles never touches files on disk, while shared metadata,
multi-file bundles, hierarchical tags/folders, and cover/primary selection all
work.
"""

from pathlib import Path

from fastapi.testclient import TestClient


def _make_media_tree(tmp_path: Path) -> Path:
    root = tmp_path / "media"
    (root / "movie").mkdir(parents=True)
    (root / "movie" / "part1.mp4").write_text("video-1")
    (root / "movie" / "part2.mp4").write_text("video-2")
    (root / "movie" / "cover.jpg").write_text("cover")
    (root / "movie" / "movie.srt").write_text("subtitles")
    return root


def _create_root(client: TestClient, path: Path) -> str:
    resp = client.post("/api/v1/storage-roots", json={"name": "media", "canonical_path": str(path)})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _link(
    client: TestClient, bundle_id: str, root_id: str, rel: str, role: str, kind: str
) -> dict[str, object]:
    resp = client.post(
        f"/api/v1/bundles/{bundle_id}/files",
        json={
            "storage_root_id": root_id,
            "relative_path": rel,
            "role": role,
            "media_kind": kind,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_full_bundle_acceptance_flow(client: TestClient, tmp_path: Path) -> None:
    media = _make_media_tree(tmp_path)
    root_id = _create_root(client, media)

    bundle_id = client.post("/api/v1/bundles", json={}).json()["id"]

    # Link a cover, two video parts, and a subtitle — one bundle, many files.
    cover = _link(client, bundle_id, root_id, "movie/cover.jpg", "cover", "image")
    primary = _link(client, bundle_id, root_id, "movie/part1.mp4", "primary_video", "video")
    _link(client, bundle_id, root_id, "movie/part2.mp4", "video_part", "video")
    _link(client, bundle_id, root_id, "movie/movie.srt", "subtitle", "subtitle")

    files = client.get(f"/api/v1/bundles/{bundle_id}/files").json()
    assert len(files) == 4

    # Shared metadata + cover/primary selection (set once at bundle level).
    patched = client.patch(
        f"/api/v1/bundles/{bundle_id}",
        json={
            "title": "My Movie",
            "note": "great",
            "rating": 4,
            "cover_file_id": cover["id"],
            "primary_file_id": primary["id"],
        },
    ).json()
    assert patched["title"] == "My Movie"
    assert patched["rating"] == 4
    assert patched["cover_file_id"] == cover["id"]
    assert patched["primary_file_id"] == primary["id"]

    # Hierarchical tags across multiple groups.
    genre = client.post("/api/v1/tags", json={"name": "genre"}).json()
    thriller = client.post(
        "/api/v1/tags", json={"name": "thriller", "parent_id": genre["id"]}
    ).json()
    tags_resp = client.put(
        f"/api/v1/bundles/{bundle_id}/tags", json={"ids": [genre["id"], thriller["id"]]}
    )
    assert set(tags_resp.json()["tag_ids"]) == {genre["id"], thriller["id"]}

    # Multiple hierarchical folders.
    f_root = client.post("/api/v1/folders", json={"name": "Films"}).json()
    f_sub = client.post("/api/v1/folders", json={"name": "2026", "parent_id": f_root["id"]}).json()
    folders_resp = client.put(
        f"/api/v1/bundles/{bundle_id}/folders", json={"ids": [f_root["id"], f_sub["id"]]}
    )
    assert set(folders_resp.json()["folder_ids"]) == {f_root["id"], f_sub["id"]}

    # --- metadata-only guarantees ---
    # Unlink a file: row gone, physical file still present.
    part2_id = next(f["id"] for f in files if f["relative_path"] == "movie/part2.mp4")
    assert client.delete(f"/api/v1/bundles/{bundle_id}/files/{part2_id}").status_code == 204
    assert (media / "movie" / "part2.mp4").read_text() == "video-2"
    assert len(client.get(f"/api/v1/bundles/{bundle_id}/files").json()) == 3

    # Delete the bundle: every physical file remains on disk.
    assert client.delete(f"/api/v1/bundles/{bundle_id}").status_code == 204
    assert client.get(f"/api/v1/bundles/{bundle_id}").status_code == 404
    for name in ("part1.mp4", "part2.mp4", "cover.jpg", "movie.srt"):
        assert (media / "movie" / name).exists()


def test_add_file_rejects_path_traversal(client: TestClient, tmp_path: Path) -> None:
    root_id = _create_root(client, _make_media_tree(tmp_path))
    bundle_id = client.post("/api/v1/bundles", json={}).json()["id"]
    resp = client.post(
        f"/api/v1/bundles/{bundle_id}/files",
        json={
            "storage_root_id": root_id,
            "relative_path": "../../etc/passwd",
            "role": "attachment",
            "media_kind": "other",
        },
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "validation_error"


def test_add_file_rejects_duplicate_link(client: TestClient, tmp_path: Path) -> None:
    root_id = _create_root(client, _make_media_tree(tmp_path))
    bundle_id = client.post("/api/v1/bundles", json={}).json()["id"]
    _link(client, bundle_id, root_id, "movie/part1.mp4", "primary_video", "video")
    dup = client.post(
        f"/api/v1/bundles/{bundle_id}/files",
        json={
            "storage_root_id": root_id,
            "relative_path": "movie/part1.mp4",
            "role": "video_part",
            "media_kind": "video",
        },
    )
    assert dup.status_code == 409


def test_cover_must_belong_to_bundle(client: TestClient, tmp_path: Path) -> None:
    root_id = _create_root(client, _make_media_tree(tmp_path))
    bundle_a = client.post("/api/v1/bundles", json={}).json()["id"]
    bundle_b = client.post("/api/v1/bundles", json={}).json()["id"]
    foreign = _link(client, bundle_b, root_id, "movie/cover.jpg", "cover", "image")

    resp = client.patch(f"/api/v1/bundles/{bundle_a}", json={"cover_file_id": foreign["id"]})
    assert resp.status_code == 422


def test_rating_out_of_range_rejected_by_schema(client: TestClient) -> None:
    bundle_id = client.post("/api/v1/bundles", json={}).json()["id"]
    resp = client.patch(f"/api/v1/bundles/{bundle_id}", json={"rating": 9})
    assert resp.status_code == 422


def test_set_tags_rejects_unknown_id(client: TestClient) -> None:
    bundle_id = client.post("/api/v1/bundles", json={}).json()["id"]
    resp = client.put(f"/api/v1/bundles/{bundle_id}/tags", json={"ids": ["nope"]})
    assert resp.status_code == 422
