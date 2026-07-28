"""Playback decision matrix (plan 1 §6.1): a pure caps × source function.

The bulk of coverage is the pure ``decide_playback`` function across a
capability × source matrix, including legacy rows missing M1 probe keys (which
must degrade safely, never raise). One HTTP test covers the direct-decision
response shape end to end; non-direct decisions (which start an HLS session) are
covered in ``test_hls_sessions.py`` with a fake ffmpeg.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileRole, MediaKind
from cairndex.media.playback import (
    CapabilityProfile,
    PlaybackDecision,
    decide_playback,
    default_audio_stream_index,
    normalize_audio_codec,
    normalize_container,
    normalize_video_codec,
)
from cairndex.services import bundles as bundle_service

# A representative modern web client: MP4/WebM progressive + common codecs.
_CAPS = CapabilityProfile.build(
    containers=["mp4", "webm"],
    video_codecs=["h264", "vp9", "av1"],
    audio_codecs=["aac", "opus", "mp3"],
    max_height=2160,
    native_hls=False,
)


def _method(
    *,
    ext: str,
    video_codec: str | None = "h264",
    audio_codec: str | None = "aac",
    source_height: int | None = None,
    audio_stream_index: int | None = None,
    default_audio_index: int | None = None,
    burn_subtitle: bool = False,
    requested_max_height: int | None = None,
    video_codec_tag: str | None = None,
    caps: CapabilityProfile = _CAPS,
) -> str:
    return decide_playback(
        caps,
        ext=ext,
        video_codec=video_codec,
        audio_codec=audio_codec,
        video_codec_tag=video_codec_tag,
        source_height=source_height,
        audio_stream_index=audio_stream_index,
        default_audio_index=default_audio_index,
        burn_subtitle=burn_subtitle,
        requested_max_height=requested_max_height,
    ).method


# --- normalization ----------------------------------------------------------
def test_container_and_codec_normalization() -> None:
    assert normalize_container("m4v") == "mp4"
    assert normalize_container(".MP4") == "mp4"
    assert normalize_container("mkv") == "mkv"
    assert normalize_container("mov") == "mov"
    assert normalize_container(None) is None
    assert normalize_video_codec("AVC1") == "h264"
    assert normalize_video_codec("hevc") == "hevc"
    assert normalize_video_codec("h265") == "hevc"
    assert normalize_video_codec(None) is None
    assert normalize_audio_codec("mp4a") == "aac"
    assert normalize_audio_codec("E-AC-3") == "eac3"


# --- the core matrix --------------------------------------------------------
def test_direct_when_container_and_codecs_supported() -> None:
    assert _method(ext="mp4", video_codec="h264", audio_codec="aac") == "direct"
    assert _method(ext="m4v", video_codec="h264", audio_codec="aac") == "direct"  # m4v→mp4
    assert _method(ext="webm", video_codec="vp9", audio_codec="opus") == "direct"


# --- HEVC codec tags --------------------------------------------------------
# An Apple client: HEVC decodes, but only when the container labels it `hvc1`.
# `hev1` is advertised by MediaSource yet refused by AVFoundation, so it must
# never reach the direct path.
_APPLE_CAPS = CapabilityProfile.build(
    containers=["mp4"],
    video_codecs=["h264", "hevc", "hvc1"],
    audio_codecs=["aac"],
    max_height=2160,
    native_hls=True,
)


def test_hvc1_tagged_hevc_plays_directly_on_an_apple_client() -> None:
    assert (
        _method(ext="mp4", video_codec="hevc", video_codec_tag="hvc1", caps=_APPLE_CAPS) == "direct"
    )


def test_hev1_tagged_hevc_remuxes_rather_than_transcoding() -> None:
    # The codec family is supported — only the container's label is wrong — so
    # this must stay a stream copy. Transcoding here would re-encode a whole
    # HEVC feature film to fix four bytes of metadata.
    assert (
        _method(ext="mp4", video_codec="hevc", video_codec_tag="hev1", caps=_APPLE_CAPS) == "remux"
    )


def test_hev1_plays_directly_when_the_client_confirms_that_tag() -> None:
    caps = CapabilityProfile.build(
        containers=["mp4"],
        video_codecs=["hevc", "hvc1", "hev1"],
        audio_codecs=["aac"],
        max_height=2160,
        native_hls=False,
    )
    assert _method(ext="mp4", video_codec="hevc", video_codec_tag="hev1", caps=caps) == "direct"


def test_missing_or_meaningless_codec_tag_stays_optimistic() -> None:
    # Rows probed before the tag was recorded, and containers that carry no tag
    # at all (ffprobe reports "[0][0][0][0]"), keep their pre-existing decision.
    assert (
        _method(ext="mp4", video_codec="hevc", video_codec_tag=None, caps=_APPLE_CAPS) == "direct"
    )
    assert (
        _method(ext="mp4", video_codec="hevc", video_codec_tag="[0][0][0][0]", caps=_APPLE_CAPS)
        == "direct"
    )


def test_codec_tag_does_not_override_an_unsupported_codec_family() -> None:
    # No HEVC at all → transcode, regardless of how the source is tagged.
    assert _method(ext="mp4", video_codec="hevc", video_codec_tag="hvc1") == "transcode"


def test_non_discriminating_tags_are_ignored() -> None:
    # avc1 is the only tag H.264 uses in MP4; testing it against caps would
    # refuse every ordinary file, so only the HEVC pair is discriminating.
    assert _method(ext="mp4", video_codec="h264", video_codec_tag="avc1") == "direct"


def test_remux_when_codecs_supported_but_container_not() -> None:
    # The huge MKV-with-H.264 class: copy streams into fMP4, no re-encode.
    assert _method(ext="mkv", video_codec="h264", audio_codec="aac") == "remux"
    assert _method(ext="mov", video_codec="h264", audio_codec="aac") == "remux"


def test_transcode_when_video_codec_unsupported() -> None:
    assert _method(ext="mp4", video_codec="hevc", audio_codec="aac") == "transcode"
    assert _method(ext="mkv", video_codec="hevc", audio_codec="aac") == "transcode"


def test_remux_when_only_audio_codec_unsupported() -> None:
    assert _method(ext="mp4", video_codec="h264", audio_codec="dts") == "remux"
    assert _method(ext="mp4", video_codec="h264", audio_codec="ac3") == "remux"


def test_transcode_when_source_exceeds_height_cap() -> None:
    # Caps cap at 2160; an 8K source must be downscaled → transcode.
    assert (
        _method(ext="mp4", video_codec="h264", audio_codec="aac", source_height=4320) == "transcode"
    )
    # A per-request cap tighter than the source also forces transcode.
    assert (
        _method(
            ext="mp4",
            video_codec="h264",
            audio_codec="aac",
            source_height=1080,
            requested_max_height=720,
        )
        == "transcode"
    )
    # Under the cap stays direct.
    assert _method(ext="mp4", video_codec="h264", audio_codec="aac", source_height=1080) == "direct"


def test_non_default_audio_track_forces_at_least_remux() -> None:
    # Progressive can't switch tracks; selecting a non-default one needs remux.
    assert (
        _method(
            ext="mp4",
            video_codec="h264",
            audio_codec="aac",
            audio_stream_index=3,
            default_audio_index=1,
        )
        == "remux"
    )
    # Selecting the default track is a no-op → still direct.
    assert (
        _method(
            ext="mp4",
            video_codec="h264",
            audio_codec="aac",
            audio_stream_index=1,
            default_audio_index=1,
        )
        == "direct"
    )


def test_burn_in_subtitle_forces_transcode() -> None:
    assert (
        _method(ext="mp4", video_codec="h264", audio_codec="aac", burn_subtitle=True) == "transcode"
    )


def test_video_codec_precedes_container_and_audio() -> None:
    # An MKV/HEVC/DTS source: the most restrictive need (video re-encode) wins.
    assert _method(ext="mkv", video_codec="hevc", audio_codec="dts") == "transcode"


# --- legacy rows missing M1 keys (must degrade safely) ----------------------
def test_legacy_rows_without_codecs_degrade_safely() -> None:
    # Unknown codecs are optimistic (like assess_playability); container decides.
    assert _method(ext="mp4", video_codec=None, audio_codec=None) == "direct"
    assert _method(ext="mkv", video_codec=None, audio_codec=None) == "remux"
    # Unknown container extension + unknown codecs → not in caps → remux.
    assert _method(ext="", video_codec=None, audio_codec=None) == "remux"


def test_empty_caps_never_direct_but_never_raises() -> None:
    # A client that declares nothing can't play anything directly; an unsupported
    # video codec dominates → transcode (and it must never raise).
    empty = CapabilityProfile.build()
    assert _method(ext="mp4", video_codec="h264", audio_codec="aac", caps=empty) == "transcode"


# --- helpers ----------------------------------------------------------------
def test_session_kind_maps_direct_to_remux() -> None:
    assert PlaybackDecision("direct", "").session_kind == "remux"
    assert PlaybackDecision("remux", "").session_kind == "remux"
    assert PlaybackDecision("transcode", "").session_kind == "transcode"


def test_default_audio_stream_index_prefers_flagged_then_first() -> None:
    assert default_audio_stream_index([]) is None
    assert default_audio_stream_index([{"index": 1}, {"index": 2}]) == 1
    assert default_audio_stream_index([{"index": 1}, {"index": 2, "default": True}]) == 2


# --- HTTP: the direct decision response shape -------------------------------
def test_playback_decision_endpoint_returns_direct_with_metadata(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    (library_root / "movie.mp4").write_bytes(bytes(range(256)))
    bundle = bundle_service.create_bundle(session, title="Movie")
    video = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="movie.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    video.tech_metadata = {
        "duration": 30.0,
        "width": 640,
        "height": 360,
        "video_codec": "h264",
        "audio_codec": "aac",
        "audio_streams": [
            {"index": 1, "codec": "aac", "channels": 2, "language": "eng", "default": True}
        ],
        "chapters": [{"start": 0.0, "end": 30.0, "title": "Intro"}],
    }
    session.commit()

    body = client.post(
        f"/api/v1/libraries/{library_id}/files/{video.id}/playback-decision",
        json={"caps": {"containers": ["mp4"], "video_codecs": ["h264"], "audio_codecs": ["aac"]}},
    ).json()

    assert body["method"] == "direct"
    assert body["stream_url"] == f"/api/v1/libraries/{library_id}/files/{video.id}/stream"
    assert body["session"] is None
    assert body["duration"] == 30.0
    assert body["audio_streams"][0]["codec"] == "aac"
    assert body["chapters"] == [{"start": 0.0, "end": 30.0, "title": "Intro"}]
    assert body["progress"] is None


def test_playback_decision_requires_a_video_file(
    client: TestClient, library_id: str, session: Session, library_root: Path
) -> None:
    (library_root / "photo.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    bundle = bundle_service.create_bundle(session, title="Album")
    image = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="photo.png",
        role=FileRole.IMAGE,
        media_kind=MediaKind.IMAGE,
    )
    session.commit()

    resp = client.post(
        f"/api/v1/libraries/{library_id}/files/{image.id}/playback-decision",
        json={"caps": {"containers": ["mp4"]}},
    )
    assert resp.status_code == 422
