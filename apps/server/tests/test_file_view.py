"""Read-only File View: listing, hidden files, traversal/symlink safety, links."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.domain.enums import FileRole, MediaKind
from cairndex.services import bundles as bundle_service
from cairndex.services import file_view as service


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
    assert by_name["notes.txt"].linked is False


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
