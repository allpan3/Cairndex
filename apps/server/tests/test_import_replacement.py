"""Synthetic destination metadata and interrupted Replace/Undo regressions"""

import asyncio
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError
from cairndex.core.time import utcnow
from cairndex.domain.enums import FileAvailability, FileOpStatus, FileOpType
from cairndex.file_ops import imports, journal, operations, replacement, trash
from cairndex.file_ops.conflicts import ConflictPolicy
from cairndex.file_ops.reconcile import reconcile_pending
from cairndex.media import derived_cache, playback, thumbnails
from cairndex.persistence.models import (
    AssetFile,
    BundleCursor,
    Collection,
    Moment,
    PlaybackProgress,
    SubtitleTrack,
    Tag,
)


# Drive the production streaming path without HTTP or owner data
def upload(session: Session, root: Path, data: bytes, *, name: str = "clip.mkv", link: bool = True):
    return asyncio.run(
        imports.import_stream(
            session,
            root,
            dest_dir="",
            filename=name,
            body=imports.chunks_of([data]),
            on_conflict=ConflictPolicy.REPLACE,
            link=link,
        )
    ).operation.operation


# Seed distinct source and destination bundles with authored and derived metadata
def decorated_file(session: Session, root: Path) -> AssetFile:
    upload(session, root, b"old synthetic video")
    upload(session, root, b"1\n00:00:00,000 --> 00:00:01,000\nOld caption\n", name="clip.srt")
    row = session.scalar(select(AssetFile).where(AssetFile.relative_path == "clip.mkv"))
    sub = session.scalar(select(AssetFile).where(AssetFile.relative_path == "clip.srt"))
    assert row is not None and sub is not None
    row.note, row.source, row.cover_time = "Destination note", "Synthetic origin", 0.5
    row.full_hash, row.tech_metadata = "old-hash", {"duration": 9}
    row.bundle.notes, row.bundle.rating = ["Bundle note"], 4.5
    row.bundle.tags = [Tag(name="Synthetic tag")]
    row.bundle.collections = [Collection(name="Synthetic collection")]
    row.bundle.cover_file_id, row.bundle.primary_file_id = row.id, row.id
    session.add_all(
        [
            Moment(
                bundle_id=row.bundle_id,
                file_id=row.id,
                start_s=0.2,
                end_s=0.6,
                comment="Moment note",
            ),
            SubtitleTrack(
                bundle_id=row.bundle_id,
                video_file_id=row.id,
                source_file_id=sub.id,
                label="External label",
            ),
            SubtitleTrack(
                bundle_id=row.bundle_id,
                video_file_id=row.id,
                embedded_index=2,
                label="Embedded label",
            ),
            PlaybackProgress(
                file_id=row.id, bundle_id=row.bundle_id, position_s=0.4, updated_at=utcnow()
            ),
            BundleCursor(bundle_id=row.bundle_id, file_id=row.id, updated_at=utcnow()),
        ]
    )
    session.commit()
    return row


