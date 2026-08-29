"""Directory members — a folder standing in for its files as one bundle row.

Plan 6 S1: the storage and the two operations, with no UI yet. The property
these tests exist to pin down is that collapsing and expanding are *lossless* —
the feature stores which directories are entities and never their contents, so
neither direction may touch a file row, an id, a rating, or an order.
"""

from pathlib import Path

from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileAvailability
from cairndex.persistence.models import AssetBundle, AssetFile, BundleDirectoryMember
from cairndex.services import directory_members


def _album(library_root: Path, name: str = "album", count: int = 3) -> None:
    folder = library_root / name
    folder.mkdir(parents=True, exist_ok=True)
    for index in range(count):
        (folder / f"shot{index}.jpg").write_text(f"image-{index}")


def _link(client: TestClient, base: str, bundle_id: str, rel: str) -> dict[str, object]:
    resp = client.post(
        f"{base}/bundles/{bundle_id}/files",
        json={"relative_path": rel, "role": "image", "media_kind": "image"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _collapse(client: TestClient, base: str, bundle_id: str, path: str) -> Response:
    return client.post(
        f"{base}/bundles/{bundle_id}/directory-members", json={"directory_path": path}
    )


def test_collapse_then_expand_leaves_every_file_untouched(
    client: TestClient, library_id: str, library_root: Path
) -> None:
    """The round trip is the whole safety argument: nothing is stored, so nothing
    can be lost."""
    _album(library_root)
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    for index in range(3):
        _link(client, base, bundle_id, f"album/shot{index}.jpg")

    before = client.get(f"{base}/bundles/{bundle_id}/files").json()
    assert len(before) == 3

    created = _collapse(client, base, bundle_id, "album")
    assert created.status_code == 201, created.text
    member = created.json()
    assert member["directory_path"] == "album"
    assert member["name"] == "album"
    assert member["file_count"] == 3

    # Collapsing is a drawing decision, not a membership one: the files are still
    # exactly the bundle's files while the folder row exists.
    during = client.get(f"{base}/bundles/{bundle_id}/files").json()
    assert [f["id"] for f in during] == [f["id"] for f in before]

    removed = client.delete(f"{base}/bundles/{bundle_id}/directory-members/{member['id']}")
    assert removed.status_code == 204
    assert client.get(f"{base}/bundles/{bundle_id}/directory-members").json() == []

    after = client.get(f"{base}/bundles/{bundle_id}/files").json()
    assert [f["id"] for f in after] == [f["id"] for f in before]
    assert [f["sequence"] for f in after] == [f["sequence"] for f in before]


def test_folder_row_covers_the_whole_subtree(
    client: TestClient, library_id: str, library_root: Path
) -> None:
    """A folder member stands for the folder, subfolders included — otherwise a
    nested album leaves its files loose in the bundle, which is the problem this
    exists to solve."""
    _album(library_root, "album", count=2)
    nested = library_root / "album" / "raw"
    nested.mkdir()
    (nested / "shot0.dng").write_text("raw-0")

    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    for index in range(2):
        _link(client, base, bundle_id, f"album/shot{index}.jpg")
    _link(client, base, bundle_id, "album/raw/shot0.dng")

    member = _collapse(client, base, bundle_id, "album").json()
    assert member["file_count"] == 3


def test_count_is_this_bundles_files_not_the_folders(
    client: TestClient, library_id: str, library_root: Path
) -> None:
    """Plan 6 §4.2: a folder row is a member of one bundle and can only speak for
    that bundle's files. A sibling filed elsewhere keeps its own row."""
    _album(library_root, "album", count=3)
    base = f"/api/v1/libraries/{library_id}"
    mine = client.post(f"{base}/bundles", json={}).json()["id"]
    theirs = client.post(f"{base}/bundles", json={}).json()["id"]
    _link(client, base, mine, "album/shot0.jpg")
    _link(client, base, mine, "album/shot1.jpg")
    _link(client, base, theirs, "album/shot2.jpg")

    member = _collapse(client, base, mine, "album").json()
    assert member["file_count"] == 2

    other_files = client.get(f"{base}/bundles/{theirs}/files").json()
    assert [f["relative_path"] for f in other_files] == ["album/shot2.jpg"]


def test_a_folder_that_holds_none_of_the_bundles_files_is_refused(
    client: TestClient, library_id: str, library_root: Path
) -> None:
    _album(library_root, "album")
    (library_root / "elsewhere").mkdir()
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    _link(client, base, bundle_id, "album/shot0.jpg")

    assert _collapse(client, base, bundle_id, "elsewhere").status_code == 422


def test_nesting_is_refused_in_both_directions(
    client: TestClient, library_id: str, library_root: Path
) -> None:
    """The unique constraint only stops the same directory twice; a parent or a
    child is a different string. Plan 6 §5.1 leaves nesting open, and refusing is
    the answer that can be relaxed later without a migration."""
    _album(library_root, "album", count=1)
    nested = library_root / "album" / "raw"
    nested.mkdir()
    (nested / "shot0.dng").write_text("raw-0")

    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    _link(client, base, bundle_id, "album/shot0.jpg")
    _link(client, base, bundle_id, "album/raw/shot0.dng")

    assert _collapse(client, base, bundle_id, "album").status_code == 201
    assert _collapse(client, base, bundle_id, "album").status_code == 409
    assert _collapse(client, base, bundle_id, "album/raw").status_code == 409


def test_a_parent_of_an_existing_folder_row_is_refused(
    client: TestClient, library_id: str, library_root: Path
) -> None:
    nested = library_root / "album" / "raw"
    nested.mkdir(parents=True)
    (nested / "shot0.dng").write_text("raw-0")

    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    _link(client, base, bundle_id, "album/raw/shot0.dng")

    assert _collapse(client, base, bundle_id, "album/raw").status_code == 201
    assert _collapse(client, base, bundle_id, "album").status_code == 409


def test_wildcard_characters_in_a_folder_name_are_matched_literally(
    client: TestClient, library_id: str, library_root: Path
) -> None:
    """The subtree match is a range, not a LIKE, so ``%`` and ``_`` in a real
    directory name cannot widen it."""
    (library_root / "a%b").mkdir()
    (library_root / "a%b" / "shot0.jpg").write_text("in")
    (library_root / "axb").mkdir()
    (library_root / "axb" / "shot0.jpg").write_text("out")

    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    _link(client, base, bundle_id, "a%b/shot0.jpg")
    _link(client, base, bundle_id, "axb/shot0.jpg")

    member = _collapse(client, base, bundle_id, "a%b").json()
    assert member["file_count"] == 1


def test_a_sibling_sharing_a_name_prefix_is_not_swept_in(
    client: TestClient, library_id: str, library_root: Path
) -> None:
    """``album2`` is not inside ``album``, however the strings sort."""
    _album(library_root, "album", count=1)
    _album(library_root, "album2", count=1)
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    _link(client, base, bundle_id, "album/shot0.jpg")
    _link(client, base, bundle_id, "album2/shot0.jpg")

    member = _collapse(client, base, bundle_id, "album").json()
    assert member["file_count"] == 1


def test_the_folder_row_lands_where_its_contents_were(
    client: TestClient, library_id: str, library_root: Path
) -> None:
    """Collapsing must not also reorder the bundle."""
    (library_root / "poster.jpg").write_text("poster")
    _album(library_root, "album", count=2)
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    poster = _link(client, base, bundle_id, "poster.jpg")
    first = _link(client, base, bundle_id, "album/shot0.jpg")
    _link(client, base, bundle_id, "album/shot1.jpg")

    order = [poster["id"], first["id"]]
    files = client.get(f"{base}/bundles/{bundle_id}/files").json()
    reordered = client.put(
        f"{base}/bundles/{bundle_id}/files/order",
        json={"ordered_ids": order + [f["id"] for f in files if f["id"] not in order]},
    )
    assert reordered.status_code == 200

    member = _collapse(client, base, bundle_id, "album").json()
    after = client.get(f"{base}/bundles/{bundle_id}/files").json()
    by_id = {f["id"]: f["sequence"] for f in after}
    assert member["sequence"] == by_id[first["id"]]
    assert by_id[poster["id"]] < member["sequence"]


def test_client_supplied_paths_are_guarded(
    client: TestClient, library_id: str, library_root: Path
) -> None:
    _album(library_root, "album", count=1)
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    _link(client, base, bundle_id, "album/shot0.jpg")

    for hostile in ("/etc", "../outside", "album/../../outside"):
        assert _collapse(client, base, bundle_id, hostile).status_code == 422, hostile


def test_expanding_another_bundles_folder_row_is_refused(
    client: TestClient, library_id: str, library_root: Path
) -> None:
    _album(library_root, "album", count=1)
    base = f"/api/v1/libraries/{library_id}"
    mine = client.post(f"{base}/bundles", json={}).json()["id"]
    theirs = client.post(f"{base}/bundles", json={}).json()["id"]
    _link(client, base, mine, "album/shot0.jpg")
    member = _collapse(client, base, mine, "album").json()

    assert (
        client.delete(f"{base}/bundles/{theirs}/directory-members/{member['id']}").status_code
        == 404
    )


def test_deleting_the_bundle_takes_its_folder_rows(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    _album(library_root, "album", count=1)
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    _link(client, base, bundle_id, "album/shot0.jpg")
    _collapse(client, base, bundle_id, "album")

    assert client.delete(f"{base}/bundles/{bundle_id}").status_code == 204
    session.expire_all()
    assert session.get(AssetBundle, bundle_id) is None
    assert session.query(BundleDirectoryMember).count() == 0


def test_several_folders_in_one_bundle_each_get_their_own_count(
    client: TestClient, library_id: str, library_root: Path
) -> None:
    """The counts come from one grouped query; this pins that the grouping keys
    rows to the right folder rather than pooling them."""
    _album(library_root, "album", count=3)
    _album(library_root, "extras", count=1)
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    for index in range(3):
        _link(client, base, bundle_id, f"album/shot{index}.jpg")
    _link(client, base, bundle_id, "extras/shot0.jpg")

    _collapse(client, base, bundle_id, "album")
    _collapse(client, base, bundle_id, "extras")

    members = client.get(f"{base}/bundles/{bundle_id}/directory-members").json()
    assert {m["directory_path"]: m["file_count"] for m in members} == {"album": 3, "extras": 1}


def test_a_folder_whose_files_are_all_trashed_still_reports_a_count(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """A GROUP BY cannot emit a row for a folder with nothing visible left.

    Asserted against the service, not the endpoint: the route defaults a missing
    id to zero on its own, so an endpoint-level assertion passes whether or not
    the service keeps its promise. ``file_counts`` returns a count for *every*
    folder row, and this is where that is pinned.
    """
    _album(library_root, "album", count=2)
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    for index in range(2):
        _link(client, base, bundle_id, f"album/shot{index}.jpg")
    member_id = _collapse(client, base, bundle_id, "album").json()["id"]

    for asset_file in session.query(AssetFile).filter_by(bundle_id=bundle_id):
        asset_file.availability = FileAvailability.TRASHED
    session.flush()

    assert directory_members.file_counts(session, bundle_id) == {member_id: 0}
    assert client.get(f"{base}/bundles/{bundle_id}/directory-members").json()[0]["file_count"] == 0
