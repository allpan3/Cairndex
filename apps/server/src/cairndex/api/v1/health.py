from fastapi import APIRouter
from pydantic import BaseModel

from cairndex.core.config import get_settings

router = APIRouter(tags=["health"])


class HealthStatus(BaseModel):
    status: str
    app_name: str
    environment: str
    api_features: list[str]
    # The deployment write-mode master switch, ``allowed`` or ``disabled``
    # (ADR-0013 §1). Reported here rather than as an ``api_features`` entry
    # because that list is a compatibility check — a server with write mode
    # switched off is not an older or lesser server, and must not look like one.
    write_mode: str


@router.get("/health", response_model=HealthStatus)
def get_health() -> HealthStatus:
    settings = get_settings()
    return HealthStatus(
        status="ok",
        app_name=settings.app_name,
        environment=settings.environment,
        api_features=["trickplay", "hls", "progress", "pairing"],
        write_mode=settings.write_mode,
    )
