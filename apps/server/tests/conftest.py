import os
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from cairndex.api.deps import get_db
from cairndex.core.config import get_settings
from cairndex.main import create_app
from cairndex.persistence import models  # noqa: F401  (register metadata)
from cairndex.persistence.base import Base
from cairndex.persistence.engine import create_app_engine


@pytest.fixture(autouse=True, scope="session")
def _isolate_data_dir(tmp_path_factory: pytest.TempPathFactory) -> Iterator[None]:
    """Point the app-data dir at a temp location for the whole test session.

    Keeps tests hermetic — no database/cache files land in the repo's var/.
    """
    data_dir = tmp_path_factory.mktemp("cairndex-data")
    os.environ["CAIRNDEX_DATA_DIR"] = str(data_dir)
    # Drive jobs deterministically in tests; no background polling thread.
    os.environ["CAIRNDEX_WORKER_ENABLED"] = "false"
    get_settings.cache_clear()
    yield
    os.environ.pop("CAIRNDEX_DATA_DIR", None)
    os.environ.pop("CAIRNDEX_WORKER_ENABLED", None)
    get_settings.cache_clear()


@pytest.fixture
def engine(tmp_path: "os.PathLike[str]") -> Iterator[Engine]:
    """A fresh file-backed SQLite engine with the schema created via metadata.

    Uses create_all (fast) rather than running migrations; the migration
    itself is exercised separately in test_migrations.py.
    """
    db_path = os.path.join(tmp_path, "test.db")
    eng = create_app_engine(database_url=f"sqlite:///{db_path}")
    Base.metadata.create_all(eng)
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
def client(session: Session) -> Iterator[TestClient]:
    """A TestClient whose DB dependency is bound to the test session.

    Requests share the fixture session and commit on success, so writes from
    one request are visible to the next (and to direct session assertions).
    """
    app = create_app()

    def _override_get_db() -> Iterator[Session]:
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
