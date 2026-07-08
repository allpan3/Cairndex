"""Read-only File View: listing, hidden files, traversal/symlink safety, links."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.domain.enums import (
    FileRole,
    GroupingSource,
    GroupingState,
    MediaKind,
)
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.services import bundles as bundle_service
from cairndex.services import file_view as service


def _stage_unbundled(session: Session, relative_path: str) -> AssetFile:
    """Link a path into a scan-staged provisional (unbundled) one-file bundle."""
    name = relative_path.rsplit("/", 1)[-1]
    bundle = AssetBundle(
        title=name.rsplit(".", 1)[0],
        grouping_state=GroupingState.PROVISIONAL,
        grouping_source=GroupingSource.SCAN_SUGGESTION,
    )
    session.add(bundle)
    session.flush()
    row = AssetFile(
        bundle_id=bundle.id,
        relative_path=relative_path,
        original_filename=name,
        display_title=name,
        role=FileRole.OTHER,
        media_kind=MediaKind.VIDEO,
        size_bytes=10,
    )
    session.add(row)
    session.flush()
    return row


def _make_media(root: Path) -> None:
    (root / "Show" / "S01").mkdir(parents=True)
    (root / "Show" / "S01" / "ep1.mkv").write_text("video")
    (root / "Show" / "cover.jpg").write_text("poster")
    (root / "Show" / "notes.txt").write_text("unsupported but visible")
    (root / "Show" / ".hidden.mkv").write_text("dotfile")
    (root / "Show" / ".git").mkdir()
    (root / "Show" / "__pycache__").mkdir()
    (root / "top.mp4").write_text("toplevel")


def test_root_listing_dirs_first_and_hides_hidden(session: Session, library_root: Path) -> None:
    _make_media(library_root)
    listing = service.list_entries(session)

    assert listing.path == ""
    names = [e.name for e in listing.entries]
    # Directory "Show" before file "top.mp4"; the .cairndex marker is hidden.
    assert names == ["Show", "top.mp4"]
    assert listing.entries[0].kind == "directory"
    assert listing.entries[1].kind == "file"


def test_entries_carry_created_and_modified_times(session: Session, library_root: Path) -> None:
    _make_media(library_root)
    by_name = {e.name: e for e in service.list_entries(session).entries}
    top = by_name["top.mp4"]
    # A real on-disk file reports both a creation ("date added") and a modified
    # time; the field exists and is distinct from modified_at's type/None-ness.
    assert top.created_at is not None
    assert top.modified_at is not None


def test_nested_listing_excludes_hidden_and_marks_support(
    session: Session, library_root: Path
) -> None:
    _make_media(library_root)
    listing = service.list_entries(session, path="Show")

    by_name = {e.name: e for e in listing.entries}
    assert ".hidden.mkv" not in by_name
    assert ".git" not in by_name
    assert "__pycache__" not in by_name
    assert by_name["cover.jpg"].supported is True
    assert by_name["cover.jpg"].media_kind == "image"
    assert by_name["notes.txt"].supported is False
    assert by_name["notes.txt"].media_kind is None
    assert listing.entries[0].name == "S01"


def test_preview_capable_images_are_openable(session: Session, library_root: Path) -> None:
    (library_root / "Show").mkdir()
    (library_root / "Show" / "still.heic").write_text("synthetic")
    (library_root / "Show" / "scan.tiff").write_text("synthetic")
    listing = service.list_entries(session, path="Show")

    by_name = {e.name: e for e in listing.entries}
    assert by_name["still.heic"].supported is True
    assert by_name["scan.tiff"].supported is True


def test_linked_file_is_flagged(session: Session, library_root: Path) -> None:
    _make_media(library_root)
    bundle = bundle_service.create_bundle(session, title="b")
    bundle_service.add_file(
        session,
        bundle.id,
        relative_path="Show/cover.jpg",
        role=FileRole.COVER,
        media_kind=MediaKind.IMAGE,
    )
    session.commit()

    by_name = {e.name: e for e in service.list_entries(session, path="Show").entries}
    assert by_name["cover.jpg"].linked is True
    assert by_name["cover.jpg"].bundle_id == bundle.id
    # Linked into a *confirmed* bundle → not unbundled.
    assert by_name["cover.jpg"].unbundled is False
    assert by_name["notes.txt"].linked is False
    assert by_name["notes.txt"].unbundled is False


def test_unbundled_flag_tracks_provisional_bundles(session: Session, library_root: Path) -> None:
    _make_media(library_root)
    # ep1.mkv staged as a provisional (unbundled) file; cover.jpg confirmed.
    _stage_unbundled(session, "Show/S01/ep1.mkv")
    confirmed = bundle_service.create_bundle(session, title="c")
    bundle_service.add_file(
        session,
        confirmed.id,
        relative_path="Show/cover.jpg",
        role=FileRole.COVER,
        media_kind=MediaKind.IMAGE,
    )
    session.commit()

    s01 = {e.name: e for e in service.list_entries(session, path="Show/S01").entries}
    assert s01["ep1.mkv"].linked is True and s01["ep1.mkv"].unbundled is True

    show = {e.name: e for e in service.list_entries(session, path="Show").entries}
    assert show["cover.jpg"].linked is True and show["cover.jpg"].unbundled is False
    assert show["notes.txt"].unbundled is False  # unlinked


def test_list_unbundled_files_flat(session: Session, library_root: Path) -> None:
    _stage_unbundled(session, "movie/feature.mp4")
    _stage_unbundled(session, "photos/sunset.jpg")
    # A confirmed file must not appear in the unbundled queue.
    confirmed = bundle_service.create_bundle(session, title="real")
    bundle_service.add_file(
        session,
        confirmed.id,
        relative_path="movie/other.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    session.commit()

    page = service.list_unbundled_files(session)
    assert page.total == 2
    paths = [e.relative_path for e in page.items]
    assert paths == ["movie/feature.mp4", "photos/sunset.jpg"]  # sorted by path
    feature = page.items[0]
    assert feature.kind == "file" and feature.linked is True and feature.unbundled is True
    assert feature.supported is True and feature.media_kind == "video"


def test_traversal_and_absolute_paths_rejected(session: Session, library_root: Path) -> None:
    with pytest.raises(ValidationError):
        service.list_entries(session, path="../secrets")
    with pytest.raises(ValidationError):
        service.list_entries(session, path="/etc")


def test_symlink_escape_is_excluded(session: Session, library_root: Path, tmp_path: Path) -> None:
    _make_media(library_root)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.mp4").write_text("nope")
    (library_root / "escape").symlink_to(outside, target_is_directory=True)

    names = [e.name for e in service.list_entries(session).entries]
    assert "escape" not in names


def test_missing_path_and_non_directory(session: Session, library_root: Path) -> None:
    _make_media(library_root)
    with pytest.raises(NotFoundError):
        service.list_entries(session, path="nope")
    with pytest.raises(ValidationError):
        service.list_entries(session, path="top.mp4")  # a file, not a dir


def test_entries_endpoint(client: TestClient, library_id: str, library_root: Path) -> None:
    _make_media(library_root)
    base = f"/api/v1/libraries/{library_id}"
    r = client.get(f"{base}/file-view/entries", params={"path": "Show"})
    assert r.status_code == 200
    body = r.json()
    assert body["path"] == "Show"
    names = [e["name"] for e in body["entries"]]
    assert "cover.jpg" in names and ".hidden.mkv" not in names

    bad = client.get(f"{base}/file-view/entries", params={"path": "../x"})
    assert bad.status_code in (400, 422)


def test_resolve_entry_path(session: Session, library_root: Path) -> None:
    _make_media(library_root)
    resolved = service.resolve_entry_path(session, "Show/S01/ep1.mkv")
    assert resolved == (library_root / "Show" / "S01" / "ep1.mkv").resolve()

    with pytest.raises(ValidationError):
        service.resolve_entry_path(session, "Show")  # a directory, not a file
    with pytest.raises(ValidationError):
        service.resolve_entry_path(session, "../secrets")  # traversal
    with pytest.raises(NotFoundError):
        service.resolve_entry_path(session, "Show/missing.mkv")


def test_file_content_endpoint(client: TestClient, library_id: str, library_root: Path) -> None:
    _make_media(library_root)
    base = f"/api/v1/libraries/{library_id}"
    r = client.get(f"{base}/file", params={"path": "top.mp4"})
    assert r.status_code == 200
    assert r.content == b"toplevel"

    assert client.get(f"{base}/file", params={"path": "Show"}).status_code in (400, 422)
    assert client.get(f"{base}/file", params={"path": "../etc"}).status_code in (400, 422)
