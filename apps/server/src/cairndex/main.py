from fastapi import FastAPI

from cairndex.api.v1.router import router as api_v1_router
from cairndex.core.config import get_settings


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name)
    app.include_router(api_v1_router)
    return app


app = create_app()
