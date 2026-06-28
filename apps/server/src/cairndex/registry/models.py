from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Enum, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from cairndex.domain.enums import JobStatus, JobType, LibraryStatus
from cairndex.persistence.base import CreatedAt, UlidFk, UlidPk, UpdatedAt
from cairndex.persistence.types import UtcDateTime
from cairndex.registry.base import RegistryBase


class RegisteredLibrary(RegistryBase):
    """A library directory the server knows about (ADR-0008).

    One row per ``<root>/.cairndex/`` library package. The row is server
    runtime state: it records where the library lives and whether it is
    currently reachable, but the library's *content* metadata lives in its own
    ``library.db``.
    """

    __tablename__ = "registered_libraries"

    id: Mapped[UlidPk]
    # The library's own identity, copied from its manifest. Stable across moves,
    # so re-registering a moved library is recognized as the same library.
    library_uuid: Mapped[str] = mapped_column(String(26), unique=True)
    name: Mapped[str] = mapped_column(String(255))
    # Absolute, server-side, normalized root directory. Unique: a single root
    # maps to at most one registered library.
    root_path: Mapped[str] = mapped_column(Text, unique=True)
    # Absolute path to the library's manifest.json (derived from root_path).
    manifest_path: Mapped[str] = mapped_column(Text)
    status: Mapped[LibraryStatus] = mapped_column(
        Enum(LibraryStatus, native_enum=False, length=20),
        default=LibraryStatus.AVAILABLE,
    )
    # The library DB's schema/format version, as recorded in the manifest.
    schema_version: Mapped[int] = mapped_column(Integer, default=1)

    created_at: Mapped[CreatedAt]
    updated_at: Mapped[UpdatedAt]
    last_opened_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class JobQueueEntry(RegistryBase):
    """A server-runtime background job, scoped to one library (ADR-0008).

    The registry owns the transient job queue; durable results land in the
    target library's ``library.db``. ``library_id`` lets the worker open the
    correct library DB when executing. The per-library worker that consumes
    these rows lands in a later PR (phase 7); this table is defined now so the
    registry schema is complete and stable.
    """

    __tablename__ = "job_queue"

    id: Mapped[UlidPk]
    library_id: Mapped[UlidFk] = mapped_column(
        ForeignKey("registered_libraries.id", ondelete="CASCADE")
    )
    job_type: Mapped[JobType] = mapped_column(Enum(JobType, native_enum=False, length=32))
    status: Mapped[JobStatus] = mapped_column(
        Enum(JobStatus, native_enum=False, length=16),
        default=JobStatus.QUEUED,
    )
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    processed: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    cancel_requested: Mapped[bool] = mapped_column(default=False)

    created_at: Mapped[CreatedAt]
    updated_at: Mapped[UpdatedAt]
    started_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
