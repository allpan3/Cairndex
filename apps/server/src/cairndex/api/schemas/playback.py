"""Schemas for playback manifests, resume progress, and watch rows."""

import math

from pydantic import BaseModel, Field, field_validator

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


class CoverFrameUpdate(BaseModel):
    """Owner-selected timestamp for a video's generated cover thumbnail."""

    time: float

    @field_validator("time")
    @classmethod
    def finite_non_negative(cls, value: float) -> float:
        if not math.isfinite(value) or value < 0:
            raise ValueError("time must be a finite non-negative number")
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


# --- Playback decision + HLS sessions (plan 1 §6.1/§6.2) --------------------


# A client's declared playback capabilities. The client computes these at
# startup (canPlayType/MediaSource.isTypeSupported) or hardcodes them per
# platform; the server decides direct/remux/transcode from them.
class ClientCapabilities(BaseModel):
    protocols: list[str] = Field(default_factory=list)
    containers: list[str] = Field(default_factory=list)
    video_codecs: list[str] = Field(default_factory=list)
    audio_codecs: list[str] = Field(default_factory=list)
    max_height: int | None = None
    native_hls: bool = False


# One selectable audio track from the source's probed streams
class AudioStreamRead(BaseModel):
    index: int | None
    codec: str | None
    channels: int | None
    language: str | None
    title: str | None
    default: bool


# Reference to a started HLS session (present when method != direct)
class PlaybackSessionRef(BaseModel):
    id: str
    playlist_url: str


# Per-file playback decision request (§6.1)
class PlaybackDecisionRequest(BaseModel):
    caps: ClientCapabilities
    audio_stream_index: int | None = None
    burn_subtitle_track_id: str | None = None
    max_height: int | None = None


# Decision response: how to play plus the metadata the player needs up front
class PlaybackDecisionResponse(BaseModel):
    method: str  # "direct" | "remux" | "transcode"
    reason: str
    stream_url: str | None  # direct only
    session: PlaybackSessionRef | None  # remux/transcode only
    duration: float | None
    audio_streams: list[AudioStreamRead]
    subtitles: list[SubtitleTrackRead]
    chapters: list[PlaybackChapter]
    storyboard_url: str | None
    progress: PlaybackProgressRead | None


# Explicit HLS session creation (§6.2) — e.g. a quality/audio switch mid-play
class PlaybackSessionCreate(BaseModel):
    caps: ClientCapabilities
    start_s: float | None = None
    audio_stream_index: int | None = None
    burn_subtitle_track_id: str | None = None
    max_height: int | None = None

    @field_validator("start_s")
    @classmethod
    def finite_non_negative(cls, value: float | None) -> float | None:
        if value is None:
            return None
        if not math.isfinite(value) or value < 0:
            raise ValueError("start_s must be a finite non-negative number")
        return value


class PlaybackSessionCreated(BaseModel):
    session_id: str
    playlist_url: str
    kind: str  # "remux" | "transcode"
