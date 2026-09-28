from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from cairndex.api.errors import register_exception_handlers
from cairndex.api.library_lifecycle import LibraryLifecycleMiddleware
from cairndex.api.local_token_middleware import register_local_token_gate
from cairndex.api.static_site import mount_static_site
from cairndex.api.v1.router import router as api_v1_router
from cairndex.auth.local_token import sidecar_mode
from cairndex.core.config import PACKAGED_DESKTOP_ORIGINS, get_settings
from cairndex.file_ops.smb_transport import close_sessions as close_smb_sessions
from cairndex.media.exports import shutdown_export_manager
from cairndex.media.hls import shutdown_session_manager
from cairndex.persistence.engine import discard_all_plans
from cairndex.registry.engine import get_registry_sessionmaker
from cairndex.replicas.recovery_tasks import RecoveryWorker
from cairndex.replicas.service import ReplicaWorker
from cairndex.version import APP_VERSION


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Run private catalog exchange and recovery; close media processes on stop."""
    settings = get_settings()
    # Before anything can open a library: a grouping plan lasts as long as the server
    # that made it (ADR-0022), so whatever the previous run left goes now.
    discard_all_plans()
    replicas = ReplicaWorker()
    replicas.start()
    recovery_worker: RecoveryWorker | None = None
    if settings.worker_enabled:
        recovery_worker = RecoveryWorker(get_registry_sessionmaker())
        recovery_worker.start()
    try:
        yield
    finally:
        if recovery_worker is not None:
            recovery_worker.stop()
        replicas.stop()
        shutdown_session_manager()
        # Export artifacts are throwaway state under the data dir, so they go
        # with the process that made them rather than outliving it as orphans.
        shutdown_export_manager()
        close_smb_sessions()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, version=APP_VERSION, lifespan=lifespan)
    # Packaged Tauri origins are trusted; development origins require explicit opt-in
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[*PACKAGED_DESKTOP_ORIGINS, *settings.cors_extra_origins],
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Cairndex-Basis"],
    )
    # Only present for a desktop sidecar (ADR-0018 §5); an ordinary NAS or
    # container deployment never registers it and is unaffected.
    if sidecar_mode():
        register_local_token_gate(app)
    app.add_middleware(LibraryLifecycleMiddleware)
    register_exception_handlers(app)
    app.include_router(api_v1_router)
    # Mounted last so the explicit /api/v1 routes always win; only present in
    # production single-container deployments where CAIRNDEX_STATIC_DIR points
    # at the built frontend (docs/deployment.md).
    if settings.static_dir is not None and settings.static_dir.is_dir():
        mount_static_site(app, settings.static_dir)
    return app


app = create_app()
