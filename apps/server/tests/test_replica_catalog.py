"""Complete synthetic catalogs exercise lossless conversion and causal structural editing"""

import json
import sqlite3

import pytest

from cairndex.devtools.catalog_fixture import create_disposable
from cairndex.replicas.catalog.commands import preview as catalog_preview
from cairndex.replicas.catalog.conversion import (
    compare_checkpoints,
    export_legacy,
    prepare_disposable,
)
from cairndex.replicas.catalog.model import AUTHORED, key, value_text
from cairndex.replicas.catalog.protocol import CatalogDescriptor, UnitChange
from cairndex.replicas.catalog.recovery import recover_preview
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError, canonical, checksum


# Test reviews explicitly capture the alternatives displayed before preparation
def preview(store, command):
    if command["action"] == "choose" and "observed" not in command:
        with store.connection() as db:
            command = command | {
                "observed": {
                    unit: [tip["event"] for tip in store.tips(db, unit)]
                    for unit in store.scope(db, [command["unit"]])
                }
            }
    return catalog_preview(store, command)


# Independent private stores share a complete seed but no mutable database or drafts
@pytest.fixture
def catalog_pair(tmp_path):
    conversion = prepare_disposable(create_disposable(parent=tmp_path, bundles=3))
    first = conversion.store
    second = CatalogStore(tmp_path / "peer", first.descriptor)
    exchange(first, second)
    assert second.status()["ready"]
    return conversion, first, second


# Ordinary delivery imports retained artifacts in deliberately reversed order
def exchange(*stores):
    for source in stores:
        with source.connection() as db:
            artifacts = [row[0] for row in db.execute("SELECT raw FROM events ORDER BY id DESC")]
        for target in stores:
            if target is source:
                continue
            for raw in artifacts:
                target.ingest(raw)
    for store in stores:
        for _ in range(12):
            store.import_batch()
        assert store.status()["blocked"] is None


# Editors retain the bases displayed with their input, including lifetime/reference guards
def edit(store, family, identity, field, value):
    unit = key(family, identity, field)
    with store.connection() as db:
        result = {
            unit: UnitChange(
                unit=unit,
                value=value_text(value),
                basis=[tip["event"] for tip in store.tips(db, unit)],
            )
        }
        for guard in store.required_guards(db, unit, result[unit].value):
            result[guard] = UnitChange(
                unit=guard, value="true", basis=[tip["event"] for tip in store.tips(db, guard)]
            )
    return list(result.values())


# Test saves explicitly retain the snapshot frontier supplied by the current editor
def save(store, changes, operation, **options):
    return store.save(changes, operation, parents=store.frontier(), **options)


# Read exact cells from the validated projection without coercing opaque metadata
def value(store, family, identity, field):
    return json.loads(store.entity(family, identity)["fields"][field]["value"])


# Full conversion crosses the former 100-bundle boundary and round-trips every raw table
def test_complete_conversion_round_trip(tmp_path):
    fixture = create_disposable(parent=tmp_path)
    original = checksum((fixture.source / ".cairndex/library.db").read_bytes())
    conversion = prepare_disposable(fixture)
    output = export_legacy(conversion)
    compare_checkpoints(conversion.archive / "library.db", output / "library.db")
    compare_checkpoints(conversion.archive / "plans.db", output / "plans.db")
    assert (output / "synthetic-auth.json").read_bytes() == (
        fixture.directory / "private/synthetic-auth.json"
    ).read_bytes()
    assert checksum((fixture.source / ".cairndex/library.db").read_bytes()) == original
    with conversion.store.connection() as db:
        families = {row[0] for row in db.execute("SELECT DISTINCT family FROM catalog_rows")}
        assert families == set(AUTHORED)
        assert (
            db.execute("SELECT COUNT(*) FROM catalog_rows WHERE family='asset_bundles'").fetchone()[
                0
            ]
            == 125
        )
        transported = b"".join(row[0] for row in db.execute("SELECT raw FROM events"))
        assert b"private-auth-record" not in transported
        assert b"quick_fingerprint" not in transported
        assert b"synthetic_recovery" not in transported
    assert value(conversion.store, "asset_bundles", "bundle-000000", "notes") is None
    assert value(conversion.store, "asset_bundles", "bundle-000001", "notes") == "[]"
    assert "9007199254740993" in value(
        conversion.store, "asset_bundles", "bundle-000000", "extra_metadata"
    )


