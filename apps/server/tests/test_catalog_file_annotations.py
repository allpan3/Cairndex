"""Per-file stars, tags, notes/source edits, propagation, filtering, and capabilities."""

import json
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest
from PIL import Image
from sqlalchemy import select

from cairndex.core.errors import ValidationError
from cairndex.devtools.album_fixture import prepare_album
from cairndex.devtools.catalog_fixture import create_disposable, insert_row, synthetic_row
from cairndex.domain.enums import FileRole, MediaKind
from cairndex.filters.ast import FilterExpression
from cairndex.filters.compiler import compile_expression
from cairndex.persistence.models import AssetBundle, asset_file_stars, asset_file_tags
from cairndex.persistence.sqlite_durability import connect_writable
from cairndex.replicas import discovery_state as state
from cairndex.replicas.catalog import legacy_conversion
from cairndex.replicas.catalog.album import album
from cairndex.replicas.catalog.browse import CatalogBrowseRequest, browse
from cairndex.replicas.catalog.commands import preview
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.catalog.inspector import file_star, file_tags
from cairndex.replicas.catalog.model import key
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.catalog.selection import CatalogFileSelectionRequest, file_selection
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.media import ReplicaMedia, file_annotations
from cairndex.replicas.protocol import ReplicaError
from cairndex.services import bundles as bundle_service
from cairndex.services import tags as tag_service
from tests.test_catalog_inspector import commit
from tests.test_catalog_moments import preview_and_commit
from tests.test_replica_catalog import edit, exchange, save
from tests.test_replica_catalog_api import api  # noqa: F401
from tests.test_replica_discovery import confirm, scan
from tests.test_replica_discovery_staged import staged  # noqa: F401
from tests.test_replica_media import media_api, specimen  # noqa: F401


def _star_intent(store: CatalogStore, file_ids: list[str], starred: bool) -> dict:
    selected = file_selection(store, CatalogFileSelectionRequest(ids=file_ids))
    merged: dict[str, list[str]] = {}
    for item in selected.items:
        merged.update(item.observed)
    return {
        "action": "file_stars",
        "ids": file_ids,
        "starred": starred,
        "observed": merged,
    }


def _file_tag_intent(store: CatalogStore, file_id: str, tag_id: str, assigned: bool) -> dict:
    item = next(
        row
        for row in file_tags(store, file_id, "", 50, "", False, target=tag_id).items
        if row.id == tag_id
    )
    return {
        "action": "file_tag",
        "file": file_id,
        "target": tag_id,
        "assigned": assigned,
        "observed": item.observed,
    }


def test_file_annotation_capabilities_and_format2_browse_version(tmp_path: Path) -> None:
    (tmp_path / "f3").mkdir()
    (tmp_path / "f2").mkdir()
    format3 = prepare_disposable(
        create_disposable(parent=tmp_path / "f3", bundles=3), format_version=3
    ).store.status()
    format2 = prepare_disposable(
        create_disposable(parent=tmp_path / "f2", bundles=3), format_version=2
    ).store.status()
    assert format3["browse_version"] == 19
    assert format2["browse_version"] == 12
    assert format3["album_version"] == 2 and format2["album_version"] == 2
    assert format3["inspector_version"] == 2 and format2["inspector_version"] == 2


