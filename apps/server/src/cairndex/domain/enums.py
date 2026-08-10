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
    """File presence on disk. Distinct from metadata deletion (ADR-0002).

    ``trashed`` is the third state, added by write mode (ADR-0013 §3.2): the
    file has been moved into the library's own trash and is recoverable. It is
    deliberately **not** ``missing`` — missing means "we do not know where this
    went", which is the scanner's problem to solve, whereas trashed means "we
    put it there, and here is how to put it back". Surfaces that require a
    readable file already test for ``available``, so they exclude it for free;
    the Missing Files view tests for ``missing``, so a trashed file does not
    appear there either.
    """

    AVAILABLE = "available"
    MISSING = "missing"
    TRASHED = "trashed"


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


# Controls how aggressively filename stems combine files within one directory
class StemMode(StrEnum):
    """Sensitivity used by grouping-plan stem matching."""

    NARROW = "narrow"
    BALANCED = "balanced"
    WIDE = "wide"


class ProposalKind(StrEnum):
    """Whether a grouping proposal makes a bundle or a logical container (ADR-0009).

    ``container`` is a logical-collection suggestion (its members are the bundles
    proposed inside it), never a filesystem-synced rule.
    """

    BUNDLE = "bundle"
    CONTAINER = "container"


# Marker path used by a synthesized context node standing in for a live
# collection, which has no filesystem directory of its own. Defined once so the
# suggester, the plan store, apply, and the additive-column backfills cannot
# disagree about its spelling or its length.
CONTEXT_DIRECTORY_PREFIX = "@existing-collection/"


def context_directory(collection_id: str) -> str:
    """The marker path for a context node standing in for ``collection_id``."""
    return f"{CONTEXT_DIRECTORY_PREFIX}{collection_id}"


class GroupingPlanStatus(StrEnum):
    """Lifecycle of a durable grouping plan (ADR-0009).

    A plan is a snapshot of suggestions: ``open`` until the user applies it
    (``applied``), regeneration ``superseded`` it, or it was ``cancelled``.
    """

    OPEN = "open"
    APPLIED = "applied"
    SUPERSEDED = "superseded"
    CANCELLED = "cancelled"


# --- Guarded file operations (ADR-0013, plan 4) ------------------------------
class FileOpType(StrEnum):
    """Kind of guarded file operation recorded in the journal.

    Only the operations that exist are listed. ``save_new`` (W2) follows; the
    journal stores the value as text, so adding one needs no migration.

    There is no ``restore`` member: restoring is not a new operation, it is the
    original ``trash`` row being undone, which is why the trash can be listed by
    reading the journal for `trash` rows that are still ``done``.
    """

    RENAME = "rename"
    MKDIR = "mkdir"
    TRASH = "trash"
    IMPORT = "import"
    MOVE = "move"


class FileOpStatus(StrEnum):
    """Lifecycle of a journaled file operation (ADR-0013 §3.1).

    ``pending`` is written *before* the filesystem is touched, so a crash
    mid-operation is discoverable rather than silent: the reconciler on the next
    library open decides whether the operation completed (finish the metadata
    side) or never happened (``failed``). ``undone`` records that the inverse
    was applied, keeping the history honest rather than deleting the row.
    """

    PENDING = "pending"
    DONE = "done"
    FAILED = "failed"
    UNDONE = "undone"
    # A trashed operation whose entries have been deleted for good. Distinct
    # from ``undone`` (restored) and kept rather than dropped, because "these
    # files were permanently deleted on this date" is the single most useful
    # thing the history can still say once the bytes are gone.
    EMPTIED = "emptied"
