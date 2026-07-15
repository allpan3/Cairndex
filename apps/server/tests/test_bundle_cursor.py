"""Ordered bundle-media cursor selection and persistence."""

from sqlalchemy.orm import Session

from cairndex.domain.enums import FileAvailability, FileRole, MediaKind
from cairndex.persistence.models import BundleCursor
from cairndex.services import bundle_cursor, bundles, playback_progress


# Add one ordered file through the public bundle service
def _file(
    session: Session,
    bundle_id: str,
    path: str,
    kind: MediaKind,
    sequence: int,
):
    return bundles.add_file(
        session,
        bundle_id,
        relative_path=path,
        role=FileRole.IMAGE if kind is MediaKind.IMAGE else FileRole.VIDEO_PART,
        media_kind=kind,
        sequence=sequence,
    )


# Explicit cursor wins over legacy video progress and first-file fallback
def test_cursor_selects_one_ordered_media_location(session: Session) -> None:
    bundle = bundles.create_bundle(session, title="Album")
    image = _file(session, bundle.id, "album/01.jpg", MediaKind.IMAGE, 0)
    video = _file(session, bundle.id, "album/02.mp4", MediaKind.VIDEO, 1)

    assert bundle_cursor.current_file(session, bundle.id) is image
    playback_progress.upsert_progress(session, video.id, position_s=12, duration_s=100)
    assert bundle_cursor.current_file(session, bundle.id) is video

    bundle_cursor.set_cursor(session, bundle.id, image.id)
    assert bundle_cursor.current_file(session, bundle.id) is image


# A remembered file stays current when its path later becomes unavailable
def test_cursor_preserves_missing_current_file(session: Session) -> None:
    bundle = bundles.create_bundle(session, title="Movie")
    video = _file(session, bundle.id, "movie/feature.mp4", MediaKind.VIDEO, 0)
    bundle_cursor.set_cursor(session, bundle.id, video.id)
    video.availability = FileAvailability.MISSING
    session.flush()

    assert bundle_cursor.current_file(session, bundle.id) is video


# Reparenting a current file clears the source bundle's now-invalid cursor
def test_reparenting_current_file_clears_cursor(session: Session) -> None:
    source = bundles.create_bundle(session, title="Source")
    target = bundles.create_bundle(session, title="Target")
    video = _file(session, source.id, "movie/feature.mp4", MediaKind.VIDEO, 0)
    bundle_cursor.set_cursor(session, source.id, video.id)

    video.bundle_id = target.id
    session.flush()
    session.expire_all()

    assert session.get(BundleCursor, source.id) is None