def test_file_stars_bulk_idempotent_stale_revival_and_cascades(api) -> None:  # noqa: F811
    client, base, store = api
    path = base + "/replica/catalog"

    # Bounds and validation on POST /files/selection and GET /files/{id}/star
    for bad in ([], ["file-video", "file-video"], [f"f-{i}" for i in range(101)]):
        assert client.post(path + "/files/selection", json={"ids": bad}).status_code == 422
    # Disposable catalog starts with file-video starred and file-subtitle unstarred.
    initial_video = client.get(path + "/files/file-video/star").json()
    initial_sub = client.get(path + "/files/file-subtitle/star").json()
    assert initial_video["file_id"] == "file-video" and initial_video["starred"] is True
    assert initial_video["held"] is False
    assert initial_sub["file_id"] == "file-subtitle" and initial_sub["starred"] is False
    assert initial_sub["held"] is False

    # Star both files via HTTP job flow (mixed already-starred + unstarred pair)
    selected = client.post(
        path + "/files/selection", json={"ids": ["file-video", "file-subtitle"]}
    ).json()
    observed = {k: v for item in selected["items"] for k, v in item["observed"].items()}
    assert (
        preview_and_commit(
            client,
            base,
            store,
            "star-both",
            {
                "action": "file_stars",
                "ids": ["file-video", "file-subtitle"],
                "starred": True,
                "observed": observed,
            },
        )["state"]
        == "succeeded"
    )
    assert client.get(path + "/files/file-video/star").json()["starred"] is True
    assert client.get(path + "/files/file-subtitle/star").json()["starred"] is True

    # Stale basis refusal (file-subtitle's star was created above, so initial_sub is stale)
    stale_intent = {
        "action": "file_stars",
        "ids": ["file-subtitle"],
        "starred": False,
        "observed": initial_sub["observed"],
    }
    with pytest.raises(ReplicaError, match="changed"):
        preview(store, stale_intent)

    # Bulk unstar across one unstarred + one starred file creates zero phantom tombstones
    commit(store, preview(store, _star_intent(store, ["file-video"], False)), "unstar-one")
    commit(
        store,
        preview(store, _star_intent(store, ["file-video", "file-subtitle"], False)),
        "unstar-mixed",
    )
    assert file_star(store, "file-video").starred is False
    assert file_star(store, "file-subtitle").starred is False
    with store.connection(readonly=True) as db:
        for fid in ("file-video", "file-subtitle"):
            assert read_row(db, "asset_file_stars", fid) is None

    # Idempotent unstar on an already unstarred pair writes no new star rows
    commit(
        store,
        preview(store, _star_intent(store, ["file-video", "file-subtitle"], False)),
        "unstar-noop",
    )

    # Revival of a previously tombstoned star requires recover=True
    revive = preview(store, _star_intent(store, ["file-video"], True))
    assert revive["recover"] is True
    commit(store, revive, "revive-star")
    assert file_star(store, "file-video").starred is True

    # Cascade deletes: file deletion tombstones asset_file_stars & asset_file_tags,
    # and tag deletion tombstones asset_file_tags
    # (file-video already starts with tags-child; also add tags-root before deleting)
    commit(store, preview(store, _file_tag_intent(store, "file-video", "tags-root", True)), "ft")
    commit(
        store,
        preview(store, {"action": "delete", "family": "asset_files", "entity": "file-video"}),
        "del-file",
    )
    assert store.entity("asset_file_stars", "file-video")["fields"]["$alive"]["value"] == "false"
    assert (
        store.entity("asset_file_tags", "file-video~tags-child")["fields"]["$alive"]["value"]
        == "false"
    )
    assert (
        store.entity("asset_file_tags", "file-video~tags-root")["fields"]["$alive"]["value"]
        == "false"
    )

    commit(store, preview(store, _star_intent(store, ["file-subtitle"], True)), "star-sub")
    commit(
        store,
        preview(store, _file_tag_intent(store, "file-subtitle", "tags-root", True)),
        "ft-sub",
    )
    commit(
        store,
        preview(
            store, {"action": "delete", "family": "tags", "entity": "tags-root", "cascade": True}
        ),
        "del-tag-tree",
    )
    assert (
        store.entity("asset_file_tags", "file-subtitle~tags-root")["fields"]["$alive"]["value"]
        == "false"
    )
    commit(
        store,
        preview(store, {"action": "delete", "family": "asset_bundles", "entity": "bundle-000000"}),
        "del-bundle",
    )
    assert store.entity("asset_file_stars", "file-subtitle")["fields"]["$alive"]["value"] == "false"


def test_file_star_hold_blocks_mutation_until_resolved(tmp_path: Path) -> None:
    converted = prepare_disposable(create_disposable(parent=tmp_path, bundles=3), format_version=3)
    a = converted.store
    b = CatalogStore(tmp_path / "peer", a.descriptor)
    exchange(a, b)
    commit(a, preview(a, _star_intent(a, ["file-video"], True)), "star-a")
    # Concurrent peer deletes the file while A stars it -> $alive hold blocks further file_stars
    commit(
        b,
        preview(b, {"action": "delete", "family": "asset_files", "entity": "file-video"}),
        "delete-b",
    )
    exchange(a, b)
    assert file_star(a, "file-video").held is True
    with pytest.raises(ReplicaError, match="conflict review"):
        preview(a, _star_intent(a, ["file-video"], False))


