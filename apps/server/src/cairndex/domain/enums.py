from enum import StrEnum


class LibraryStatus(StrEnum):
    """Whether a registered library's root/marker is currently reachable.

    Server-registry state (ADR-0008), distinct from a library's own content
    metadata. ``unavailable`` means the root path or ``.cairndex`` marker
    could not be found when last probed (e.g. an offline NAS mount).
    """

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


class JobType(StrEnum):
    """Kind of background job (AGENTS.md §4.10/§5.2)."""

    SCAN = "scan"
    PROBE = "probe"
    THUMBNAIL = "thumbnail"


class JobStatus(StrEnum):
    """Lifecycle state of a background job."""

    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class Grouping(StrEnum):
    """How fast-add groups selected files into bundles."""

    PER_FILE = "per_file"  # one bundle per file (the scan default)
    SINGLE_BUNDLE = "single_bundle"  # one bundle holding all selected files
