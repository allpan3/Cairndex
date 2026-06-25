import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect

from cairndex.core.config import get_settings

SERVER_DIR = Path(__file__).resolve().parents[1]

EXPECTED_TABLES = {
    "storage_roots",
    "asset_bundles",
    "asset_files",
    "tags",
    "tag_groups",
    "tag_group_memberships",
    "asset_bundle_tags",
    "folders",
    "asset_bundle_folders",
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