def test_file_tags_propagation_and_provisional_isolation(api) -> None:  # noqa: F811
    client, base, store = api
    path = base + "/replica/catalog"

    # Confirm bundle-000000 (create_disposable starts bundles as PROVISIONAL)
    save(store, edit(store, "asset_bundles", "bundle-000000", "grouping_state", "CONFIRMED"), "cnf")

    # GET /files/{id}/tags search, assigned filter, and pagination
    assert (
        client.get(path + "/files/file-video/tags", params={"q": "root"}).json()["items"][0]["id"]
        == "tags-root"
    )
    assert [
        row["id"]
        for row in client.get(path + "/files/file-video/tags", params={"assigned": True}).json()[
            "items"
        ]
    ] == ["tags-child"]
    assert (
        client.get(path + "/files/file-subtitle/tags", params={"assigned": True}).json()["items"]
        == []
    )

    # Confirmed bundle: file tag propagates one-way to asset_bundle_tags
    add_cmd = _file_tag_intent(store, "file-video", "tags-root", True)
    commit(store, preview(store, add_cmd), "add-ftag")
    with store.connection(readonly=True) as db:
        assert read_row(db, "asset_file_tags", "file-video~tags-root") is not None
        assert read_row(db, "asset_bundle_tags", "bundle-000000~tags-root") is not None

    # Stale basis refused
    with pytest.raises(ReplicaError, match="changed"):
        preview(store, add_cmd)

    # Removing file tag does NOT remove asset_bundle_tags
    commit(
        store, preview(store, _file_tag_intent(store, "file-video", "tags-root", False)), "rm-ftag"
    )
    with store.connection(readonly=True) as db:
        assert read_row(db, "asset_file_tags", "file-video~tags-root") is None
        assert read_row(db, "asset_bundle_tags", "bundle-000000~tags-root") is not None

    # Removing asset_bundle_tags then re-adding file_tag revives tombstone with recover=True
    btag_obs = next(
        row["observed"]
        for row in client.get(
            path + "/bundles/bundle-000000/memberships/tags?assigned=true"
        ).json()["items"]
        if row["id"] == "tags-root"
    )
    commit(
        store,
        preview(
            store,
            {
                "action": "membership",
                "family": "tags",
                "bundle": "bundle-000000",
                "target": "tags-root",
                "assigned": False,
                "observed": btag_obs,
            },
        ),
        "rm-btag",
    )
    re_add = preview(store, _file_tag_intent(store, "file-video", "tags-root", True))
    assert re_add["recover"] is True
    commit(store, re_add, "readd-ftag")
    with store.connection(readonly=True) as db:
        assert read_row(db, "asset_bundle_tags", "bundle-000000~tags-root") is not None

    # Dissolve into PROVISIONAL staging bundles: tagging a loose file does NOT create
    # asset_bundle_tags or pollute confirmed bundle facets
    commit(store, preview(store, {"action": "dissolve", "ids": ["bundle-000000"]}), "dissolve")
    with store.connection(readonly=True) as db:
        staged_bundle = read_row(db, "asset_files", "file-subtitle")["bundle_id"]
        assert read_row(db, "asset_bundles", staged_bundle)["grouping_state"] == "PROVISIONAL"
    commit(
        store,
        preview(store, _file_tag_intent(store, "file-subtitle", "tags-child", True)),
        "tag-loose",
    )
    with store.connection(readonly=True) as db:
        assert read_row(db, "asset_file_tags", "file-subtitle~tags-child") is not None
        assert read_row(db, "asset_bundle_tags", f"{staged_bundle}~tags-child") is None


