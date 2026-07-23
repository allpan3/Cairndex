"""Guarded rename / New Folder and the operation journal (ADR-0013, plan 4 W1).

Uses the shared ``session``/``library_root`` fixtures so operations run against
a real on-disk library package and real files — the whole point of these tests
is what happens on the filesystem, so nothing here is mocked.
"""

import os
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.paths import PathSafetyError
from cairndex.domain.enums import FileOpStatus, FileOpType, FileRole, MediaKind
from cairndex.file_ops import journal, operations
from cairndex.file_ops.conflicts import ConflictPolicy
from cairndex.file_ops.paths import suffixed_name, validate_name
from cairndex.file_ops.reconcile import reconcile_pending
from cairndex.persistence.models import AssetBundle, AssetFile, FileOperation


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