# Unsupported fields, source recovery obligations and invalid ASTs block before activation
@pytest.mark.parametrize(
    "mutation",
    [
        "ALTER TABLE asset_bundles ADD COLUMN future_metadata TEXT",
        "CREATE TABLE future_rows (id TEXT)",
        "UPDATE file_operations SET status='PENDING'",
        "UPDATE file_operations SET op='TRASH',status='DONE'",
        'UPDATE smart_folders SET filter_json=\'{"version":1,"root":'
        '{"field":"future","operator":"equals","value":1}}\'',
        'UPDATE asset_bundles SET extra_metadata=\'{"duplicate":1,"duplicate":2}\'',
    ],
)
def test_conversion_refuses_unknown_or_unresolved(tmp_path, mutation):
    fixture = create_disposable(parent=tmp_path, bundles=3)
    with sqlite3.connect(fixture.source / ".cairndex/library.db") as db:
        db.execute(mutation)
    before = checksum((fixture.source / ".cairndex/library.db").read_bytes())
    with pytest.raises(ReplicaError):
        prepare_disposable(fixture)
    assert checksum((fixture.source / ".cairndex/library.db").read_bytes()) == before
    assert not list(fixture.directory.glob("conversion-*/package/.cairndex/manifest.json"))


# Missing middle chunks never expose a partial catalog, even when the complete root arrives
def test_incomplete_seed_waits_atomically(catalog_pair, tmp_path):
    _, source, _ = catalog_pair
    waiting = CatalogStore(tmp_path / "waiting", source.descriptor)
    with source.connection() as db:
        rows = list(db.execute("SELECT id,raw FROM events"))
    missing = next(row for row in rows if row["id"] != source.descriptor.genesis)
    for row in rows:
        if row["id"] != missing["id"]:
            waiting.ingest(row["raw"])
    for _ in range(3):
        waiting.import_batch()
    assert not waiting.status()["ready"]
    assert waiting.entities("asset_bundles")["items"] == []
    waiting.ingest(missing["raw"])
    for _ in range(3):
        waiting.import_batch()
    assert waiting.status()["ready"]


# Scalar edits across all authored families merge independently from unrelated fields
@pytest.mark.parametrize(
    "family,identity,field,chosen",
    [
        ("asset_bundles", "bundle-000000", "title", "Amber"),
        ("asset_files", "file-video", "note", "Exact 雪\n"),
        ("bundle_directory_members", "directory-one", "directory_path", "Synthetic-new"),
        ("tags", "tags-child", "name", "Amber tag"),
        ("tag_groups", "group-one", "name", "Amber group"),
        ("collections", "collections-child", "note", "Amber collection"),
        ("smart_folders", "filter-one", "name", "Amber saved filter"),
        ("moments", "moment-one", "comment", "Amber moment"),
        ("subtitle_tracks", "track-one", "label", "Amber subtitles"),
        (
            "asset_bundle_collections",
            "bundle-000000~collections-child",
            "sort_order",
            9007199254740994,
        ),
        ("tag_group_memberships", "group-one~tags-child", "sort_order", 8),
    ],
)
def test_family_scalar_merge(catalog_pair, family, identity, field, chosen):
    _, a, b = catalog_pair
    save(a, edit(a, family, identity, field, chosen), "amber")
    save(b, edit(b, "asset_bundles", "bundle-000002", "notes", '["Blue","Blue",""]'), "blue")
    exchange(a, b)
    assert value(a, family, identity, field) == value(b, family, identity, field) == chosen
    assert value(a, "asset_bundles", "bundle-000002", "notes") == '["Blue","Blue",""]'


# Same-field conflicts retain local valid views and history; explicit reviewed choices converge
def test_conflict_choice_and_stale_basis(catalog_pair):
    _, a, b = catalog_pair
    save(a, edit(a, "asset_bundles", "bundle-000000", "title", "Amber"), "amber")
    save(b, edit(b, "asset_bundles", "bundle-000000", "title", "Blue"), "blue")
    exchange(a, b)
    assert value(a, "asset_bundles", "bundle-000000", "title") == "Amber"
    assert value(b, "asset_bundles", "bundle-000000", "title") == "Blue"
    choice = edit(a, "asset_bundles", "bundle-000000", "title", "Blue")
    parents = a.frontier()
    receipt = a.save(choice, "choice", resolve=True, parents=parents)
    assert a.save(choice, "choice", resolve=True, parents=parents) == receipt
    with pytest.raises(ReplicaError, match="stale"):
        save(a, choice, "stale", resolve=True)
    exchange(a, b)
    assert value(a, "asset_bundles", "bundle-000000", "title") == "Blue"
    assert len(a.history("asset_bundles/bundle-000000/title")["items"]) == 4


# Post-edit rollback retains unsent events, unresolved alternatives and private draft generations
def test_rollback_after_conflict_and_draft(catalog_pair):
    conversion, a, b = catalog_pair
    save(a, edit(a, "moments", "moment-one", "comment", "Amber"), "amber")
    save(b, edit(b, "moments", "moment-one", "comment", "Blue"), "blue")
    exchange(a, b)
    draft = {
        "changes": [
            change.model_dump() for change in edit(a, "moments", "moment-one", "comment", "Unsent")
        ]
    }
    a.draft("editor", "moments/moment-one", 3, draft)
    output = export_legacy(conversion)
    with sqlite3.connect(output / "replica-recovery.db") as db, a.connection() as live:
        for table in ("events", "catalog_revisions", "catalog_holds", "drafts"):
            assert db.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall() == [
                tuple(row) for row in live.execute(f"SELECT * FROM {table} ORDER BY 1")
            ]
    assert a.drafts("moments/moment-one")["items"][0]["body"] == draft
    a.dismiss_draft("editor", 3)
    a.draft("editor", "moments/moment-one", 2, draft)
    assert a.drafts("moments/moment-one")["items"] == []


