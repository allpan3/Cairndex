"""Keeping a folder member correct as the library changes (plan 6 S4).

Covers the three things §4 worried about after the feature works at all: a
bundle that is nothing but a folder still having a cover, the scanner growing a
folder without flattening it, and a renamed folder repairing rather than
stranding its row.
"""

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.file_ops import gate
from cairndex.media.thumbnails import effective_cover_file
from cairndex.persistence.models import AssetBundle, AssetFile, BundleDirectoryMember
from cairndex.scanning.scanner import scan_library
from cairndex.services import directory_members


def _album(root: Path, directory: str = "album", count: int = 3) -> None:
    folder = root / directory
    folder.mkdir(parents=True, exist_ok=True)
    for index in range(count):
        (folder / f"shot{index}.jpg").write_bytes(b"\xff\xd8\xff\xd9")


def _link(client: TestClient, base: str, bundle_id: str, rel: str) -> dict[str, object]:
    resp = client.post(
        f"{base}/bundles/{bundle_id}/files",
        json={"relative_path": rel, "role": "image", "media_kind": "image"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_a_bundle_that_is_only_a_folder_still_has_a_cover(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """Plan 6 §4.3 feared a blank card, and proposed reading the first image off
    disk. Nothing to build: the existing cover fallback already walks the
    bundle's own files, and a collapsed folder's files are still its files.

    Pinned here because that is only true while collapsing stays a *drawing*
    decision. The day something filters the covered files out of the bundle's
    file list, this is the test that says a folder-only bundle went blank.
    """
    _album(library_root, "album", 3)
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    for index in range(3):
        _link(client, base, bundle_id, f"album/shot{index}.jpg")
    collapsed = client.post(
        f"{base}/bundles/{bundle_id}/directory-members", json={"directory_path": "album"}
    )
    assert collapsed.status_code == 201, collapsed.text

    session.expire_all()
    bundle = session.get(AssetBundle, bundle_id)
    assert bundle is not None
    bundle.cover_file_id = None  # nothing was ever chosen
    session.flush()

    cover = effective_cover_file(session, bundle_id)
    assert cover is not None
    assert cover.relative_path.startswith("album/")


def test_a_file_dropped_into_a_folder_joins_its_bundle(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """What keeps the feature worth having: an album stays one row as it grows,
    instead of sprouting a provisional bundle per photo added."""
    _album(library_root, "album", 3)
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    for index in range(3):
        _link(client, base, bundle_id, f"album/shot{index}.jpg")
    client.post(f"{base}/bundles/{bundle_id}/directory-members", json={"directory_path": "album"})

    (library_root / "album" / "shot9.jpg").write_bytes(b"\xff\xd8\xff\xd9")
    (library_root / "loose.jpg").write_bytes(b"\xff\xd8\xff\xd9")
    summary = scan_library(session, library_root)
    session.flush()

    assert summary.joined_folders == 1
    joined = session.query(AssetFile).filter_by(relative_path="album/shot9.jpg").one()
    assert joined.bundle_id == bundle_id
    # A file outside the folder is staged for review exactly as before.
    loose = session.query(AssetFile).filter_by(relative_path="loose.jpg").one()
    assert loose.bundle_id != bundle_id
    members = session.query(BundleDirectoryMember).all()
    assert [m.directory_path for m in members] == ["album"]
    assert directory_members.file_counts(session, bundle_id) == {members[0].id: 4}


def test_renaming_a_folder_moves_its_row_with_it(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """Move repair rewrites the files; without this the row still names a
    directory that no longer exists, and the album silently un-collapses."""
    _album(library_root, "album", 3)
    nested = library_root / "album" / "raw"
    nested.mkdir()
    # A recognised extension: an unclassified one is never indexed, so it would
    # not be in the bundle and could not exercise the nesting at all.
    (nested / "shot0.tif").write_bytes(b"II*\x00")
    base = f"/api/v1/libraries/{library_id}"
    scan_library(session, library_root)
    session.commit()

    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    for row in session.query(AssetFile).filter(AssetFile.relative_path.like("album/%")).all():
        row.bundle_id = bundle_id
    session.commit()
    collapsed = client.post(
        f"{base}/bundles/{bundle_id}/directory-members", json={"directory_path": "album"}
    )
    assert collapsed.status_code == 201, collapsed.text

    (library_root / "album").rename(library_root / "trip")
    scan_library(session, library_root)
    session.flush()

    members = session.query(BundleDirectoryMember).all()
    # The nested file votes for the folder's new location, not its own parent's.
    assert [m.directory_path for m in members] == ["trip"]
    assert directory_members.file_counts(session, bundle_id) == {members[0].id: 4}


def test_a_folder_scattered_by_a_move_drops_its_row(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """A folder whose files went to different places is not a folder anymore.
    Dropping the row lists the files individually, which is visible and
    harmless — better than a row pointing at nothing."""
    _album(library_root, "album", 3)
    base = f"/api/v1/libraries/{library_id}"
    scan_library(session, library_root)
    session.commit()
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    for row in session.query(AssetFile).filter(AssetFile.relative_path.like("album/%")).all():
        row.bundle_id = bundle_id
    session.commit()
    client.post(f"{base}/bundles/{bundle_id}/directory-members", json={"directory_path": "album"})

    for index, destination in enumerate(["one", "two", "three"]):
        (library_root / destination).mkdir()
        (library_root / "album" / f"shot{index}.jpg").rename(
            library_root / destination / f"shot{index}.jpg"
        )
    scan_library(session, library_root)
    session.flush()

    assert session.query(BundleDirectoryMember).count() == 0
    # The files are still the bundle's; only the row that drew them as one is gone.
    assert session.query(AssetFile).filter_by(bundle_id=bundle_id).count() == 3


def test_a_nested_file_alone_says_where_its_folder_went() -> None:
    """The suffix rule, pinned directly.

    A file two levels down inside a renamed folder must vote for the *folder's*
    new location, not its own parent's — otherwise the row follows the subfolder
    and names something a level too deep.
    """
    from cairndex.services.directory_members import repair_after_moves

    class _Recorder:
        """Enough Session surface for the pure path arithmetic under test."""

        def __init__(self, members: list[BundleDirectoryMember]) -> None:
            self._members = members
            self.deleted: list[BundleDirectoryMember] = []

        def scalars(self, _statement: object) -> list[BundleDirectoryMember]:
            return self._members

        def delete(self, member: BundleDirectoryMember) -> None:
            self.deleted.append(member)

        def flush(self) -> None:
            return None

    member = BundleDirectoryMember(id="m1", bundle_id="b1", directory_path="album", sequence=0)
    session = _Recorder([member])
    repair_after_moves(session, [("album/raw/deep/shot0.tif", "trip/raw/deep/shot0.tif")])  # type: ignore[arg-type]

    assert session.deleted == []
    assert member.directory_path == "trip"


def test_trashing_a_folders_bundle_keeps_the_row_and_restores_it(
    client: TestClient,
    library_id: str,
    library_root: Path,
    session: Session,
    registry_session: Session,
) -> None:
    """Trash and Put back already work over a folder member, unchanged.

    Trashing repoints file rows into ``.cairndex/trash/`` and deliberately keeps
    the bundle, which is what makes Put back whole (see ``delete-with-files``).
    A folder row is bundle-scoped state, so it survives with the bundle and is
    correct again the moment the files return — nothing about the folder had to
    know about the trash.

    Recorded as a test rather than a change: plan 6 §4.6 wants the *whole folder*
    moved in one journaled rename instead of one per file, which is an
    optimisation to how ADR-0013 journals, not a correctness gap. That belongs in
    its own slice.
    """
    gate.set_write_mode(registry_session, library_id, enabled=True)
    registry_session.commit()
    _album(library_root, "album", 3)
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    for index in range(3):
        _link(client, base, bundle_id, f"album/shot{index}.jpg")
    member_id = client.post(
        f"{base}/bundles/{bundle_id}/directory-members", json={"directory_path": "album"}
    ).json()["id"]

    trashed = client.post(f"{base}/bundles/{bundle_id}/delete-with-files")
    assert trashed.status_code == 200, trashed.text
    operation_id = trashed.json()["operation"]["id"]

    session.expire_all()
    # The row is still there, now standing for nothing visible — which is why
    # ``file_counts`` has to answer for a folder with everything trashed.
    assert directory_members.file_counts(session, bundle_id) == {member_id: 0}

    restored = client.post(f"{base}/file-ops/{operation_id}/undo")
    assert restored.status_code == 200, restored.text
    session.expire_all()
    assert directory_members.file_counts(session, bundle_id) == {member_id: 3}


def test_a_folder_row_goes_when_its_last_file_leaves_the_bundle(
    client: TestClient, library_id: str, library_root: Path, session: Session
) -> None:
    """A folder row stands for files. Once none of them are the bundle's any
    more it stands for nothing, and would render as "Folder · 0 files" with no
    way to fill it."""
    _album(library_root, "album", 2)
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    file_ids = [_link(client, base, bundle_id, f"album/shot{i}.jpg")["id"] for i in range(2)]
    client.post(f"{base}/bundles/{bundle_id}/directory-members", json={"directory_path": "album"})

    assert client.delete(f"{base}/bundles/{bundle_id}/files/{file_ids[0]}").status_code == 204
    session.expire_all()
    # One file left: the folder still stands for something.
    assert session.query(BundleDirectoryMember).count() == 1

    assert client.delete(f"{base}/bundles/{bundle_id}/files/{file_ids[1]}").status_code == 204
    session.expire_all()
    assert session.query(BundleDirectoryMember).count() == 0


def test_trashing_every_file_keeps_the_folder_row(
    client: TestClient,
    library_id: str,
    library_root: Path,
    session: Session,
    registry_session: Session,
) -> None:
    """The counterpart, and the reason the prune counts trashed files: trashing
    keeps a file in its bundle, so Put back has to find the folder still there."""
    gate.set_write_mode(registry_session, library_id, enabled=True)
    registry_session.commit()
    _album(library_root, "album", 2)
    base = f"/api/v1/libraries/{library_id}"
    bundle_id = client.post(f"{base}/bundles", json={}).json()["id"]
    for index in range(2):
        _link(client, base, bundle_id, f"album/shot{index}.jpg")
    client.post(f"{base}/bundles/{bundle_id}/directory-members", json={"directory_path": "album"})

    assert client.post(f"{base}/bundles/{bundle_id}/delete-with-files").status_code == 200
    session.expire_all()
    assert session.query(BundleDirectoryMember).count() == 1
