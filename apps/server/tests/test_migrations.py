import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from cairndex.core.config import get_settings

SERVER_DIR = Path(__file__).resolve().parents[1]

# The revision immediately before folders -> collections.
_BEFORE_COLLECTIONS = "bfa871853413"
_COLLECTIONS = "a1b2c3d4e5f6"

EXPECTED_TABLES = {
    "storage_roots",
    "asset_bundles",
    "asset_files",
    "tags",
    "tag_groups",
    "tag_group_memberships",
    "asset_bundle_tags",
    "collections",
    "asset_bundle_collections",
    "smart_folders",
}


def _alembic_config(database_url: str) -> Config:
    cfg = Config(str(SERVER_DIR / "alembic.ini"))
    # Use absolute paths so the test is independent of the working directory.
    cfg.set_main_option("script_location", str(SERVER_DIR / "alembic"))
    os.environ["CAIRNDEX_DATABASE_URL"] = database_url
    get_settings.cache_clear()
    return cfg


@pytest.fixture
def migration_db(tmp_path: Path) -> Iterator[str]:
    url = f"sqlite:///{tmp_path / 'migrate.db'}"
    yield url
    os.environ.pop("CAIRNDEX_DATABASE_URL", None)
    get_settings.cache_clear()


def test_upgrade_creates_all_core_tables(migration_db: str) -> None:
    cfg = _alembic_config(migration_db)
    command.upgrade(cfg, "head")

    inspector = inspect(create_engine(migration_db))
    tables = set(inspector.get_table_names())
    assert EXPECTED_TABLES.issubset(tables)
    assert "alembic_version" in tables


def test_downgrade_then_upgrade_is_idempotent(migration_db: str) -> None:
    cfg = _alembic_config(migration_db)
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "base")

    after_downgrade = set(inspect(create_engine(migration_db)).get_table_names())
    assert EXPECTED_TABLES.isdisjoint(after_downgrade)

    command.upgrade(cfg, "head")
    after_reupgrade = set(inspect(create_engine(migration_db)).get_table_names())
    assert EXPECTED_TABLES.issubset(after_reupgrade)


def test_folders_to_collections_preserves_data(migration_db: str) -> None:
    """The folder->collection rename keeps hierarchy, ids, and memberships."""
    cfg = _alembic_config(migration_db)
    command.upgrade(cfg, _BEFORE_COLLECTIONS)

    engine = create_engine(migration_db)
    now = "2026-06-27T00:00:00+00:00"
    with engine.begin() as conn:
        conn.execute(text("PRAGMA foreign_keys=OFF"))
        conn.execute(
            text(
                "INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at) "
                "VALUES ('P', NULL, 'parent', 0, :t, :t), ('C', 'P', 'child', 0, :t, :t)"
            ),
            {"t": now},
        )
        conn.execute(
            text(
                "INSERT INTO asset_bundles (id, note, created_at, imported_at, updated_at) "
                "VALUES ('B', '', :t, :t, :t)"
            ),
            {"t": now},
        )
        conn.execute(
            text("INSERT INTO asset_bundle_folders (bundle_id, folder_id) VALUES ('B', 'C')")
        )

    command.upgrade(cfg, _COLLECTIONS)

    with create_engine(migration_db).connect() as conn:
        rows = conn.execute(text("SELECT id, parent_id, name FROM collections ORDER BY id")).all()
        assert rows == [("C", "P", "child"), ("P", None, "parent")]
        membership = conn.execute(
            text("SELECT bundle_id, collection_id FROM asset_bundle_collections")
        ).all()
        assert membership == [("B", "C")]
