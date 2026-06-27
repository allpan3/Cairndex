"""Read-only File View: listing, hidden files, traversal/symlink safety, links."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.domain.enums import FileRole, MediaKind
from cairndex.services import bundles as bundle_service
from cairndex.services import file_view as service
from cairndex.services import storage_roots as root_service


def _make_root(session: Session, tmp_path: Path) -> tuple[str, Path]:
    media = tmp_path / "media"
    (media / "Show" / "S01").mkdir(parents=True)
    (media / "Show" / "S01" / "ep1.mkv").write_text("video")
    (media / "Show" / "cover.jpg").write_text("poster")
    (media / "Show" / "notes.txt").write_text("unsupported but visible")
    (media / "Show" / ".hidden.mkv").write_text("dotfile")
    (media / "Show" / ".git").mkdir()
    (media / "Show" / "__pycache__").mkdir()
    (media / "top.mp4").write_text("toplevel")
    root = root_service.create_storage_root(session, name="lib", canonical_path=str(media))
    session.commit()
    return root.id, media


def test_root_listing_dirs_first_and_hides_hidden(session: Session, tmp_path: Path) -> None:
    root_id, _ = _make_root(session, tmp_path)
    listing = service.list_entries(session, root_id)

    assert listing.path == ""
    names = [e.name for e in listing.entries]
    # Directory "Show" before file "top.mp4".
    assert names == ["Show", "top.mp4"]
    assert listing.entries[0].kind == "directory"
    assert listing.entries[1].kind == "file"


def test_nested_listing_excludes_hidden_and_marks_support(session: Session, tmp_path: Path) -> None:
    root_id, _ = _make_root(session, tmp_path)
    listing = service.list_entries(session, root_id, path="Show")

    by_name = {e.name: e for e in listing.entries}
    # Dotfiles/dot-dirs and known cruft dirs are hidden.
    assert ".hidden.mkv" not in by_name
    assert ".git" not in by_name
    assert "__pycache__" not in by_name
    # Supported media is flagged; unsupported files still appear.
    assert by_name["cover.jpg"].supported is True
    assert by_name["cover.jpg"].media_kind == "image"
    assert by_name["notes.txt"].supported is False
    assert by_name["notes.txt"].media_kind is None
    # Directories sort before files.
    assert listing.entries[0].name == "S01"


def test_linked_file_is_flagged(session: Session, tmp_path: Path) -> None:
    root_id, _ = _make_root(session, tmp_path)
    bundle = bundle_service.create_bundle(session, title="b")
    bundle_service.add_file(
        session,
        bundle.id,
        storage_root_id=root_id,
        relative_path="Show/cover.jpg",
        role=FileRole.COVER,
        media_kind=MediaKind.IMAGE,
    )
    session.commit()

    by_name = {e.name: e for e in service.list_entries(session, root_id, path="Show").entries}
    assert by_name["cover.jpg"].linked is True
    assert by_name["cover.jpg"].bundle_id == bundle.id
    assert by_name["notes.txt"].linked is False


def test_traversal_and_absolute_paths_rejected(session: Session, tmp_path: Path) -> None:
    root_id, _ = _make_root(session, tmp_path)
    with pytest.raises(ValidationError):
        service.list_entries(session, root_id, path="../secrets")
    with pytest.raises(ValidationError):
        service.list_entries(session, root_id, path="/etc")


def test_symlink_escape_is_excluded(session: Session, tmp_path: Path) -> None:
    root_id, media = _make_root(session, tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.mp4").write_text("nope")
    # A symlink inside the root that points outside it must not be listed.
    (media / "escape").symlink_to(outside, target_is_directory=True)

    names = [e.name for e in service.list_entries(session, root_id).entries]
    assert "escape" not in names


def test_missing_path_and_non_directory(session: Session, tmp_path: Path) -> None:
    root_id, _ = _make_root(session, tmp_path)
    with pytest.raises(NotFoundError):
        service.list_entries(session, root_id, path="nope")
    with pytest.raises(ValidationError):
        service.list_entries(session, root_id, path="top.mp4")  # a file, not a dir


def test_entries_endpoint(client: TestClient, session: Session, tmp_path: Path) -> None:
    root_id, _ = _make_root(session, tmp_path)
    r = client.get(f"/api/v1/storage-roots/{root_id}/entries", params={"path": "Show"})
    assert r.status_code == 200
    body = r.json()
    assert body["path"] == "Show"
    names = [e["name"] for e in body["entries"]]
    assert "cover.jpg" in names and ".hidden.mkv" not in names

    # Traversal is a 4xx, not a listing.
    bad = client.get(f"/api/v1/storage-roots/{root_id}/entries", params={"path": "../x"})
    assert bad.status_code == 422 or bad.status_code == 400
