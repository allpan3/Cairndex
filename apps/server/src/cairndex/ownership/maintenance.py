"""Ownership-checked CLI maintenance; SQLite opening itself may mutate storage"""

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from sqlalchemy import Engine

from cairndex.core.errors import LibraryDrainError, LibraryLeaseError
from cairndex.ownership.manager import LeaseManager, LeaseSettings
from cairndex.ownership.sql_guard import guard_engine
from cairndex.persistence.engine import create_app_engine
from cairndex.persistence.journal import checkpoint_and_revert
from cairndex.registry import library_package as pkg


@contextmanager
def maintenance_engine(root: Path) -> Iterator[Engine]:
    """Acquire before DB/plan initialization, close before release, never take over

    A separate ephemeral identity refuses even the running server's own lease.
    Merely sharing its data directory must not impersonate that live process
    """
    root = root.resolve()
    manifest = pkg.detect(root)
    if manifest is None:
        raise ValueError("No Cairndex library at the supplied root")
    library_id = manifest.library_uuid
    manager = LeaseManager(
        server_uuid=str(uuid4()),
        machine_name="Cairndex maintenance",
        advertised_url=None,
        settings=LeaseSettings.from_settings(),
    )
    manager.acquire(library_id=library_id, root=root)
    manager.start()
    engine: Engine | None = None
    clean = False
    try:
        engine = create_app_engine(
            database_url=f"sqlite:///{pkg.db_path(root).as_posix()}", no_checkpoint_on_close=True
        )

        guard_engine(engine, manager, library_id)
        yield engine
    finally:
        try:
            manager.validate(library_id, force=True)
            if engine is not None:
                clean = checkpoint_and_revert(engine)
            if clean:
                manager.release(library_id)
        except LibraryLeaseError:
            pass  # Preserve the new owner's record and available recovery files
        finally:
            if engine is not None:
                engine.dispose()
            manager.stop()
        if engine is not None and manager.holds(library_id) and not clean:
            raise LibraryDrainError(
                "Maintenance could not close cleanly; lease remains stale for explicit recovery"
            )
