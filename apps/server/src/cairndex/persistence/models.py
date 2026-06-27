"""SQLAlchemy ORM models for the Cairndex core domain (ADR-0002).

Covers storage roots, asset bundles, asset files, tags, tag groups (+
membership), collections, and smart collections, plus the bundle↔tag and
bundle↔collection join tables (Phase 1); the jobs table (Phase 2); and subtitle
tracks (Phase 6, ADR-0003).

Note: the logical grouping concept is a **Collection** (formerly "folder"). The
physical filesystem File View is a separate, storage-root-scoped surface and is
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
    ForeignKey,
    Integer,
    String,
    Table,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from cairndex.domain.enums import (
    FileAvailability,
    FileRole,
    JobStatus,
    JobType,
    MediaKind,
    StorageRootStatus,
)
from cairndex.persistence.base import Base, CreatedAt, UlidFk, UlidPk, UpdatedAt
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


class StorageRoot(Base):
    __tablename__ = "storage_roots"

    id: Mapped[UlidPk]
    name: Mapped[str] = mapped_column(String(255), unique=True)
    # Absolute, server-side canonical path. Never a client-supplied path.
    canonical_path: Mapped[str] = mapped_column(Text)
    read_only: Mapped[bool] = mapped_column(default=True)
    status: Mapped[StorageRootStatus] = mapped_column(
        Enum(StorageRootStatus, native_enum=False, length=20),
        default=StorageRootStatus.AVAILABLE,
    )
    # Free-form scan settings; shape is defined when the scanner lands (Phase 2).
    scan_config: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[CreatedAt]
    updated_at: Mapped[UpdatedAt]
    last_scanned_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)

    files: Mapped[list[AssetFile]] = relationship(back_populates="storage_root")


class AssetBundle(Base):
    __tablename__ = "asset_bundles"

    id: Mapped[UlidPk]
    title: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 0..5; NULL means unrated. Range enforced by a CHECK constraint and schema.
    rating: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Selected cover/primary files live in this bundle. The FKs form a cycle
    # with asset_files.bundle_id, so they are created via ALTER and updated
    # after the file rows exist (post_update).
    cover_file_id: Mapped[str | None] = mapped_column(
        String(26),
        ForeignKey("asset_files.id", ondelete="SET NULL", use_alter=True),
        nullable=True,
    )
    primary_file_id: Mapped[str | None] = mapped_column(
        String(26),
        ForeignKey("asset_files.id", ondelete="SET NULL", use_alter=True),
        nullable=True,
    )

    extra_metadata: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[CreatedAt]
    imported_at: Mapped[CreatedAt]
    updated_at: Mapped[UpdatedAt]

    files: Mapped[list[AssetFile]] = relationship(
        back_populates="bundle",
        foreign_keys="AssetFile.bundle_id",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    cover_file: Mapped[AssetFile | None] = relationship(
        foreign_keys=[cover_file_id], post_update=True
    )
    primary_file: Mapped[AssetFile | None] = relationship(
        foreign_keys=[primary_file_id], post_update=True
    )
    tags: Mapped[list[Tag]] = relationship(secondary=asset_bundle_tags)
    collections: Mapped[list[Collection]] = relationship(secondary=asset_bundle_collections)

    __table_args__ = (CheckConstraint("rating >= 0 AND rating <= 5", name="rating_range"),)


class AssetFile(Base):
    __tablename__ = "asset_files"

    id: Mapped[UlidPk]
    bundle_id: Mapped[UlidFk] = mapped_column(ForeignKey("asset_bundles.id", ondelete="CASCADE"))
    storage_root_id: Mapped[UlidFk] = mapped_column(
        ForeignKey("storage_roots.id", ondelete="RESTRICT")
    )

    # Normalized path relative to the storage root's canonical path.
    relative_path: Mapped[str] = mapped_column(Text)
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
    tech_metadata: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[CreatedAt]
    updated_at: Mapped[UpdatedAt]

    bundle: Mapped[AssetBundle] = relationship(back_populates="files", foreign_keys=[bundle_id])
    storage_root: Mapped[StorageRoot] = relationship(back_populates="files")

    __table_args__ = (
        # One physical file is linked at most once (AGENTS.md §4.3).
        UniqueConstraint("storage_root_id", "relative_path", name="root_path"),
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
    this is purely logical and independent of the physical File View.
    """

    __tablename__ = "collections"

    id: Mapped[UlidPk]
    parent_id: Mapped[str | None] = mapped_column(
        String(26), ForeignKey("collections.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(255))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[CreatedAt]
    updated_at: Mapped[UpdatedAt]

    parent: Mapped[Collection | None] = relationship(
        back_populates="children", remote_side="Collection.id"
    )
    children: Mapped[list[Collection]] = relationship(back_populates="parent")

    __table_args__ = (UniqueConstraint("parent_id", "name", name="parent_name"),)


class SmartFolder(Base):
    # Renamed to SmartCollection in Phase 2 along with its service/API; the
    # table name stays ``smart_folders``.
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


class ImportRecord(Base):
    """Maps an external item to the bundle it produced, for idempotent imports.

    Keyed by ``(provider, external_id)`` so re-running an import (e.g. Eagle —
    ADR-0004) skips already-imported items instead of duplicating them.
    """

    __tablename__ = "import_records"

    id: Mapped[UlidPk]
    provider: Mapped[str] = mapped_column(String(32))
    external_id: Mapped[str] = mapped_column(String(255))
    bundle_id: Mapped[UlidFk] = mapped_column(ForeignKey("asset_bundles.id", ondelete="CASCADE"))
    imported_at: Mapped[CreatedAt]

    __table_args__ = (UniqueConstraint("provider", "external_id", name="import_provider_external"),)


class Job(Base):
    """A resumable background job (scan, ffprobe, thumbnail, …).

    Backs the in-process worker (ADR-0001 — a DB-backed queue, not Celery).
    ``cancel_requested`` is a cooperative flag the running handler polls.
    """

    __tablename__ = "jobs"

    id: Mapped[UlidPk]
    type: Mapped[JobType] = mapped_column(Enum(JobType, native_enum=False, length=32))
    status: Mapped[JobStatus] = mapped_column(
        Enum(JobStatus, native_enum=False, length=16),
        default=JobStatus.QUEUED,
    )
    # Free-form job parameters (e.g. {"storage_root_id": "..."}).
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # Progress counters; total is unknown until discovery completes.
    processed: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    cancel_requested: Mapped[bool] = mapped_column(default=False)

    created_at: Mapped[CreatedAt]
    updated_at: Mapped[UpdatedAt]
    started_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
