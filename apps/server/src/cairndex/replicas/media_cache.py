"""Private derivatives reuse the production decoders without mutating catalog choices"""

import os
from pathlib import Path

from cairndex.core.errors import ValidationError
from cairndex.domain.enums import MediaKind
from cairndex.media import derived_cache, playback, previews, thumbnails
from cairndex.media.hls import BurnSubtitle
from cairndex.media.subtitles import extension_of
from cairndex.persistence.models import AssetFile
from cairndex.replicas.media import ReplicaMedia, generation, open_source
from cairndex.replicas.protocol import ReplicaError


# Cache publication requires the same current source generation before and after derivation
def preview(media: ReplicaMedia, file_id: str, size: int) -> Path:
    _, asset = media.resolve_file(file_id)
    if asset.media_kind != MediaKind.IMAGE:
        raise ValidationError("Only images have previews")
    token = asset.quick_fingerprint or ""
    dest = media.cache("previews", file_id, token, f"-{size}.webp")
    with open_source(media.root, asset.relative_path) as handle:
        if generation(asset.relative_path, os.fstat(handle)) != token:
            raise ReplicaError("Local image changed; retry preview")
        path = previews._preview_for_source(
            Path(f"/dev/fd/{handle}"), dest, previews._preview_size(size), token
        )
    media.validate(file_id, token)
    return path


# Cover timestamp is read from authored metadata and never selected by a local probe
def thumbnail(media: ReplicaMedia, file_id: str) -> Path:
    source, asset = media.resolve_file(file_id)
    if asset.media_kind == MediaKind.IMAGE:
        return preview(media, file_id, 640)
    if asset.media_kind != MediaKind.VIDEO:
        raise ValidationError("Only video and images have thumbnails")
    token = asset.quick_fingerprint or ""
    dest = media.cache("thumbnails", file_id, f"{token}:{asset.cover_time}", ".jpg")
    with derived_cache.locked(dest):
        if not dest.exists():
            temp = dest.with_suffix(".tmp.jpg")
            try:
                with media.input_scope({file_id: token}):
                    thumbnails._generate(source, temp, asset.media_kind, asset.cover_time)
                media.validate(file_id, token)
                temp.replace(dest)
            finally:
                temp.unlink(missing_ok=True)
    media.validate(file_id, token)
    return dest


# SRT/VTT retain their authored track identity and are converted under a source-specific key
def subtitle(media: ReplicaMedia, track_id: str) -> Path:
    track = media.row("subtitle_tracks", track_id)
    if track["source_file_id"] is None:
        raise ValidationError("Embedded subtitles use the existing burn-in playback path")
    source_id = track["source_file_id"]
    _, asset = media.resolve_file(source_id)
    extension = extension_of(asset.relative_path)
    if extension not in ("srt", "vtt"):
        raise ValidationError(
            "Only SRT and VTT have browser text tracks; other formats require burn-in"
        )
    token = asset.quick_fingerprint or ""
    dest = media.cache("subtitles", track_id, token, ".vtt")
    with derived_cache.locked(dest):
        if not dest.exists():
            with open_source(media.root, asset.relative_path) as handle:
                if generation(asset.relative_path, os.fstat(handle)) != token:
                    raise ReplicaError("Local subtitle changed; retry playback")
                with os.fdopen(os.dup(handle), "rb") as stream:
                    raw = stream.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValidationError("Subtitle exceeds the 8 MiB local text-track limit")
            text = raw.decode("utf-8", errors="replace")
            media.validate(source_id, token)
            dest.write_text(
                text if extension == "vtt" else playback._srt_to_vtt(text), encoding="utf-8"
            )
    media.validate(source_id, token)
    return dest


# Resolve only cataloged subtitle references belonging to the current video and bundle
def burn_subtitle(
    media: ReplicaMedia, asset: AssetFile, video_path: Path, track_id: str
) -> BurnSubtitle:
    from cairndex.api.v1.playback_sessions import _relative_subtitle_index

    track = media.row("subtitle_tracks", track_id)
    if track["bundle_id"] != asset.bundle_id or track["video_file_id"] not in (None, asset.id):
        raise ValidationError("Subtitle track does not belong to this video")
    if track["source_file_id"]:
        source, _ = media.resolve_file(track["source_file_id"])
        return BurnSubtitle(path=source, stream_index=None)
    index = _relative_subtitle_index(asset.tech_metadata or {}, track["embedded_index"])
    if index is None:
        raise ValidationError("Cataloged embedded subtitle is unavailable in this local file")
    return BurnSubtitle(path=video_path, stream_index=index)
