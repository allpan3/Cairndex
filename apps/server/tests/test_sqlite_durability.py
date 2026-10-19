"""Assert connection policy on every platform, including Linux CI."""

import sqlite3
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from typing import Literal

import pytest

from cairndex.devtools.replica_fixture import create_fixture
from cairndex.persistence import sqlite_durability
from cairndex.persistence.engine import create_app_engine
from cairndex.registry.engine import create_registry_engine
from cairndex.replicas.store import Store


def _settings(db: sqlite3.Connection, schema: str = "main") -> tuple[int, int, int]:
    return (
        db.execute(f"PRAGMA {schema}.synchronous").fetchone()[0],
        db.execute("PRAGMA fullfsync").fetchone()[0],
        db.execute("PRAGMA checkpoint_fullfsync").fetchone()[0],
    )


@pytest.mark.parametrize("platform", ["darwin", "linux", "win32"])
@pytest.mark.parametrize("synchronous", ["NORMAL", "FULL"])
def test_platform_policy(
    monkeypatch: pytest.MonkeyPatch, platform: str, synchronous: Literal["NORMAL", "FULL"]
) -> None:
    monkeypatch.setattr(sqlite_durability, "sys", SimpleNamespace(platform=platform))
    with closing(sqlite3.connect(":memory:")) as db:
        sqlite_durability.configure_durability(db, synchronous=synchronous)
        assert _settings(db) == (
            (2, 1, 1) if platform == "darwin" else (1 if synchronous == "NORMAL" else 2, 0, 0)
        )


@pytest.mark.parametrize("platform", ["darwin", "linux", "win32"])
def test_writers_and_new_pooled_connections_use_policy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, platform: str
) -> None:
    monkeypatch.setattr(sqlite_durability, "sys", SimpleNamespace(platform=platform))
    flags = (1, 1) if platform == "darwin" else (0, 0)
    with closing(sqlite_durability.connect_writable(tmp_path / "backup.db")) as db:
        assert _settings(db) == (2, *flags)

    store = Store(tmp_path / "private", create_fixture(tmp_path / "source"))
    with store.connection() as db:
        assert _settings(db) == (2, *flags)

    for factory in (create_app_engine, create_registry_engine):
        engine = factory(f"sqlite:///{tmp_path / (factory.__name__ + '.db')}")
        try:
            # Concurrent checkouts force the pool to open a second DBAPI connection.
            with engine.connect() as first, engine.connect() as second:
                for connection in (first, second):
                    db = connection.connection.driver_connection
                    assert _settings(db) == (2 if platform == "darwin" else 1, *flags)
                    if factory is create_app_engine:
                        assert _settings(db, "plans") == (2, *flags)
        finally:
            engine.dispose()