# Unsupported capability combinations cannot masquerade as a complete catalog reader
def test_catalog_descriptor_gates(catalog_pair):
    _, a, _ = catalog_pair
    for field, replacement in (
        ("minimum_reader", 99),
        ("catalog_version", 99),
        ("capabilities", ["authored_catalog_v1"]),
    ):
        with pytest.raises(ValueError):
            CatalogDescriptor.model_validate(a.descriptor.model_dump() | {field: replacement})
    raw = canonical({"future": True})
    a.ingest(raw)
    a.import_batch()
    assert a.status()["ready"]


# Submitting a preview preserves the exact bases and frontier that were shown for review
def submit(store, receipt, operation):
    return store.save(
        [UnitChange.model_validate(change) for change in receipt["changes"]],
        operation,
        parents=receipt["parents"],
        resolve=receipt["resolve"],
        recover=receipt["recover"],
    )


# Transfers include both complete orders, selected cover references and dependent rows
def test_transfer_with_moments_subtitles_and_concurrent_order(catalog_pair):
    _, a, b = catalog_pair
    transfer = preview(
        a,
        {
            "action": "transfer",
            "source": "bundle-000000",
            "target": "bundle-000001",
            "members": ["bundle_directory_members/directory-one"],
        },
    )
    submit(a, transfer, "transfer")
    members = value(b, "asset_bundles", "bundle-000000", "$members")
    members[0]["sequence"] = 99
    submit(
        b,
        preview(
            b,
            {"action": "arrange", "unit": "asset_bundles/bundle-000000/$members", "value": members},
        ),
        "order",
    )
    exchange(a, b)
    for store in (a, b):
        with store.connection() as db:
            bundles = [
                json.loads(row[0])["bundle_id"]
                for row in db.execute(
                    "SELECT body FROM catalog_rows WHERE family IN "
                    "('asset_files','moments','subtitle_tracks','bundle_directory_members')"
                )
            ]
            assert len(set(bundles)) == 1
            assert db.execute("SELECT COUNT(*) FROM catalog_holds").fetchone()[0] > 0
    scope = a.history("asset_bundles/bundle-000000/$members")["scope"]
    assert "asset_bundles/bundle-000001/$members" in scope
    choice_values = {}
    with a.connection() as db:
        for unit in scope:
            tips = a.tips(db, unit)
            if len({tip["value"] for tip in tips}) > 1:
                choice_values[unit] = db.execute(
                    "SELECT value FROM catalog_units WHERE unit=?", (unit,)
                ).fetchone()[0]
    choice = preview(
        a,
        {
            "action": "choose",
            "unit": "asset_bundles/bundle-000000/$members",
            "choices": choice_values,
        },
    )
    submit(a, choice, "choose-transfer")
    exchange(a, b)
    assert value(a, "asset_bundles", "bundle-000000", "$members") == []
    assert value(b, "asset_bundles", "bundle-000000", "$members") == []


# Every entity and Boolean edge supports retained metadata-only deletion with complete cascades
@pytest.mark.parametrize(
    "family,identity",
    [
        ("asset_bundles", "bundle-000000"),
        ("asset_files", "file-video"),
        ("bundle_directory_members", "directory-one"),
        ("tags", "tags-root"),
        ("tags", "tags-child"),
        ("tag_groups", "group-one"),
        ("collections", "collections-child"),
        ("smart_folders", "filter-one"),
        ("moments", "moment-one"),
        ("subtitle_tracks", "track-one"),
        ("asset_bundle_tags", "bundle-000000~tags-child"),
        ("asset_bundle_collections", "bundle-000000~collections-child"),
        ("moment_tags", "moment-one~tags-child"),
        ("tag_group_memberships", "group-one~tags-child"),
    ],
)
def test_complete_deletion_cascades(catalog_pair, family, identity):
    conversion, a, b = catalog_pair
    receipt = preview(a, {"action": "delete", "family": family, "entity": identity})
    submit(a, receipt, "delete")
    exchange(a, b)
    assert value(a, family, identity, "$alive") is False
    assert value(b, family, identity, "$alive") is False
    export_legacy(conversion)


