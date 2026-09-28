"""Authorized recovery controls with server-managed identities and bounded listings."""

from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Cookie, Depends, Header, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from cairndex.api.deps import RegistryDbSession, authorize_library
from cairndex.auth import SESSION_COOKIE
from cairndex.registry import services
from cairndex.registry.models import RecoveryTask, RegisteredLibrary
from cairndex.replicas import recovery, recovery_tasks
from cairndex.replicas.protocol import ReplicaError

router = APIRouter(prefix="/libraries/{library_id}/private-recovery", tags=["private-recovery"])
Identity = Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")]
Receipt = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class RecoveryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Identity
    action: Literal[
        "backup", "verify", "prepare", "review", "inspect", "activate", "cancel", "retry_job"
    ]
    backup: Identity | None = None
    recovery: Identity | None = None
    receipt: Receipt | None = None
    job: Annotated[str, Field(min_length=1, max_length=128)] | None = None
    kind: Literal["drafts", "jobs", "events", "catalog", "bundles"] | None = None
    source: Literal["prepared", "previous"] = "prepared"
    after: str = Field(default="", max_length=256)
    limit: int = Field(default=20, ge=1, le=50)

    @model_validator(mode="after")
    def required_fields(self) -> "RecoveryRequest":
        if self.action == "verify" and not self.backup:
            raise ValueError("Select a snapshot")
        if self.action not in {"backup", "verify", "prepare"} and not self.recovery:
            raise ValueError("Select a recovery")
        if self.action in {"activate", "cancel", "retry_job"} and not self.receipt:
            raise ValueError("Review the exact state first")
        if self.action == "retry_job" and not self.job:
            raise ValueError("Select a recovered job")
        if self.action == "inspect" and not self.kind:
            raise ValueError("Select the content to inspect")
        return self


class RecoveryTaskRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    action: str
    state: str
    result: dict[str, Any] | None = None
    error: str | None = None


class RecoveryTaskPage(BaseModel):
    items: list[RecoveryTaskRead]
    next_cursor: str | None = None


def authorized_library(
    library_id: str,
    registry: RegistryDbSession,
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> RegisteredLibrary:
    library = services.get_library(registry, library_id)
    authorize_library(
        registry,
        library_id=library_id,
        root=Path(library.root_path),
        session_cookie=session_cookie,
        authorization=authorization,
    )
    recovery.descriptor_at(Path(library.root_path))
    return library


Library = Annotated[RegisteredLibrary, Depends(authorized_library)]


@router.get("/tasks", response_model=RecoveryTaskPage)
def tasks(
    library: Library,
    registry: RegistryDbSession,
    after: Annotated[str, Query(max_length=32)] = "",
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> RecoveryTaskPage:
    rows = list(
        registry.scalars(
            select(RecoveryTask)
            .where(RecoveryTask.library_id == library.id, RecoveryTask.id > after)
            .order_by(RecoveryTask.id)
            .limit(limit + 1)
        )
    )
    # Results can contain drafts. Fetch one result explicitly instead of collecting them here.
    return RecoveryTaskPage(
        items=[
            RecoveryTaskRead(id=row.id, action=row.action, state=row.state, error=row.error)
            for row in rows[:limit]
        ],
        next_cursor=rows[limit - 1].id if len(rows) > limit else None,
    )


@router.post("/tasks", response_model=RecoveryTaskRead, status_code=202)
def start(payload: RecoveryRequest, library: Library, registry: RegistryDbSession) -> RecoveryTask:
    body = payload.model_dump(exclude={"operation", "action"}, exclude_none=True)
    return recovery_tasks.enqueue(registry, library, payload.operation, payload.action, body)


@router.get("/tasks/{identity}", response_model=RecoveryTaskRead)
def task(identity: Identity, library: Library, registry: RegistryDbSession) -> RecoveryTask:
    row = registry.get(RecoveryTask, identity)
    if row is None or row.library_id != library.id:
        raise ReplicaError("Operation is not available for this library")
    return row


@router.post("/tasks/{identity}/stop", response_model=RecoveryTaskRead)
def stop(identity: Identity, library: Library, registry: RegistryDbSession) -> RecoveryTask:
    row = task(identity, library, registry)
    registry.execute(
        update(RecoveryTask)
        .where(RecoveryTask.id == row.id, RecoveryTask.state == "queued")
        .values(state="cancelled")
        .execution_options(synchronize_session=False)
    )
    registry.refresh(row)
    if row.state == "running":
        raise ReplicaError(
            "This operation is running. Wait for its verified result; original stores are retained."
        )
    return row


@router.post("/tasks/{identity}/retry", response_model=RecoveryTaskRead)
def retry(identity: Identity, library: Library, registry: RegistryDbSession) -> RecoveryTask:
    row = task(identity, library, registry)
    if row.state not in {"failed", "interrupted"}:
        raise ReplicaError("Only a failed or interrupted operation can be retried")
    if registry.scalar(
        select(RecoveryTask.id).where(
            RecoveryTask.library_id == library.id, RecoveryTask.state.in_(["queued", "running"])
        )
    ):
        raise ReplicaError("Wait for the current operation")
    row.state = "queued"
    row.error = None
    try:
        registry.flush()
    except IntegrityError as error:
        registry.rollback()
        raise ReplicaError("Another operation is active; refresh and retry") from error
    return row