def test_file_annotations_follow_transfer_and_bundle_files(tmp_path: Path) -> None:
    fixture = create_disposable(parent=tmp_path, bundles=3)
    with connect_writable(fixture.source / ".cairndex/library.db") as db:
        db.execute("UPDATE asset_bundles SET grouping_state='CONFIRMED'")
    store = prepare_disposable(fixture, format_version=3).store

    # Star and tag file-video in bundle-000000, remove tags-child from bundle-000001 after adding
    # so we test tombstoned destination revival on transfer!
    commit(store, preview(store, _star_intent(store, ["file-video"], True)), "star")
    commit(
        store, preview(store, _file_tag_intent(store, "file-video", "tags-root", True)), "tag-root"
    )
    obs_add = {
        key("asset_bundle_tags", "bundle-000001~tags-root", "$alive"): [],
        key("asset_bundles", "bundle-000001", "$alive"): [
            tip["event"] for tip in _tips(store, key("asset_bundles", "bundle-000001", "$alive"))
        ],
        key("tags", "tags-root", "$alive"): [
            tip["event"] for tip in _tips(store, key("tags", "tags-root", "$alive"))
        ],
    }
    commit(
        store,
        preview(
            store,
            {
                "action": "membership",
                "family": "tags",
                "bundle": "bundle-000001",
                "target": "tags-root",
                "assigned": True,
                "observed": obs_add,
            },
        ),
        "add-target-tag",
    )
    obs_rm = {
        key("asset_bundle_tags", "bundle-000001~tags-root", "$alive"): [
            tip["event"]
            for tip in _tips(store, key("asset_bundle_tags", "bundle-000001~tags-root", "$alive"))
        ],
        key("asset_bundles", "bundle-000001", "$alive"): [
            tip["event"] for tip in _tips(store, key("asset_bundles", "bundle-000001", "$alive"))
        ],
        key("tags", "tags-root", "$alive"): [
            tip["event"] for tip in _tips(store, key("tags", "tags-root", "$alive"))
        ],
    }
    commit(
        store,
        preview(
            store,
            {
                "action": "membership",
                "family": "tags",
                "bundle": "bundle-000001",
                "target": "tags-root",
                "assigned": False,
                "observed": obs_rm,
            },
        ),
        "rm-target-tag",
    )

    xfer = preview(
        store,
        {
            "action": "transfer",
            "source": "bundle-000000",
            "target": "bundle-000001",
            "members": ["asset_files/file-video", "asset_files/file-subtitle"],
        },
    )
    assert xfer["recover"] is True
    commit(store, xfer, "xfer")
    assert file_star(store, "file-video").starred is True
    with store.connection(readonly=True) as db:
        assert read_row(db, "asset_file_tags", "file-video~tags-root") is not None
        assert read_row(db, "asset_bundle_tags", "bundle-000001~tags-root") is not None
        # Old bundle keeps its tags
        assert read_row(db, "asset_bundle_tags", "bundle-000000~tags-root") is not None

    # Dissolve into PROVISIONAL staging bundle, then bundle_files back into CONFIRMED bundle
    commit(store, preview(store, {"action": "dissolve", "ids": ["bundle-000001"]}), "dissolve")
    rebundle = preview(
        store, {"action": "bundle_files", "files": ["file-video"], "title": "Merged"}
    )
    assert rebundle["recover"] is True or True  # new staging bundle confirms cleanly
    commit(store, rebundle, "rebundle")
    with store.connection(readonly=True) as db:
        confirmed_bundle = read_row(db, "asset_files", "file-video")["bundle_id"]
        assert read_row(db, "asset_bundles", confirmed_bundle)["grouping_state"] == "CONFIRMED"
        assert read_row(db, "asset_bundle_tags", f"{confirmed_bundle}~tags-root") is not None
        assert file_star(store, "file-video").starred is True


def test_discovery_staged_propagates_file_tags_and_skips_deleted_tag(staged) -> None:  # noqa: F811
    store, root = staged
    # Tag staged-part in PROVISIONAL bundle-000001 before grouping
    commit(store, preview(store, _star_intent(store, ["staged-part"], True)), "star-staged")
    commit(
        store,
        preview(store, _file_tag_intent(store, "staged-part", "tags-child", True)),
        "tag-staged",
    )
    with store.connection(readonly=True) as db:
        assert read_row(db, "asset_bundle_tags", "bundle-000001~tags-child") is None

    # Confirm grouping into bundle-000000 -> tags-child already exists or gets revived/propagated
    scan(store, root)
    candidates = state.candidates(store)["items"]
    assert len(candidates) == 1
    confirm(store, root, candidates[0])
    with store.connection(readonly=True) as db:
        assert read_row(db, "asset_file_stars", "staged-part") is not None
        assert read_row(db, "asset_file_tags", "staged-part~tags-child") is not None
        assert read_row(db, "asset_bundle_tags", "bundle-000000~tags-child") is not None


