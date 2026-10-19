"""Grouping Unbundled files keeps stable identities and authored attachments."""

import json
import shutil
from uuid import uuid4

import pytest

from cairndex.devtools.catalog_fixture import create_disposable, insert_row, synthetic_row
from cairndex.persistence.sqlite_durability import connect_writable
from cairndex.replicas import discovery
from cairndex.replicas import discovery_state as state
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.catalog.protocol import DISCOVERY_CAPABILITIES, CatalogDescriptor
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.transport import Transport
from tests.test_replica_catalog import edit, save
from tests.test_replica_discovery import advance_review, confirm, scan


@pytest.fixture
def staged(tmp_path):
    fixture = create_disposable(parent=tmp_path, bundles=3)
    media = fixture.source / "Set"
    media.mkdir()
    for name in ("movie-part01.mp4", "movie-part01.srt", "movie-part02.mp4", "cover.jpg"):
        (media / name).write_bytes(("synthetic " + name).encode())
    with connect_writable(fixture.source / ".cairndex/library.db") as db:
        db.execute("UPDATE asset_bundles SET grouping_state='CONFIRMED'")
        db.execute(
            "UPDATE asset_bundles SET grouping_state='PROVISIONAL',"
            "grouping_source='SCAN_SUGGESTION' "
            "WHERE id IN ('bundle-000000','bundle-000001')"
        )
        db.execute(
            "UPDATE asset_bundles SET notes=NULL,rating=NULL,extra_metadata='{}' "
            "WHERE id='bundle-000001'"
        )
        db.execute(
            "UPDATE asset_files SET relative_path='Set/movie-part01.mp4',directory_path='Set' "
            "WHERE id='file-video'"
        )
        db.execute(
            "UPDATE asset_files SET relative_path='Set/movie-part01.srt',directory_path='Set' "
            "WHERE id='file-subtitle'"
        )
        insert_row(
            db,
            "asset_files",
            synthetic_row(
                "asset_files",
                "staged-part",
                bundle_id="bundle-000001",
                relative_path="Set/movie-part02.mp4",
                directory_path="Set",
                original_filename="movie-part02.mp4",
                display_title="Synthetic second part",
                role="PRIMARY_VIDEO",
                note="Synthetic file note",
            ),
        )
        insert_row(
            db,
            "moments",
            synthetic_row(
                "moments",
                "staged-moment",
                bundle_id="bundle-000001",
                file_id="staged-part",
                start_s=3.0,
                end_s=5.0,
                comment="Synthetic retained moment",
            ),
        )
    converted = prepare_disposable(fixture)
    shutil.copytree(media, converted.package / "Set")
    descriptor = CatalogDescriptor.model_validate(
        converted.store.descriptor.model_dump()
        | {
            "format_version": 3,
            "catalog_version": 2,
            "minimum_reader": 3,
            "capabilities": DISCOVERY_CAPABILITIES,
        }
    )
    (converted.package / ".cairndex/manifest.json").write_text(descriptor.model_dump_json())
    store = CatalogStore(tmp_path / "private", descriptor)
    transport = Transport(converted.package, store)
    for _ in range(15):
        transport.tick()
    try:
        yield store, converted.package
    finally:
        discovery.close(store)
        transport.close()


def test_grouping_reuses_provisional_bundle_and_preserves_file_metadata(staged):
    store, root = staged
    before = store.entity("asset_bundles", "bundle-000000")
    scan(store, root)
    candidates = state.candidates(store)["items"]
    assert len(candidates) == 1
    assert candidates[0]["body"]["file_count"] == 4
    result = confirm(store, root, candidates[0])
    # Exact acceptance retry does not author another event or duplicate identities.
    assert state.accept(store, result["id"], result["receipt"])["event"] == result["event"]
    after = store.entity("asset_bundles", "bundle-000000")
    for field in ("notes", "rating", "extra_metadata", "cover_file_id", "primary_file_id"):
        assert after["fields"][field]["value"] == before["fields"][field]["value"]
        assert len(after["fields"][field]["candidates"]) == 1
    with store.connection(readonly=True) as db:
        from cairndex.replicas.discovery_validation import validate

        validate(db, store)
        assert read_row(db, "asset_bundles", "bundle-000000")["grouping_state"] == "CONFIRMED"
        assert read_row(db, "asset_bundles", "bundle-000001") is None
        assert read_row(db, "asset_files", "staged-part")["bundle_id"] == "bundle-000000"
        assert read_row(db, "asset_files", "staged-part")["note"] == "Synthetic file note"
        assert read_row(db, "moments", "staged-moment")["bundle_id"] == "bundle-000000"
        assert read_row(db, "moments", "staged-moment")["comment"] == "Synthetic retained moment"
        assert read_row(db, "asset_files", "file-subtitle")["bundle_id"] == "bundle-000000"
        assert (
            db.execute("SELECT count(*) FROM catalog_rows WHERE family='asset_files'").fetchone()[0]
            == 4
        )
    scan(store, root)
    assert state.candidates(store)["items"] == []


def test_staged_grouping_refuses_a_later_confirmed_boundary(staged):
    store, root = staged
    scan(store, root)
    candidate = state.candidates(store)["items"][0]
    save(
        store,
        edit(store, "asset_bundles", "bundle-000000", "grouping_state", "CONFIRMED"),
        "confirm-other",
    )
    operation = uuid4().hex
    state.prepare(store, operation, {"candidate": candidate["id"]})
    prepared = advance_review(store, root, operation)
    assert prepared["state"] == "failed"
    assert "identity changed" in prepared["error"]
    assert (
        json.loads(
            store.entity("asset_bundles", "bundle-000000")["fields"]["grouping_state"]["value"]
        )
        == "CONFIRMED"
    )
    with store.connection(readonly=True) as db:
        assert read_row(db, "asset_files", "staged-part")["bundle_id"] == "bundle-000001"


def test_grouping_does_not_discard_metadata_from_a_second_source(staged):
    store, root = staged
    save(
        store,
        edit(store, "asset_bundles", "bundle-000001", "notes", '["Synthetic second note"]'),
        "note",
    )
    scan(store, root)
    candidate = state.candidates(store)["items"][0]
    operation = uuid4().hex
    state.prepare(store, operation, {"candidate": candidate["id"]})
    prepared = advance_review(store, root, operation)
    assert prepared["state"] == "failed"
    assert "source bundles with metadata" in prepared["error"]
    with store.connection(readonly=True) as db:
        assert (
            read_row(db, "asset_bundles", "bundle-000001")["notes"] == '["Synthetic second note"]'
        )
        assert read_row(db, "asset_files", "staged-part")["bundle_id"] == "bundle-000001"
