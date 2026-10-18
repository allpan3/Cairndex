"""Owner-setup conversion controls. Slow inspection and swaps run in one worker."""

from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, model_validator

from cairndex.api.deps import RegistryDbSession
from cairndex.registry.models import ConversionTask
from cairndex.replicas import conversion_tasks
from cairndex.replicas.protocol import ReplicaError

router = APIRouter(prefix="/libraries/conversions", tags=["library-conversions"])
Identity = Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")]
Receipt = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Action = Literal["inspect", "prepare", "activate", "undo"]


class ConversionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Identity
    action: Action
    root_path: str = Field(min_length=1, max_length=4096)
    attempt: Identity | None = None
    receipt: Receipt | None = None
    confirm_stale_lease: bool = False

    @model_validator(mode="after")
    def required_fields(self) -> "ConversionRequest":
        if self.action in {"activate", "undo"}:
            if self.attempt is None or self.receipt is None:
                raise ValueError("Select and review a prepared conversion")
        elif self.attempt is not None or self.receipt is not None:
            raise ValueError("Inspection and preparation create their own attempt")
        if self.confirm_stale_lease and self.action != "activate":
            raise ValueError("Writer confirmation belongs to activation")
        return self


class ConversionInspectionRead(BaseModel):
    library_uuid: str
    display_name: str
    lease: Literal["absent", "released", "fresh", "stale", "unreadable"]
    passphrase: bool
    caches: bool
    converts: dict[str, int] = Field(default_factory=dict)
    stays_in_backup: dict[str, int] = Field(default_factory=dict)
    blocking: list[str] = Field(default_factory=list)


class ConversionResultRead(BaseModel):
    """Bounded review fields; object inventories and private paths stay server-side."""

    state: Literal["converted", "restored"] | None = None
    attempt: Identity | None = None
    receipt: Receipt | None = None
    library_uuid: str | None = None
    library_id: str | None = None
    display_name: str | None = None
    backup_name: str | None = None
    retained: str | None = None
    inspection: ConversionInspectionRead | None = None


class ConversionTaskRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: Identity
    root_path: str
    action: Action
    attempt: Identity
    state: Literal["queued", "running", "succeeded", "failed", "interrupted"]
    result: ConversionResultRead | None = None
    error: str | None = None
    # storage_authorization: allow access with authorize-storage; storage_login: save a login
    error_code: Literal["storage_authorization", "storage_login"] | None = None


@router.post("/tasks", response_model=ConversionTaskRead, status_code=202)
def start(payload: ConversionRequest, registry: RegistryDbSession) -> ConversionTask:
    body = payload.model_dump(exclude={"operation", "action", "root_path"}, exclude_none=True)
    row = conversion_tasks.queue(
        registry, payload.root_path, payload.operation, payload.action, body
    )
    registry.commit()
    return row


@router.get("/tasks/{identity}", response_model=ConversionTaskRead)
def task(identity: Identity, registry: RegistryDbSession) -> ConversionTask:
    row = registry.get(ConversionTask, identity)
    if row is None:
        raise ReplicaError("Conversion operation is not available on this server")
    return row


@router.post("/tasks/{identity}/authorize-storage", status_code=204)
def authorize_storage(identity: Identity, registry: RegistryDbSession) -> None:
    """Ask macOS for the step's network-share login, while the owner watches.

    The request waits up to two minutes for the owner to answer the macOS dialog.
    """
    root = Path(task(identity, registry).root_path)
    registry.commit()  # Hold no registry transaction while the owner answers
    conversion_tasks.authorize_storage(root)


@router.post("/tasks/{identity}/retry", response_model=ConversionTaskRead)
def retry(identity: Identity, registry: RegistryDbSession) -> ConversionTask:
    row = conversion_tasks.retry(registry, task(identity, registry))
    registry.commit()
    return row