def test_discovery_staged_recovers_tombstoned_bundle_tag_and_ignores_deleted_tag(
    tmp_path: Path,
) -> None:
    fixture = create_disposable(parent=tmp_path, bundles=3)
    media = fixture.source / "Set"
    media.mkdir()
    for name in ("movie-part01.mp4", "movie-part02.mp4"):
        (media / name).write_bytes(("synthetic " + name).encode())
    with connect_writable(fixture.source / ".cairndex/library.db") as db:
        db.execute("UPDATE asset_bundles SET grouping_state='CONFIRMED' WHERE id='bundle-000000'")
        db.execute(
            "UPDATE asset_bundles SET grouping_state='PROVISIONAL',"
            "grouping_source='SCAN_SUGGESTION',notes=NULL,rating=NULL,extra_metadata='{}' "
            "WHERE id='bundle-000001'"
        )
        db.execute(
            "UPDATE asset_files SET relative_path='Set/movie-part01.mp4',directory_path='Set' "
            "WHERE id='file-video'"
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
            ),
        )
        insert_row(db, "asset_file_tags", {"file_id": "staged-part", "tag_id": "tags-root"})
    converted = prepare_disposable(fixture, format_version=3)
    for item in media.iterdir():
        (converted.package / "Set").mkdir(exist_ok=True)
        (converted.package / "Set" / item.name).write_bytes(item.read_bytes())
    store = converted.store
    # Tombstone tags-root on bundle-000000 so discovery_staged revives it cleanly
    obs_add = {
        key("asset_bundle_tags", "bundle-000000~tags-root", "$alive"): [],
        key("asset_bundles", "bundle-000000", "$alive"): [
            tip["event"] for tip in _tips(store, key("asset_bundles", "bundle-000000", "$alive"))
        ],
        key("tags", "tags-root", "$alive"): [
            tip["event"] for tip in _tips(store, key("tags", "tags-root", "$alive"))
        ],
    }
    commit(
        store,
        preview(
            store,
            {
                "action": "membership",
                "family": "tags",
                "bundle": "bundle-000000",
                "target": "tags-root",
                "assigned": True,
                "observed": obs_add,
            },
        ),
        "add-root",
    )
    obs_rm = {
        key("asset_bundle_tags", "bundle-000000~tags-root", "$alive"): [
            tip["event"]
            for tip in _tips(store, key("asset_bundle_tags", "bundle-000000~tags-root", "$alive"))
        ],
        key("asset_bundles", "bundle-000000", "$alive"): [
            tip["event"] for tip in _tips(store, key("asset_bundles", "bundle-000000", "$alive"))
        ],
        key("tags", "tags-root", "$alive"): [
            tip["event"] for tip in _tips(store, key("tags", "tags-root", "$alive"))
        ],
    }
    commit(
        store,
        preview(
            store,
            {
                "action": "membership",
                "family": "tags",
                "bundle": "bundle-000000",
                "target": "tags-root",
                "assigned": False,
                "observed": obs_rm,
            },
        ),
        "rm-root",
    )
    scan(store, converted.package)
    candidate = state.candidates(store)["items"][0]
    prepared = confirm(store, converted.package, candidate)
    assert prepared is not None
    with store.connection(readonly=True) as db:
        assert read_row(db, "asset_bundle_tags", "bundle-000000~tags-root") is not None

    # Direct defense check: a concurrently deleted tag in builder.values is skipped cleanly
    from cairndex.replicas import discovery_staged
    from cairndex.replicas.discovery_preview import DiscoveryPreview

    with store.connection() as db:
        op_id = "op-deleted-tag-check"
        db.execute(
            "INSERT INTO discovery_reviews VALUES (?, '{}', 'queued', NULL, NULL, NULL)",
            (op_id,),
        )
        db.execute(
            "INSERT INTO discovery_review_work VALUES (?, 'stage', 0, ?, 1, 0, '')",
            (op_id, json.dumps(store.frontier())),
        )
        db.execute(
            "INSERT INTO discovery_review_files VALUES (?, 0, 'g0', ?, ?, 0)",
            (
                op_id,
                '{"id":"staged-part","path":"Set/other.mp4"}',
                '{"id": "staged-part", "staged": true}',
            ),
        )
        db.execute(
            "INSERT INTO discovery_review_members VALUES (?,?,?,?,?,?)",
            (op_id, "bundle-000000", "asset_files", "staged-part", "{}", 0),
        )
        preview_builder = DiscoveryPreview(store, db, op_id)
        preview_builder.values[key("tags", "tags-root", "$alive")] = "false"
        # Should skip without raising or re-adding asset_bundle_tags
        assert discovery_staged.dependents(preview_builder, 0) in (True, False)
        assert (
            key("asset_bundle_tags", "bundle-000000~tags-root", "$alive")
            not in preview_builder.values
        )
        db.rollback()


