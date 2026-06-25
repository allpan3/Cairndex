from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from cairndex.devtools.synthetic import seed_synthetic_library
from cairndex.persistence.base import Base
from cairndex.persistence.engine import create_app_engine
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.services import bundles as bundle_service


def _seed_fresh_db(tmp_path: Path, name: str, *, n_bundles: int, seed: int) -> int:
    engine = create_app_engine(database_url=f"sqlite:///{tmp_path / name}")
    Base.metadata.create_all(engine)
    maker = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    with maker() as session:
        summary = seed_synthetic_library(session, n_bundles=n_bundles, seed=seed)
        session.commit()
    engine.dispose()
    return summary.files


def test_seed_creates_requested_counts(session: Session) -> None:
    summary = seed_synthetic_library(session, n_bundles=25, seed=1)

    assert summary.bundles == 25
    bundle_count = session.scalar(select(func.count()).select_from(AssetBundle))
    assert bundle_count == 25
    file_count = session.scalar(select(func.count()).select_from(AssetFile))
    assert file_count == summary.files
    assert summary.files >= summary.bundles  # at least one file per bundle


def test_seed_is_deterministic(tmp_path: Path) -> None:
    # Same seed, two independent fresh databases => identical file count.
    a = _seed_fresh_db(tmp_path, "a.db", n_bundles=15, seed=7)
    b = _seed_fresh_db(tmp_path, "b.db", n_bundles=15, seed=7)
    assert a == b


def test_seeded_bundles_paginate(session: Session) -> None:
    seed_synthetic_library(session, n_bundles=120, seed=3)
    first, cursor = bundle_service.list_bundles(session, limit=50, cursor=None)
    assert len(first) == 50
    assert cursor is not None
