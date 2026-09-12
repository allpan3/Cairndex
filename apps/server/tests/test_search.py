"""Whole-library FTS5 metadata search: coverage, freshness, escaping, API."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, inspect, text
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileRole, MediaKind
from cairndex.search import ensure_search_schema, rebuild, to_match_query
from cairndex.search.index import FTS_TABLE
from cairndex.services import browse as browse_service
from cairndex.services import bundles as bundle_service
from cairndex.services import tags as tag_service


def _titles(session: Session, q: str, **kw: object) -> list[str | None]:
    page = browse_service.browse_bundles(session, search=q, limit=100, **kw)  # type: ignore[arg-type]
    return [b.title for b in page.items]


def test_to_match_query_escaping() -> None:
    assert to_match_query("cosmos ep") == '"cosmos"* "ep"*'
    assert to_match_query("  spaced  ") == '"spaced"*'
    assert to_match_query("!!!") is None
    assert to_match_query("") is None
    # FTS operators are neutralized (treated as literal terms, no syntax error).
    assert to_match_query('a AND "b') == '"a"* "AND"* "b"*'


def test_search_finds_item_beyond_first_page(session: Session) -> None:
    for i in range(150):
        bundle_service.create_bundle(session, title=f"Filler {i:03d}")
    target = bundle_service.create_bundle(session, title="Cosmos Documentary", notes=["deep space"])
    bundle_service.add_file(
        session,
        target.id,
        relative_path="dir/cosmos_ep01.mkv",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    tag = tag_service.create_tag(session, name="astronomy")
    bundle_service.set_bundle_tags(session, target.id, [tag.id])
    session.commit()

    assert _titles(session, "cosmos") == ["Cosmos Documentary"]
    assert _titles(session, "ep01") == []  # filenames belong in File Browser
    assert _titles(session, "astronomy") == []  # tags remain explicit filters
    assert _titles(session, "space") == ["Cosmos Documentary"]  # note
    assert _titles(session, "zzznope") == []


def test_search_updates_on_edit_and_delete(session: Session) -> None:
    b = bundle_service.create_bundle(session, title="Original Title")
    session.commit()
    assert _titles(session, "original") == ["Original Title"]

    bundle_service.update_bundle(session, b.id, {"title": "Renamed"})
    session.commit()
    assert _titles(session, "original") == []  # stale text gone
    assert _titles(session, "renamed") == ["Renamed"]

    bundle_service.delete_bundle(session, b.id)
    session.commit()
    assert _titles(session, "renamed") == []


def test_tag_names_never_enter_free_text(session: Session) -> None:
    b = bundle_service.create_bundle(session, title="Movie")
    tag = tag_service.create_tag(session, name="thriller")
    bundle_service.set_bundle_tags(session, b.id, [tag.id])
    session.commit()
    assert _titles(session, "thriller") == []

    tag_service.update_tag(session, tag.id, name="suspense")
    session.commit()
    assert _titles(session, "thriller") == []
    assert _titles(session, "suspense") == []


def test_search_composes_with_filter(session: Session) -> None:
    keep = bundle_service.create_bundle(session, title="Space Odyssey", rating=5)
    bundle_service.create_bundle(session, title="Space Filler", rating=1)
    session.commit()
    from cairndex.filters.ast import FilterExpression, PredicateNode

    expr = FilterExpression(root=PredicateNode(field="rating", operator="gte", value=4))
    page = browse_service.browse_bundles(session, search="space", filter_expr=expr, limit=100)
    assert [b.title for b in page.items] == ["Space Odyssey"]
    assert page.total == 1
    _ = keep


def test_rebuild_repopulates(session: Session) -> None:
    bundle_service.create_bundle(session, title="Alpha")
    bundle_service.create_bundle(session, title="Beta")
    session.commit()
    count = rebuild(session)
    session.commit()
    assert count == 2
    assert _titles(session, "alpha") == ["Alpha"]


def test_ensure_search_schema_rebuilds_after_column_rename(
    engine: Engine, session: Session
) -> None:
    """A library whose FTS table predates the note→notes column rename is
    detected as stale and rebuilt (table + triggers), without data loss."""
    # Replace the current index with the pre-rename schema (column ``note``).
    with engine.begin() as conn:
        conn.exec_driver_sql(f"DROP TABLE IF EXISTS {FTS_TABLE}")
        conn.exec_driver_sql(
            f"CREATE VIRTUAL TABLE {FTS_TABLE} USING fts5("
            "bundle_id UNINDEXED, title, note, files, tags, collections)"
        )
    assert "note" in {c["name"] for c in inspect(engine).get_columns(FTS_TABLE)}

    ensure_search_schema(engine)

    cols = {c["name"] for c in inspect(engine).get_columns(FTS_TABLE)}
    assert "notes" in cols and "note" not in cols

    # The rebuilt index + triggers index notes on subsequent writes.
    bundle_service.create_bundle(session, title="Rebuilt", notes=["distinctivemarker"])
    session.commit()
    assert _titles(session, "distinctivemarker") == ["Rebuilt"]


def test_browse_api_q_param(client: TestClient, library_id: str, session: Session) -> None:
    bundle_service.create_bundle(session, title="Findable Widget")
    bundle_service.create_bundle(session, title="Other Thing")
    session.commit()

    got = client.get(f"/api/v1/libraries/{library_id}/bundles/browse?q=widget")
    assert got.status_code == 200
    body = got.json()
    assert body["total"] == 1
    assert body["items"][0]["title"] == "Findable Widget"

    # POST browse also accepts q (alongside a filter AST).
    posted = client.post(
        f"/api/v1/libraries/{library_id}/bundles/browse",
        json={"q": "other"},
    )
    assert posted.status_code == 200
    assert [i["title"] for i in posted.json()["items"]] == ["Other Thing"]


# --- the index is keyed on the bundle's rowid ---------------------------------
# Every maintenance trigger used to locate a bundle's FTS row with
# ``WHERE bundle_id = ?``. ``bundle_id`` is UNINDEXED and FTS5 supports no
# secondary indexes, so each of those was a full scan of the index: 8.5 ms on a
# synthetic 60k-bundle library, against 0.0 ms by rowid, and a create fires ten
# of them (owner: "creating a bundle takes about 5 seconds", 2026-08-26).
def _fts_rowids(session: Session) -> dict[int, str]:
    return {
        int(rowid): str(bundle_id)
        for rowid, bundle_id in session.execute(
            text(f"SELECT rowid, bundle_id FROM {FTS_TABLE}")
        ).all()
    }


def test_fts_rowid_is_the_bundles_own_rowid(session: Session) -> None:
    """The invariant the rowid-keyed triggers depend on: an FTS row's rowid is
    its bundle's rowid. If these ever drift, every trigger silently maintains
    the wrong row."""
    a = bundle_service.create_bundle(session, title="Alpha")
    b = bundle_service.create_bundle(session, title="Beta")
    session.commit()
    # The edit matters: a reindex is a delete-then-insert, and under the old
    # bundle_id-keyed scheme the reinserted row took a *fresh* auto rowid at the
    # top of the sequence. Without an edit first, auto rowids and bundle rowids
    # coincidentally agree on a fresh database and this asserts nothing.
    bundle_service.update_bundle(session, a.id, {"title": "Alphaedited"})
    session.commit()

    by_rowid = _fts_rowids(session)
    for bundle in (a, b):
        own = session.execute(
            text("SELECT rowid FROM asset_bundles WHERE id = :id"), {"id": bundle.id}
        ).scalar_one()
        assert by_rowid[int(own)] == bundle.id


def test_deleting_a_bundle_leaves_no_index_row(session: Session) -> None:
    """The delete trigger has to read ``OLD.rowid``: by the time it fires the
    bundle row is gone, so resolving the rowid through ``asset_bundles`` would
    match nothing and orphan the FTS row forever."""
    keep = bundle_service.create_bundle(session, title="Keeper")
    doomed = bundle_service.create_bundle(session, title="Doomedmarker")
    session.commit()
    assert _titles(session, "doomedmarker") == ["Doomedmarker"]

    bundle_service.delete_bundle(session, doomed.id)
    session.commit()

    assert _titles(session, "doomedmarker") == []
    assert set(_fts_rowids(session).values()) == {keep.id}


def test_index_survives_a_rebuild_keyed_on_rowid(session: Session) -> None:
    """A rebuild must reassign the same rowids, or the triggers start
    maintaining rows that belong to other bundles."""
    a = bundle_service.create_bundle(session, title="Alpha")
    bundle_service.create_bundle(session, title="Beta")
    session.commit()
    before = _fts_rowids(session)

    rebuild(session)
    session.commit()

    assert _fts_rowids(session) == before
    # And the triggers still maintain the right row afterwards.
    bundle_service.update_bundle(session, a.id, {"title": "Renamedmarker"})
    session.commit()
    assert _titles(session, "renamedmarker") == ["Renamedmarker"]
    assert _titles(session, "beta") == ["Beta"]


def test_an_index_predating_rowid_keying_is_rebuilt(engine: Engine, session: Session) -> None:
    """A library whose triggers still key on ``bundle_id`` is detected and
    rebuilt on open. Its FTS rowids bear no relation to ``asset_bundles.rowid``,
    so leaving them would point every trigger at the wrong row."""
    bundle_service.create_bundle(session, title="Existingmarker")
    session.commit()

    # Recreate the pre-change state: auto-assigned rowids and a bundle_id-keyed
    # trigger, exactly as an older library carries them.
    with engine.begin() as conn:
        conn.exec_driver_sql("DROP TRIGGER IF EXISTS bundle_search_bundle_ai")
        conn.exec_driver_sql(f"DELETE FROM {FTS_TABLE}")
        conn.exec_driver_sql(
            f"INSERT INTO {FTS_TABLE}(rowid, bundle_id, title, notes, file_notes, moments) "
            "VALUES (9999, 'stale-id', 'stale', '', '', '')"
        )
        conn.exec_driver_sql(
            "CREATE TRIGGER bundle_search_bundle_ai AFTER INSERT ON asset_bundles BEGIN "
            f"DELETE FROM {FTS_TABLE} WHERE bundle_id = NEW.id; END"
        )

    ensure_search_schema(engine)

    # Rebuilt from the source view, so the stale row is gone and every real
    # bundle is indexed at its own rowid.
    rows = _fts_rowids(session)
    assert "stale-id" not in rows.values()
    assert _titles(session, "existingmarker") == ["Existingmarker"]
    for rowid, bundle_id in rows.items():
        own = session.execute(
            text("SELECT rowid FROM asset_bundles WHERE id = :id"), {"id": bundle_id}
        ).scalar_one()
        assert int(own) == rowid


# Each note family must update and disappear independently through normal service writes
def test_all_notes_moments_and_membership_updates(session: Session) -> None:
    from cairndex.persistence.models import AssetFile
    from cairndex.services import moments

    first = bundle_service.create_bundle(session, title="First", notes=["Ambernote", "Bluenote"])
    second = bundle_service.create_bundle(session, title="Second")
    file = bundle_service.add_file(
        session,
        first.id,
        relative_path="pathonly/filenameonly.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    file.note = "Filenote"
    file.source = "Sourceonly"
    mark = moments.create_moment(
        session, first.id, file_id=file.id, start_s=1, comment="Momentnote"
    )
    session.commit()
    for term in ["Ambernote", "Bluenote", "Filenote", "Momentnote"]:
        assert _titles(session, term) == ["First"]
    for term in ["pathonly", "filenameonly", "Sourceonly", "video"]:
        assert _titles(session, term) == []
    bundle_service.update_bundle(session, first.id, {"notes": ["Bluenote", "Greennote"]})
    moments.update_moment(session, first.id, mark.id, {"comment": "Newmoment"})
    file.note = "Newfile"
    session.commit()
    for term in ["Ambernote", "Momentnote", "Filenote"]:
        assert _titles(session, term) == []
    for term in ["Bluenote", "Greennote", "Newmoment", "Newfile"]:
        assert _titles(session, term) == ["First"]

    # Raw membership updates also move search ownership, without relying on ORM listeners
    session.execute(
        text("UPDATE asset_files SET bundle_id=:bundle WHERE id=:id"),
        {"bundle": second.id, "id": file.id},
    )
    session.commit()
    assert _titles(session, "Newfile") == ["Second"]
    assert _titles(session, "Newmoment") == ["Second"]
    assert _titles(session, "Bluenote") == ["First"]
    session.expire_all()
    file = session.get(AssetFile, file.id)
    file.bundle_id = first.id
    session.commit()
    assert _titles(session, "Newmoment") == ["First"]
    moments.delete_moment(session, first.id, mark.id)
    session.commit()
    assert _titles(session, "Newmoment") == []
    session.delete(file)
    session.commit()
    assert _titles(session, "Newfile") == []
    bundle_service.update_bundle(session, first.id, {"notes": []})
    session.commit()
    assert _titles(session, "Bluenote") == []


# Explicit tag and collection filters remain available independently of free text
def test_membership_filters_survive_excluded_names(session: Session) -> None:
    from cairndex.filters.ast import FilterExpression, PredicateNode
    from cairndex.services import collections

    bundle = bundle_service.create_bundle(session, title="Visible")
    tag = tag_service.create_tag(session, name="Tagonly")
    collection = collections.create_collection(session, name="Collectiononly")
    bundle_service.set_bundle_tags(session, bundle.id, [tag.id])
    bundle_service.set_bundle_collections(session, bundle.id, [collection.id])
    session.commit()
    for field, target, term in [
        ("tags", tag.id, "Tagonly"),
        ("collections", collection.id, "Collectiononly"),
    ]:
        assert _titles(session, term) == []
        expr = FilterExpression(
            root=PredicateNode(field=field, operator="contains_any", value=[target])
        )
        assert _titles(session, "Visible", filter_expr=expr) == ["Visible"]
    collections.update_collection(session, collection.id, name="Renamedcollection")
    session.commit()
    assert _titles(session, "Renamedcollection") == []


# Failed upgrades roll back both DDL and data; retry rebuilds in bounded batches only once
def test_versioned_upgrade_is_atomic_bounded_and_idempotent(
    engine: Engine, session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from cairndex.search import index

    for i in range(520):
        bundle_service.create_bundle(session, title=f"Seed {i}", notes=["Notemarker"])
    session.commit()
    with engine.begin() as conn:
        for name, _ in index._TRIGGERS:
            conn.exec_driver_sql(f"DROP TRIGGER {name}")
        conn.exec_driver_sql(f"DROP TABLE {FTS_TABLE}")
        conn.exec_driver_sql(
            f"CREATE VIRTUAL TABLE {FTS_TABLE} USING fts5("
            "bundle_id UNINDEXED, title, notes, files, tags, collections)"
        )
        conn.exec_driver_sql(
            f"INSERT INTO {FTS_TABLE}(bundle_id, title, files) "
            "VALUES ('old', 'Legacy', 'Excludedfilename')"
        )
        conn.exec_driver_sql(
            "CREATE TRIGGER bundle_search_tag_ai AFTER INSERT ON "
            "asset_bundle_tags BEGIN SELECT 1; END"
        )
    populate = index._populate

    def fail(conn):
        populate(conn)
        raise RuntimeError("synthetic interrupted upgrade")

    monkeypatch.setattr(index, "_populate", fail)
    with pytest.raises(RuntimeError):
        ensure_search_schema(engine)
    with engine.connect() as conn:
        assert (
            conn.exec_driver_sql(f"SELECT files FROM {FTS_TABLE}").scalar_one()
            == "Excludedfilename"
        )
        assert (
            conn.exec_driver_sql(
                "SELECT count(*) FROM sqlite_master WHERE name='bundle_search_tag_ai'"
            ).scalar_one()
            == 1
        )
    monkeypatch.setattr(index, "_populate", populate)
    statements = []
    from sqlalchemy import event

    def record(conn, cursor, statement, parameters, context, executemany):
        if statement.startswith(f"INSERT INTO {FTS_TABLE}(rowid"):
            statements.append(parameters)

    event.listen(engine, "before_cursor_execute", record)
    try:
        ensure_search_schema(engine)
        assert len(statements) == 3
        assert all(high - low < index._BATCH_SIZE for low, high in statements)
        statements.clear()
        ensure_search_schema(engine)
        assert statements == []
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert len(_fts_rowids(session)) == 520
    assert _titles(session, "Excludedfilename") == []
    assert browse_service.browse_bundles(session, search="Notemarker", limit=1).total == 520
    bundle_service.create_bundle(session, title="Afterupgrade")
    session.commit()
    assert _titles(session, "Afterupgrade") == ["Afterupgrade"]


# Independent database caches cannot cross the active library boundary
def test_search_isolated_between_libraries(session: Session, tmp_path: Path) -> None:
    from cairndex.persistence.engine import create_app_engine
    from cairndex.registry.library_package import create_package, db_path

    root = tmp_path / "separate"
    root.mkdir()
    create_package(root, "Separate")
    engine = create_app_engine(database_url=f"sqlite:///{db_path(root)}")
    try:
        with Session(engine) as other:
            bundle_service.create_bundle(session, title="Firstscope")
            bundle_service.create_bundle(other, title="Secondscope")
            session.commit()
            other.commit()
            assert _titles(session, "Secondscope") == []
            assert _titles(other, "Firstscope") == []
            assert _titles(other, "Secondscope") == ["Secondscope"]
    finally:
        engine.dispose()


# A version-only cache change must rebuild even when the column names still match
def test_search_version_marker_and_legacy_note_boundary(engine: Engine, session: Session) -> None:
    from cairndex.search import index

    bundle = bundle_service.create_bundle(session, title="Current", notes=["Acceptednote"])
    session.commit()
    with engine.begin() as conn:
        # The retired scalar field is not authored content under the current notes contract
        conn.exec_driver_sql("ALTER TABLE asset_bundles ADD COLUMN note TEXT")
        conn.exec_driver_sql("UPDATE asset_bundles SET note='Retirednote'")
        conn.exec_driver_sql(f"DROP VIEW {index._SOURCE_VIEW}")
        conn.exec_driver_sql(
            index._CREATE_VIEW.replace(index._VERSION_MARKER, "cairndex-search-version: 1")
        )
        conn.exec_driver_sql(f"DELETE FROM {FTS_TABLE}")
    ensure_search_schema(engine)
    assert _titles(session, "Acceptednote") == ["Current"]
    assert _titles(session, "Retirednote") == []
    assert set(_fts_rowids(session).values()) == {bundle.id}