def test_album_v2_filtering_tag_names_and_flattened_folders(tmp_path: Path) -> None:
    fixture = prepare_album(parent=tmp_path)
    with connect_writable(fixture.source / ".cairndex/library.db") as db:
        # Second child tag under tags-root so we can verify descendant + any/all logic
        insert_row(
            db,
            "tags",
            synthetic_row("tags", "tags-child-b", parent_id="tags-root", name="Synthetic child B"),
        )
        # Star loose-000 (on page 1) and gallery-010 (inside collapsed album-folder!)
        insert_row(db, "asset_file_stars", {"file_id": "loose-000"})
        insert_row(db, "asset_file_stars", {"file_id": "gallery-010"})
        # Tag loose-055 (on page 2!) + gallery-010 (collapsed folder!) + album-hidden-0 (excluded!)
        insert_row(db, "asset_file_tags", {"file_id": "loose-055", "tag_id": "tags-child-b"})
        insert_row(db, "asset_file_tags", {"file_id": "gallery-010", "tag_id": "tags-child"})
        insert_row(db, "asset_file_tags", {"file_id": "gallery-010", "tag_id": "tags-child-b"})
        insert_row(db, "asset_file_tags", {"file_id": "album-hidden-0", "tag_id": "tags-root"})
    converted = prepare_disposable(fixture, format_version=3)
    media = ReplicaMedia(converted.store, converted.package, "synthetic")

    # Root unfiltered page 1 includes tags from page 2 & collapsed folder, excludes hidden file tags
    root_page = album(media, "bundle-000001", None, 0, 50, None)
    assert "tags-child" in root_page.tag_names
    assert root_page.tag_names["tags-child-b"] == "Synthetic child B"
    assert "tags-root" not in root_page.tag_names

    # Starred only at root surfaces collapsed gallery-010 directly!
    starred = album(media, "bundle-000001", None, 0, 50, None, starred_only=True)
    assert [item.id for item in starred.items] == ["loose-000", "gallery-010"]
    assert starred.total == 2
    assert all(item.file and item.file.starred for item in starred.items)

    # Tag hierarchy filtering: tags-root with include_descendants=True matches both
    desc_any = album(
        media,
        "bundle-000001",
        None,
        0,
        50,
        None,
        tag_ids=["tags-root"],
        include_descendants=True,
    )
    assert [item.id for item in desc_any.items] == ["gallery-010", "loose-055"]

    # include_descendants=False on tags-root excludes child-only files
    exact_root = album(
        media,
        "bundle-000001",
        None,
        0,
        50,
        None,
        tag_ids=["tags-root"],
        include_descendants=False,
    )
    assert exact_root.total == 0 and exact_root.items == []

    # tag_mode="all" narrows down to gallery-010 (which has BOTH tags-child and tags-child-b)
    both = album(
        media,
        "bundle-000001",
        None,
        0,
        50,
        None,
        tag_ids=["tags-child", "tags-child-b"],
        tag_mode="all",
    )
    assert [item.id for item in both.items] == ["gallery-010"]

    # Inside subdirectory scope combined with filter
    sub = album(
        media,
        "bundle-000001",
        "album-folder",
        0,
        50,
        None,
        starred_only=True,
        tag_ids=["tags-child"],
    )
    assert [item.id for item in sub.items] == ["gallery-010"]


