from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict

from cairndex.domain.enums import JobStatus, JobType


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    type: JobType
    status: JobStatus
    payload: dict[str, Any]
    processed: int
    total: int | None
    result: dict[str, Any] | None
    error: str | None
    cancel_requested: bool
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
