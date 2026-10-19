"""Portable manual suggestions preserve the established ranking on synthetic metadata."""

from dataclasses import asdict

import pytest
from sqlalchemy.orm import Session

from cairndex.devtools.catalog_fixture import create_disposable, insert_row, synthetic_row
from cairndex.manual_bundling import suggest as legacy
from cairndex.persistence.engine import library_engine_scope
from cairndex.persistence.sqlite_durability import connect_writable
from cairndex.replicas.catalog import manual_suggestions as suggestions
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.protocol import ReplicaError
from cairndex.search.index import ensure_search_schema


@pytest.fixture(params=["folder", "root", "distant"])
def catalog(tmp_path, request):
    fixture = create_disposable(parent=tmp_path, bundles=4)
    database = fixture.source / ".cairndex/library.db"
    with connect_writable(database) as db:
        db.execute("UPDATE asset_bundles SET title='Atlas scene' WHERE id='bundle-000000'")
        db.execute(
            "UPDATE asset_bundles SET grouping_state='CONFIRMED',grouping_source='MANUAL' "
            "WHERE id IN ('bundle-000000','bundle-000003')"
        )
        db.execute(
            "UPDATE asset_files SET relative_path='Atlas/scene.mp4',directory_path='Atlas' "
            "WHERE id='file-video'"
        )
        db.execute(
            "UPDATE asset_files SET relative_path='Atlas/scene.srt',directory_path='Atlas' "
            "WHERE id='file-subtitle'"
        )
        db.execute(
            "UPDATE asset_bundles SET grouping_state='PROVISIONAL',"
            "grouping_source='SCAN_SUGGESTION' "
            "WHERE id IN ('bundle-000001','bundle-000002')"
        )
        for identity, path, owner, media in (
            ("staged-video", "Atlas/scene-part02.mp4", "bundle-000001", "VIDEO"),
            ("staged-caption", "Atlas/scene-part02.en.srt", "bundle-000001", "SUBTITLE"),
            ("staged-cover", "Atlas/cover.jpg", "bundle-000001", "IMAGE"),
            ("nearby-caption", "Atlas/scene-part02.zh.srt", "bundle-000002", "SUBTITLE"),
            ("unrelated", "Elsewhere/other.mp4", "bundle-000003", "VIDEO"),
        ):
            insert_row(
                db,
                "asset_files",
                synthetic_row(
                    "asset_files",
                    identity,
                    bundle_id=owner,
                    relative_path=path,
                    directory_path=path.rpartition("/")[0],
                    original_filename=path.rpartition("/")[2],
                    display_title=path.rpartition("/")[2],
                    media_kind=media,
                    role="OTHER",
                ),
            )
        if request.param == "root":
            db.execute(
                "UPDATE asset_files SET relative_path=replace(relative_path,'Atlas/',''),"
                "directory_path='' WHERE directory_path='Atlas'"
            )
        elif request.param == "distant":
            db.execute("UPDATE asset_bundles SET title='Archive' WHERE id='bundle-000000'")
            db.execute(
                "UPDATE asset_files SET relative_path=replace(relative_path,'Atlas/','Archive/'),"
                "directory_path='Archive' WHERE bundle_id='bundle-000000'"
            )
    converted = prepare_disposable(fixture)
    return converted.store, database


def test_ranking_titles_roles_and_nearby_files_match_the_reference(catalog, monkeypatch):
    store, database = catalog
    selected = suggestions.SeedSelection(
        file_ids=["staged-video", "staged-caption", "staged-cover"]
    )
    with library_engine_scope(f"sqlite:///{database}") as engine:
        ensure_search_schema(engine)
        with Session(engine) as session:
            expected_targets = [
                asdict(item)
                for item in legacy.suggest_target_bundles(session, selected.file_ids, limit=30)
            ]
            expected_draft = legacy.suggest_bundle_from_files(session, selected.file_ids)
            expected_nearby = [
                asdict(item)
                for item in legacy.suggest_unbundled_files_for_bundle(session, "bundle-000000")
            ]
    assert expected_targets[0]["bundle_id"] == "bundle-000000"

    def forbid(*_args, **_kwargs):
        raise AssertionError("Suggestions must not inspect source paths")

    monkeypatch.setattr("os.scandir", forbid)
    monkeypatch.setattr("cairndex.replicas.media.open_source", forbid)
    with store.connection(readonly=True) as db:
        before = list(map(tuple, db.execute("SELECT id,raw FROM events ORDER BY id")))
        assert suggestions.targets(db, selected) == expected_targets
        draft = suggestions.draft(db, selected)
        assert draft["proposed_title"] == expected_draft.proposed_title
        assert [(role["file_id"], role["role"], role["sequence"]) for role in draft["roles"]] == [
            (role.file_id, role.role, role.sequence) for role in expected_draft.roles
        ]
        assert draft["additional"] == [asdict(item) for item in expected_draft.additional]
        assert suggestions.files_for(db, "bundle-000000", 30) == expected_nearby
        assert list(map(tuple, db.execute("SELECT id,raw FROM events ORDER BY id"))) == before


def test_suggestions_refuse_confirmed_seeds_and_unknown_targets(catalog):
    store, _ = catalog
    with store.connection(readonly=True) as db:
        with pytest.raises(ReplicaError, match="Unbundled"):
            suggestions.targets(db, suggestions.SeedSelection(file_ids=["file-video"]))
        with pytest.raises(ReplicaError, match="confirmed"):
            suggestions.files_for(db, "missing", 30)


def test_filename_matches_follow_moves_and_upgrade_older_private_stores(catalog):
    from cairndex.replicas.catalog.store import CatalogStore
    from cairndex.replicas.catalog.suggestion_index import TABLES
    from cairndex.replicas.private_schema import validate_schema
    from tests.test_replica_catalog import edit, save

    store, _ = catalog
    selected = suggestions.SeedSelection(file_ids=["staged-video"])
    with store.connection(readonly=True) as db:
        assert "nearby-caption" in {
            item["file_id"] for item in suggestions.draft(db, selected)["additional"]
        }
        validate_schema(db, catalog=True)
    save(
        store,
        edit(store, "asset_files", "nearby-caption", "relative_path", "Other/lunar.srt"),
        "move",
    )
    with store.connection() as db:
        assert "nearby-caption" not in {
            item["file_id"] for item in suggestions.draft(db, selected)["additional"]
        }
        # A retained backup from before this derived index must still be recognized.
        for name in sorted(TABLES):
            if name.startswith("catalog_suggestion_path_"):
                db.execute(f"DROP TRIGGER {name}")
        db.execute("DROP TABLE catalog_suggestion_paths")
        validate_schema(db, catalog=True)
    reopened = CatalogStore(store.path.parent, store.descriptor)
    with reopened.connection(readonly=True) as db:
        validate_schema(db, catalog=True)
        assert "nearby-caption" not in {
            item["file_id"] for item in suggestions.draft(db, selected)["additional"]
        }
        assert suggestions.targets(db, selected)[0]["bundle_id"] == "bundle-000000"
