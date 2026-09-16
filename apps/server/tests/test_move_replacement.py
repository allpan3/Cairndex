"""Synthetic Rename/Move collision identity and recovery examples"""

from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.time import utcnow
from cairndex.domain.enums import FileAvailability, FileRole, MediaKind
from cairndex.file_ops import operations
from cairndex.file_ops.conflicts import ConflictPolicy
from cairndex.persistence.models import (
    AssetBundle,
    AssetFile,
    BundleCursor,
    Collection,
    Moment,
    PlaybackProgress,
    SubtitleTrack,
    Tag,
)


# Give each synthetic identity distinct authored references and cached media facts
def decorated(session: Session, root: Path, path: str, label: str) -> AssetFile:
    full = root / path
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(label.encode())
    bundle = AssetBundle(title=label, notes=[label], rating=4 if label == "A" else 2)
    bundle.tags = [Tag(name=label)]
    bundle.collections = [Collection(name=label)]
    session.add(bundle)
    session.flush()
    row = AssetFile(
        bundle_id=bundle.id,
        relative_path=path,
        original_filename=full.name,
        display_title=full.name,
        role=FileRole.VIDEO_PART,
        media_kind=MediaKind.VIDEO,
        note=label,
        source=f"Synthetic {label}",
        quick_fingerprint=label,
        full_hash=f"synthetic-{label}",
        sequence=3,
        cover_time=0.5,
        tech_metadata={"duration": 10},
    )
    sub = AssetFile(
        bundle_id=bundle.id,
        relative_path=f"{path}.srt",
        original_filename="clip.srt",
        display_title="clip.srt",
        role=FileRole.SUBTITLE,
        media_kind=MediaKind.SUBTITLE,
    )
    (root / sub.relative_path).write_text(label)
    session.add_all([row, sub])
    session.flush()
    bundle.cover_file_id = bundle.primary_file_id = row.id
    session.add_all(
        [
            Moment(bundle_id=bundle.id, file_id=row.id, start_s=1, comment=label),
            SubtitleTrack(
                bundle_id=bundle.id, video_file_id=row.id, source_file_id=sub.id, label=label
            ),
            SubtitleTrack(bundle_id=bundle.id, video_file_id=row.id, embedded_index=0, label=label),
            PlaybackProgress(
                file_id=row.id, bundle_id=bundle.id, position_s=2, updated_at=utcnow()
            ),
            BundleCursor(bundle_id=bundle.id, file_id=row.id, updated_at=utcnow()),
        ]
    )
    session.commit()
    return row


# Snapshot stable metadata independently of physical location and availability
def metadata(session: Session, row: AssetFile) -> tuple:
    return (
        row.id,
        row.bundle_id,
        row.note,
        row.source,
        row.quick_fingerprint,
        row.tech_metadata,
        row.original_filename,
        row.full_hash,
        row.sequence,
        row.cover_time,
        row.role,
        row.bundle.notes,
        row.bundle.rating,
        row.bundle.cover_file_id,
        row.bundle.primary_file_id,
        tuple(t.id for t in row.bundle.tags),
        tuple(c.id for c in row.bundle.collections),
        tuple(
            (s.id, s.label, s.source_file_id, s.embedded_index)
            for s in session.scalars(
                select(SubtitleTrack)
                .where(SubtitleTrack.video_file_id == row.id)
                .order_by(SubtitleTrack.id)
            )
        ),
        tuple(
            (m.id, m.comment)
            for m in session.scalars(select(Moment).where(Moment.file_id == row.id))
        ),
        session.get(PlaybackProgress, row.id).position_s,
        session.get(BundleCursor, row.bundle_id).file_id,
    )


# Characterize both identities before replacement, while displaced, and after Undo
@pytest.mark.parametrize("verb", ["rename", "move"])
def test_two_decorated_identities_round_trip(
    session: Session, library_root: Path, verb: str
) -> None:
    source = "A.mkv" if verb == "rename" else "incoming/B.mkv"
    a = decorated(session, library_root, source, "A")
    b = decorated(session, library_root, "B.mkv", "B")
    before = [metadata(session, row) for row in (a, b)]
    if verb == "rename":
        result = operations.rename(
            session, library_root, path=source, new_name="B.mkv", on_conflict=ConflictPolicy.REPLACE
        )
    else:
        result = operations.move(
            session, library_root, paths=[source], dest_dir="", on_conflict=ConflictPolicy.REPLACE
        )
    assert a.relative_path == "B.mkv" and a.availability is FileAvailability.AVAILABLE
    assert b.availability is FileAvailability.TRASHED
    assert (library_root / a.relative_path).read_bytes() == b"A"
    assert (library_root / b.relative_path).read_bytes() == b"B"
    assert [metadata(session, row) for row in (a, b)] == before
    a.note, b.note = "A edited", "B edited"
    a.bundle.notes, b.bundle.notes = ["A edited"], ["B edited"]
    a.bundle.rating, b.bundle.rating = 3, 5
    for moment in session.scalars(select(Moment)):
        moment.comment += " edited"
    for track in session.scalars(select(SubtitleTrack)):
        track.label += " edited"
    session.commit()
    edited = [metadata(session, row) for row in (a, b)]
    operations.undo(session, library_root, operation_id=result.operation.id)
    assert a.relative_path == source and b.relative_path == "B.mkv"
    assert all(row.availability is FileAvailability.AVAILABLE for row in (a, b))
    assert [metadata(session, row) for row in (a, b)] == edited
    assert (library_root / source).read_bytes() == b"A"
    assert (library_root / "B.mkv").read_bytes() == b"B"


