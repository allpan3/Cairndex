"""Tests for the perf devtools: the bulk synthetic-library generator and the
query benchmark. These stay small (dozens of bundles) so they are fast; the
tools' value is at 100k scale, exercised manually."""

from pathlib import Path

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, sessionmaker

from cairndex.devtools import benchmark_queries
from cairndex.devtools.synthetic_library import generate_synthetic_library, parse_range
from cairndex.persistence.base import Base
from cairndex.persistence.engine import create_app_engine
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.registry import library_package as pkg
from cairndex.search import FTS_TABLE
from cairndex.services import browse as browse_service
from cairndex.services import bundles as bundle_service


def _fresh_session(db_path: Path) -> tuple[Session, object]:
    engine = create_app_engine(database_url=f"sqlite:///{db_path}")
    Base.metadata.create_all(engine)
    maker = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    return maker(), engine


def test_parse_range() -> None:
    assert parse_range("1-5") == (1, 5)
    assert parse_range("3") == (3, 3)
    with pytest.raises(ValueError):
        parse_range("5-1")
    with pytest.raises(ValueError):
        parse_range("0")


def test_generate_creates_requested_counts(tmp_path: Path) -> None:
    session, engine = _fresh_session(tmp_path / "gen.db")
    try:
        summary = generate_synthetic_library(
            session,
            n_bundles=50,
            files_per_bundle=(1, 3),
            n_collections=10,
            n_tags=20,
            seed=5,
        )
        assert summary.bundles == 50
        assert session.scalar(select(func.count()).select_from(AssetBundle)) == 50
        assert session.scalar(select(func.count()).select_from(AssetFile)) == summary.files
        # Every bundle got a representative primary file pointer.
        with_primary = session.scalar(
            select(func.count())
            .select_from(AssetBundle)
            .where(AssetBundle.primary_file_id.isnot(None))
        )
        assert with_primary == 50
    finally:
        session.close()
        engine.dispose()  # type: ignore[attr-defined]


def test_generate_is_deterministic(tmp_path: Path) -> None:
    def gen(name: str) -> int:
        session, engine = _fresh_session(tmp_path / name)
        try:
            return generate_synthetic_library(
                session, n_bundles=30, n_collections=5, n_tags=10, seed=42
            ).files
        finally:
            session.close()
            engine.dispose()  # type: ignore[attr-defined]

    assert gen("a.db") == gen("b.db")


def test_generate_rebuilds_search_index_and_restores_triggers(tmp_path: Path) -> None:
    """Regression test: the bulk generator must suspend FTS maintenance
    triggers during the load (they are pathologically slow per-row at scale —
    see synthetic_library.generate_synthetic_library) and restore them
    afterward, leaving a correct, fully-populated, and live search index."""
    root = tmp_path / "lib"
    root.mkdir()
    pkg.create_package(root, "Search Regression")  # pre-creates the FTS schema
    engine = create_app_engine(database_url=f"sqlite:///{pkg.db_path(root).as_posix()}")
    with Session(engine) as session:
        summary = generate_synthetic_library(
            session, n_bundles=60, n_collections=10, n_tags=15, seed=3
        )
        # The index is fully populated (not left empty by suspended triggers).
        fts_count = session.execute(text(f"SELECT count(*) FROM {FTS_TABLE}")).scalar_one()
        assert fts_count == summary.bundles

        # A generated bundle is actually findable by title.
        hit = browse_service.browse_bundles(session, search="Synthetic Bundle 000005", limit=5)
        assert [b.title for b in hit.items] == ["Synthetic Bundle 000005"]

        # Triggers are restored: a post-generation write is indexed immediately.
        bundle_service.create_bundle(session, title="Post-Generation Probe")
        session.commit()
        probe = browse_service.browse_bundles(session, search="Probe", limit=5)
        assert [b.title for b in probe.items] == ["Post-Generation Probe"]
    engine.dispose()


def test_benchmark_runs_on_generated_library(tmp_path: Path) -> None:
    root = tmp_path / "lib"
    root.mkdir()
    pkg.create_package(root, "Bench Test")
    engine = create_app_engine(database_url=f"sqlite:///{pkg.db_path(root).as_posix()}")
    with Session(engine) as session:
        generate_synthetic_library(session, n_bundles=40, n_collections=8, n_tags=15, seed=1)
    engine.dispose()

    report = benchmark_queries.run(root, iterations=2, explain=True)
    assert report["total_bundles"] == 40
    names = {r["name"] for r in report["results"]}
    # The core paths the milestone requires are all measured.
    assert {
        "browse_first_page",
        "collection_counts",
        "tag_counts",
        "view_counts",
        "collection_descendant_filter",
        "tag_descendant_filter",
        "bundle_detail_read",
        "thumbnail_lookup",
    } <= names
    # EXPLAIN captured a plan for at least the browse path.
    assert report["query_plans"]["browse_first_page"]
