"""Guarded rename / New Folder and the operation journal (ADR-0013, plan 4 W1).

Uses the shared ``session``/``library_root`` fixtures so operations run against
a real on-disk library package and real files — the whole point of these tests
is what happens on the filesystem, so nothing here is mocked.
"""

import asyncio
import json
import os
from collections.abc import AsyncIterator
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.config import get_settings
from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.paths import PathSafetyError
from cairndex.core.time import utcnow
from cairndex.domain.enums import (
    FileAvailability,
    FileOpStatus,
    FileOpType,
    FileRole,
    MediaKind,
)
from cairndex.file_ops import imports, journal, operations
from cairndex.file_ops.conflicts import ConflictPolicy
from cairndex.file_ops.paths import suffixed_name, validate_name
from cairndex.file_ops.reconcile import reconcile_pending
from cairndex.file_ops.trash import stored_relative_path
from cairndex.persistence.models import AssetBundle, AssetFile, FileOperation
from cairndex.scanning.scanner import _mark_missing


def _touch(root: Path, relative: str, content: bytes = b"x") -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


def _link(session: Session, relative: str, *, bundle: AssetBundle | None = None) -> AssetFile:
    """Link a path into a bundle the way a scan would, and return the row."""
    if bundle is None:
        bundle = AssetBundle(title="Bundle")
        session.add(bundle)
        session.flush()
    file = AssetFile(
        bundle_id=bundle.id,
        relative_path=relative,
        original_filename=relative.rpartition("/")[2],
        display_title=relative.rpartition("/")[2],
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    session.add(file)
    session.commit()
    return file


# --- name and path validation ------------------------------------------------
@pytest.mark.parametrize(
    "name",
    [
        "",
        "   ",
        ".",
        "..",
        ".hidden",  # File Browser hides dotfiles; creating one looks like a failure
        "a/b",
        "a\\b",
        "trailing.",
        "nul\x00byte",
        "bell\x07",
        "x" * 256,
    ],
)
def test_validate_name_rejects(name: str) -> None:
    with pytest.raises(PathSafetyError):
        validate_name(name)


def test_validate_name_accepts_ordinary_names() -> None:
    # Surrounding whitespace is trimmed rather than refused: a stray space in a
    # rename box is a typo, not something worth an error message.
    assert validate_name("  Season 1  ") == "Season 1"
    assert validate_name("épisode (2).mkv") == "épisode (2).mkv"


def test_suffixed_name_keeps_the_extension_last() -> None:
    assert suffixed_name("report.txt", 2) == "report (2).txt"
    assert suffixed_name("folder", 3) == "folder (3)"
    # Compound extensions are deliberately not special-cased; the file still opens.
    assert suffixed_name("archive.tar.gz", 2) == "archive.tar (2).gz"


@pytest.mark.parametrize("path", ["/etc/passwd", "../outside.mkv", "a/../../b", ""])
def test_rename_rejects_unsafe_sources(session: Session, library_root: Path, path: str) -> None:
    with pytest.raises(ValidationError):
        operations.rename(session, library_root, path=path, new_name="ok.mkv")


def test_rename_refuses_to_touch_the_library_package(session: Session, library_root: Path) -> None:
    """`.cairndex/` holds the manifest, the DB and the cache. A rename in there
    would corrupt the library through an ordinary-looking operation."""
    with pytest.raises(ValidationError):
        operations.rename(session, library_root, path=".cairndex/manifest.json", new_name="m.json")
    with pytest.raises(ValidationError):
        operations.make_directory(session, library_root, path=".cairndex/sneaky")


def test_rename_refuses_a_symlink_that_escapes_the_root(
    session: Session, library_root: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.mkv").write_bytes(b"x")
    (library_root / "link").symlink_to(outside)

    with pytest.raises(ValidationError):
        operations.rename(session, library_root, path="link/secret.mkv", new_name="taken.mkv")


# --- rename ------------------------------------------------------------------
def test_rename_moves_the_file_and_repoints_its_row(session: Session, library_root: Path) -> None:
    _touch(library_root, "Show/ep1.mkv")
    file = _link(session, "Show/ep1.mkv")
    original_id = file.id

    result = operations.rename(session, library_root, path="Show/ep1.mkv", new_name="Episode 1.mkv")

    assert result.path == "Show/Episode 1.mkv"
    assert result.files_updated == 1
    assert not (library_root / "Show/ep1.mkv").exists()
    assert (library_root / "Show/Episode 1.mkv").is_file()

    session.refresh(file)
    # The invariant the whole feature rests on: same row, same id, new path.
    assert file.id == original_id
    assert file.relative_path == "Show/Episode 1.mkv"
    assert file.directory_path == "Show"


def test_rename_preserves_bundle_membership_and_cover(session: Session, library_root: Path) -> None:
    _touch(library_root, "Movie/movie.mkv")
    file = _link(session, "Movie/movie.mkv")
    bundle = session.get(AssetBundle, file.bundle_id)
    assert bundle is not None
    bundle.cover_file_id = file.id
    session.commit()

    operations.rename(session, library_root, path="Movie/movie.mkv", new_name="renamed.mkv")

    session.refresh(bundle)
    assert bundle.cover_file_id == file.id
    assert [f.relative_path for f in bundle.files] == ["Movie/renamed.mkv"]


def test_renaming_a_directory_repoints_every_row_beneath_it(
    session: Session, library_root: Path
) -> None:
    _touch(library_root, "Show/S01/ep1.mkv")
    _touch(library_root, "Show/S01/ep2.mkv")
    _touch(library_root, "Show/S01 extras/behind.mkv")
    inside_a = _link(session, "Show/S01/ep1.mkv")
    inside_b = _link(session, "Show/S01/ep2.mkv")
    sibling = _link(session, "Show/S01 extras/behind.mkv")

    result = operations.rename(session, library_root, path="Show/S01", new_name="Season 1")

    assert result.files_updated == 2
    session.refresh(inside_a)
    session.refresh(inside_b)
    session.refresh(sibling)
    assert inside_a.relative_path == "Show/Season 1/ep1.mkv"
    assert inside_b.relative_path == "Show/Season 1/ep2.mkv"
    # The prefix is matched on path segments: a LIKE 'Show/S01%' rewrite would
    # have swept this sibling directory up with it.
    assert sibling.relative_path == "Show/S01 extras/behind.mkv"


def test_renaming_a_directory_treats_like_wildcards_in_its_name_as_literals(
    session: Session, library_root: Path
) -> None:
    """``_`` and ``%`` are LIKE wildcards, but in a path they are just characters.

    Without escaping, renaming ``my_show`` selects ``myxshow/…`` too (``_``
    matches any one character) and the repoint slices the bystander's path into
    garbage — a row corrupted for a file that never moved.
    """
    _touch(library_root, "my_show/ep1.mkv")
    _touch(library_root, "myxshow/other.mkv")
    _touch(library_root, "100% legit/real.mkv")
    _touch(library_root, "100 percent legit/decoy.mkv")
    inside = _link(session, "my_show/ep1.mkv")
    bystander = _link(session, "myxshow/other.mkv")
    percent_inside = _link(session, "100% legit/real.mkv")
    percent_bystander = _link(session, "100 percent legit/decoy.mkv")

    underscore = operations.rename(session, library_root, path="my_show", new_name="My Show")
    percent = operations.rename(session, library_root, path="100% legit", new_name="Legit")

    assert underscore.files_updated == 1
    assert percent.files_updated == 1
    session.refresh(inside)
    session.refresh(bystander)
    session.refresh(percent_inside)
    session.refresh(percent_bystander)
    assert inside.relative_path == "My Show/ep1.mkv"
    assert bystander.relative_path == "myxshow/other.mkv"
    assert percent_inside.relative_path == "Legit/real.mkv"
    assert percent_bystander.relative_path == "100 percent legit/decoy.mkv"


def test_rename_of_an_unlinked_file_is_still_a_rename(session: Session, library_root: Path) -> None:
    _touch(library_root, "loose.mkv")

    result = operations.rename(session, library_root, path="loose.mkv", new_name="tidy.mkv")

    assert result.files_updated == 0
    assert (library_root / "tidy.mkv").is_file()


def test_rename_to_the_same_name_does_nothing_and_says_so(
    session: Session, library_root: Path
) -> None:
    _touch(library_root, "same.mkv")

    result = operations.rename(session, library_root, path="same.mkv", new_name="same.mkv")

    assert result.path == "same.mkv"
    assert (library_root / "same.mkv").is_file()


def test_rename_of_a_missing_source_is_not_found(session: Session, library_root: Path) -> None:
    with pytest.raises(NotFoundError):
        operations.rename(session, library_root, path="ghost.mkv", new_name="x.mkv")


# --- collisions --------------------------------------------------------------
def test_collision_fails_by_default(session: Session, library_root: Path) -> None:
    _touch(library_root, "a.mkv")
    _touch(library_root, "b.mkv")

    with pytest.raises(ConflictError) as refused:
        operations.rename(session, library_root, path="a.mkv", new_name="b.mkv")

    assert refused.value.details is not None
    assert refused.value.details["code"] == "path_conflict"
    # Nothing moved: the prompt is the point, and a failed collision must leave
    # both files exactly where they were.
    assert (library_root / "a.mkv").is_file()
    assert (library_root / "b.mkv").is_file()


def test_collision_skip_leaves_everything_alone(session: Session, library_root: Path) -> None:
    _touch(library_root, "a.mkv")
    _touch(library_root, "b.mkv")

    result = operations.rename(
        session, library_root, path="a.mkv", new_name="b.mkv", on_conflict=ConflictPolicy.SKIP
    )

    assert result.skipped is True
    assert result.path == "a.mkv"
    assert (library_root / "a.mkv").is_file()


def test_collision_suffix_keeps_both(session: Session, library_root: Path) -> None:
    _touch(library_root, "a.mkv", b"first")
    _touch(library_root, "b.mkv", b"second")
    _touch(library_root, "b (2).mkv", b"third")

    result = operations.rename(
        session, library_root, path="a.mkv", new_name="b.mkv", on_conflict=ConflictPolicy.SUFFIX
    )

    # Counts past a name that is itself already taken.
    assert result.path == "b (3).mkv"
    assert (library_root / "b (3).mkv").read_bytes() == b"first"
    assert (library_root / "b.mkv").read_bytes() == b"second"


def test_collision_with_a_linked_row_is_refused_before_the_file_moves(
    session: Session, library_root: Path
) -> None:
    """`relative_path` is unique. Moving first and discovering that second would
    leave the filesystem and the database disagreeing."""
    _touch(library_root, "a.mkv")
    _link(session, "b.mkv")  # a row whose file is absent, e.g. currently missing

    with pytest.raises(ConflictError):
        operations.rename(session, library_root, path="a.mkv", new_name="b.mkv")

    assert (library_root / "a.mkv").is_file()


# --- new folder --------------------------------------------------------------
def test_make_directory_creates_one_directory(session: Session, library_root: Path) -> None:
    (library_root / "Show").mkdir()

    result = operations.make_directory(session, library_root, path="Show/Season 2")

    assert result.path == "Show/Season 2"
    assert (library_root / "Show/Season 2").is_dir()


def test_make_directory_needs_its_parent(session: Session, library_root: Path) -> None:
    with pytest.raises(NotFoundError):
        operations.make_directory(session, library_root, path="Nope/Season 2")


def test_make_directory_refuses_an_existing_name(session: Session, library_root: Path) -> None:
    (library_root / "Show").mkdir()

    with pytest.raises(ConflictError):
        operations.make_directory(session, library_root, path="Show")


# --- journal -----------------------------------------------------------------
def test_every_operation_is_journaled(session: Session, library_root: Path) -> None:
    _touch(library_root, "a.mkv")

    operations.make_directory(session, library_root, path="Folder")
    operations.rename(session, library_root, path="a.mkv", new_name="b.mkv")

    rows = journal.list_operations(session, limit=10)
    assert [row.op for row in rows] == [FileOpType.RENAME, FileOpType.MKDIR]  # newest first
    assert all(row.status is FileOpStatus.DONE for row in rows)
    assert rows[0].payload == {"source": "a.mkv", "destination": "b.mkv", "files_updated": 0}
    assert rows[0].finished_at is not None


def test_a_name_that_is_really_a_path_is_refused_before_anything_is_journaled(
    session: Session, library_root: Path
) -> None:
    """Rename takes a name, not a path. Refusing it in the validator means no
    journal row is written for an operation that was never going to happen."""
    _touch(library_root, "a.mkv")

    with pytest.raises(ValidationError):
        operations.rename(session, library_root, path="a.mkv", new_name="sub/b.mkv")

    assert journal.list_operations(session, limit=10) == []


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_a_failed_filesystem_operation_is_journaled_as_failed(
    session: Session, library_root: Path
) -> None:
    """A crash-shaped failure the validator cannot predict: the rename is legal,
    and the filesystem refuses it. The pending row must not be left behind."""
    _touch(library_root, "locked/a.mkv")
    locked = library_root / "locked"
    locked.chmod(0o500)  # readable and traversable, not writable
    try:
        with pytest.raises(ConflictError):
            operations.rename(session, library_root, path="locked/a.mkv", new_name="b.mkv")
    finally:
        locked.chmod(0o700)

    rows = journal.list_operations(session, limit=10)
    assert [row.status for row in rows] == [FileOpStatus.FAILED]
    assert rows[0].error  # the OS's own reason, without a server path in it
    assert (library_root / "locked/a.mkv").is_file()


# --- undo --------------------------------------------------------------------
def test_undo_reverses_a_rename_and_keeps_the_history_honest(
    session: Session, library_root: Path
) -> None:
    _touch(library_root, "Show/ep1.mkv")
    file = _link(session, "Show/ep1.mkv")
    result = operations.rename(session, library_root, path="Show/ep1.mkv", new_name="ep2.mkv")

    undone = operations.undo(session, library_root, operation_id=result.operation.id)

    assert undone.path == "Show/ep1.mkv"
    assert (library_root / "Show/ep1.mkv").is_file()
    assert not (library_root / "Show/ep2.mkv").exists()
    session.refresh(file)
    assert file.relative_path == "Show/ep1.mkv"

    # The row stays, flipped rather than deleted — and the inverse rename did
    # not leave a second entry pretending to be a user action.
    rows = journal.list_operations(session, limit=10)
    assert [row.status for row in rows] == [FileOpStatus.UNDONE]


def test_undo_reverses_a_new_folder_only_while_it_is_empty(
    session: Session, library_root: Path
) -> None:
    result = operations.make_directory(session, library_root, path="Folder")
    _touch(library_root, "Folder/something.mkv")

    with pytest.raises(ConflictError):
        operations.undo(session, library_root, operation_id=result.operation.id)

    (library_root / "Folder/something.mkv").unlink()
    operations.undo(session, library_root, operation_id=result.operation.id)
    assert not (library_root / "Folder").exists()


def test_an_operation_cannot_be_undone_twice(session: Session, library_root: Path) -> None:
    _touch(library_root, "a.mkv")
    result = operations.rename(session, library_root, path="a.mkv", new_name="b.mkv")
    operations.undo(session, library_root, operation_id=result.operation.id)

    with pytest.raises(ConflictError):
        operations.undo(session, library_root, operation_id=result.operation.id)


def test_undo_of_an_unknown_operation_is_not_found(session: Session, library_root: Path) -> None:
    with pytest.raises(NotFoundError):
        operations.undo(session, library_root, operation_id="01NOPE")


# --- crash recovery ----------------------------------------------------------
def _interrupted(session: Session, op: FileOpType, payload: dict[str, str]) -> FileOperation:
    """A journal row left behind by a crash between the filesystem and the DB."""
    row = FileOperation(op=op, status=FileOpStatus.PENDING, payload=payload)
    session.add(row)
    session.commit()
    return row


def test_reconciler_completes_a_rename_that_reached_the_disk(
    session: Session, library_root: Path
) -> None:
    """The filesystem half happened, the metadata half did not — the exact state
    a crash between journal.begin and journal.finish leaves behind."""
    _touch(library_root, "Show/new.mkv")
    file = _link(session, "Show/old.mkv")
    row = _interrupted(
        session, FileOpType.RENAME, {"source": "Show/old.mkv", "destination": "Show/new.mkv"}
    )

    report = reconcile_pending(session, library_root)

    assert (report.completed, report.failed) == (1, 0)
    session.refresh(row)
    session.refresh(file)
    assert row.status is FileOpStatus.DONE
    assert row.payload["reconciled"] is True
    assert file.relative_path == "Show/new.mkv"  # id preserved, as ever


def test_reconciler_fails_a_rename_that_never_happened(
    session: Session, library_root: Path
) -> None:
    _touch(library_root, "Show/old.mkv")
    file = _link(session, "Show/old.mkv")
    row = _interrupted(
        session, FileOpType.RENAME, {"source": "Show/old.mkv", "destination": "Show/new.mkv"}
    )

    report = reconcile_pending(session, library_root)

    assert (report.completed, report.failed) == (0, 1)
    session.refresh(row)
    session.refresh(file)
    assert row.status is FileOpStatus.FAILED
    assert file.relative_path == "Show/old.mkv"


def test_reconciler_refuses_to_guess_when_both_paths_exist(
    session: Session, library_root: Path
) -> None:
    _touch(library_root, "Show/old.mkv")
    _touch(library_root, "Show/new.mkv")
    file = _link(session, "Show/old.mkv")
    row = _interrupted(
        session, FileOpType.RENAME, {"source": "Show/old.mkv", "destination": "Show/new.mkv"}
    )

    reconcile_pending(session, library_root)

    session.refresh(row)
    session.refresh(file)
    assert row.status is FileOpStatus.FAILED
    # Untouched: an ambiguous state is the scanner's job (ADR-0006), not a guess.
    assert file.relative_path == "Show/old.mkv"
    assert (library_root / "Show/old.mkv").is_file()
    assert (library_root / "Show/new.mkv").is_file()


def test_reconciler_settles_an_interrupted_new_folder(session: Session, library_root: Path) -> None:
    (library_root / "Made").mkdir()
    made = _interrupted(session, FileOpType.MKDIR, {"destination": "Made"})
    missing = _interrupted(session, FileOpType.MKDIR, {"destination": "NotMade"})

    report = reconcile_pending(session, library_root)

    assert (report.completed, report.failed) == (1, 1)
    session.refresh(made)
    session.refresh(missing)
    assert made.status is FileOpStatus.DONE
    assert missing.status is FileOpStatus.FAILED


def test_reconciler_is_a_no_op_on_a_library_that_was_never_written_to(
    session: Session, library_root: Path
) -> None:
    assert reconcile_pending(session, library_root).total == 0
    assert session.scalar(select(FileOperation).limit(1)) is None


# --- trash (ADR-0013 §3.2) ---------------------------------------------------
def _trashed_bytes(root: Path) -> list[Path]:
    """Every file currently sitting in the library's trash."""
    return sorted(p for p in (root / ".cairndex" / "trash").rglob("*") if p.is_file())


def test_trashing_a_file_moves_it_and_keeps_its_row(session: Session, library_root: Path) -> None:
    _touch(library_root, "Show/ep1.mkv", b"payload")
    file = _link(session, "Show/ep1.mkv")
    original_id = file.id

    result = operations.trash_paths(session, library_root, paths=["Show/ep1.mkv"])

    # Gone from where it was, but not gone.
    assert not (library_root / "Show/ep1.mkv").exists()
    stored = library_root / f".cairndex/trash/{result.operation.id}/files/Show/ep1.mkv"
    assert stored.read_bytes() == b"payload"

    session.refresh(file)
    assert file.id == original_id  # the whole reason restore is lossless
    assert file.availability is FileAvailability.TRASHED
    # The path follows the bytes, which is what frees the original path.
    assert file.relative_path == stored_relative_path(result.operation.id, "Show/ep1.mkv")


def test_trashing_writes_a_readable_note_beside_the_files(
    session: Session, library_root: Path
) -> None:
    """For the case where someone opens the package without Cairndex."""
    _touch(library_root, "a.mkv")
    result = operations.trash_paths(session, library_root, paths=["a.mkv"])

    meta = json.loads(
        (library_root / f".cairndex/trash/{result.operation.id}/meta.json").read_text()
    )

    assert meta["operation_id"] == result.operation.id
    assert [entry["original_path"] for entry in meta["entries"]] == ["a.mkv"]


def test_trashing_a_directory_takes_its_subtree_as_one_operation(
    session: Session, library_root: Path
) -> None:
    _touch(library_root, "Show/S01/ep1.mkv")
    _touch(library_root, "Show/S01/ep2.mkv")
    inside_a = _link(session, "Show/S01/ep1.mkv")
    inside_b = _link(session, "Show/S01/ep2.mkv")

    result = operations.trash_paths(session, library_root, paths=["Show/S01"])

    assert not (library_root / "Show/S01").exists()
    assert result.files_updated == 2
    for row in (inside_a, inside_b):
        session.refresh(row)
        assert row.availability is FileAvailability.TRASHED
    # One operation, so restoring is one action rather than two decisions.
    assert len(journal.list_operations(session, limit=10)) == 1


def test_trashing_a_folder_and_something_inside_it_is_one_move(
    session: Session, library_root: Path
) -> None:
    """An ordinary multi-select. The child must not be trashed twice — the
    second move would fail on a path the first one already took away."""
    _touch(library_root, "Show/S01/ep1.mkv")

    result = operations.trash_paths(session, library_root, paths=["Show/S01", "Show/S01/ep1.mkv"])

    assert result.operation.payload["paths"] == ["Show/S01"]
    assert (
        library_root / f".cairndex/trash/{result.operation.id}/files/Show/S01/ep1.mkv"
    ).is_file()


def test_restore_puts_everything_back_with_its_metadata(
    session: Session, library_root: Path
) -> None:
    _touch(library_root, "Show/ep1.mkv", b"payload")
    file = _link(session, "Show/ep1.mkv")
    bundle = session.get(AssetBundle, file.bundle_id)
    assert bundle is not None
    bundle.cover_file_id = file.id
    session.commit()
    trashed = operations.trash_paths(session, library_root, paths=["Show/ep1.mkv"])

    restored = operations.restore(session, library_root, operation_id=trashed.operation.id)

    assert restored.files_updated == 1
    assert (library_root / "Show/ep1.mkv").read_bytes() == b"payload"
    session.refresh(file)
    session.refresh(bundle)
    assert file.availability is FileAvailability.AVAILABLE
    assert file.relative_path == "Show/ep1.mkv"
    assert bundle.cover_file_id == file.id  # the round trip loses nothing
    # The trash directory is tidied up rather than left as an empty shell.
    assert not (library_root / f".cairndex/trash/{trashed.operation.id}").exists()


def test_restoring_a_directory_restores_its_contents(session: Session, library_root: Path) -> None:
    _touch(library_root, "Show/S01/ep1.mkv")
    _touch(library_root, "Show/S01/ep2.mkv")
    inside = _link(session, "Show/S01/ep1.mkv")
    trashed = operations.trash_paths(session, library_root, paths=["Show/S01"])

    operations.restore(session, library_root, operation_id=trashed.operation.id)

    assert (library_root / "Show/S01/ep1.mkv").is_file()
    assert (library_root / "Show/S01/ep2.mkv").is_file()
    session.refresh(inside)
    assert inside.relative_path == "Show/S01/ep1.mkv"
    assert inside.availability is FileAvailability.AVAILABLE


def test_restore_is_refused_whole_when_the_path_is_taken(
    session: Session, library_root: Path
) -> None:
    """Half a restore is worse than none: the owner would have to work out
    which files came back."""
    _touch(library_root, "a.mkv", b"original")
    _touch(library_root, "b.mkv", b"other")
    trashed = operations.trash_paths(session, library_root, paths=["a.mkv", "b.mkv"])
    _touch(library_root, "a.mkv", b"something new")

    with pytest.raises(ConflictError):
        operations.restore(session, library_root, operation_id=trashed.operation.id)

    # Nothing moved — b.mkv is still in the trash, waiting.
    assert (library_root / "a.mkv").read_bytes() == b"something new"
    assert not (library_root / "b.mkv").exists()


def test_restoring_a_file_whose_folder_is_gone_recreates_the_folder(
    session: Session, library_root: Path
) -> None:
    _touch(library_root, "Show/ep1.mkv")
    trashed = operations.trash_paths(session, library_root, paths=["Show/ep1.mkv"])
    (library_root / "Show").rmdir()

    operations.restore(session, library_root, operation_id=trashed.operation.id)

    assert (library_root / "Show/ep1.mkv").is_file()


def test_undo_of_a_deletion_is_the_restore(session: Session, library_root: Path) -> None:
    _touch(library_root, "a.mkv")
    trashed = operations.trash_paths(session, library_root, paths=["a.mkv"])

    operations.undo(session, library_root, operation_id=trashed.operation.id)

    assert (library_root / "a.mkv").is_file()
    assert session.get(FileOperation, trashed.operation.id).status is FileOpStatus.UNDONE


def test_a_trashed_file_is_not_missing(session: Session, library_root: Path) -> None:
    """The distinction the whole state exists for: missing means "we do not know
    where this went"; trashed means "we put it there". A scan must not confuse
    the two, or the Trash view empties into Missing Files."""
    _touch(library_root, "a.mkv")
    file = _link(session, "a.mkv")
    operations.trash_paths(session, library_root, paths=["a.mkv"])

    changed = _mark_missing([file], keep=set())

    assert changed == 0
    assert file.availability is FileAvailability.TRASHED


def test_empty_trash_is_the_one_way_door(session: Session, library_root: Path) -> None:
    _touch(library_root, "a.mkv")
    file = _link(session, "a.mkv")
    trashed = operations.trash_paths(session, library_root, paths=["a.mkv"])
    file_id = file.id

    emptied = operations.empty_trash(session, library_root)

    assert emptied == 1
    assert _trashed_bytes(library_root) == []
    # Metadata deletion happens here and only here.
    assert session.get(AssetFile, file_id) is None
    assert session.get(FileOperation, trashed.operation.id).status is FileOpStatus.EMPTIED
    assert operations.list_trash(session) == []


def test_empty_trash_can_keep_recent_deletions(session: Session, library_root: Path) -> None:
    _touch(library_root, "old.mkv")
    _touch(library_root, "new.mkv")
    old = operations.trash_paths(session, library_root, paths=["old.mkv"])
    new = operations.trash_paths(session, library_root, paths=["new.mkv"])
    old.operation.finished_at = utcnow() - timedelta(days=40)
    session.commit()

    emptied = operations.empty_trash(session, library_root, older_than_days=30)

    assert emptied == 1
    assert [op.id for op, _ in operations.list_trash(session)] == [new.operation.id]


def test_an_emptied_deletion_cannot_be_restored(session: Session, library_root: Path) -> None:
    _touch(library_root, "a.mkv")
    trashed = operations.trash_paths(session, library_root, paths=["a.mkv"])
    operations.empty_trash(session, library_root)

    with pytest.raises(ConflictError):
        operations.restore(session, library_root, operation_id=trashed.operation.id)


# --- replace, which the trash is what makes safe (ADR-0013 §3.3) -------------
def test_replace_trashes_the_displaced_file_rather_than_overwriting_it(
    session: Session, library_root: Path
) -> None:
    _touch(library_root, "new.mkv", b"the better copy")
    _touch(library_root, "old.mkv", b"the original")
    displaced = _link(session, "old.mkv")

    result = operations.rename(
        session,
        library_root,
        path="new.mkv",
        new_name="old.mkv",
        on_conflict=ConflictPolicy.REPLACE,
    )

    assert (library_root / "old.mkv").read_bytes() == b"the better copy"
    session.refresh(displaced)
    assert displaced.availability is FileAvailability.TRASHED
    # Recorded as an ordinary deletion of its own, so it shows up in the Trash
    # view, restores on its own, and is emptied by the same sweep as the rest.
    trashed = operations.list_trash(session)
    assert [entry.original_path for _op, entries in trashed for entry in entries] == ["old.mkv"]
    assert result.operation.payload["replaced_operation_id"] == trashed[0][0].id
    assert (library_root / f".cairndex/trash/{trashed[0][0].id}/files/old.mkv").read_bytes() == (
        b"the original"
    )


def test_undoing_a_replace_puts_both_files_back(session: Session, library_root: Path) -> None:
    """Otherwise the owner is left with neither file where they expected it —
    recoverable, but silently."""
    _touch(library_root, "new.mkv", b"the better copy")
    _touch(library_root, "old.mkv", b"the original")
    displaced = _link(session, "old.mkv")

    result = operations.rename(
        session,
        library_root,
        path="new.mkv",
        new_name="old.mkv",
        on_conflict=ConflictPolicy.REPLACE,
    )
    operations.undo(session, library_root, operation_id=result.operation.id)

    assert (library_root / "old.mkv").read_bytes() == b"the original"
    assert (library_root / "new.mkv").read_bytes() == b"the better copy"
    session.refresh(displaced)
    assert displaced.availability is FileAvailability.AVAILABLE
    assert displaced.relative_path == "old.mkv"


def test_reconciler_completes_a_deletion_that_was_interrupted_halfway(
    session: Session, library_root: Path
) -> None:
    """The one operation reconciled *partially*, because it is the one that can
    be partially done. Failing it whole would leave the moved file in the trash
    with nothing listing it — invisible and unrestorable."""
    _touch(library_root, "moved.mkv", b"payload")
    _touch(library_root, "not-moved.mkv")
    moved_row = _link(session, "moved.mkv")
    still_here = _link(session, "not-moved.mkv")
    row = _interrupted(session, FileOpType.TRASH, {"paths": ["moved.mkv", "not-moved.mkv"]})
    # Only the first path made it into the trash before the crash.
    stored = library_root / f".cairndex/trash/{row.id}/files/moved.mkv"
    stored.parent.mkdir(parents=True)
    (library_root / "moved.mkv").rename(stored)

    report = reconcile_pending(session, library_root)

    assert (report.completed, report.failed) == (1, 0)
    session.refresh(row)
    session.refresh(moved_row)
    session.refresh(still_here)
    assert row.status is FileOpStatus.DONE
    assert moved_row.availability is FileAvailability.TRASHED
    # The one that never moved is untouched, and still on disk.
    assert still_here.availability is FileAvailability.AVAILABLE
    assert (library_root / "not-moved.mkv").is_file()
    # And what did move is restorable, which is the whole point.
    operations.restore(session, library_root, operation_id=row.id)
    assert (library_root / "moved.mkv").read_bytes() == b"payload"


def test_reconciler_fails_a_deletion_that_never_started(
    session: Session, library_root: Path
) -> None:
    _touch(library_root, "a.mkv")
    row = _interrupted(session, FileOpType.TRASH, {"paths": ["a.mkv"]})

    report = reconcile_pending(session, library_root)

    assert (report.completed, report.failed) == (0, 1)
    session.refresh(row)
    assert row.status is FileOpStatus.FAILED
    assert (library_root / "a.mkv").is_file()


# --- import (ADR-0013 §7, plan 4 W5) -----------------------------------------
async def _body(*chunks: bytes) -> AsyncIterator[bytes]:
    for chunk in chunks:
        yield chunk


def test_import_streams_in_chunks_without_holding_the_file(
    session: Session, library_root: Path
) -> None:
    result = asyncio.run(
        imports.import_stream(
            session,
            library_root,
            dest_dir="",
            filename="clip.mkv",
            body=_body(b"part one ", b"part two"),
        )
    )

    assert result.size_bytes == len(b"part one part two")
    assert (library_root / "clip.mkv").read_bytes() == b"part one part two"


def test_import_over_the_size_limit_is_refused_and_cleans_up(
    session: Session, library_root: Path
) -> None:
    """The limit has to be enforced *while* streaming — checking a
    Content-Length would trust the client about the thing being limited."""
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("CAIRNDEX_IMPORT_MAX_BYTES", "10")
        get_settings.cache_clear()
        try:
            with pytest.raises(ValidationError):
                asyncio.run(
                    imports.import_stream(
                        session,
                        library_root,
                        dest_dir="",
                        filename="big.mkv",
                        body=_body(b"x" * 8, b"y" * 8),
                    )
                )
        finally:
            get_settings.cache_clear()

    assert not (library_root / "big.mkv").exists()
    # The partial upload is gone, not left occupying the space it was refused.
    assert list(imports.staging_dir(library_root).iterdir()) == []
    assert journal.list_operations(session, limit=5)[0].status is FileOpStatus.FAILED


def test_staging_sweep_removes_abandoned_partial_uploads(library_root: Path) -> None:
    staging = imports.staging_dir(library_root)
    staging.mkdir(parents=True)
    (staging / "01ABANDONED.part").write_bytes(b"half a video")

    removed = imports.sweep_staging(library_root)

    assert removed == 1
    assert list(staging.iterdir()) == []


def test_staging_sweep_is_quiet_when_nothing_was_ever_imported(library_root: Path) -> None:
    assert imports.sweep_staging(library_root) == 0
