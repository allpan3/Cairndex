"""Alembic migration environment for Cairndex.

The database URL and engine (with SQLite pragmas) come from application
settings so migrations target the same database as the app. `render_as_batch`
is enabled because SQLite's limited ALTER TABLE support requires Alembic's
batch mode for most schema changes (ADR-0002).
"""

from logging.config import fileConfig
from typing import Any

from alembic import context
from alembic.autogenerate.api import AutogenContext

from cairndex.core.config import get_settings
from cairndex.persistence import models  # noqa: F401  (populate metadata)
from cairndex.persistence.base import Base
from cairndex.persistence.engine import create_app_engine
from cairndex.persistence.types import UtcDateTime

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def render_item(type_: str, obj: Any, autogen_context: AutogenContext) -> str | bool:
    """Render custom column types as their plain SQLAlchemy equivalent.

    Keeps generated migrations independent of application code: UtcDateTime
    (a TypeDecorator over DateTime(timezone=True)) emits identical DDL, so the
    migration can use the stock type and never import cairndex packages.
    """
    if type_ == "type" and isinstance(obj, UtcDateTime):
        return "sa.DateTime(timezone=True)"
    return False


def run_migrations_offline() -> None:
    url = get_settings().resolved_database_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
        compare_type=True,
        render_item=render_item,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_app_engine()
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
            compare_type=True,
            render_item=render_item,
        )
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
