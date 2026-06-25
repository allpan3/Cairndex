from enum import StrEnum


class StorageRootStatus(StrEnum):
    """Whether a storage root's canonical path is currently reachable."""

    AVAILABLE = "available"
    UNAVAILABLE = "unavailable"


class FileRole(StrEnum):
    """Role of an asset file within its bundle (AGENTS.md §4.3)."""

    PRIMARY_VIDEO = "primary_video"
    VIDEO_PART = "video_part"
    ALTERNATE_VERSION = "alternate_version"
    COVER = "cover"
    IMAGE = "image"
    SCREENSHOT = "screenshot"
    ALBUM_IMAGE = "album_image"
    SUBTITLE = "subtitle"
    ATTACHMENT = "attachment"
    GENERATED_DERIVATIVE = "generated_derivative"
    OTHER = "other"


class MediaKind(StrEnum):
    """Coarse media classification, independent of the in-bundle role."""

    VIDEO = "video"
    IMAGE = "image"
    SUBTITLE = "subtitle"
    AUDIO = "audio"
    OTHER = "other"


class FileAvailability(StrEnum):
    """File presence on disk. Distinct from metadata deletion (ADR-0002)."""

    AVAILABLE = "available"
    MISSING = "missing"