# Concurrent delete/edit preserves alternatives and forbids implicit resurrection
def test_delete_edit_requires_explicit_recovery(catalog_pair):
    _, a, b = catalog_pair
    submit(
        a, preview(a, {"action": "delete", "family": "moments", "entity": "moment-one"}), "delete"
    )
    save(b, edit(b, "moments", "moment-one", "comment", "Keep this edit"), "edit")
    exchange(a, b)
    unit = "moments/moment-one/$alive"
    assert len(a.entity("moments", "moment-one")["fields"]["$alive"]["candidates"]) == 2
    with pytest.raises(ReplicaError, match="recovery"):
        save(a, edit(a, "moments", "moment-one", "comment", "Implicit"), "implicit")
    scope = a.history(unit)["scope"]
    choices = {unit: "true"}
    with b.connection() as db:
        for affected in scope:
            if affected != unit:
                row = db.execute(
                    "SELECT value FROM catalog_units WHERE unit=?", (affected,)
                ).fetchone()
                if row:
                    choices[affected] = row[0]
    receipt = preview(b, {"action": "choose", "unit": unit, "choices": choices, "recover": True})
    submit(b, receipt, "keep-edited")
    exchange(a, b)
    assert value(a, "moments", "moment-one", "comment") == "Keep this edit"
    assert value(a, "moment_tags", "moment-one~tags-child", "$alive") is True


# Forest choices keep unrelated names and reject cycles
def test_forest_conflict_keeps_scalar_names(catalog_pair):
    _, a, b = catalog_pair
    unit = "tags/_/$forest"
    first = value(a, "tags", "_", "$forest")
    second = json.loads(json.dumps(first))
    first[0]["sort_order"] = 7
    second[0]["parent_id"] = None
    submit(a, preview(a, {"action": "arrange", "unit": unit, "value": first}), "forest-a")
    submit(b, preview(b, {"action": "arrange", "unit": unit, "value": second}), "forest-b")
    save(b, edit(b, "tags", "tags-child", "name", "Independent name"), "name")
    exchange(a, b)
    assert value(a, "tags", "tags-child", "name") == "Independent name"
    submit(
        a,
        preview(a, {"action": "choose", "unit": unit, "choices": {unit: value_text(second)}}),
        "forest-choice",
    )
    exchange(a, b)
    assert value(a, "tags", "_", "$forest") == value(b, "tags", "_", "$forest")
    cyclic = [
        {"id": "tags-root", "parent_id": "tags-child", "sort_order": 0},
        {"id": "tags-child", "parent_id": "tags-root", "sort_order": 0},
    ]
    with pytest.raises(ReplicaError, match="cyclic"):
        preview(a, {"action": "arrange", "unit": unit, "value": cyclic})


# New Boolean references expose concurrent deletion of their target instead of dangling
def test_create_boolean_edge_and_delete_reference(catalog_pair):
    _, a, b = catalog_pair
    receipt = preview(
        a,
        {
            "action": "create",
            "family": "asset_bundle_tags",
            "row": {"bundle_id": "bundle-000001", "tag_id": "tags-child"},
        },
    )
    submit(
        b, preview(b, {"action": "delete", "family": "tags", "entity": "tags-child"}), "delete-tag"
    )
    submit(a, receipt, "new-edge")
    exchange(a, b)
    assert len(a.entity("tags", "tags-child")["fields"]["$alive"]["candidates"]) == 2


# Explicit branch recovery restores the same identity and cascade relationships for every family
@pytest.mark.parametrize(
    "family,identity",
    [
        ("asset_bundles", "bundle-000000"),
        ("asset_files", "file-video"),
        ("bundle_directory_members", "directory-one"),
        ("tags", "tags-root"),
        ("tags", "tags-child"),
        ("tag_groups", "group-one"),
        ("collections", "collections-child"),
        ("smart_folders", "filter-one"),
        ("moments", "moment-one"),
        ("subtitle_tracks", "track-one"),
        ("asset_bundle_tags", "bundle-000000~tags-child"),
        ("asset_bundle_collections", "bundle-000000~collections-child"),
        ("moment_tags", "moment-one~tags-child"),
        ("tag_group_memberships", "group-one~tags-child"),
    ],
)
def test_branch_recovery_all_families(catalog_pair, family, identity):
    _, a, b = catalog_pair
    submit(a, preview(a, {"action": "delete", "family": family, "entity": identity}), "delete")
    save(
        a,
        edit(a, "asset_bundles", "bundle-000002", "title", "Keep unrelated live work"),
        "unrelated",
    )
    receipt = recover_preview(a, a.descriptor.genesis, family, identity)
    submit(a, receipt, "recover")
    exchange(a, b)
    assert value(a, family, identity, "$alive") is True
    assert value(b, family, identity, "$alive") is True
    assert value(b, "asset_bundles", "bundle-000002", "title") == "Keep unrelated live work"


