"""Asset-bundle acceptance tests (library-scoped, ADR-0008).

Verifies the bundle is metadata-only and non-destructive: linking/unlinking
files and deleting bundles never touches files on disk, while shared metadata,
multi-file bundles, hierarchical tags/collections, and cover/primary selection
all work.
"""

from pathlib import Path

from fastapi.testclient import TestClient


def _make_media_tree(library_root: Path) -> None:
    movie = library_root / "movie"
    movie.mkdir(parents=True)
    (movie / "part1.mp4").write_text("video-1")
    (movie / "part2.mp4").write_text("video-2")
    (movie / "cover.jpg").write_text("cover")
    (movie / "movie.srt").write_text("subtitles")


def _link(
    client: TestClient, base: str, bundle_id: str, rel: str, role: str, kind: str
) -> dict[str, object]:
    resp = client.post(
        f"{base}/bundles/{bundle_id}/files",
        json={"relative_path": rel, "role": role, "media_kind": kind},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_full_bundle_acceptance_flow(
    client: TestClient, library_id: str, library_root: Path
) -> None:
    _make_media_tree(library_root)
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]

    cover = _link(client, base, bundle_id, "movie/cover.jpg", "cover", "image")
    primary = _link(client, base, bundle_id, "movie/part1.mp4", "primary_video", "video")
    _link(client, base, bundle_id, "movie/part2.mp4", "video_part", "video")
    _link(client, base, bundle_id, "movie/movie.srt", "subtitle", "subtitle")

    files = client.get(f"{base}/bundles/{bundle_id}/files").json()
    assert len(files) == 4

    patched = client.patch(
        f"{base}/bundles/{bundle_id}",
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

    genre = client.post(f"{base}/tags", json={"name": "genre"}).json()
    thriller = client.post(
        f"{base}/tags", json={"name": "thriller", "parent_id": genre["id"]}
    ).json()
    tags_resp = client.put(
        f"{base}/bundles/{bundle_id}/tags", json={"ids": [genre["id"], thriller["id"]]}
    )
    assert set(tags_resp.json()["tag_ids"]) == {genre["id"], thriller["id"]}

    c_root = client.post(f"{base}/collections", json={"name": "Films"}).json()
    c_sub = client.post(
        f"{base}/collections", json={"name": "2026", "parent_id": c_root["id"]}
    ).json()
    collections_resp = client.put(
        f"{base}/bundles/{bundle_id}/collections", json={"ids": [c_root["id"], c_sub["id"]]}
    )
    assert set(collections_resp.json()["collection_ids"]) == {c_root["id"], c_sub["id"]}

    # --- metadata-only guarantees ---
    part2_id = next(f["id"] for f in files if f["relative_path"] == "movie/part2.mp4")
    assert client.delete(f"{base}/bundles/{bundle_id}/files/{part2_id}").status_code == 204
    assert (library_root / "movie" / "part2.mp4").read_text() == "video-2"
    assert len(client.get(f"{base}/bundles/{bundle_id}/files").json()) == 3

    assert client.delete(f"{base}/bundles/{bundle_id}").status_code == 204
    assert client.get(f"{base}/bundles/{bundle_id}").status_code == 404
    for name in ("part1.mp4", "part2.mp4", "cover.jpg", "movie.srt"):
        assert (library_root / "movie" / name).exists()


def test_add_file_rejects_path_traversal(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    resp = client.post(
        f"{base}/bundles/{bundle_id}/files",
        json={"relative_path": "../../etc/passwd", "role": "attachment", "media_kind": "other"},
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "validation_error"


def test_add_file_rejects_duplicate_link(
    client: TestClient, library_id: str, library_root: Path
) -> None:
    _make_media_tree(library_root)
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    _link(client, base, bundle_id, "movie/part1.mp4", "primary_video", "video")
    dup = client.post(
        f"{base}/bundles/{bundle_id}/files",
        json={"relative_path": "movie/part1.mp4", "role": "video_part", "media_kind": "video"},
    )
    assert dup.status_code == 409


def test_cover_must_belong_to_bundle(
    client: TestClient, library_id: str, library_root: Path
) -> None:
    _make_media_tree(library_root)
    base = f"/api/v1/libraries/{library_id}"
    bundle_a = client.post(f"{base}/bundles", json={}).json()["id"]
    bundle_b = client.post(f"{base}/bundles", json={}).json()["id"]
    foreign = _link(client, base, bundle_b, "movie/cover.jpg", "cover", "image")

    resp = client.patch(f"{base}/bundles/{bundle_a}", json={"cover_file_id": foreign["id"]})
    assert resp.status_code == 422


def test_rating_out_of_range_rejected_by_schema(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    resp = client.patch(f"{base}/bundles/{bundle_id}", json={"rating": 9})
    assert resp.status_code == 422


def test_set_tags_rejects_unknown_id(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    resp = client.put(f"{base}/bundles/{bundle_id}/tags", json={"ids": ["nope"]})
    assert resp.status_code == 422