# Replacement retains destination metadata even without a request to catalog the incoming copy
@pytest.mark.parametrize("link", [False, True])
def test_replace_and_undo_preserve_authored_destination_metadata(
    session: Session, library_root: Path, link: bool
) -> None:
    row = decorated_file(session, library_root)
    identity, bundle_id, fingerprint = row.id, row.bundle_id, row.quick_fingerprint
    collection_version = row.bundle.collections[0].updated_at
    embedded_id = session.scalar(select(SubtitleTrack.id).where(SubtitleTrack.embedded_index == 2))
    upload(session, library_root, b"incoming bytes", name="incoming.mkv")
    incoming = session.scalar(select(AssetFile).where(AssetFile.relative_path == "incoming.mkv"))
    assert incoming is not None
    incoming.note = "Source note"
    session.commit()
    op = upload(session, library_root, (library_root / "incoming.mkv").read_bytes(), link=link)
    assert row.id == identity and row.bundle_id == bundle_id
    assert row.note == "Destination note" and row.source == "Synthetic origin"
    assert row.bundle.notes == ["Bundle note"] and row.bundle.rating == 4.5
    assert [t.name for t in row.bundle.tags] == ["Synthetic tag"]
    assert [c.name for c in row.bundle.collections] == ["Synthetic collection"]
    assert row.bundle.cover_file_id == row.bundle.primary_file_id == identity
    assert row.cover_time == 0.5 and row.quick_fingerprint != fingerprint
    assert row.bundle.collections[0].updated_at > collection_version
    assert row.full_hash is None and row.tech_metadata is None
    assert session.get(SubtitleTrack, embedded_id) is None
    assert (
        session.scalars(select(AssetFile).where(AssetFile.relative_path == "clip.mkv")).one().id
        == identity
    )
    previous = operations.list_trash(session)[0][1][0]
    assert previous.file_id is None
    assert (library_root / previous.stored_path).read_bytes() == b"old synthetic video"
    assert (library_root / "incoming.mkv").read_bytes() == b"incoming bytes"
    # An edit after Replace must survive Undo too
    row.note = "Edited after Replace"
    session.commit()
    operations.undo(session, library_root, operation_id=op.id)
    assert row.id == identity and row.bundle_id == bundle_id
    assert row.note == "Edited after Replace"
    assert row.bundle.cover_file_id == identity and row.bundle.rating == 4.5
    assert row.quick_fingerprint == fingerprint
    assert (library_root / row.relative_path).read_bytes() == b"old synthetic video"
    assert session.get(SubtitleTrack, embedded_id).label == "Embedded label"
    external = session.scalars(
        select(SubtitleTrack).where(SubtitleTrack.source_file_id.is_not(None))
    ).one()
    assert external.video_file_id == identity and external.label == "External label"
    moment = session.scalars(select(Moment)).one()
    assert (moment.file_id, moment.start_s, moment.end_s, moment.comment) == (
        identity,
        0.2,
        0.6,
        "Moment note",
    )
    assert session.get(PlaybackProgress, identity).position_s == 0.4
    assert session.get(BundleCursor, bundle_id).file_id == identity
    assert incoming.note == "Source note"
    # Retrying a completed Undo refuses without touching either version
    with pytest.raises(ConflictError):
        operations.undo(session, library_root, operation_id=op.id)
    assert (library_root / row.relative_path).read_bytes() == b"old synthetic video"


# Cancellation before publication must never trash or detach the old destination
@pytest.mark.parametrize("cancel", [asyncio.CancelledError, OSError])
def test_cancel_replace_keeps_destination(
    session: Session, library_root: Path, cancel: type[BaseException]
) -> None:
    row = decorated_file(session, library_root)
    fingerprint = row.quick_fingerprint

    async def body():
        yield b"partial"
        raise cancel()

    with pytest.raises(cancel):
        asyncio.run(
            imports.import_stream(
                session,
                library_root,
                dest_dir="",
                filename="clip.mkv",
                body=body(),
                on_conflict=ConflictPolicy.REPLACE,
            )
        )
    assert (library_root / "clip.mkv").read_bytes() == b"old synthetic video"
    assert row.relative_path == "clip.mkv" and row.quick_fingerprint == fingerprint
    assert operations.list_trash(session) == []
    assert list(imports.staging_dir(library_root).iterdir()) == []
    assert journal.list_operations(session, limit=1)[0].status is FileOpStatus.FAILED


