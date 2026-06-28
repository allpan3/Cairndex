from pathlib import Path

import pytest
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.domain.enums import StorageRootStatus
from cairndex.services import storage_roots as service


def test_create_requires_absolute_path(session: Session) -> None:
    with pytest.raises(ValidationError):
        service.create_storage_root(session, name="rel", canonical_path="relative/dir")


def test_create_if_missing_makes_the_directory(session: Session, tmp_path: Path) -> None:
    target = tmp_path / "new" / "library"
    assert not target.exists()
    root = service.create_storage_root(
        session, name="lib", canonical_path=str(target), create_if_missing=True
    )
    assert target.is_dir()
    assert root.status == StorageRootStatus.AVAILABLE


def test_create_without_create_if_missing_stays_unavailable(
    session: Session, tmp_path: Path
) -> None:
    target = tmp_path / "absent"
    root = service.create_storage_root(session, name="lib", canonical_path=str(target))
    assert not target.exists()
    assert root.status == StorageRootStatus.UNAVAILABLE


def test_suggest_paths_lists_child_directories(tmp_path: Path) -> None:
    (tmp_path / "Movies").mkdir()
    (tmp_path / "Music").mkdir()
    (tmp_path / "readme.txt").write_text("x")  # files are not suggested
    (tmp_path / ".hidden").mkdir()  # dotfiles are skipped

    # Trailing slash => list children of the directory.
    children = service.suggest_paths(f"{tmp_path}/")
    names = {Path(p).name for p in children}
    assert names == {"Movies", "Music"}

    # A partial basename filters by prefix.
    filtered = service.suggest_paths(str(tmp_path / "Mov"))
    assert [Path(p).name for p in filtered] == ["Movies"]


def test_suggest_paths_relative_or_unreadable_is_safe() -> None:
    # A non-absolute prefix falls back to the filesystem root (never crashes).
    assert isinstance(service.suggest_paths("not/absolute"), list)
    assert service.suggest_paths("/this/does/not/exist/anywhere") == []


def test_create_normalizes_path_and_probes_status(session: Session, tmp_path: Path) -> None:
    media = tmp_path / "media"
    media.mkdir()
    # A path with redundant segments is normalized; an existing dir => available.
    root = service.create_storage_root(
        session, name="media", canonical_path=str(media / "." / "sub" / "..")
    )
    assert root.canonical_path == media.resolve().as_posix()
    assert root.status == StorageRootStatus.AVAILABLE


def test_create_marks_missing_path_unavailable(session: Session, tmp_path: Path) -> None:
    root = service.create_storage_root(
        session, name="nas", canonical_path=str(tmp_path / "not-mounted")
    )
    assert root.status == StorageRootStatus.UNAVAILABLE


def test_duplicate_name_conflicts(session: Session, tmp_path: Path) -> None:
    service.create_storage_root(session, name="dup", canonical_path=str(tmp_path))
    with pytest.raises(ConflictError):
        service.create_storage_root(session, name="dup", canonical_path=str(tmp_path))


def test_get_unknown_raises_not_found(session: Session) -> None:
    with pytest.raises(NotFoundError):
        service.get_storage_root(session, "does-not-exist")


def test_update_changes_fields(session: Session, tmp_path: Path) -> None:
    root = service.create_storage_root(session, name="a", canonical_path=str(tmp_path))
    updated = service.update_storage_root(session, root.id, name="b", read_only=False)
    assert updated.name == "b"
    assert updated.read_only is False
