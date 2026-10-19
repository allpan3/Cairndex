"""Ordinary file controls preserve complete membership and reject stale gestures."""

import json

import pytest

from cairndex.devtools.album_fixture import prepare_album
from cairndex.replicas.catalog import jobs
from cairndex.replicas.catalog.album import album
from cairndex.replicas.catalog.commands import preview
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.media import ReplicaMedia
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.recovery_validation import validate_private
from tests.test_catalog_inspector import commit


@pytest.fixture
def media(tmp_path):
    converted = prepare_disposable(prepare_album(parent=tmp_path), format_version=3)
    return ReplicaMedia(converted.store, converted.package, "synthetic")


def command(media, change, entity, bundle="bundle-000001", **options):
    return {
        "action": "bundle_member",
        "bundle": bundle,
        "change": change,
        "entity": entity,
        "observed": album(media, bundle, None, 0, 30, None).observed,
        **options,
    }


def members(media, bundle="bundle-000001"):
    with media.store.connection(readonly=True) as db:
        return json.loads(
            db.execute(
                "SELECT value FROM catalog_units WHERE unit=?",
                (f"asset_bundles/{bundle}/$members",),
            ).fetchone()[0]
        )


def test_collapse_pages_and_expand_preserve_files_and_metadata(media, monkeypatch):
    monkeypatch.setattr(
        "cairndex.replicas.media.open_source", lambda *args: pytest.fail("source read")
    )
    original = members(media)
    first = album(media, "bundle-000001", None, 0, 30, None)
    folder = next(item.directory for item in first.items if item.id == "album-folder")
    assert folder.file_count == 125  # Hidden catalog paths do not inflate the displayed count.
    frontier = media.store.frontier()
    prepared = preview(media.store, command(media, "collapse", "loose-000", directory="Loose"))
    assert media.store.frontier() == frontier
    commit(media.store, prepared, "collapse")
    page = album(media, "bundle-000001", None, 0, 30, None)
    collapsed = next(
        item for item in page.items if item.directory and item.directory.directory_path == "Loose"
    )
    assert collapsed.directory.file_count == 62
    files = [
        item.id
        for offset in (0, 30, 60)
        for item in album(media, "bundle-000001", collapsed.id, offset, 30, None).items
    ]
    assert len(files) == 62 and files[-1] == "loose-061"
    assert {item["id"] for item in members(media) if item["family"] == "asset_files"} == {
        item["id"] for item in original if item["family"] == "asset_files"
    }
    commit(media.store, preview(media.store, command(media, "expand", collapsed.id)), "expand")
    assert members(media) == original


def test_later_page_order_and_folder_blocks_keep_every_hidden_member(media):
    original = members(media)
    intent = command(media, "move", "loose-061", before="gallery2-000")
    commit(media.store, preview(media.store, intent), "later-file")
    assert album(media, "bundle-000001", None, 0, 30, None).items[0].id == "loose-061"
    commit(
        media.store,
        preview(media.store, command(media, "move", "album-folder", before="loose-061")),
        "folder-block",
    )
    ordered = sorted(members(media), key=lambda item: item["sequence"])
    assert ordered[0]["id"] == "album-folder"
    assert {item["id"] for item in ordered} == {item["id"] for item in original}
    assert len(ordered) == len(original)
    assert [item["sequence"] for item in ordered] == list(range(len(ordered)))
    assert album(media, "bundle-000001", None, 0, 30, None).items[:2][1].id == "loose-061"
    with pytest.raises(ReplicaError, match="changed"):
        preview(media.store, intent)


