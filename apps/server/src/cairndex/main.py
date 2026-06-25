from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from cairndex.api.errors import register_exception_handlers
from cairndex.api.v1.router import router as api_v1_router
from cairndex.core.config import get_settings
from cairndex.jobs.registry import build_registry
from cairndex.jobs.worker import Worker
from cairndex.persistence.engine import get_sessionmaker


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Start/stop the in-process background worker around the app's lifetime."""
    worker: Worker | None = None
    if get_settings().worker_enabled:
        worker = Worker(get_sessionmaker(), build_registry())
        worker.start()
        app.state.worker = worker
    try:
        yield
    finally:
        if worker is not None:
            worker.stop()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, lifespan=lifespan)
    register_exception_handlers(app)
    app.include_router(api_v1_router)
    return app


app = create_app()
