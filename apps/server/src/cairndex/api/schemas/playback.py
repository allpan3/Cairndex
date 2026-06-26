"""Schemas for the playback manifest (videos + subtitle tracks)."""

from pydantic import BaseModel


class SubtitleTrackRead(BaseModel):
    id: str
    language: str | None
    label: str
    format: str | None
    is_default: bool
    is_forced: bool
    kind: str  # "external" | "embedded"
    # WebVTT URL for servable external tracks; null for embedded/unsupported.
    src: str | None


class PlayableVideo(BaseModel):
    file_id: str
    display_title: str
    playable: bool
    reason: str
    mime_type: str
    stream_url: str
    width: int | None
    height: int | None
    duration: float | None
    subtitles: list[SubtitleTrackRead]


class PlaybackManifest(BaseModel):
    bundle_id: str
    videos: list[PlayableVideo]