def test_remove_preserves_file_moments_and_source_values_without_erasing_missing_files(media):
    with media.store.connection(readonly=True) as db:
        before = read_row(db, "asset_files", "file-video")
        moment = read_row(db, "moments", "moment-one")
    intent = command(media, "remove", "file-video", bundle="bundle-000000")
    commit(media.store, preview(media.store, intent), "remove")
    with media.store.connection(readonly=True) as db:
        file = read_row(db, "asset_files", "file-video")
        assert file["bundle_id"] != "bundle-000000"
        assert {k: v for k, v in file.items() if k not in ("bundle_id", "sequence")} == {
            k: v for k, v in before.items() if k not in ("bundle_id", "sequence")
        }
        staged = read_row(db, "asset_bundles", file["bundle_id"])
        assert staged["grouping_state"] == "PROVISIONAL"
        assert read_row(db, "asset_bundles", "bundle-000000")["cover_file_id"] is None
        assert read_row(db, "moments", "moment-one") == moment | {"bundle_id": file["bundle_id"]}
        assert read_row(db, "moment_tags", "moment-one~tags-child")
        assert read_row(db, "subtitle_tracks", "track-one") is None
        assert read_row(db, "asset_files", "file-subtitle")["bundle_id"] == "bundle-000000"
    with pytest.raises(ReplicaError, match="changed"):
        preview(media.store, intent)


def test_last_file_removal_prunes_empty_directory_and_keeps_source_bundle(media):
    commit(
        media.store,
        preview(media.store, command(media, "remove", "file-video", bundle="bundle-000000")),
        "video",
    )
    commit(
        media.store,
        preview(media.store, command(media, "remove", "file-subtitle", bundle="bundle-000000")),
        "subtitle",
    )
    with media.store.connection(readonly=True) as db:
        assert read_row(db, "bundle_directory_members", "directory-one") is None
        assert read_row(db, "asset_bundles", "bundle-000000") is not None


@pytest.mark.parametrize("directory", ["/Loose", "../Loose", "Gallery", "Synthetic", ""])
def test_collapse_refuses_unsafe_unrelated_and_overlapping_directories(media, directory):
    original = members(media)
    with pytest.raises((ReplicaError, ValueError)):
        preview(media.store, command(media, "collapse", "loose-000", directory=directory))
    assert members(media) == original


def test_preview_receipt_retains_conflicting_peer_order_for_review(media):
    prepared = preview(media.store, command(media, "move", "loose-061", before="gallery2-000"))
    commit(
        media.store,
        preview(media.store, command(media, "move", "loose-060", before="gallery2-000")),
        "peer",
    )
    commit(media.store, prepared, "stale")
    with media.store.connection(readonly=True) as db:
        assert db.execute(
            "SELECT 1 FROM catalog_holds WHERE unit=?", ("asset_bundles/bundle-000001/$members",)
        ).fetchone()
    assert not album(media, "bundle-000001", None, 0, 30, None).editable


def test_collapse_refuses_an_existing_folder_and_unrelated_empty_folders_survive_removal(media):
    with pytest.raises(ReplicaError, match="overlaps"):
        preview(media.store, command(media, "collapse", "gallery-000", directory="Gallery"))
    commit(media.store, preview(media.store, command(media, "remove", "loose-061")), "remove-loose")
    with media.store.connection(readonly=True) as db:
        assert read_row(db, "bundle_directory_members", "empty-folder") is not None


def test_lost_job_acknowledgement_retries_the_same_staging_bundle(media):
    jobs.enqueue(media.store, "preview-remove", "preview", command(media, "remove", "loose-061"))
    jobs.run_one(media.store)
    prepared = jobs.job(media.store, "preview-remove")
    assert prepared["state"] == "succeeded", prepared["error"]
    jobs.enqueue(
        media.store,
        "commit-remove",
        "commit_preview",
        {"job": prepared["id"], "receipt": prepared["receipt"]},
    )
    jobs.run_one(media.store)
    applied = jobs.job(media.store, "commit-remove")
    assert applied["state"] == "succeeded", applied["error"]
    with media.store.connection() as db:
        bundle = read_row(db, "asset_files", "loose-061")["bundle_id"]
        count = db.execute("SELECT count(*) FROM events").fetchone()[0]
        db.execute("UPDATE catalog_jobs SET state='queued',result=NULL WHERE id='commit-remove'")
    jobs.run_one(media.store)
    assert jobs.job(media.store, "commit-remove")["result"] == applied["result"]
    with media.store.connection(readonly=True) as db:
        assert read_row(db, "asset_files", "loose-061")["bundle_id"] == bundle
        assert db.execute("SELECT count(*) FROM events").fetchone()[0] == count
        validate_private(db, media.store)