# Field/object recovery is a durable background job and reuses one reviewed commit identity
def test_durable_jobs_and_retry(catalog_pair):
    from cairndex.replicas.catalog import jobs

    _, store, _ = catalog_pair
    queued = jobs.enqueue(
        store,
        "preview",
        "preview",
        {"action": "delete", "family": "moments", "entity": "moment-one"},
    )
    assert queued["state"] == "queued"
    assert value(store, "moments", "moment-one", "$alive") is True
    reopened = CatalogStore(store.path.parent, store.descriptor)
    jobs.run_one(reopened)
    prepared = jobs.job(store, "preview")
    body = {"job": prepared["id"], "receipt": prepared["receipt"]}
    jobs.enqueue(store, "commit", "commit_preview", body)
    jobs.run_one(store)
    assert jobs.job(store, "commit")["state"] == "succeeded"
    assert value(store, "moments", "moment-one", "$alive") is False
    assert (
        jobs.enqueue(store, "commit", "commit_preview", body)["result"]
        == jobs.job(store, "commit")["result"]
    )


# Concurrent explicit choices remain alternatives rather than being rejected as corrupt deliveries
def test_concurrent_resolution_import_is_not_upgrade_failure(catalog_pair):
    _, a, b = catalog_pair
    save(a, edit(a, "moments", "moment-one", "comment", "Amber"), "amber")
    save(b, edit(b, "moments", "moment-one", "comment", "Blue"), "blue")
    exchange(a, b)
    save(a, edit(a, "moments", "moment-one", "comment", "Amber"), "resolve-a", resolve=True)
    save(b, edit(b, "moments", "moment-one", "comment", "Blue"), "resolve-b", resolve=True)
    exchange(a, b)
    assert len(a.entity("moments", "moment-one")["fields"]["comment"]["candidates"]) == 2


# An old order cannot split a completed transfer after both original anchors were superseded
def test_late_order_after_transfer_anchors_superseded(catalog_pair):
    _, a, b = catalog_pair
    submit(
        a,
        preview(
            a,
            {
                "action": "transfer",
                "source": "bundle-000000",
                "target": "bundle-000001",
                "members": ["bundle_directory_members/directory-one"],
            },
        ),
        "transfer",
    )
    for bundle in ("bundle-000000", "bundle-000001"):
        submit(
            a,
            preview(
                a,
                {
                    "action": "arrange",
                    "unit": f"asset_bundles/{bundle}/$members",
                    "value": value(a, "asset_bundles", bundle, "$members"),
                },
            ),
            f"supersede-{bundle}",
        )
    save(a, edit(a, "moments", "moment-one", "comment", "Independent after transfer"), "note")
    submit(
        b,
        preview(
            b,
            {
                "action": "reorder",
                "unit": "asset_bundles/bundle-000000/$members",
                "entity": "file-video",
                "offset": 1,
            },
        ),
        "late-order",
    )
    exchange(a, b)
    for store in (a, b):
        assert value(store, "moments", "moment-one", "comment") == "Independent after transfer"
        with store.connection() as db:
            scope = store.scope(db, ["asset_bundles/bundle-000000/$members"])
            assert "asset_bundles/bundle-000001/$members" in scope
            assert "moments/moment-one/$span" in scope
            assert "moments/moment-one/comment" not in scope
            placements = {
                json.loads(row[0])["bundle_id"]
                for row in db.execute(
                    "SELECT body FROM catalog_rows WHERE family IN ('asset_files','moments',"
                    "'subtitle_tracks','bundle_directory_members')"
                )
            }
            assert len(placements) == 1
    choices = {}
    with a.connection() as db:
        for unit in a.scope(db, ["asset_bundles/bundle-000000/$members"]):
            choices[unit] = db.execute(
                "SELECT value FROM catalog_units WHERE unit=?", (unit,)
            ).fetchone()[0]
    submit(
        a,
        preview(
            a,
            {
                "action": "choose",
                "unit": "asset_bundles/bundle-000000/$members",
                "choices": choices,
            },
        ),
        "keep-transfer",
    )
    exchange(a, b)
    assert value(b, "asset_bundles", "bundle-000000", "$members") == []
    assert value(b, "moments", "moment-one", "$span")["bundle_id"] == "bundle-000001"


# Reusing a stable identity is never a creation shortcut, including retained deleted objects
@pytest.mark.parametrize("deleted", [False, True])
def test_creation_refuses_existing_identity(catalog_pair, deleted):
    _, store, _ = catalog_pair
    from cairndex.replicas.catalog.projection import read_row

    with store.connection() as db:
        row = read_row(db, "moments", "moment-one")
    if deleted:
        submit(
            store,
            preview(store, {"action": "delete", "family": "moments", "entity": "moment-one"}),
            "delete",
        )
    with pytest.raises(ReplicaError, match="already exists"):
        preview(store, {"action": "create", "family": "moments", "row": row})


