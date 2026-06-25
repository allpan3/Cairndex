from fastapi import APIRouter
from pydantic import BaseModel

from cairndex.core.config import get_settings

router = APIRouter(tags=["health"])


class HealthStatus(BaseModel):
    status: str
    app_name: str
    environment: str


@router.get("/health", response_model=HealthStatus)
def get_health() -> HealthStatus:
    settings = get_settings()
    return HealthStatus(
        status="ok",
        app_name=settings.app_name,
        environment=settings.environment,
    )
