"""Subtitle track domain service (ADR-0003).

Tracks link a subtitle (external ``AssetFile`` or embedded ``ffprobe`` stream)
to a video file. ``auto_link_external_subtitles`` applies the same-directory +
basename heuristic; ambiguous subtitles are left unlinked for manual
attachment — never guessed destructively (AGENTS.md §4.9).
"""

from __future__ import annotations

import posixpath

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.domain.enums import MediaKind
from cairndex.media.subtitles import format_for_path, is_subtitle_path, parse_subtitle_name
from cairndex.persistence.models import AssetFile, SubtitleTrack


def get_track(session: Session, track_id: str) -> SubtitleTrack:
    track = session.get(SubtitleTrack, track_id)
    if track is None:
        raise NotFoundError(f"subtitle track {track_id!r} not found")
    return track


def list_tracks(session: Session, bundle_id: str) -> list[SubtitleTrack]:
    stmt = (
        select(SubtitleTrack)
        .where(SubtitleTrack.bundle_id == bundle_id)
        .order_by(SubtitleTrack.sort_order, SubtitleTrack.created_at)
    )
    return list(session.scalars(stmt))


def list_tracks_for_video(session: Session, video_file_id: str) -> list[SubtitleTrack]:
    stmt = (
        select(SubtitleTrack)
        .where(SubtitleTrack.video_file_id == video_file_id)
        .order_by(SubtitleTrack.sort_order, SubtitleTrack.created_at)
    )
    return list(session.scalars(stmt))


def _require_file(session: Session, file_id: str) -> AssetFile:
    f = session.get(AssetFile, file_id)
    if f is None:
        raise ValidationError(f"asset file {file_id!r} does not exist")
    return f


def create_external_track(
    session: Session,
    *,
    bundle_id: str,
    source_file_id: str,
    video_file_id: str | None = None,
    language: str | None = None,
    label: str | None = None,
    format: str | None = None,
    is_default: bool = False,
    is_forced: bool = False,
    sort_order: int = 0,
) -> SubtitleTrack:
    _require_file(session, source_file_id)
    if video_file_id is not None:
        _require_file(session, video_file_id)
    track = SubtitleTrack(
        bundle_id=bundle_id,
        source_file_id=source_file_id,
        video_file_id=video_file_id,
        language=language,
        label=label,
        format=format,
        is_default=is_default,
        is_forced=is_forced,
        sort_order=sort_order,
    )
    session.add(track)
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError(f"file {source_file_id!r} already backs a subtitle track") from exc
    return track


def create_embedded_track(
    session: Session,
    *,
    bundle_id: str,
    video_file_id: str,
    embedded_index: int,
    language: str | None = None,
    label: str | None = None,
    format: str | None = None,
    is_default: bool = False,
    is_forced: bool = False,
    sort_order: int = 0,
) -> SubtitleTrack:
    _require_file(session, video_file_id)
    track = SubtitleTrack(
        bundle_id=bundle_id,
        video_file_id=video_file_id,
        embedded_index=embedded_index,
        language=language,
        label=label,
        format=format,
        is_default=is_default,
        is_forced=is_forced,
        sort_order=sort_order,
    )
    session.add(track)
    try:
        session.flush()
    except IntegrityError as exc:
        raise ConflictError(
            f"stream {embedded_index} of {video_file_id!r} is already a track"
        ) from exc
    return track


def attach_to_video(session: Session, track_id: str, video_file_id: str) -> SubtitleTrack:
    """Manually (re)link a track to a video — the correction path (§4.9)."""
    track = get_track(session, track_id)
    _require_file(session, video_file_id)
    track.video_file_id = video_file_id
    session.flush()
    return track


def delete_track(session: Session, track_id: str) -> None:
    session.delete(get_track(session, track_id))
    session.flush()


def sync_embedded_tracks(session: Session, video_file: AssetFile) -> list[SubtitleTrack]:
    """Create tracks for embedded subtitle streams found by ffprobe.

    Reads ``tech_metadata['embedded_subtitles']`` (populated by the probe step)
    and adds one track per not-yet-seen stream index. Idempotent, so a reprobe
    never duplicates tracks.
    """
    meta = video_file.tech_metadata or {}
    streams = meta.get("embedded_subtitles") or []
    existing = {
        t.embedded_index
        for t in list_tracks_for_video(session, video_file.id)
        if t.embedded_index is not None
    }
    created: list[SubtitleTrack] = []
    for stream in streams:
        index = stream.get("index")
        if index is None or index in existing:
            continue
        created.append(
            create_embedded_track(
                session,
                bundle_id=video_file.bundle_id,
                video_file_id=video_file.id,
                embedded_index=index,
                language=stream.get("language"),
                format=stream.get("codec"),
            )
        )
        existing.add(index)
    return created


def auto_link_external_subtitles(session: Session, bundle_id: str) -> list[SubtitleTrack]:
    """Create tracks for unlinked external subtitle files in a bundle.

    Matches a subtitle to a video in the **same directory** whose basename
    equals the subtitle's basename minus a trailing language/forced suffix.
    Idempotent: subtitle files that already back a track are skipped.
    """
    files = list(session.scalars(select(AssetFile).where(AssetFile.bundle_id == bundle_id)))
    subtitles = [
        f for f in files if f.media_kind == MediaKind.SUBTITLE or is_subtitle_path(f.relative_path)
    ]
    videos = [f for f in files if f.media_kind == MediaKind.VIDEO]

    already_linked = {
        t.source_file_id for t in list_tracks(session, bundle_id) if t.source_file_id is not None
    }

    # Index videos by (directory, stem) for an exact basename match.
    by_dir_stem: dict[tuple[str, str], AssetFile] = {}
    for v in videos:
        d = posixpath.dirname(v.relative_path)
        stem = posixpath.splitext(posixpath.basename(v.relative_path))[0]
        by_dir_stem.setdefault((d, stem), v)

    created: list[SubtitleTrack] = []
    for sub in subtitles:
        if sub.id in already_linked:
            continue
        parsed = parse_subtitle_name(sub.relative_path)
        video = by_dir_stem.get((posixpath.dirname(sub.relative_path), parsed.video_stem))
        track = create_external_track(
            session,
            bundle_id=bundle_id,
            source_file_id=sub.id,
            video_file_id=video.id if video is not None else None,
            language=parsed.language,
            is_forced=parsed.is_forced,
            format=format_for_path(sub.relative_path),
            sort_order=len(created),
        )
        created.append(track)
    return created
