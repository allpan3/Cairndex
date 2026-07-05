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
    STORYBOARD = "storyboard"


class JobStatus(StrEnum):
    """Lifecycle state of a background job."""

    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class JobPhase(StrEnum):
    """Coarse stage a running job is in, for human-readable progress.

    Phases are advisory labels surfaced in the UI, not a strict state machine:
    a scan moves through ``discovering`` → ``reconciling`` → ``grouping`` →
    ``finalizing``; probe/thumbnail/storyboard jobs report their media phase.
    Stored as a plain string column so new phases never require a migration.
    """

    DISCOVERING = "discovering"
    RECONCILING = "reconciling"
    GROUPING = "grouping"
    PROBING = "probing"
    THUMBNAILING = "thumbnailing"
    STORYBOARDING = "storyboarding"
    FINALIZING = "finalizing"


class Grouping(StrEnum):
    """How fast-add groups selected files into bundles."""

    PER_FILE = "per_file"  # one bundle per file (the scan default)
    SINGLE_BUNDLE = "single_bundle"  # one bundle holding all selected files


class GroupingState(StrEnum):
    """Whether a bundle's grouping is a confirmed user decision (ADR-0009).

    Scan discovers files and stages them in ``provisional`` bundles; only an
    explicit user action (review/apply, fast-add, manual create) confirms a
    grouping. Confirmed groupings are durable and win over heuristics on
    re-scan — they are never silently re-split, merged, or retitled.
    """

    PROVISIONAL = "provisional"
    CONFIRMED = "confirmed"


class GroupingSource(StrEnum):
    """What produced a bundle's current grouping (ADR-0009).

    ``legacy`` backfills bundles created before grouping state existed (they are
    treated as already confirmed). ``scan_suggestion`` marks provisional bundles
    staged by a scan; ``manual``/``fast_add``/``import`` mark groupings the user
    decided directly, so they confirm immediately.
    """

    LEGACY = "legacy"
    SCAN_SUGGESTION = "scan_suggestion"
    MANUAL = "manual"
    FAST_ADD = "fast_add"
    IMPORT = "import"


class ProposalKind(StrEnum):
    """Whether a grouping proposal makes a bundle or a logical container (ADR-0009).

    ``container`` is a logical-collection suggestion (its members are the bundles
    proposed inside it), never a filesystem-synced rule.
    """

    BUNDLE = "bundle"
    CONTAINER = "container"


class GroupingPlanStatus(StrEnum):
    """Lifecycle of a durable grouping plan (ADR-0009).

    A plan is a snapshot of suggestions: ``open`` until the user applies it
    (``applied``), regeneration ``superseded`` it, or it was ``cancelled``.
    """

    OPEN = "open"
    APPLIED = "applied"
    SUPERSEDED = "superseded"
    CANCELLED = "cancelled"
