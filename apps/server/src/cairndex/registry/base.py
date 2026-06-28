from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

from cairndex.persistence.base import NAMING_CONVENTION


class RegistryBase(DeclarativeBase):
    """Declarative base for registry models (ADR-0008).

    Deliberately separate from the content ``persistence.base.Base`` so the
    registry database and any per-library database never share a metadata
    object — their schemas are created and evolved independently. The naming
    convention is reused so constraint/index names stay consistent project-wide.
    """

    metadata = MetaData(naming_convention=NAMING_CONVENTION)