# A stopped process must not lose the destination's Trash link after the source moves
def test_interrupted_replace_move_keeps_displaced_receipt(
    session: Session, library_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from cairndex.domain.enums import FileOpType
    from cairndex.file_ops.reconcile import reconcile_pending
    from cairndex.persistence.models import FileOperation

    a = decorated(session, library_root, "incoming/B.mkv", "A")
    b = decorated(session, library_root, "B.mkv", "B")
    original = operations._rename_on_disk

    def crash(source: Path, destination: Path) -> None:
        original(source, destination)
        raise SystemExit("synthetic process exit")

    with monkeypatch.context() as patch:
        patch.setattr(operations, "_rename_on_disk", crash)
        with pytest.raises(SystemExit):
            operations.move(
                session,
                library_root,
                paths=["incoming/B.mkv"],
                dest_dir="",
                on_conflict=ConflictPolicy.REPLACE,
            )
    session.rollback()
    reconcile_pending(session, library_root)
    op = session.scalars(select(FileOperation).where(FileOperation.op == FileOpType.MOVE)).one()
    operations.undo(session, library_root, operation_id=op.id)
    assert a.relative_path == "incoming/B.mkv"
    assert b.relative_path == "B.mkv" and b.availability is FileAvailability.AVAILABLE


# Linked and unlinked inputs never borrow the other file's identity
@pytest.mark.parametrize("verb", ["rename", "move"])
@pytest.mark.parametrize(
    "linked_a,linked_b", [(False, False), (False, True), (True, False), (True, True)]
)
def test_linkage_combinations(
    session: Session, library_root: Path, verb: str, linked_a: bool, linked_b: bool
) -> None:
    source = "A.mkv" if verb == "rename" else "incoming/B.mkv"
    rows = []
    for path, label, linked in [(source, "A", linked_a), ("B.mkv", "B", linked_b)]:
        if linked:
            rows.append(decorated(session, library_root, path, label))
        else:
            full = library_root / path
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_bytes(label.encode())
    before = [metadata(session, row) for row in rows]
    result = replace_files(session, library_root, verb)
    active = session.scalar(select(AssetFile).where(AssetFile.relative_path == "B.mkv"))
    assert (active is not None) is linked_a
    operations.undo(session, library_root, operation_id=result.operation.id)
    assert [metadata(session, row) for row in rows] == before
    assert (library_root / source).read_bytes() == b"A"
    assert (library_root / "B.mkv").read_bytes() == b"B"


# Run either explicit collision command through its production service
def replace_files(session: Session, root: Path, verb: str):
    if verb == "rename":
        return operations.rename(
            session, root, path="A.mkv", new_name="B.mkv", on_conflict=ConflictPolicy.REPLACE
        )
    return operations.move(
        session, root, paths=["incoming/B.mkv"], dest_dir="", on_conflict=ConflictPolicy.REPLACE
    )


# Restart at each forward/inverse filesystem boundary preserves both byte/metadata pairs
@pytest.mark.parametrize("verb", ["rename", "move"])
@pytest.mark.parametrize(
    "phase", ["before_trash", "after_trash", "after_move", "undo_source", "undo_destination"]
)
def test_interruption_boundaries(
    session: Session, library_root: Path, monkeypatch: pytest.MonkeyPatch, verb: str, phase: str
) -> None:
    from cairndex.core.errors import ConflictError
    from cairndex.domain.enums import FileOpStatus, FileOpType
    from cairndex.file_ops import fsmove
    from cairndex.file_ops.reconcile import reconcile_pending
    from cairndex.persistence.models import FileOperation

    source = "A.mkv" if verb == "rename" else "incoming/B.mkv"
    a = decorated(session, library_root, source, "A")
    b = decorated(session, library_root, "B.mkv", "B")
    before = [metadata(session, row) for row in (a, b)]
    op = replace_files(session, library_root, verb).operation if phase.startswith("undo") else None
    original = fsmove.move_path

    # Simulate an exit at the real disk boundary, without committing pending ORM changes
    def crash(src: Path, dst: Path) -> None:
        target = (
            (phase in ("before_trash", "after_trash") and ".cairndex/trash/" in str(dst))
            or (phase == "after_move" and dst == library_root / "B.mkv")
            or (phase == "undo_source" and dst == library_root / source)
            or (phase == "undo_destination" and dst == library_root / "B.mkv")
        )
        if target and phase == "before_trash":
            raise SystemExit("synthetic exit")
        original(src, dst)
        if target:
            raise SystemExit("synthetic exit")

    with monkeypatch.context() as patch:
        patch.setattr(fsmove, "move_path", crash)
        with pytest.raises(SystemExit):
            if op is None:
                replace_files(session, library_root, verb)
            else:
                operations.undo(session, library_root, operation_id=op.id)
    session.rollback()
    session.expire_all()
    reconcile_pending(session, library_root)
    op = session.scalars(
        select(FileOperation).where(
            FileOperation.op == (FileOpType.RENAME if verb == "rename" else FileOpType.MOVE)
        )
    ).one()
    if phase == "after_move":
        assert op.status is FileOpStatus.DONE
        operations.undo(session, library_root, operation_id=op.id)
    elif phase.startswith("undo"):
        assert op.status is FileOpStatus.UNDONE
        with pytest.raises(ConflictError):
            operations.undo(session, library_root, operation_id=op.id)
    else:
        assert op.status is FileOpStatus.FAILED
    assert [metadata(session, row) for row in (a, b)] == before
    assert a.relative_path == source and b.relative_path == "B.mkv"
    assert (library_root / source).read_bytes() == b"A"
    assert (library_root / "B.mkv").read_bytes() == b"B"
    assert reconcile_pending(session, library_root).total == 0


# Undo refuses changes to either physical path without moving or relabeling a bystander
@pytest.mark.parametrize("change", ["new_source", "new_destination", "empty_trash"])
def test_undo_refuses_changed_paths(session: Session, library_root: Path, change: str) -> None:
    from cairndex.core.errors import ConflictError

    a = decorated(session, library_root, "A.mkv", "A")
    b = decorated(session, library_root, "B.mkv", "B")
    op = replace_files(session, library_root, "rename").operation
    if change == "new_source":
        (library_root / "A.mkv").write_bytes(b"newcomer")
    elif change == "new_destination":
        (library_root / "B.mkv").write_bytes(b"external change")
    else:
        operations.empty_trash(session, library_root)
    before_path = a.relative_path
    before_bytes = (library_root / before_path).read_bytes()
    with pytest.raises(ConflictError):
        operations.undo(session, library_root, operation_id=op.id)
    assert a.relative_path == before_path
    assert (library_root / before_path).read_bytes() == before_bytes
    if change != "empty_trash":
        assert b.availability is FileAvailability.TRASHED
        assert (library_root / b.relative_path).read_bytes() == b"B"


# Direct Put back retains the displaced identity after the incoming file has moved away
@pytest.mark.parametrize("interrupt", [False, True])
def test_put_back_displaced_file(
    session: Session, library_root: Path, monkeypatch: pytest.MonkeyPatch, interrupt: bool
) -> None:
    from cairndex.core.errors import ConflictError
    from cairndex.file_ops.reconcile import reconcile_pending

    a = decorated(session, library_root, "A.mkv", "A")
    b = decorated(session, library_root, "B.mkv", "B")
    op = replace_files(session, library_root, "rename").operation
    backup_id = op.payload["replaced_operation_id"]
    with pytest.raises(ConflictError):
        operations.restore(session, library_root, operation_id=backup_id)
    operations.rename(session, library_root, path="B.mkv", new_name="C.mkv")
    before = metadata(session, b)
    original = operations._rename_on_disk

    # Stop after bytes return but before the catalog can commit their restored path
    def crash(source: Path, destination: Path) -> None:
        original(source, destination)
        raise SystemExit("synthetic exit")

    if interrupt:
        with monkeypatch.context() as patch:
            patch.setattr(operations, "_rename_on_disk", crash)
            with pytest.raises(SystemExit):
                operations.restore(session, library_root, operation_id=backup_id)
        session.rollback()
        reconcile_pending(session, library_root)
    else:
        operations.restore(session, library_root, operation_id=backup_id)
    assert metadata(session, b) == before
    assert b.relative_path == "B.mkv" and a.relative_path == "C.mkv"
    assert (library_root / "B.mkv").read_bytes() == b"B"
    assert (library_root / "C.mkv").read_bytes() == b"A"


# Directory replacement preserves every child identity instead of merging directory contents
def test_directory_replace_round_trip(session: Session, library_root: Path) -> None:
    a = decorated(session, library_root, "A/clip.mkv", "A")
    b = decorated(session, library_root, "B/clip.mkv", "B")
    before = [metadata(session, row) for row in (a, b)]
    op = operations.rename(
        session, library_root, path="A", new_name="B", on_conflict=ConflictPolicy.REPLACE
    ).operation
    assert a.relative_path == "B/clip.mkv" and b.availability is FileAvailability.TRASHED
    operations.undo(session, library_root, operation_id=op.id)
    assert a.relative_path == "A/clip.mkv" and b.relative_path == "B/clip.mkv"
    assert [metadata(session, row) for row in (a, b)] == before


# Independent process exits prove that recovery uses committed intent, not surviving ORM objects
@pytest.mark.parametrize("verb", ["rename", "move"])
@pytest.mark.parametrize("phase", ["displaced", "moved", "undo_source", "undo_destination"])
def test_process_exit_recovery(session: Session, library_root: Path, verb: str, phase: str) -> None:
    import subprocess
    import sys
    import textwrap

    from cairndex.domain.enums import FileOpStatus, FileOpType
    from cairndex.file_ops import journal
    from cairndex.file_ops.reconcile import reconcile_pending
    from cairndex.persistence.models import FileOperation

    source = "A.mkv" if verb == "rename" else "incoming/B.mkv"
    a = decorated(session, library_root, source, "A")
    b = decorated(session, library_root, "B.mkv", "B")
    before = [metadata(session, row) for row in (a, b)]
    session.rollback()
    script = textwrap.dedent("""
        import os, sys
        from pathlib import Path
        from sqlalchemy.orm import Session
        from cairndex.persistence.engine import create_app_engine
        from cairndex.file_ops import fsmove, operations
        from tests.test_move_replacement import replace_files
        root, verb, phase = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
        source = "A.mkv" if verb == "rename" else "incoming/B.mkv"
        engine = create_app_engine(database_url=f"sqlite:///{root / '.cairndex/library.db'}")
        with Session(engine, expire_on_commit=False) as db:
            op = replace_files(db, root, verb).operation if phase.startswith("undo") else None
            move = fsmove.move_path
            def crash(src, dst):
                move(src, dst)
                target = ((phase == "displaced" and ".cairndex/trash/" in str(dst))
                    or (phase == "moved" and dst == root / "B.mkv")
                    or (phase == "undo_source" and dst == root / source)
                    or (phase == "undo_destination" and dst == root / "B.mkv"))
                if target:
                    os._exit(77)
            fsmove.move_path = crash
            if op:
                operations.undo(db, root, operation_id=op.id)
            else:
                replace_files(db, root, verb)
    """)
    result = subprocess.run(
        [sys.executable, "-c", script, str(library_root), verb, phase],
        capture_output=True,
        timeout=30,
    )
    assert result.returncode == 77, result.stderr.decode()
    session.expire_all()
    reconcile_pending(session, library_root)
    op = session.scalars(
        select(FileOperation).where(
            FileOperation.op == (FileOpType.RENAME if verb == "rename" else FileOpType.MOVE)
        )
    ).one()
    if phase == "moved":
        assert op.status is FileOpStatus.DONE
        operations.undo(session, library_root, operation_id=op.id)
    assert not journal.pending_operations(session)
    assert a.relative_path == source and b.relative_path == "B.mkv"
    assert [metadata(session, row) for row in (a, b)] == before
    assert (library_root / source).read_bytes() == b"A"
    assert (library_root / "B.mkv").read_bytes() == b"B"


# One failed source does not stop its siblings or strand the file it displaced
def test_partial_batch_rolls_back_failed_displacement(
    session: Session, library_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    a = decorated(session, library_root, "incoming/B.mkv", "A")
    b = decorated(session, library_root, "B.mkv", "B")
    (library_root / "incoming/C.mkv").write_bytes(b"C")
    original = operations._rename_on_disk

    # Inject one source failure after B has already moved into recoverable Trash
    def deny(source: Path, destination: Path) -> None:
        if source == library_root / "incoming/B.mkv":
            raise PermissionError("synthetic failure")
        original(source, destination)

    with monkeypatch.context() as patch:
        patch.setattr(operations, "_rename_on_disk", deny)
        result = operations.move(
            session,
            library_root,
            paths=["incoming/B.mkv", "incoming/C.mkv"],
            dest_dir="",
            on_conflict=ConflictPolicy.REPLACE,
        )
    assert result.failed_paths == ["incoming/B.mkv"]
    assert a.relative_path == "incoming/B.mkv" and b.relative_path == "B.mkv"
    assert (library_root / "B.mkv").read_bytes() == b"B"
    assert (library_root / "C.mkv").read_bytes() == b"C"
    operations.undo(session, library_root, operation_id=result.operation.id)
    assert (library_root / "incoming/C.mkv").read_bytes() == b"C"
