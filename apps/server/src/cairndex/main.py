from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from cairndex.api.errors import register_exception_handlers
from cairndex.api.local_token_middleware import register_local_token_gate
from cairndex.api.static_site import mount_static_site
from cairndex.api.v1.router import router as api_v1_router
from cairndex.auth.local_token import sidecar_mode
from cairndex.core.config import PACKAGED_DESKTOP_ORIGINS, get_settings
from cairndex.jobs.registry import build_registry
from cairndex.jobs.worker import Worker
from cairndex.media.hls import shutdown_session_manager
from cairndex.ownership import get_lease_manager
from cairndex.persistence.maintenance import SqliteMaintenance
from cairndex.registry.engine import get_registry_sessionmaker
from cairndex.registry.library_engine import close_library_engines


def _registered_db_paths() -> set[Path]:
    """Every library database this server has registered, for the plans sweep.

    Read fresh each pass rather than captured, so a library registered while the
    server runs is protected from the very next sweep. Path only — nothing here
    touches the library, so an unplugged one still counts as registered.
    """
    from cairndex.registry import library_package as pkg
    from cairndex.registry.models import RegisteredLibrary

    with get_registry_sessionmaker()() as session:
        return {
            pkg.db_path(Path(root)) for (root,) in session.query(RegisteredLibrary.root_path).all()
        }


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

    maintenance: SqliteMaintenance | None = None
    if settings.sqlite_maintenance_enabled:
        maintenance = SqliteMaintenance(
            owned_library_ids=lambda: get_lease_manager().held_library_id_set(),
            interval=settings.sqlite_maintenance_interval,
            idle_after=settings.sqlite_idle_checkpoint_after,
            snapshot_interval=settings.sqlite_snapshot_interval,
            registered_db_paths=_registered_db_paths,
        )
        maintenance.start()
    try:
        yield
    finally:
        # Order matters on the way out. Stop producing writes first (the worker,
        # then maintenance), fold each library's WAL back in and close it, and
        # only then release the leases — so every library is left as a single
        # consistent file *before* another machine is invited to pick it up.
        if worker is not None:
            worker.stop()
        if maintenance is not None:
            maintenance.stop()
        shutdown_session_manager()
        close_library_engines()
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
    # Only present for a desktop sidecar (ADR-0018 §5); an ordinary NAS or
    # container deployment never registers it and is unaffected.
    if sidecar_mode():
        register_local_token_gate(app)
    register_exception_handlers(app)
    app.include_router(api_v1_router)
    # Mounted last so the explicit /api/v1 routes always win; only present in
    # production single-container deployments where CAIRNDEX_STATIC_DIR points
    # at the built frontend (docs/deployment.md).
    if settings.static_dir is not None and settings.static_dir.is_dir():
        mount_static_site(app, settings.static_dir)
    return app


app = create_app()