# Collection covers validate both direct edits and membership or hierarchy changes
@pytest.mark.parametrize("change", ["cover", "forest"])
def test_collection_cover_tree_invariant(catalog_pair, change):
    _, store, _ = catalog_pair
    save(
        store,
        edit(store, "collections", "collections-root", "cover_bundle_id", "bundle-000000"),
        "cover",
    )
    with pytest.raises(ReplicaError, match="collection tree"):
        if change == "cover":
            save(
                store,
                edit(store, "collections", "collections-root", "cover_bundle_id", "bundle-000001"),
                "bad-cover",
            )
        else:
            preview(
                store,
                {
                    "action": "reorder",
                    "unit": "collections/_/$forest",
                    "entity": "collections-child",
                    "parent": None,
                },
            )
    assert value(store, "collections", "collections-root", "cover_bundle_id") == "bundle-000000"


# A previously displayed choice must not consume revisions that arrived before preview creation
def test_stale_review_before_preview(catalog_pair):
    _, store, peer = catalog_pair
    unit = "moments/moment-one/comment"
    save(store, edit(store, "moments", "moment-one", "comment", "Amber"), "amber")
    save(peer, edit(peer, "moments", "moment-one", "comment", "Blue"), "blue")
    exchange(store, peer)
    with store.connection() as db:
        observed = {
            target: [tip["event"] for tip in store.tips(db, target)]
            for target in store.scope(db, [unit])
        }
    save(peer, edit(peer, "moments", "moment-one", "comment", "Cyan"), "cyan")
    exchange(store, peer)
    with pytest.raises(ReplicaError, match="stale"):
        preview(
            store,
            {"action": "choose", "unit": unit, "choices": {unit: '"Amber"'}, "observed": observed},
        )


# Indexed readers see the last committed catalog during a background writer transaction
def test_browsing_during_background_write(catalog_pair):
    _, store, _ = catalog_pair
    with store.connection() as writer:
        writer.execute(
            "UPDATE catalog_units SET value='\"Uncommitted\"' "
            "WHERE unit='moments/moment-one/comment'"
        )
        assert value(store, "moments", "moment-one", "comment") != "Uncommitted"
        assert store.entities("asset_bundles")["items"]
        assert store.files()["items"]
        writer.rollback()


# Durable listings retain lost responses, queued cancellation and safe restart of claimed jobs
def test_job_listing_cancel_and_restart(catalog_pair):
    from cairndex.replicas.catalog import jobs

    _, store, _ = catalog_pair
    for operation in ("first", "second", "third"):
        jobs.enqueue(
            store,
            operation,
            "preview",
            {"action": "delete", "family": "moments", "entity": "moment-one"},
        )
    page = jobs.listing(store, limit=2)
    assert [item["id"] for item in page["items"]] == ["third", "second"]
    assert jobs.listing(store, after=page["next_cursor"])["items"][0]["id"] == "first"
    jobs.cancel(store, "first")
    with store.connection() as db:
        db.execute("UPDATE catalog_jobs SET state='running' WHERE id='second'")
    reopened = CatalogStore(store.path.parent, store.descriptor)
    jobs.run_one(reopened)
    assert jobs.job(store, "first")["state"] == "cancelled"
    assert jobs.job(store, "second")["state"] == "succeeded"
    assert value(store, "moments", "moment-one", "$alive") is True


# Large single units span linked parts and reject a false final digest without partial visibility
def test_large_single_unit_and_corrupt_root(catalog_pair):
    from cairndex.replicas.catalog.protocol import Root, decode, envelope, payload

    _, store, peer = catalog_pair
    note = json.dumps(["雪😀" * 100_000, "", "repeat", "repeat"], ensure_ascii=False)
    save(store, edit(store, "asset_bundles", "bundle-000000", "notes", note), "large")
    exchange(store, peer)
    assert value(peer, "asset_bundles", "bundle-000000", "notes") == note
    changes = edit(store, "moments", "moment-one", "comment", "Never visible")
    artifacts = list(
        payload(
            changes,
            library=store.descriptor.library_uuid,
            epoch=store.descriptor.epoch,
            replica="damaged",
            operation="bad-final",
            parents=store.frontier(),
        )
    )
    _, root = decode(artifacts[-1][1], store.descriptor)
    assert isinstance(root, Root)
    artifacts[-1] = envelope(root.model_copy(update={"payload_hash": "0" * 64}))
    for _, raw in artifacts:
        peer.ingest(raw)
    for _ in range(5):
        peer.import_batch()
    assert peer.status()["blocked"]
    assert value(peer, "moments", "moment-one", "comment") != "Never visible"


# Source specimens and private auth survive conversion and rollback byte for byte
def test_source_and_auth_preservation(tmp_path):
    fixture = create_disposable(parent=tmp_path, bundles=3)
    paths = [
        fixture.source / "Synthetic/雪.mp4",
        fixture.source / "Synthetic/雪.srt",
        fixture.source / ".cairndex/manifest.json",
    ]
    originals = {path: path.read_bytes() for path in paths}
    conversion = prepare_disposable(fixture)
    output = export_legacy(conversion)
    assert all(path.read_bytes() == raw for path, raw in originals.items())
    assert (output / "manifest.json").read_bytes() == originals[paths[-1]]


