"""Subtitle track parsing, model invariants, and the auto-link heuristic (ADR-0003)."""

import pytest
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError
from cairndex.domain.enums import FileRole, MediaKind
from cairndex.media.subtitles import (
    format_for_path,
    is_subtitle_path,
    parse_subtitle_name,
)
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.services import bundles as bundle_service
from cairndex.services import subtitles as sub_service


# --- pure helpers ------------------------------------------------------------
def test_is_subtitle_path_and_format() -> None:
    assert is_subtitle_path("a/b/movie.en.SRT")
    assert not is_subtitle_path("a/b/movie.mkv")
    assert format_for_path("x.ssa") == "ass"
    assert format_for_path("x.vtt") == "vtt"
    assert format_for_path("x.mkv") is None


def test_parse_subtitle_name_peels_language_and_forced() -> None:
    assert parse_subtitle_name("movie.en.forced.srt") == _parsed("movie", "en", True)
    assert parse_subtitle_name("movie.eng.srt") == _parsed("movie", "eng", False)
    assert parse_subtitle_name("movie.srt") == _parsed("movie", None, False)
    assert parse_subtitle_name("the.matrix.srt") == _parsed("the.matrix", None, False)
    assert parse_subtitle_name("films/movie.fr.srt").video_stem == "movie"


def _parsed(stem: str, lang: str | None, forced: bool):
    from cairndex.media.subtitles import ParsedSubtitleName

    return ParsedSubtitleName(video_stem=stem, language=lang, is_forced=forced)


# --- service + model ---------------------------------------------------------
def _bundle_with_files(session: Session) -> tuple[AssetBundle, AssetFile]:
    bundle = bundle_service.create_bundle(session, title="Movie")
    video = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="films/movie.mkv",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    return bundle, video


def test_external_track_unique_per_source(session: Session) -> None:
    bundle, video = _bundle_with_files(session)
    sub = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="films/movie.en.srt",
        role=FileRole.SUBTITLE,
        media_kind=MediaKind.SUBTITLE,
    )
    sub_service.create_external_track(
        session, bundle_id=bundle.id, source_file_id=sub.id, video_file_id=video.id
    )
    session.flush()
    with pytest.raises(ConflictError):
        sub_service.create_external_track(
            session, bundle_id=bundle.id, source_file_id=sub.id, video_file_id=video.id
        )


def test_embedded_track_requires_unique_stream(session: Session) -> None:
    bundle, video = _bundle_with_files(session)
    sub_service.create_embedded_track(
        session, bundle_id=bundle.id, video_file_id=video.id, embedded_index=2, language="en"
    )
    session.flush()
    with pytest.raises(ConflictError):
        sub_service.create_embedded_track(
            session, bundle_id=bundle.id, video_file_id=video.id, embedded_index=2
        )


def test_auto_link_matches_same_dir_basename(session: Session) -> None:
    bundle, video = _bundle_with_files(session)
    sub = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="films/movie.en.forced.srt",
        role=FileRole.SUBTITLE,
        media_kind=MediaKind.SUBTITLE,
    )
    orphan = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="films/other.srt",
        role=FileRole.SUBTITLE,
        media_kind=MediaKind.SUBTITLE,
    )
    session.flush()

    created = sub_service.auto_link_external_subtitles(session, bundle.id)
    session.commit()

    by_source = {t.source_file_id: t for t in created}
    assert by_source[sub.id].video_file_id == video.id
    assert by_source[sub.id].language == "en"
    assert by_source[sub.id].is_forced is True
    assert by_source[sub.id].format == "srt"
    assert by_source[orphan.id].video_file_id is None

    assert sub_service.auto_link_external_subtitles(session, bundle.id) == []
    assert len(sub_service.list_tracks(session, bundle.id)) == 2


def test_sync_embedded_tracks_from_metadata(session: Session) -> None:
    _bundle, video = _bundle_with_files(session)
    video.tech_metadata = {
        "embedded_subtitles": [
            {"index": 2, "codec": "subrip", "language": "eng"},
            {"index": 3, "codec": "ass", "language": None},
        ]
    }
    session.flush()

    created = sub_service.sync_embedded_tracks(session, video)
    assert {t.embedded_index for t in created} == {2, 3}
    assert created[0].language == "eng"
    assert created[0].format == "subrip"
    assert all(t.video_file_id == video.id for t in created)

    assert sub_service.sync_embedded_tracks(session, video) == []
    assert len(sub_service.list_tracks_for_video(session, video.id)) == 2


def test_classify_recognizes_subtitle_extensions() -> None:
    from cairndex.domain.enums import MediaKind as MK
    from cairndex.scanning.media_types import classify

    assert classify("movie.srt") == (MK.SUBTITLE, FileRole.SUBTITLE)
    assert classify("movie.sbv") == (MK.SUBTITLE, FileRole.SUBTITLE)


def test_attach_and_delete(session: Session) -> None:
    bundle, video = _bundle_with_files(session)
    sub = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="films/loose.srt",
        role=FileRole.SUBTITLE,
        media_kind=MediaKind.SUBTITLE,
    )
    track = sub_service.create_external_track(session, bundle_id=bundle.id, source_file_id=sub.id)
    session.flush()
    assert track.video_file_id is None

    sub_service.attach_to_video(session, track.id, video.id)
    assert sub_service.get_track(session, track.id).video_file_id == video.id

    sub_service.delete_track(session, track.id)
    assert sub_service.list_tracks(session, bundle.id) == []
