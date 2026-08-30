"""SQLAlchemy ORM models for the Cairndex core domain (ADR-0002).

Covers storage roots, asset bundles, asset files, tags, tag groups (+
membership), collections, and smart collections, plus the bundle↔tag and
bundle↔collection join tables (Phase 1); the jobs table (Phase 2); and subtitle
tracks (Phase 6, ADR-0003).

Note: the logical grouping concept is a **Collection** (formerly "folder"). The
physical filesystem File Browser is a separate, storage-root-scoped surface and is
not modeled here.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    CheckConstraint,
    Column,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Table,
    Text,
    UniqueConstraint,
    delete,
    event,
    update,
)
from sqlalchemy import (
    inspect as sa_inspect,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship, validates
from sqlalchemy.orm import Session as OrmSession

from cairndex.domain.enums import (
    FileAvailability,
    FileOpStatus,
    FileOpType,
    FileRole,
    GroupingPlanStatus,
    GroupingSource,
    GroupingState,
    MediaKind,
    ProposalKind,
)
from cairndex.persistence.base import (
    PLANS_SCHEMA,
    Base,
    CreatedAt,
    UlidFk,
    UlidPk,
    UpdatedAt,
    Version,
)
from cairndex.persistence.types import UtcDateTime

# --- Association tables ------------------------------------------------------

asset_bundle_tags = Table(
    "asset_bundle_tags",
    Base.metadata,
    Column(
        "bundle_id",
        String(26),
        ForeignKey("asset_bundles.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "tag_id",
        String(26),
        ForeignKey("tags.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    # The composite PK indexes the leading bundle_id; this reverse index serves
    # tag_counts' GROUP BY tag_id and tag-scoped lookups (measured: perf/M2).
    Index("ix_asset_bundle_tags_tag_id", "tag_id"),
)

asset_bundle_collections = Table(
    "asset_bundle_collections",
    Base.metadata,
    Column(
        "bundle_id",
        String(26),
        ForeignKey("asset_bundles.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "collection_id",
        String(26),
        ForeignKey("collections.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    # Manual ("custom") order of a bundle *within* this collection, maintained by
    # drag-reorder and rewritten by "Clean up by…". Distinct from the global
    # AssetBundle.manual_order used in All/system views. Lower sorts first.
    Column("sort_order", Integer, nullable=False, default=0, server_default="0"),
    # Reverse index (PK leads with bundle_id) for collection_counts' GROUP BY
    # collection_id and collection-scoped lookups (measured: perf/M2).
    Index("ix_asset_bundle_collections_collection_id", "collection_id"),
)

tag_group_memberships = Table(
    "tag_group_memberships",
    Base.metadata,
    Column(
        "group_id",
        String(26),
        ForeignKey("tag_groups.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "tag_id",
        String(26),
        ForeignKey("tags.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("sort_order", Integer, nullable=False, default=0),
)


# --- Core entities -----------------------------------------------------------


class AssetBundle(Base):
    __tablename__ = "asset_bundles"

    id: Mapped[UlidPk]
    title: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    # Ordered list of freeform owner notes/descriptions — the store for the
    # inspector "NOTES" section (the ``+`` affordance appends a block). There are
    # no predefined roles; each entry is just a separate text block. NULL on rows
    # created before this column existed reads back as an empty list.
    notes: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    # 0..5 stars in half-star steps; NULL means unrated (see domain/rating.py).
    # The CHECK below enforces the range. The *step* is enforced in the service
    # and schema layers only: a library created before half stars has this table
    # already built, and SQLite cannot add a constraint to an existing table
    # without rebuilding it — which is exactly what storing stars rather than
    # half-units lets us avoid.
    rating: Mapped[float | None] = mapped_column(Float, nullable=True)

    # The selected cover lives in this bundle. The FK forms a cycle with
    # asset_files.bundle_id, so it is created via ALTER and updated after the
    # file rows exist (post_update).
    cover_file_id: Mapped[str | None] = mapped_column(
        String(26),
        ForeignKey("asset_files.id", ondelete="SET NULL", use_alter=True),
        nullable=True,
    )
    # Legacy compatibility only; ordered playback no longer reads or writes it
    primary_file_id: Mapped[str | None] = mapped_column(
        String(26),
        ForeignKey("asset_files.id", ondelete="SET NULL", use_alter=True),
        nullable=True,
    )

    extra_metadata: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    # Global manual ("custom") order used when browsing All / system views with
    # BundleSort.MANUAL (drag-reorder, rewritten by "Clean up by…"). Per-collection
    # order lives on asset_bundle_collections.sort_order instead. Lower sorts first.
    # server_default so a row inserted without it (a pre-existing/legacy bundle)
    # is filled by the DB rather than violating NOT NULL.
    manual_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # Grouping state (ADR-0009). Scan stages files in PROVISIONAL bundles; only
    # an explicit user action confirms a grouping. Defaults make a bare
    # ``AssetBundle()`` a confirmed/manual bundle (a directly-made user
    # decision); the scanner overrides to provisional/scan_suggestion. Existing
    # rows backfill via the server_defaults as confirmed/legacy.
    grouping_state: Mapped[GroupingState] = mapped_column(
        Enum(GroupingState, native_enum=False, length=16),
        default=GroupingState.CONFIRMED,
        # SQLAlchemy stores these enums by member *name*, so the server_default
        # (applied to rows written without the column) must use the name too.
        server_default=GroupingState.CONFIRMED.name,
    )
    grouping_source: Mapped[GroupingSource] = mapped_column(
        Enum(GroupingSource, native_enum=False, length=16),
        default=GroupingSource.MANUAL,
        server_default=GroupingSource.LEGACY.name,
    )
    # Which grouping heuristic version produced/last touched this grouping; NULL
    # for hand-made bundles that no heuristic owns.
    grouping_rule_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # When the grouping became confirmed (NULL while still provisional).
    confirmed_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)

    created_at: Mapped[CreatedAt]
    imported_at: Mapped[CreatedAt]
    updated_at: Mapped[UpdatedAt]
    # Last time the owner opened this bundle (album view or viewer) — the
    # ordering behind the Recent view's "Date Opened". Deliberately *not*
    # ``updated_at``: opening is a read, and bumping the metadata version for it
    # would make every browse look like an edit to the optimistic-concurrency
    # checks. NULL until first opened, which sorts last under "most recent
    # first".
    last_opened_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    version: Mapped[Version]  # optimistic-concurrency counter (phase 9)

    files: Mapped[list[AssetFile]] = relationship(
        back_populates="bundle",
        foreign_keys="AssetFile.bundle_id",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    cover_file: Mapped[AssetFile | None] = relationship(
        foreign_keys=[cover_file_id], post_update=True
    )
    tags: Mapped[list[Tag]] = relationship(secondary=asset_bundle_tags)
    collections: Mapped[list[Collection]] = relationship(secondary=asset_bundle_collections)

    __table_args__ = (CheckConstraint("rating >= 0 AND rating <= 5", name="rating_range"),)


class AssetFile(Base):
    __tablename__ = "asset_files"

    id: Mapped[UlidPk]
    # Indexed: SQLite does not auto-index FKs, and nearly every browse/count path
    # correlates asset_files by bundle_id (visible-file EXISTS, per-bundle
    # summary, size/count, missing-file checks). The single highest-impact index
    # measured in perf/M2 — without it these are full asset_files scans per row.
    bundle_id: Mapped[UlidFk] = mapped_column(
        ForeignKey("asset_bundles.id", ondelete="CASCADE"), index=True
    )

    # Normalized path relative to the library root (ADR-0008). The library DB is
    # itself the storage scope, so there is no storage-root reference anymore.
    relative_path: Mapped[str] = mapped_column(Text)
    # Indexed parent directory for bounded File Browser reconciliation
    directory_path: Mapped[str] = mapped_column(Text, default="", index=True)
    original_filename: Mapped[str] = mapped_column(String(1024))
    display_title: Mapped[str] = mapped_column(String(1024))
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The file's origin — a URL, magnet:, ed2k:, etc. (not necessarily http).
    source: Mapped[str | None] = mapped_column(Text, nullable=True)

    role: Mapped[FileRole] = mapped_column(Enum(FileRole, native_enum=False, length=32))
    media_kind: Mapped[MediaKind] = mapped_column(Enum(MediaKind, native_enum=False, length=16))
    mime_type: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sequence: Mapped[int] = mapped_column(Integer, default=0)

    # Populated lazily by the scanner (Phase 2); nullable until then.
    size_bytes: Mapped[int | None] = mapped_column(nullable=True)
    mtime: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    availability: Mapped[FileAvailability] = mapped_column(
        Enum(FileAvailability, native_enum=False, length=16),
        default=FileAvailability.AVAILABLE,
    )
    quick_fingerprint: Mapped[str | None] = mapped_column(String(128), nullable=True)
    full_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # Filesystem identity (st_dev/st_ino), captured by the scanner. The strongest
    # moved-file repair signal on a single volume — survives content edits that
    # change size/mtime/hash. ``identity_available`` flags whether the values are
    # trustworthy (some network filesystems report unstable/zero inodes).
    # Unsigned 64-bit values use their signed two's-complement representation.
    filesystem_device: Mapped[int | None] = mapped_column(Integer, nullable=True)
    filesystem_inode: Mapped[int | None] = mapped_column(Integer, nullable=True)
    identity_available: Mapped[bool] = mapped_column(default=False)
    tech_metadata: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    # Owner-selected video timestamp used when regenerating this file's cover
    # thumbnail; NULL keeps automatic representative-frame selection
    cover_time: Mapped[float | None] = mapped_column(Float, nullable=True)

    created_at: Mapped[CreatedAt]
    updated_at: Mapped[UpdatedAt]
    version: Mapped[Version]  # optimistic-concurrency counter (phase 9)

    bundle: Mapped[AssetBundle] = relationship(back_populates="files", foreign_keys=[bundle_id])

    # Keep the indexed directory key synchronized with every path create/repair
    @validates("relative_path")
    def _sync_directory_path(self, _key: str, value: str) -> str:
        self.directory_path = value.rpartition("/")[0]
        return value

    __table_args__ = (
        # One physical file (by library-relative path) is linked at most once
        # (AGENTS.md §4.3; ADR-0008 — the library DB is the storage scope).
        UniqueConstraint("relative_path", name="relative_path"),
    )


class BundleDirectoryMember(Base):
    """One directory that stands in for its files as a single row in a bundle.

    An album of a thousand photos should occupy one row in the inspector and one
    row in the grouping dialog, not a thousand (plan 6). This table records
    *which directories are entities* and nothing else: membership stays on
    ``asset_files.bundle_id``, and the files under an entity directory are found
    at read time through the index on ``asset_files.directory_path``.

    Storing no contents is what makes the feature reversible for free —
    collapsing is one row inserted, expanding is one row deleted, and neither
    touches a file row, an ``AssetFile.id``, a rating, or a resume position.
    """

    __tablename__ = "bundle_directory_members"

    id: Mapped[UlidPk]
    # Indexed for the same reason as ``asset_files.bundle_id``: every inspector
    # read correlates these rows by bundle, and SQLite does not index FKs.
    bundle_id: Mapped[UlidFk] = mapped_column(
        ForeignKey("asset_bundles.id", ondelete="CASCADE"), index=True
    )
    # Library-relative, no trailing slash — the exact form
    # ``AssetFile.directory_path`` holds, so the two compare without massaging.
    directory_path: Mapped[str] = mapped_column(Text)
    # Position among the bundle's file rows: this shares one key space with
    # ``AssetFile.sequence`` so a folder can be dragged among files (plan 6 §4.5).
    sequence: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[CreatedAt]

    bundle: Mapped[AssetBundle] = relationship()

    __table_args__ = (
        # A directory is an entity for at most one bundle, mirroring the
        # uniqueness ``asset_files.relative_path`` gives a file. Without it two
        # bundles could each claim the same folder and the File Browser handoff
        # would have no single answer to "whose folder is this?".
        UniqueConstraint("directory_path", name="directory_path"),
    )


# Resume state for one playable video file
class PlaybackProgress(Base):
    __tablename__ = "playback_progress"

    file_id: Mapped[str] = mapped_column(
        String(26), ForeignKey("asset_files.id", ondelete="CASCADE"), primary_key=True
    )
    bundle_id: Mapped[str] = mapped_column(String(26), nullable=False)
    position_s: Mapped[float] = mapped_column(Float, nullable=False)
    duration_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    completed: Mapped[bool] = mapped_column(
        Integer, nullable=False, default=False, server_default="0"
    )
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, nullable=False)
    user_id: Mapped[str | None] = mapped_column(String(255), nullable=True)

    file: Mapped[AssetFile] = relationship()

    __table_args__ = (
        Index("ix_playback_progress_bundle_id", "bundle_id"),
        Index("ix_playback_progress_completed_updated_at", "completed", "updated_at"),
    )


# One active ordered-media location per bundle, independent of metadata versioning
class BundleCursor(Base):
    __tablename__ = "bundle_cursors"

    bundle_id: Mapped[str] = mapped_column(
        String(26), ForeignKey("asset_bundles.id", ondelete="CASCADE"), primary_key=True
    )
    file_id: Mapped[str] = mapped_column(
        String(26),
        ForeignKey("asset_files.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, nullable=False)

    file: Mapped[AssetFile] = relationship()


# Sync progress ownership and clear a source bundle's cursor after file reparenting
@event.listens_for(OrmSession, "before_flush")
def _sync_playback_progress_bundle_id(
    session: OrmSession, _flush_context: object, _instances: object
) -> None:
    for obj in session.dirty:
        if not isinstance(obj, AssetFile) or obj.id is None:
            continue
        state = sa_inspect(obj)
        if not state.attrs.bundle_id.history.has_changes():
            continue
        session.execute(
            update(PlaybackProgress)
            .where(PlaybackProgress.file_id == obj.id)
            .values(bundle_id=obj.bundle_id)
        )
        session.execute(
            delete(BundleCursor).where(
                BundleCursor.file_id == obj.id,
                BundleCursor.bundle_id != obj.bundle_id,
            )
        )


class Tag(Base):
    __tablename__ = "tags"

    id: Mapped[UlidPk]
    # Adjacency-list hierarchy (ADR-0002). Independent of group membership.
    parent_id: Mapped[str | None] = mapped_column(
        String(26), ForeignKey("tags.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(255))
    color: Mapped[str | None] = mapped_column(String(32), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[CreatedAt]
    updated_at: Mapped[UpdatedAt]
    version: Mapped[Version]  # optimistic-concurrency counter (phase 9)

    parent: Mapped[Tag | None] = relationship(back_populates="children", remote_side="Tag.id")
    children: Mapped[list[Tag]] = relationship(back_populates="parent")
    groups: Mapped[list[TagGroup]] = relationship(
        secondary=tag_group_memberships, back_populates="tags"
    )

    __table_args__ = (UniqueConstraint("parent_id", "name", name="parent_name"),)


class TagGroup(Base):
    __tablename__ = "tag_groups"

    id: Mapped[UlidPk]
    name: Mapped[str] = mapped_column(String(255), unique=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[CreatedAt]
    updated_at: Mapped[UpdatedAt]

    tags: Mapped[list[Tag]] = relationship(secondary=tag_group_memberships, back_populates="groups")


class Collection(Base):
    """A hierarchical virtual grouping of bundles (AGENTS.md §4.7).

    Formerly "folder". Membership is many-to-many and never moves files on disk;
    this is purely logical and independent of the physical File Browser.
    """

    __tablename__ = "collections"

    id: Mapped[UlidPk]
    parent_id: Mapped[str | None] = mapped_column(
        String(26), ForeignKey("collections.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(255))
    # Freeform owner note/description for the collection (shown in the inspector).
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # A bundle inside the collection whose cover is used as the collection cover
    # (set via "Set as collection cover"). NULL → auto-pick a bundle in the tree.
    cover_bundle_id: Mapped[str | None] = mapped_column(
        String(26), ForeignKey("asset_bundles.id", ondelete="SET NULL"), nullable=True
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[CreatedAt]
    updated_at: Mapped[UpdatedAt]
    version: Mapped[Version]  # optimistic-concurrency counter (phase 9)

    parent: Mapped[Collection | None] = relationship(
        back_populates="children", remote_side="Collection.id"
    )
    children: Mapped[list[Collection]] = relationship(back_populates="parent")

    __table_args__ = (UniqueConstraint("parent_id", "name", name="parent_name"),)


class SmartCollection(Base):
    """A named, saved filter expression — a "Smart Collection" (formerly Smart
    Folder). The table keeps its legacy name ``smart_folders`` to avoid a
    second data migration; the domain/API surface is Smart Collection."""

    __tablename__ = "smart_folders"

    id: Mapped[UlidPk]
    name: Mapped[str] = mapped_column(String(255), unique=True)
    # Versioned filter AST (docs/filter-language.md). Stored as JSON, never SQL.
    filter_version: Mapped[int] = mapped_column(Integer, default=1)
    filter_json: Mapped[dict[str, Any]] = mapped_column(JSON)
    default_sort: Mapped[str | None] = mapped_column(String(64), nullable=True)
    default_layout: Mapped[str | None] = mapped_column(String(32), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[CreatedAt]
    updated_at: Mapped[UpdatedAt]
    version: Mapped[Version]  # optimistic-concurrency counter (phase 9)


class SubtitleTrack(Base):
    """A subtitle track for a video — external file or embedded stream (ADR-0003).

    Exactly one of ``source_file_id`` (an external subtitle ``AssetFile``) or
    ``embedded_index`` (an ``ffprobe`` stream index inside ``video_file_id``'s
    container) is set; embedded tracks always name their host video.
    """

    __tablename__ = "subtitle_tracks"

    id: Mapped[UlidPk]
    bundle_id: Mapped[UlidFk] = mapped_column(ForeignKey("asset_bundles.id", ondelete="CASCADE"))
    video_file_id: Mapped[str | None] = mapped_column(
        ForeignKey("asset_files.id", ondelete="CASCADE"), nullable=True
    )
    source_file_id: Mapped[str | None] = mapped_column(
        ForeignKey("asset_files.id", ondelete="SET NULL"), nullable=True
    )
    embedded_index: Mapped[int | None] = mapped_column(Integer, nullable=True)

    language: Mapped[str | None] = mapped_column(String(35), nullable=True)  # BCP-47
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    format: Mapped[str | None] = mapped_column(String(32), nullable=True)
    is_default: Mapped[bool] = mapped_column(default=False)
    is_forced: Mapped[bool] = mapped_column(default=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[CreatedAt]
    updated_at: Mapped[UpdatedAt]
    version: Mapped[Version]  # optimistic-concurrency counter (phase 9)

    __table_args__ = (
        # Exactly one source: external file XOR embedded stream index.
        CheckConstraint(
            "(source_file_id IS NOT NULL) <> (embedded_index IS NOT NULL)",
            name="subtitle_one_source",
        ),
        # An embedded stream must name the video that contains it.
        CheckConstraint(
            "embedded_index IS NULL OR video_file_id IS NOT NULL",
            name="subtitle_embedded_has_video",
        ),
        UniqueConstraint("video_file_id", "embedded_index", name="subtitle_embedded_unique"),
        UniqueConstraint("source_file_id", name="subtitle_source_unique"),
    )


class GroupingPlan(Base):
    """A durable snapshot of grouping suggestions awaiting review (ADR-0009).

    Generated from the suggester, optionally edited by the user, then applied.
    A plan is a snapshot — not a live path-sync rule — so applying a stale plan
    detects conflicts (moved/vanished/already-regrouped files) per proposal
    rather than discarding the whole result.

    Being a snapshot is also why this table and its two children are the only
    library metadata that does **not** live in ``library.db``. They are
    regenerable from the library at any moment, and writing them across a network
    share cost seconds per keystroke, so they sit in a server-local file attached
    as schema ``plans`` (ADR-0022).
    """

    __tablename__ = "grouping_plans"
    __table_args__ = {"schema": PLANS_SCHEMA}

    id: Mapped[UlidPk]
    # The scan that produced this plan, if any (registry job id; no cross-DB FK).
    scan_job_id: Mapped[str | None] = mapped_column(String(26), nullable=True)
    status: Mapped[GroupingPlanStatus] = mapped_column(
        Enum(GroupingPlanStatus, native_enum=False, length=16),
        default=GroupingPlanStatus.OPEN,
    )
    rule_version: Mapped[int] = mapped_column(Integer, default=1)
    # Per-directory stem levels the owner set, keyed by library-relative folder;
    # a folder absent here used ``DEFAULT_STEM_LEVEL``. The *column* is still
    # called ``stem_modes`` because it shipped holding the old three-value enum
    # and there is no migration chain to rename it (see
    # ``engine._ADDITIVE_CONTENT_COLUMNS``); the attribute says what it now
    # holds. ``plan_store`` coerces any legacy ``"narrow"``/``"balanced"``/
    # ``"wide"`` string it finds to a level on read.
    stem_level_overrides: Mapped[dict[str, int | str]] = mapped_column(
        "stem_modes", JSON, default=dict, server_default="{}"
    )
    # Digest of exactly the facts the suggester reads, so a later scan can tell
    # whether regenerating could produce anything different. NULL on plans written
    # before the column existed, which reads as "unknown" and regenerates.
    input_digest: Mapped[str | None] = mapped_column(String(64), nullable=True)
    generated_at: Mapped[CreatedAt]
    applied_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)

    created_at: Mapped[CreatedAt]
    updated_at: Mapped[UpdatedAt]
    version: Mapped[Version]

    proposals: Mapped[list[GroupingProposal]] = relationship(
        back_populates="plan",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="GroupingProposal.sort_order",
    )


class GroupingProposal(Base):
    """One proposed BUNDLE or CONTAINER within a plan (ADR-0009).

    ``parent_proposal_id`` links a child bundle/container to the container that
    would contain it (the collection is created at apply time). ``directory`` and
    proposed title/reason are display context; durable apply targets are the
    ``asset_file_id`` rows in ``files`` and an optional
    ``target_collection_id`` for existing collection context.
    """

    __tablename__ = "grouping_proposals"
    # Both foreign keys, indexed. SQLite needs an index on the *child* column to
    # enforce ON DELETE without scanning: deleting a plan cascades to its
    # proposals, and each of those SET NULLs its children — so with no index the
    # cascade is a full table scan per deleted row. Pruning four superseded plans
    # from the owner's library took 6.4 s on a network share for that reason
    # (measured 2026-08-14).
    __table_args__ = (
        Index("ix_grouping_proposals_plan_id", "plan_id"),
        Index("ix_grouping_proposals_parent_proposal_id", "parent_proposal_id"),
        {"schema": PLANS_SCHEMA},
    )

    id: Mapped[UlidPk]
    plan_id: Mapped[UlidFk] = mapped_column(
        ForeignKey(f"{PLANS_SCHEMA}.grouping_plans.id", ondelete="CASCADE")
    )
    parent_proposal_id: Mapped[str | None] = mapped_column(
        String(26),
        ForeignKey(f"{PLANS_SCHEMA}.grouping_proposals.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Set when this proposal adds its files to an existing confirmed bundle
    # by default (ADR-0009 phase 5). A plain id resolved at apply.
    target_bundle_id: Mapped[str | None] = mapped_column(String(26), nullable=True)
    target_bundle_title: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    create_new_bundle: Mapped[bool] = mapped_column(default=False, server_default="0")
    # Stable identity for an existing collection shown as placement context
    target_collection_id: Mapped[str | None] = mapped_column(String(26), nullable=True)
    # Distinguishes a synthesized read-only context node from an ordinary
    # folder suggestion that merely resolves to an existing collection. Only
    # the former is immutable and prunable.
    is_collection_context: Mapped[bool] = mapped_column(default=False, server_default="0")
    # Preserve a proposal's original bundle identity through an explicit edit
    base_bundle_id: Mapped[str | None] = mapped_column(String(26), nullable=True)
    owner_edited: Mapped[bool] = mapped_column(default=False, server_default="0")
    # Narrower than ``owner_edited``: set only when the owner changed *which files*
    # this proposal holds. Apply treats that, and only that, as licence to move a
    # file out of an already-confirmed bundle (ADR-0009 §5/§7) — renaming a
    # suggestion or choosing where it is filed must never grant it.
    membership_edited: Mapped[bool] = mapped_column(default=False, server_default="0")
    kind: Mapped[ProposalKind] = mapped_column(Enum(ProposalKind, native_enum=False, length=16))
    title: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    directory: Mapped[str] = mapped_column(Text, default="")
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[CreatedAt]
    updated_at: Mapped[UpdatedAt]

    plan: Mapped[GroupingPlan] = relationship(back_populates="proposals")
    files: Mapped[list[GroupingProposalFile]] = relationship(
        back_populates="proposal",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="GroupingProposalFile.sequence",
    )
    directories: Mapped[list[GroupingProposalDirectory]] = relationship(
        back_populates="proposal",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="GroupingProposalDirectory.directory_path",
    )


class GroupingProposalFile(Base):
    """A file's proposed role + order within a proposed bundle (ADR-0009).

    ``asset_file_id`` is stored as a plain id (not an FK): a plan is a snapshot,
    so a file that later vanishes must surface as a conflict at apply time rather
    than cascade-deleting or nulling the proposal row. ``relative_path`` is a
    display/context snapshot.
    """

    __tablename__ = "grouping_proposal_files"
    # Same reason as ``grouping_proposals``, plus this is the column every plan
    # read joins on.
    __table_args__ = (
        Index("ix_grouping_proposal_files_proposal_id", "proposal_id"),
        {"schema": PLANS_SCHEMA},
    )

    id: Mapped[UlidPk]
    proposal_id: Mapped[UlidFk] = mapped_column(
        ForeignKey(f"{PLANS_SCHEMA}.grouping_proposals.id", ondelete="CASCADE")
    )
    asset_file_id: Mapped[str] = mapped_column(String(26))
    relative_path: Mapped[str] = mapped_column(Text, default="")
    proposed_role: Mapped[FileRole] = mapped_column(Enum(FileRole, native_enum=False, length=32))
    sequence: Mapped[int] = mapped_column(Integer, default=0)

    proposal: Mapped[GroupingProposal] = relationship(back_populates="files")


class GroupingProposalDirectory(Base):
    """A directory this proposal would collapse into one bundle row (plan 6).

    A **new table rather than a column** on ``grouping_proposals``: the plans
    database is brought up to shape with ``create_all(checkfirst=True)``, which
    creates a missing table but never adds a column to one that already exists.
    A column would therefore be silently absent from every plans database that
    predates it.

    Stores no file ids. Which files a directory covers is derived from
    ``asset_files.directory_path`` at read time, exactly as
    ``bundle_directory_members`` does after apply — so a plan cannot disagree
    with the bundle it becomes.

    Declining a proposed folder in the review dialog deletes the row; the files
    were never anywhere else, so they simply enumerate again.
    """

    __tablename__ = "grouping_proposal_directories"
    __table_args__ = (
        # Same reason as ``grouping_proposal_files``: SQLite needs an index on
        # the child column so a plan's cascade delete is not a full scan per row.
        Index("ix_grouping_proposal_directories_proposal_id", "proposal_id"),
        {"schema": PLANS_SCHEMA},
    )

    id: Mapped[UlidPk]
    proposal_id: Mapped[UlidFk] = mapped_column(
        ForeignKey(f"{PLANS_SCHEMA}.grouping_proposals.id", ondelete="CASCADE")
    )
    directory_path: Mapped[str] = mapped_column(Text)
    # Declined: list this folder's files individually instead of as one row.
    #
    # A flag rather than deleting the row, so the decision is reversible — the
    # owner could otherwise only find out what was in a folder by flattening it,
    # with no way back (owner-reported, 2026-08-28). Apply skips an expanded row.
    #
    # Safe to add as a column, unlike anywhere in ``library.db``: the plans
    # database is deleted wholesale at every server start (ADR-0022 §5), so it is
    # genuinely always created at the current shape.
    expanded: Mapped[bool] = mapped_column(default=False, server_default="0")

    proposal: Mapped[GroupingProposal] = relationship(back_populates="directories")


class FileOperation(Base):
    """One guarded file operation, journaled before it happens (ADR-0013 §3.1).

    Lives in ``library.db`` rather than the registry, so the history travels
    with the library the way the operations' *effects* do — a library carried to
    another machine arrives knowing what was done to it.

    The protocol is intent-before-action: insert ``pending`` **and commit**,
    touch the filesystem, then update content rows and mark ``done`` in one
    transaction. A crash between the second and third steps leaves a ``pending``
    row, which the reconciler on next open resolves by looking at the
    filesystem. Without the row, that same crash would leave a file whose real
    location silently disagrees with its ``relative_path`` — recoverable only by
    a scan, and only as a *guess* about what happened.

    ``payload`` carries the operation's parameters and its inverse (the paths
    Undo would restore), as JSON rather than columns because each operation kind
    has a different shape and this table must not grow a column per verb.
    """

    __tablename__ = "file_operations"

    id: Mapped[UlidPk]
    op: Mapped[FileOpType] = mapped_column(Enum(FileOpType, native_enum=False, length=16))
    status: Mapped[FileOpStatus] = mapped_column(
        Enum(FileOpStatus, native_enum=False, length=16),
        default=FileOpStatus.PENDING,
        index=True,  # the reconciler's only query: pending rows for this library
    )
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # Why a failed operation failed, in the same words the caller was given.
    # Never a filesystem path outside the library (AGENTS.md logging rules).
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[CreatedAt]
    finished_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