# Two offline additions of the same Boolean edge combine without an identity alarm
def test_concurrent_same_pair_creation(catalog_pair):
    _, a, b = catalog_pair
    command = {
        "action": "create",
        "family": "asset_bundle_tags",
        "row": {"bundle_id": "bundle-000001", "tag_id": "tags-child"},
    }
    submit(a, preview(a, command), "edge-a")
    submit(b, preview(b, command), "edge-b")
    exchange(a, b)
    assert value(a, "asset_bundle_tags", "bundle-000001~tags-child", "$alive") is True
    assert value(b, "asset_bundle_tags", "bundle-000001~tags-child", "$alive") is True


# Complete deletion previews clear invalid ancestor covers and preserve recovery values
def test_membership_deletion_clears_collection_cover(catalog_pair):
    _, a, b = catalog_pair
    save(a, edit(a, "collections", "collections-root", "cover_bundle_id", "bundle-000000"), "cover")
    receipt = preview(
        a,
        {
            "action": "delete",
            "family": "asset_bundle_collections",
            "entity": "bundle-000000~collections-child",
        },
    )
    assert any(
        change["unit"] == "collections/collections-root/cover_bundle_id"
        for change in receipt["changes"]
    )
    submit(a, receipt, "remove-membership")
    exchange(a, b)
    assert value(b, "collections", "collections-root", "cover_bundle_id") is None


# A concurrent cover choice and last-membership removal expose one complete valid arrangement
def test_concurrent_cover_and_membership_removal(catalog_pair):
    _, a, b = catalog_pair
    save(a, edit(a, "collections", "collections-root", "cover_bundle_id", "bundle-000000"), "cover")
    submit(
        b,
        preview(
            b,
            {
                "action": "delete",
                "family": "asset_bundle_collections",
                "entity": "bundle-000000~collections-child",
            },
        ),
        "remove-edge",
    )
    exchange(a, b)
    unit = "collections/collections-root/cover_bundle_id"
    scope = a.history(unit)["scope"]
    assert "asset_bundle_collections/bundle-000000~collections-child/$alive" in scope
    with a.connection() as db:
        choices = {
            target: db.execute(
                "SELECT value FROM catalog_units WHERE unit=?", (target,)
            ).fetchone()[0]
            for target in scope
        }
    choices[unit] = "null"
    choices["asset_bundle_collections/bundle-000000~collections-child/$alive"] = "false"
    submit(a, preview(a, {"action": "choose", "unit": unit, "choices": choices}), "clear-cover")
    exchange(a, b)
    assert value(a, "collections", "collections-root", "cover_bundle_id") is None
    assert (
        value(b, "asset_bundle_collections", "bundle-000000~collections-child", "$alive") is False
    )


# Every authored family supports new stable identities and exact independent delivery
@pytest.mark.parametrize("family", sorted(AUTHORED))
def test_creation_all_families(catalog_pair, family):
    from cairndex.replicas.catalog.model import IDENTITIES, entity_id
    from cairndex.replicas.catalog.projection import read_row

    conversion, a, b = catalog_pair
    with a.connection() as db:
        original = db.execute(
            "SELECT entity FROM catalog_rows WHERE family=? ORDER BY entity LIMIT 1", (family,)
        ).fetchone()[0]
        row = read_row(db, family, original)
    if IDENTITIES[family] == ("id",):
        row["id"] = "created"
        for field in ("name", "relative_path", "directory_path"):
            if field in row:
                row[field] = "Created" if field != "relative_path" else "Created/synthetic.mp4"
        if family == "asset_bundles":
            row["cover_file_id"] = row["primary_file_id"] = None
        if family == "subtitle_tracks":
            row["source_file_id"], row["embedded_index"] = None, 0
    else:
        if "bundle_id" in row:
            row["bundle_id"] = "bundle-000002"
        else:
            row["tag_id"] = "tags-root"
    submit(a, preview(a, {"action": "create", "family": family, "row": row}), "create")
    exchange(a, b)
    identity = entity_id(family, row)
    assert value(b, family, identity, "$alive") is True
    with b.connection() as db:
        assert read_row(db, family, identity) == row
    export_legacy(conversion)


# Non-table private state and unknown schema behavior must be classified before activation
@pytest.mark.parametrize("mutation", ["manifest", "layout", "auth", "private", "trigger"])
def test_conversion_blocks_unclassified_state(tmp_path, mutation):
    fixture = create_disposable(parent=tmp_path, bundles=3)
    if mutation in ("manifest", "layout"):
        path = fixture.source / ".cairndex/manifest.json"
        body = json.loads(path.read_text())
        body["format_version" if mutation == "manifest" else "db"] = (
            99 if mutation == "manifest" else "other.db"
        )
        path.write_text(json.dumps(body))
    elif mutation == "auth":
        (fixture.directory / "private/synthetic-auth.json").write_text('{"unknown":true}')
    elif mutation == "private":
        (fixture.directory / "private/unknown-state").write_text("synthetic")
    else:
        with sqlite3.connect(fixture.source / ".cairndex/library.db") as db:
            db.execute("CREATE TRIGGER unknown_update AFTER UPDATE ON tags BEGIN SELECT 1; END")
    with pytest.raises(ReplicaError):
        prepare_disposable(fixture)
    assert not list(fixture.directory.glob("conversion-*/package/.cairndex/manifest.json"))


