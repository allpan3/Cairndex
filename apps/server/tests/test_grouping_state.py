"""Bundle grouping state (ADR-0009 phase 1).

Scan stages files in *provisional* bundles awaiting review; fast-add and manual
creation produce *confirmed* bundles (the user already chose the grouping);
pre-grouping-state rows backfill as confirmed/legacy via server defaults.
"""

from pathlib import Path

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from cairndex.core.ids import new_id
from cairndex.core.time import utcnow
from cairndex.domain.enums import Grouping, GroupingSource, GroupingState
from cairndex.persistence.models import AssetBundle
from cairndex.scanning.fast_add import fast_add
from cairndex.scanning.scanner import SCAN_GROUPING_RULE_VERSION, scan_library
from cairndex.services.bundles import create_bundle


def test_scan_created_bundles_are_provisional(session: Session, library_root: Path) -> None:
    (library_root / "cosmos.mp4").write_text("video")
    scan_library(session, library_root)

    bundles = list(session.scalars(select(AssetBundle)))
    assert bundles, "scan should have created a bundle"
    for bundle in bundles:
        assert bundle.grouping_state is GroupingState.PROVISIONAL
        assert bundle.grouping_source is GroupingSource.SCAN_SUGGESTION
        assert bundle.grouping_rule_version == SCAN_GROUPING_RULE_VERSION
        assert bundle.confirmed_at is None


def test_fast_add_bundles_are_confirmed(session: Session, library_root: Path) -> None:
    (library_root / "loose.mp4").write_text("video")
    fast_add(session, paths=["loose.mp4"], grouping=Grouping.PER_FILE)

    bundle = session.scalars(select(AssetBundle)).one()
    assert bundle.grouping_state is GroupingState.CONFIRMED
    assert bundle.grouping_source is GroupingSource.FAST_ADD
    assert bundle.confirmed_at is not None


def test_manual_create_is_confirmed_manual(session: Session) -> None:
    bundle = create_bundle(session, title="Hand made")
    assert bundle.grouping_state is GroupingState.CONFIRMED
    assert bundle.grouping_source is GroupingSource.MANUAL
    assert bundle.confirmed_at is not None


def test_legacy_rows_backfill_as_confirmed(session: Session) -> None:
    """A row inserted without grouping columns (a pre-ADR-0009 bundle) takes the
    server defaults: confirmed/legacy, never silently treated as provisional."""
    bundle_id = new_id()
    now = utcnow().isoformat()
    # Raw INSERT omitting the grouping columns, mimicking a row written before
    # they existed; only the DB-level server_defaults fill them in. The
    # timestamp columns have app-side (not server) defaults, so supply them.
    session.execute(
        text(
            "INSERT INTO asset_bundles (id, title, created_at, imported_at, updated_at) "
            "VALUES (:id, :title, :ts, :ts, :ts)"
        ),
        {"id": bundle_id, "title": "Legacy", "ts": now},
    )
    session.commit()
    session.expire_all()

    bundle = session.get(AssetBundle, bundle_id)
    assert bundle is not None
    assert bundle.grouping_state is GroupingState.CONFIRMED
    assert bundle.grouping_source is GroupingSource.LEGACY
