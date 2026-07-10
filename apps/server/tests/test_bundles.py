"""Asset-bundle acceptance tests (library-scoped, ADR-0008).

Verifies the bundle is metadata-only and non-destructive: linking/unlinking
files and deleting bundles never touches files on disk, while shared metadata,
multi-file bundles, hierarchical tags/collections, and cover/primary selection
all work.
"""

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.persistence.models import AssetBundle


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


# --- Multiple notes (freeform, ordered) --------------------------------------
def test_bundle_multiple_notes_roundtrip(client: TestClient, library_id: str) -> None:
    """A bundle carries an ordered list of freeform notes; the legacy scalar
    ``note`` mirrors them (joined) so existing readers/filters keep working."""
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]

    # Add three notes.
    r = client.patch(f"{base}/bundles/{bundle_id}", json={"notes": ["synopsis", "cast", "trivia"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["notes"] == ["synopsis", "cast", "trivia"]
    assert body["note"] == "synopsis\n\ncast\n\ntrivia"  # derived shadow

    # Edit one, remove one, reorder — a whole-list replace each time.
    edited = client.patch(
        f"{base}/bundles/{bundle_id}", json={"notes": ["trivia", "synopsis v2"]}
    ).json()
    assert edited["notes"] == ["trivia", "synopsis v2"]

    # Blank/whitespace-only blocks (an untouched draft box) are dropped.
    stripped = client.patch(
        f"{base}/bundles/{bundle_id}", json={"notes": ["keep", "", "   ", "also"]}
    ).json()
    assert stripped["notes"] == ["keep", "also"]

    # Clearing all notes empties the list and nulls the shadow.
    cleared = client.patch(f"{base}/bundles/{bundle_id}", json={"notes": []}).json()
    assert cleared["notes"] == []
    assert cleared["note"] is None


def test_create_bundle_with_notes(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    created = client.post(f"{base}/bundles", json={"notes": ["one", "two"]})
    assert created.status_code == 201, created.text
    assert created.json()["notes"] == ["one", "two"]


def test_legacy_single_note_update_maps_to_list(client: TestClient, library_id: str) -> None:
    """An old client PATCHing a single ``note`` still works and surfaces as a
    one-element ``notes`` list."""
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    r = client.patch(f"{base}/bundles/{bundle_id}", json={"note": "solo"}).json()
    assert r["notes"] == ["solo"]
    assert r["note"] == "solo"


def test_legacy_row_notes_fallback(client: TestClient, library_id: str, session: Session) -> None:
    """A row created before the ``notes`` column (``notes IS NULL``) still shows
    its single legacy note via the read fallback."""
    bundle = AssetBundle(note="written before the notes column existed")
    session.add(bundle)
    session.commit()

    base = f"/api/v1/libraries/{library_id}"
    body = client.get(f"{base}/bundles/{bundle.id}").json()
    assert body["notes"] == ["written before the notes column existed"]


def test_note_filter_matches_any_note(
    client: TestClient, library_id: str, session: Session
) -> None:
    """The ``note`` filter matches text in *any* of a bundle's notes (it runs
    against the joined shadow)."""
    base = f"/api/v1/libraries/{library_id}"
    match_id = client.post(
        f"{base}/bundles", json={"notes": ["a plain first block", "the SECRET second block"]}
    ).json()["id"]
    client.post(f"{base}/bundles", json={"notes": ["nothing to see here"]})

    flt = {"version": 1, "root": {"field": "note", "operator": "contains", "value": "secret"}}
    r = client.post(f"{base}/bundles/browse", json={"filter": flt})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["id"] == match_id


def test_notes_reject_non_string(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    r = client.patch(f"{base}/bundles/{bundle_id}", json={"notes": ["ok", 5]})
    assert r.status_code == 422