# Real process exits prove all-or-nothing seed activation and save receipts at commit boundaries
@pytest.mark.parametrize(
    "point",
    ["import_before_commit", "import_after_commit", "save_before_commit", "save_after_commit"],
)
def test_catalog_process_crash(catalog_pair, tmp_path, point):
    import subprocess
    import sys

    _, source, _ = catalog_pair
    target = source
    if point.startswith("import"):
        target = CatalogStore(tmp_path / "crash-seed", source.descriptor)
        with source.connection() as db:
            for identity, raw in db.execute("SELECT id,raw FROM events"):
                if identity != source.descriptor.genesis:
                    target.ingest(raw)
            target.import_batch(1000)
            root = db.execute(
                "SELECT raw FROM events WHERE id=?", (source.descriptor.genesis,)
            ).fetchone()[0]
            target.ingest(root)
    changes = edit(source, "moments", "moment-one", "comment", "Durable crash specimen")
    parents = source.frontier()
    script = """
import json, os, sys
from pathlib import Path
from cairndex.replicas.catalog.protocol import CatalogDescriptor, UnitChange
from cairndex.replicas.catalog.store import CatalogStore
folder, descriptor, changes, parents, point = sys.argv[1:]
# Kill the process at the actual SQLite commit boundary
def fault(current):
    if current == point:
        os._exit(79)
store = CatalogStore(Path(folder), CatalogDescriptor.model_validate_json(descriptor), fault=fault)
if point.startswith("import"):
    store.import_batch(1000)
else:
    parsed = [UnitChange.model_validate(item) for item in json.loads(changes)]
    store.save(parsed, "crash", parents=json.loads(parents))
"""
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            script,
            str(target.path.parent),
            source.descriptor.model_dump_json(),
            json.dumps([change.model_dump() for change in changes]),
            json.dumps(parents),
            point,
        ],
        capture_output=True,
        timeout=20,
    )
    assert result.returncode == 79, result.stderr.decode()
    reopened = CatalogStore(target.path.parent, source.descriptor)
    if point.startswith("import"):
        assert reopened.status()["ready"] == point.endswith("after_commit")
        if not reopened.status()["ready"]:
            assert reopened.entities("moments")["items"] == []
        for _ in range(5):
            reopened.import_batch()
        assert reopened.status()["ready"]
    else:
        present = value(reopened, "moments", "moment-one", "comment") == "Durable crash specimen"
        assert present == point.endswith("after_commit")
        saved = reopened.save(changes, "crash", parents=parents)
        assert saved


# Recovering a transferred file restores necessary ownership while retaining live dependent comments
def test_recovery_after_transfer_preserves_live_scalar_work(catalog_pair):
    _, store, _ = catalog_pair
    submit(
        store,
        preview(
            store,
            {
                "action": "transfer",
                "source": "bundle-000000",
                "target": "bundle-000001",
                "members": ["bundle_directory_members/directory-one"],
            },
        ),
        "transfer",
    )
    save(store, edit(store, "moments", "moment-one", "comment", "Keep live comment"), "comment")
    receipt = recover_preview(store, store.descriptor.genesis, "asset_files", "file-video")
    submit(store, receipt, "restore-file")
    assert value(store, "moments", "moment-one", "$span")["bundle_id"] == "bundle-000000"
    assert value(store, "subtitle_tracks", "track-one", "$source")["bundle_id"] == "bundle-000000"
    assert value(store, "moments", "moment-one", "comment") == "Keep live comment"


# Recovering an ancestor cover includes its missing descendant membership without reverting names
def test_recover_collection_with_descendant_cover(catalog_pair):
    _, store, _ = catalog_pair
    branch = save(
        store,
        edit(store, "collections", "collections-root", "cover_bundle_id", "bundle-000000"),
        "cover",
    )
    submit(
        store,
        preview(
            store,
            {
                "action": "delete",
                "family": "asset_bundle_collections",
                "entity": "bundle-000000~collections-child",
            },
        ),
        "remove-edge",
    )
    save(store, edit(store, "collections", "collections-child", "name", "Keep child name"), "name")
    submit(
        store, recover_preview(store, branch, "collections", "collections-root"), "recover-cover"
    )
    assert value(store, "collections", "collections-root", "cover_bundle_id") == "bundle-000000"
    assert value(store, "collections", "collections-child", "name") == "Keep child name"
