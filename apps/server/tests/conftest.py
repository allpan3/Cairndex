import os
from collections.abc import Iterator

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from cairndex.core.config import get_settings
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
    get_settings.cache_clear()
    yield
    os.environ.pop("CAIRNDEX_DATA_DIR", None)
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
def session(engine: Engine) -> Iterator[Session]:
    maker = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    with maker() as db_session:
        yield db_session
