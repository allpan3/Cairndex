"""Schemas for playback manifests, resume progress, and watch rows."""

import math

from pydantic import BaseModel, field_validator

from cairndex.api.schemas.browse import BundleSummary


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


# Chapter metadata shown as seek-bar ticks
class PlaybackChapter(BaseModel):
    start: float
    end: float
    title: str | None


# Resume state for a playable video file
class PlaybackProgressRead(BaseModel):
    position_s: float
    duration_s: float | None
    completed: bool


# Client-reported playhead position
class PlaybackProgressUpdate(BaseModel):
    position_s: float
    duration_s: float | None = None

    # Validate numeric payloads before service-level clamping
    @field_validator("position_s", "duration_s")
    @classmethod
    def finite_non_negative(cls, value: float | None) -> float | None:
        if value is None:
            return None
        if not math.isfinite(value) or value < 0:
            raise ValueError("must be a finite non-negative number")
        return value


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
    storyboard_url: str | None
    chapters: list[PlaybackChapter]
    progress: PlaybackProgressRead | None
    subtitles: list[SubtitleTrackRead]


class PlaybackManifest(BaseModel):
    bundle_id: str
    videos: list[PlayableVideo]


# Ranked in-progress file for a continue-watching bundle row
class ContinueWatchingProgressRead(BaseModel):
    file_id: str
    position_s: float
    duration_s: float | None


# Continue-watching card row: browse summary plus direct resume position
class ContinueWatchingItem(BundleSummary):
    progress: ContinueWatchingProgressRead


# Paginated continue-watching rows
class ContinueWatchingPage(BaseModel):
    items: list[ContinueWatchingItem]
    total: int
    offset: int
    limit: int
