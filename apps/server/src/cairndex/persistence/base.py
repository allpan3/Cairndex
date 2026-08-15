from datetime import datetime
from typing import Annotated

from sqlalchemy import Integer, MetaData, String
from sqlalchemy.orm import DeclarativeBase, mapped_column

from cairndex.core.ids import new_id
from cairndex.core.time import utcnow
from cairndex.persistence.types import UtcDateTime

# Deterministic constraint/index names so Alembic autogenerate and SQLite
# batch migrations (which recreate tables) produce stable, nameable
# constraints (ADR-0002).
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


# Schema name under which each library connection attaches the server's own
# grouping-plan database (ADR-0022). A model declared with this schema lives in
# that local file, not in ``library.db``. It is attached rather than opened as a
# second engine so a query may still join a plan to the library rows it describes.
PLANS_SCHEMA = "plans"


class Base(DeclarativeBase):
    """Declarative base for all Cairndex ORM models."""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)


# Reusable typed columns (ADR-0002). SQLAlchemy copies the `mapped_column`
# carried in an Annotated alias for each model that uses it, so these are safe
# to share across model definitions.

# ULID primary key: 26-char Crockford base32, generated in the app layer.
UlidPk = Annotated[str, mapped_column(String(26), primary_key=True, default=new_id)]

# ULID foreign-key-sized column (the FK target is declared per-model).
UlidFk = Annotated[str, mapped_column(String(26))]

# Timezone-aware UTC timestamps, defaulted in the application layer (ADR-0002).
# CreatedAt is set once on insert; UpdatedAt also refreshes on update.
CreatedAt = Annotated[datetime, mapped_column(UtcDateTime, default=utcnow)]
UpdatedAt = Annotated[
    datetime,
    mapped_column(UtcDateTime, default=utcnow, onupdate=utcnow),
]

# Optimistic-concurrency counter (ADR-0008 phase 9). Starts at 1 and is bumped
# by the service layer on each client edit; write APIs may require a matching
# expected version (``If-Match``) and reject stale writes with 409. Bumped
# explicitly (not via version_id_col) so internal scan/repair updates don't risk
# StaleDataError in the single-writer model.
Version = Annotated[int, mapped_column(Integer, default=1, server_default="1")]
