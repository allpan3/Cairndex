import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from cairndex.api.deps import (
    LibraryAccess,
    RegistryAccess,
    get_library_access,
    get_library_session,
    get_registry_access,
    get_registry_db,
)
from cairndex.core.config import get_settings
from cairndex.main import create_app
from cairndex.persistence import models  # noqa: F401  (register metadata)
from cairndex.persistence.engine import create_app_engine
from cairndex.registry import library_package as pkg
from cairndex.registry import services as registry_service
from cairndex.registry.engine import create_registry_engine
from cairndex.registry.library_engine import dispose_all_library_engines


@pytest.fixture(autouse=True)
def _dispose_library_engines() -> Iterator[None]:
    """Release any per-library engines opened during a test (ADR-0008).

    The cache is process-global; disposing after each test closes handles to
    temp ``library.db`` files so their tmp dirs can be cleaned up. Also clears
    the process-global auth session store (ADR-0010) so unlocks never leak.
    """
    yield
    dispose_all_library_engines()
    from cairndex.auth import session_store
    from cairndex.auth.device_tokens import pairing_store
    from cairndex.ownership import reset_lease_manager

    session_store.clear()
    pairing_store.clear()
    # Leases are held in process memory (ADR-0018), so without this a library id
    # reused by a later test would look already-owned and skip the mount gate.
    reset_lease_manager()


@pytest.fixture(autouse=True, scope="session")
def _isolate_data_dir(tmp_path_factory: pytest.TempPathFactory) -> Iterator[None]:
    """Point the app-data dir at a temp location for the whole test session.

    Keeps tests hermetic — no database/cache files land in the repo's var/.
    """
    data_dir = tmp_path_factory.mktemp("cairndex-data")
    os.environ["CAIRNDEX_DATA_DIR"] = str(data_dir)
    # Drive jobs deterministically in tests; no background polling thread.
    os.environ["CAIRNDEX_WORKER_ENABLED"] = "false"
    # Same for the ownership-lease heartbeat (ADR-0018): tests call
    # ``heartbeat_once`` directly rather than racing a 60s timer.
    os.environ["CAIRNDEX_LEASE_HEARTBEAT_ENABLED"] = "false"
    # Acquisition sleeps between writing a lease and reading it back to confirm
    # the claim survived. Real duration, no value in a test.
    os.environ["CAIRNDEX_LEASE_VERIFY_DELAY"] = "0"
    get_settings.cache_clear()
    yield
    os.environ.pop("CAIRNDEX_DATA_DIR", None)
    os.environ.pop("CAIRNDEX_WORKER_ENABLED", None)
    os.environ.pop("CAIRNDEX_LEASE_HEARTBEAT_ENABLED", None)
    os.environ.pop("CAIRNDEX_LEASE_VERIFY_DELAY", None)
    get_settings.cache_clear()


@pytest.fixture
def library_root(tmp_path: Path) -> Path:
    """A real on-disk library package (``.cairndex/`` + content-schema DB).

    Content tests resolve library-relative file paths against this root, and
    place any real fixture media directly under it.
    """
    root = tmp_path / "library"
    root.mkdir()
    pkg.create_package(root, "Test Library")
    return root


@pytest.fixture
def engine(library_root: Path) -> Iterator[Engine]:
    """A content engine bound to the test library's ``library.db``."""
    eng = create_app_engine(database_url=f"sqlite:///{pkg.db_path(library_root).as_posix()}")
    try:
        yield eng
    finally:
        eng.dispose()


@pytest.fixture
def session_factory(engine: Engine) -> sessionmaker[Session]:
    """A sessionmaker bound to the test engine, for driving the job worker."""
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


@pytest.fixture
def session(session_factory: sessionmaker[Session]) -> Iterator[Session]:
    with session_factory() as db_session:
        yield db_session


@pytest.fixture
def registry_engine(tmp_path: Path) -> Iterator[Engine]:
    """A fresh file-backed registry engine (separate from the content DB)."""
    db_path = tmp_path / "registry.db"
    eng = create_registry_engine(
        database_url=f"sqlite:///{db_path.as_posix()}"
    )  # create_all inside
    try:
        yield eng
    finally:
        eng.dispose()


@pytest.fixture
def registry_session_factory(registry_engine: Engine) -> sessionmaker[Session]:
    """A sessionmaker bound to the test registry engine, for the job worker."""
    return sessionmaker(bind=registry_engine, expire_on_commit=False, future=True)


@pytest.fixture
def registry_session(registry_session_factory: sessionmaker[Session]) -> Iterator[Session]:
    with registry_session_factory() as db_session:
        yield db_session


@pytest.fixture
def library_id(registry_session: Session, library_root: Path) -> str:
    """Register the test library in the registry and return its id."""
    library = registry_service.register_existing_library(
        registry_session, root_path=str(library_root)
    )
    registry_session.commit()
    return library.id


@pytest.fixture
def client(session: Session, registry_session: Session) -> Iterator[TestClient]:
    """A TestClient where library-scoped content routes use the shared test
    ``session`` (bound to the test library) and registry routes use the test
    registry session. Library-scoped URLs still need a ``library_id`` (see the
    ``library_id`` fixture); resolution is bypassed so all writes share one
    connection and are immediately visible to direct session assertions.
    """
    app = create_app()

    def _override_get_registry_db() -> Iterator[Session]:
        try:
            yield registry_session
            registry_session.commit()
        except Exception:
            registry_session.rollback()
            raise

    def _override_get_library_session() -> Iterator[Session]:
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise

    def _override_get_library_access() -> LibraryAccess:
        # Streaming routes resolve the path through this handle. Bind its scope
        # to the shared test session (commit on exit, never close — the fixture
        # owns the session's lifetime) so assertions still see the same rows.
        @contextmanager
        def _open() -> Iterator[Session]:
            try:
                yield session
                session.commit()
            except Exception:
                session.rollback()
                raise

        return LibraryAccess(open_session=_open)

    app.dependency_overrides[get_registry_db] = _override_get_registry_db
    app.dependency_overrides[get_library_session] = _override_get_library_session
    app.dependency_overrides[get_library_access] = _override_get_library_access
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def _registry_access_override(registry_session: Session) -> RegistryAccess:
    """A ``RegistryAccess`` bound to the shared test registry session (commit on
    exit, never close — the fixture owns the session's lifetime)."""

    @contextmanager
    def _open() -> Iterator[Session]:
        try:
            yield registry_session
            registry_session.commit()
        except Exception:
            registry_session.rollback()
            raise

    return RegistryAccess(open_session=_open)


@pytest.fixture
def isolated_client(registry_session: Session) -> Iterator[TestClient]:
    """A TestClient with only the registry overridden, so library-scoped routes
    perform real per-library resolution and open each library's own DB. Used to
    prove cross-library isolation."""
    app = create_app()

    def _override_get_registry_db() -> Iterator[Session]:
        try:
            yield registry_session
            registry_session.commit()
        except Exception:
            registry_session.rollback()
            raise

    app.dependency_overrides[get_registry_db] = _override_get_registry_db
    app.dependency_overrides[get_registry_access] = lambda: _registry_access_override(
        registry_session
    )
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
