"""Classify a filename into a media kind + default in-bundle role by extension."""

from cairndex.domain.enums import FileRole, MediaKind
from cairndex.media.subtitles import SUBTITLE_EXTENSIONS

_VIDEO = {"mp4", "mkv", "avi", "mov", "wmv", "m4v", "ts", "webm", "flv", "mpg", "mpeg", "m2ts"}
_IMAGE = {"jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "heic"}
_SUBTITLE = SUBTITLE_EXTENSIONS  # canonical set lives in media.subtitles
_AUDIO = {"mp3", "flac", "aac", "wav", "ogg", "m4a", "opus"}


def classify(filename: str) -> tuple[MediaKind, FileRole] | None:
    """Return (kind, default role) for a supported file, or None to skip it.

    Dotfiles and unknown extensions are skipped so the scanner ignores system
    files, sidecar junk, and non-media content.
    """
    if filename.startswith("."):
        return None
    _, _, ext = filename.rpartition(".")
    ext = ext.lower()
    if not ext or ext == filename.lower():
        return None
    if ext in _VIDEO:
        return MediaKind.VIDEO, FileRole.PRIMARY_VIDEO
    if ext in _IMAGE:
        return MediaKind.IMAGE, FileRole.IMAGE
    if ext in _SUBTITLE:
        return MediaKind.SUBTITLE, FileRole.SUBTITLE
    if ext in _AUDIO:
        return MediaKind.AUDIO, FileRole.ATTACHMENT
    return None
