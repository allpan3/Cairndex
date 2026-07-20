from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from cairndex.api.errors import register_exception_handlers
from cairndex.api.static_site import mount_static_site
from cairndex.api.v1.router import router as api_v1_router
from cairndex.core.config import PACKAGED_DESKTOP_ORIGINS, get_settings
from cairndex.jobs.registry import build_registry
from cairndex.jobs.worker import Worker
from cairndex.media.hls import shutdown_session_manager
from cairndex.ownership import get_lease_manager
from cairndex.registry.engine import get_registry_sessionmaker


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Start/stop the background worker and lease heartbeat; reap HLS sessions.

    Interactive HLS sessions (ADR-0014) hold live ffmpeg processes and ephemeral
    transcode dirs; tearing them down on shutdown avoids orphaned encoders.

    Releasing every ownership lease on the way out (ADR-0018 §3) is what keeps
    the takeover prompt rare: a cleanly stopped server leaves its libraries
    marked released, so the next machine to open one acquires it silently. Only
    a crash leaves a lease to age into staleness and require a confirmation.
    """
    settings = get_settings()
    worker: Worker | None = None
    if settings.worker_enabled:
        worker = Worker(get_registry_sessionmaker(), build_registry())
        worker.start()
        app.state.worker = worker
    if settings.lease_heartbeat_enabled:
        get_lease_manager().start()
    try:
        yield
    finally:
        # Stop the worker first: a job that is still running would otherwise
        # keep writing to a library whose lease we are about to release.
        if worker is not None:
            worker.stop()
        shutdown_session_manager()
        if settings.lease_heartbeat_enabled:
            manager = get_lease_manager()
            manager.stop()
            manager.release_all()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, lifespan=lifespan)
    # Packaged Tauri origins are trusted; development origins require explicit opt-in
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[*PACKAGED_DESKTOP_ORIGINS, *settings.cors_extra_origins],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_exception_handlers(app)
    app.include_router(api_v1_router)
    # Mounted last so the explicit /api/v1 routes always win; only present in
    # production single-container deployments where CAIRNDEX_STATIC_DIR points
    # at the built frontend (docs/deployment.md).
    if settings.static_dir is not None and settings.static_dir.is_dir():
        mount_static_site(app, settings.static_dir)
    return app


app = create_app()