# A failed final rename returns the original bytes before recording failure
def test_failed_publish_restores_original(
    session: Session, library_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    row = decorated_file(session, library_root)
    publish = replacement.publish

    def fail_staging(source, destination):
        if str(source).endswith(".part"):
            raise OSError("synthetic failure")
        publish(source, destination)

    monkeypatch.setattr(replacement, "publish", fail_staging)
    with pytest.raises(ConflictError):
        upload(session, library_root, b"incoming")
    assert (library_root / row.relative_path).read_bytes() == b"old synthetic video"
    assert row.note == "Destination note" and row.tech_metadata == {"duration": 9}
    assert operations.list_trash(session) == []


# Simulate a process interruption without invoking normal exception cleanup
class Interrupted(BaseException):
    pass


# Resume each durable boundary without losing the retained ID or repeating filesystem effects
@pytest.mark.parametrize(
    "phase", ["backup_intent", "backup_moved", "published", "undo_stashed", "undo_restored"]
)
def test_reconcile_replacement_boundaries(
    session: Session, library_root: Path, monkeypatch: pytest.MonkeyPatch, phase: str
) -> None:
    row = decorated_file(session, library_root)
    identity = row.id
    finish = journal.finish
    finish_payload = journal.finish_payload
    move = trash.move_into_trash
    restore = replacement.restore_backup
    op = upload(session, library_root, b"incoming") if phase.startswith("undo") else None

    def after_move(*args, **kwargs):
        result = move(*args, **kwargs)
        if phase == "backup_moved":
            raise Interrupted()
        return result

    def after_payload(db, operation, **updates):
        result = finish_payload(db, operation, **updates)
        if phase == "backup_intent" and "replaced_operation_id" in updates:
            raise Interrupted()
        return result

    def before_finish(db, operation, **updates):
        if phase == "published" and operation.op is FileOpType.IMPORT:
            raise Interrupted()
        result = finish(db, operation, **updates)
        if phase == "undo_stashed" and operation.op is FileOpType.TRASH:
            raise Interrupted()
        return result

    def after_restore(*args, **kwargs):
        restore(*args, **kwargs)
        if phase == "undo_restored":
            raise Interrupted()

    with monkeypatch.context() as patch:
        patch.setattr(trash, "move_into_trash", after_move)
        patch.setattr(journal, "finish_payload", after_payload)
        patch.setattr(journal, "finish", before_finish)
        patch.setattr(replacement, "restore_backup", after_restore)
        with pytest.raises(Interrupted):
            if op:
                operations.undo(session, library_root, operation_id=op.id)
            else:
                upload(session, library_root, b"incoming")
    session.rollback()
    session.expire_all()
    reconcile_pending(session, library_root)
    imports.sweep_staging(library_root)
    assert journal.pending_operations(session) == []
    assert row.id == identity and row.relative_path == "clip.mkv"
    assert row.availability is FileAvailability.AVAILABLE
    expected = b"incoming" if phase == "published" else b"old synthetic video"
    assert (library_root / row.relative_path).read_bytes() == expected
    assert row.note == "Destination note" and row.bundle.rating == 4.5
    assert reconcile_pending(session, library_root).total == 0


# Empty Trash deletes old bytes only; older receipts cannot undo a newer replacement
def test_empty_trash_and_out_of_order_undo_preserve_active_identity(
    session: Session, library_root: Path
) -> None:
    row = decorated_file(session, library_root)
    first = upload(session, library_root, b"first replacement")
    second = upload(session, library_root, b"second replacement")
    with pytest.raises(ConflictError):
        operations.undo(session, library_root, operation_id=first.id)
    operations.undo(session, library_root, operation_id=second.id)
    assert (library_root / "clip.mkv").read_bytes() == b"first replacement"
    operations.empty_trash(session, library_root)
    assert session.get(AssetFile, row.id) is row
    assert row.note == "Destination note" and row.bundle.rating == 4.5
    with pytest.raises(ConflictError):
        operations.undo(session, library_root, operation_id=first.id)
    assert (library_root / "clip.mkv").read_bytes() == b"first replacement"


# VTT conversion and thumbnails cannot use cached bytes from the replaced file
def test_replacement_refreshes_derived_media(
    session: Session, library_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    row = decorated_file(session, library_root)
    track = session.scalars(
        select(SubtitleTrack).where(SubtitleTrack.source_file_id.is_not(None))
    ).one()
    vtt = playback.build_vtt_for_track(session, track)
    assert "Old caption" in vtt.read_text()
    op = upload(
        session, library_root, b"1\n00:00:00,000 --> 00:00:01,000\nNew caption\n", name="clip.srt"
    )
    assert "New caption" in playback.build_vtt_for_track(session, track).read_text()
    operations.undo(session, library_root, operation_id=op.id)
    assert "Old caption" in playback.build_vtt_for_track(session, track).read_text()

    def generate(source, destination, *_args):
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(source.read_bytes())

    monkeypatch.setattr(thumbnails, "_generate", generate)
    thumb = thumbnails.generate_for_file(session, row.id)
    assert thumb.read_bytes() == b"old synthetic video"
    op = upload(session, library_root, b"new synthetic video")
    assert not derived_cache.is_current(thumb, row.quick_fingerprint)
    assert thumbnails.generate_for_file(session, row.id).read_bytes() == b"new synthetic video"
    operations.undo(session, library_root, operation_id=op.id)
    assert thumbnails.generate_for_file(session, row.id).read_bytes() == b"old synthetic video"


# A real process exit proves recovery uses committed journal state, not surviving ORM objects
@pytest.mark.parametrize("phase", ["published", "undo_stashed", "undo_restored"])
def test_replacement_recovers_after_process_exit(
    session: Session, library_root: Path, phase: str
) -> None:
    import subprocess
    import sys
    import textwrap

    row = decorated_file(session, library_root)
    identity = row.id
    session.rollback()
    script = textwrap.dedent("""
        import os, sys
        from pathlib import Path
        from sqlalchemy.orm import Session
        from cairndex.persistence.engine import create_app_engine
        from cairndex.file_ops import journal, operations, replacement
        from cairndex.domain.enums import FileOpType
        from tests.test_import_replacement import upload
        root, phase = Path(sys.argv[1]), sys.argv[2]
        engine = create_app_engine(database_url=f"sqlite:///{root / '.cairndex/library.db'}")
        with Session(engine, expire_on_commit=False) as db:
            op = upload(db, root, b"process replacement") if phase.startswith("undo") else None
            finish, restore = journal.finish, replacement.restore_backup
            def interrupted_finish(db, operation, **updates):
                if (
                    phase == "published" and operation.op is FileOpType.IMPORT
                ) or (phase == "undo_stashed" and operation.op is FileOpType.TRASH):
                    os._exit(77)
                return finish(db, operation, **updates)
            def interrupted_restore(*args, **kwargs):
                restore(*args, **kwargs)
                if phase == "undo_restored":
                    os._exit(77)
            journal.finish, replacement.restore_backup = interrupted_finish, interrupted_restore
            if op:
                operations.undo(db, root, operation_id=op.id)
            else:
                upload(db, root, b"process replacement")
    """)
    result = subprocess.run(
        [sys.executable, "-c", script, str(library_root), phase], capture_output=True, timeout=30
    )
    assert result.returncode == 77, result.stderr.decode()
    session.expire_all()
    report = reconcile_pending(session, library_root)
    assert report.completed == 1 and report.failed == 0
    assert not journal.pending_operations(session)
    assert row.id == identity and row.note == "Destination note"
    assert row.bundle.rating == 4.5
    expected = b"process replacement" if phase == "published" else b"old synthetic video"
    assert (library_root / row.relative_path).read_bytes() == expected
    assert reconcile_pending(session, library_root).total == 0


# An unlinked old destination has no identity to inherit from the cataloged incoming copy
def test_unlinked_destination_replace_undo_keeps_new_catalog_row_in_trash(
    session: Session, library_root: Path
) -> None:
    (library_root / "clip.mkv").write_bytes(b"uncataloged original")
    op = upload(session, library_root, b"cataloged incoming")
    row = session.scalars(select(AssetFile)).one()
    identity = row.id
    operations.undo(session, library_root, operation_id=op.id)
    assert (library_root / "clip.mkv").read_bytes() == b"uncataloged original"
    assert row.id == identity and row.availability is FileAvailability.TRASHED
    assert (library_root / row.relative_path).read_bytes() == b"cataloged incoming"


# A bystander appearing at the commit boundary must not be overwritten by the upload or rollback
def test_publish_race_retains_both_bystander_and_backup(
    session: Session, library_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    decorated_file(session, library_root)
    publish = replacement.publish

    def intrude(source, destination):
        if source.suffix == ".part":
            destination.write_bytes(b"concurrent bystander")
        publish(source, destination)

    monkeypatch.setattr(replacement, "publish", intrude)
    with pytest.raises(ConflictError):
        upload(session, library_root, b"incoming")
    assert (library_root / "clip.mkv").read_bytes() == b"concurrent bystander"
    entries = operations.list_trash(session)[0][1]
    assert (library_root / entries[0].stored_path).read_bytes() == b"old synthetic video"


# A completed publication with a surviving staging link is still a completed copy on restart
def test_publication_cleanup_interruption_recovers(
    session: Session, library_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import os

    row = decorated_file(session, library_root)

    def linked_before_exit(source, destination):
        os.link(source, destination)
        raise Interrupted()

    with monkeypatch.context() as patch:
        patch.setattr(replacement, "publish", linked_before_exit)
        with pytest.raises(Interrupted):
            upload(session, library_root, b"fully uploaded")
    session.rollback()
    report = reconcile_pending(session, library_root)
    assert report.completed == 1 and report.failed == 0
    assert row.relative_path == "clip.mkv" and row.note == "Destination note"
    assert (library_root / "clip.mkv").read_bytes() == b"fully uploaded"
    assert not list(imports.staging_dir(library_root).iterdir())