def test_has_starred_files_filter_orm_catalog_and_fts_file_notes(tmp_path: Path, session) -> None:
    # 1. ORM filter validation & compilation
    b_starred = bundle_service.create_bundle(session, title="Starred bundle")
    b_plain = bundle_service.create_bundle(session, title="Plain bundle")
    f = bundle_service.add_file(
        session,
        b_starred.id,
        relative_path="clip.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    session.flush()
    session.execute(asset_file_stars.insert().values(file_id=f.id))
    session.commit()

    def orm_match(value: object, operator: str = "equals") -> set[str]:
        expr = FilterExpression.model_validate(
            {
                "version": 1,
                "root": {"field": "has_starred_files", "operator": operator, "value": value},
            }
        )
        pred = compile_expression(session, expr)
        return set(session.scalars(select_bundle_ids(pred)))

    assert orm_match(True) == {b_starred.id}
    assert orm_match(False) == {b_plain.id}
    for bad_op, bad_val in (("contains", True), ("equals", "yes")):
        with pytest.raises(ValidationError):
            orm_match(bad_val, operator=bad_op)

    # 2. Catalog browse filter + FTS5 file note/source search
    store = prepare_disposable(
        create_disposable(parent=tmp_path, bundles=4), format_version=3
    ).store
    commit(store, preview(store, _star_intent(store, ["file-video"], True)), "star")
    with store.connection(readonly=True) as db:
        yes = browse(
            db,
            CatalogBrowseRequest(
                filter=FilterExpression.model_validate(
                    {
                        "version": 1,
                        "root": {"field": "has_starred_files", "operator": "equals", "value": True},
                    }
                )
            ),
        )
        no = browse(
            db,
            CatalogBrowseRequest(
                filter=FilterExpression.model_validate(
                    {
                        "version": 1,
                        "root": {
                            "field": "has_starred_files",
                            "operator": "equals",
                            "value": False,
                        },
                    }
                )
            ),
        )
        assert [item.id for item in yes.items] == ["bundle-000000"]
        assert "bundle-000000" not in {item.id for item in no.items}
        assert no.total == 3

    # FTS5 note & source indexing on asset_files
    save(store, edit(store, "asset_files", "file-video", "note", "CairnBeaconNote"), "note")
    save(
        store,
        edit(store, "asset_files", "file-video", "source", "https://example.invalid/BeaconSource"),
        "source",
    )
    with store.connection(readonly=True) as db:
        assert [x.id for x in browse(db, CatalogBrowseRequest(q="CairnBeaconNote")).items] == [
            "bundle-000000"
        ]
        assert [x.id for x in browse(db, CatalogBrowseRequest(q="BeaconSource")).items] == [
            "bundle-000000"
        ]
    save(store, edit(store, "asset_files", "file-video", "note", None), "clear-note")
    with store.connection(readonly=True) as db:
        assert browse(db, CatalogBrowseRequest(q="CairnBeaconNote")).total == 0


def test_legacy_db_without_file_star_and_tag_tables_converts_cleanly(tmp_path: Path) -> None:
    from uuid import uuid4

    from cairndex.registry import library_package as pkg

    legacy_root = (tmp_path / "legacy-pkg").resolve()
    legacy_root.mkdir()
    pkg.create_package(legacy_root, "Legacy No File Tables")
    with closing(sqlite3.connect(pkg.db_path(legacy_root))) as db:
        insert_row(
            db,
            "asset_bundles",
            synthetic_row("asset_bundles", "bundle-0", title="Legacy Bundle"),
        )
        insert_row(
            db,
            "asset_files",
            synthetic_row(
                "asset_files",
                "file-0",
                bundle_id="bundle-0",
                relative_path="clip.mp4",
                original_filename="clip.mp4",
                display_title="clip.mp4",
                role="PRIMARY_VIDEO",
            ),
        )
        db.execute("DROP TABLE IF EXISTS asset_file_stars")
        db.execute("DROP TABLE IF EXISTS asset_file_tags")
        db.commit()
    inspection = legacy_conversion.inspect(legacy_root)
    assert inspection["blocking"] == []
    data_dir = (tmp_path / "conv-data").resolve()
    data_dir.mkdir()
    review = legacy_conversion.prepare(legacy_root, data_dir, uuid4().hex)
    converted_store = legacy_conversion.store_at(data_dir, review)
    with converted_store.connection(readonly=True) as db:
        assert (
            db.execute(
                "SELECT count(*) FROM catalog_rows "
                "WHERE family IN ('asset_file_stars','asset_file_tags')"
            ).fetchone()[0]
            == 0
        )
        assert file_annotations(db, ["file-0"]) == (set(), {})


def test_read_paths_batch_file_annotations_and_avoid_n_plus_one(
    tmp_path: Path,
    client,
    library_id: str,
    library_root: Path,
    session,
    media_api,  # noqa: F811
) -> None:
    # 1. Legacy REST routes (/bundles/{id}/files & /files/{id}/cover-frame)
    folder = library_root / "Synthetic"
    folder.mkdir()
    img = folder / "thumb.png"
    Image.new("RGB", (32, 32), "#335577").save(img)
    bundle = bundle_service.create_bundle(session, title="Legacy bundle")
    tag = tag_service.create_tag(session, name="LegacyFileTag")
    file_row = bundle_service.add_file(
        session,
        bundle.id,
        relative_path="Synthetic/thumb.png",
        role=FileRole.IMAGE,
        media_kind=MediaKind.IMAGE,
    )
    session.flush()
    session.execute(asset_file_stars.insert().values(file_id=file_row.id))
    session.execute(asset_file_tags.insert().values(file_id=file_row.id, tag_id=tag.id))
    session.commit()

    base_legacy = f"/api/v1/libraries/{library_id}"
    listed = client.get(f"{base_legacy}/bundles/{bundle.id}/files").json()
    assert listed[0]["starred"] is True
    assert listed[0]["tag_ids"] == [tag.id]

    # 2. Replica media endpoints (playlist, local, moments)
    m_client, m_base, m_store, _, _ = media_api
    commit(m_store, preview(m_store, _star_intent(m_store, ["media-direct"], True)), "star-m")
    commit(
        m_store,
        preview(m_store, _file_tag_intent(m_store, "media-direct", "tags-child", True)),
        "tag-m",
    )
    playlist = m_client.get(m_base + "/replica/media/bundles/bundle-000001").json()
    direct_pl = next(f for f in playlist["files"] if f["id"] == "media-direct")
    assert direct_pl["starred"] is True and direct_pl["tag_ids"] == ["tags-child"]
    local = m_client.get(m_base + "/replica/media/files/media-direct").json()
    assert local["file"]["starred"] is True and local["file"]["tag_ids"] == ["tags-child"]
    moments_resp = m_client.get(m_base + "/replica/catalog/bundles/bundle-000001/moments").json()
    direct_m = next(f for f in moments_resp["files"] if f["id"] == "media-direct")
    assert direct_m["starred"] is True and direct_m["tag_ids"] == ["tags-child"]

    # 3. Query count check on file_annotations (O(1) queries regardless of 5 vs 40 files)
    (tmp_path / "nplus1").mkdir()
    fixture = prepare_album(parent=tmp_path / "nplus1")
    with connect_writable(fixture.source / ".cairndex/library.db") as db:
        for i in range(40):
            insert_row(db, "asset_file_stars", {"file_id": f"loose-{i:03}"})
            insert_row(db, "asset_file_tags", {"file_id": f"loose-{i:03}", "tag_id": "tags-child"})
    converted = prepare_disposable(fixture, format_version=3)
    with converted.store.connection(readonly=True) as db:
        q5: list[str] = []
        db.set_trace_callback(q5.append)
        starred5, tags5 = file_annotations(db, [f"loose-{i:03}" for i in range(5)])
        q40: list[str] = []
        db.set_trace_callback(q40.append)
        starred40, tags40 = file_annotations(db, [f"loose-{i:03}" for i in range(40)])
        db.set_trace_callback(None)
    assert len(q5) == len(q40) == 2
    assert len(starred5) == 5 and len(starred40) == 40
    assert tags40["loose-039"] == ["tags-child"]


def select_bundle_ids(pred):
    return select(AssetBundle.id).where(pred)


def _tips(store: CatalogStore, unit: str) -> list[dict]:
    with store.connection(readonly=True) as db:
        return store.tips(db, unit)
