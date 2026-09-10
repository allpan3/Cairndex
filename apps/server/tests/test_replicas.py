"""Production replica acceptance using generated libraries and ordinary local file delivery"""

import json
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from cairndex.api.deps import get_registry_db
from cairndex.devtools.replica_fixture import create_fixture
from cairndex.main import create_app
from cairndex.registry import library_package as pkg
from cairndex.registry.engine import create_registry_engine
from cairndex.replicas import service
from cairndex.replicas.protocol import Change, PackageFormatError, ReplicaError, canonical, checksum
from cairndex.replicas.store import Store
from cairndex.replicas.transport import BATCH, Transport


# Generate two independent private stores sharing only immutable synthetic transport artifacts
@pytest.fixture
def pair(tmp_path: Path) -> tuple[Store, Store, Transport, Transport]:
    descriptor = create_fixture(tmp_path / "A")
    shutil.copytree(tmp_path / "A", tmp_path / "B")
    a = Store(tmp_path / "private-A", descriptor)
    b = Store(tmp_path / "private-B", descriptor)
    ta, tb = Transport(tmp_path / "A", a), Transport(tmp_path / "B", b)
    ta.tick()
    tb.tick()
    yield a, b, ta, tb
    ta.close()
    tb.close()


# Real provider-independent delivery copies only metadata objects, never private SQLite
# Several ticks cover duplicate ordering and bounded dependency retries
def sync(ta: Transport, tb: Transport) -> None:
    for _ in range(3):
        ta.tick()
        tb.tick()
        for source, target in ((ta, tb), (tb, ta)):
            for file in (source.root / ".cairndex/replica/objects").glob("*/*.json"):
                dest = target.root / ".cairndex/replica/objects" / file.parent.name / file.name
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(file, dest)


# Editor basis comes from the API-shaped state, never from timestamps
def change(store: Store, field: str, value: Any) -> dict[str, Change]:
    state = store.bundles()["items"][0]["fields"][field]
    return {field: Change(value=value, basis=state["basis"])}


# Disjoint offline fields and both-open alternating saves converge without handoff
def test_offline_disjoint_and_alternating(pair):
    a, b, ta, tb = pair
    a.save("synthetic-bundle", change(a, "title", "Amber"), "title-A")
    b.save("synthetic-bundle", change(b, "notes", ["Blue", "Ordered"]), "notes-B")
    sync(ta, tb)
    assert a.bundles() == b.bundles()
    assert a.bundles()["items"][0]["fields"]["notes"]["value"] == ["Blue", "Ordered"]
    for i in range(4):
        author = a if i % 2 else b
        author.save("synthetic-bundle", change(author, "rating", i / 2), f"rating-{i}")
        sync(ta, tb)
        assert a.bundles() == b.bundles()


# A conflict choice changes only the reviewed field; rejected values remain in history
def test_resolution_stale_review_and_recovery(pair):
    a, b, ta, tb = pair
    first = a.save("synthetic-bundle", change(a, "title", "Amber"), "A")
    b.save("synthetic-bundle", change(b, "title", "Blue"), "B")
    b.save("synthetic-bundle", change(b, "notes", ["Keep unrelated"]), "B-note")
    sync(ta, tb)
    reviewed = change(a, "title", "Blue")
    a.save("synthetic-bundle", reviewed, "resolve", resolve=True)
    with pytest.raises(ReplicaError, match="stale"):
        a.save("synthetic-bundle", reviewed, "stale-resolution", resolve=True)
    assert a.save("synthetic-bundle", reviewed, "resolve", resolve=True)
    sync(ta, tb)
    assert a.bundles() == b.bundles()
    history = a.history("synthetic-bundle", "title")["items"]
    assert any(row["revision"] == first and row["value"] == "Amber" for row in history)
    a.save("synthetic-bundle", change(a, "title", "Amber"), "recover")
    sync(ta, tb)
    assert b.bundles()["items"][0]["fields"]["notes"]["value"] == ["Keep unrelated"]


# A stale draft creates a candidate instead of overwriting unseen remote work
def test_draft_and_retry_identity(pair):
    a, b, ta, tb = pair
    draft = change(a, "title", "Unsaved")
    a.draft("draft-A", "synthetic-bundle", 2, draft)
    b.save("synthetic-bundle", change(b, "title", "Remote"), "remote")
    sync(ta, tb)
    with pytest.raises(ReplicaError):
        a.draft("draft-A", "synthetic-bundle", 1, change(a, "title", "Older"))
    event = a.save("synthetic-bundle", draft, "draft-save")
    assert a.save("synthetic-bundle", draft, "draft-save") == event
    with pytest.raises(ReplicaError, match="Retry identity"):
        a.save("synthetic-bundle", change(a, "title", "Different"), "draft-save")
    assert len(a.bundles()["items"][0]["fields"]["title"]["candidates"]) == 2
    reopened = Store(a.path.parent, a.descriptor)
    assert reopened.drafts("synthetic-bundle")["items"][0]["revision"] == 2
    reopened.dismiss_draft("draft-A", 1)
    assert reopened.drafts("synthetic-bundle")["items"]


# Partial delivery waits without poisoning future local saves; valid replacement clears that wait
def test_partial_corrupt_unknown_and_out_of_order(pair):
    a, b, ta, tb = pair
    first = a.save("synthetic-bundle", change(a, "title", "First"), "first")
    second = a.save("synthetic-bundle", change(a, "title", "Second"), "second")
    with a.connection() as db:
        raws = {r["id"]: r["raw"] for r in db.execute("SELECT id,raw FROM events")}
    before = b.bundles()
    b.ingest(raws[second][:50], "partial")
    b.import_batch()
    assert b.bundles() == before and not b.status()["blocked"]
    b.ingest(raws[second], "partial")
    b.import_batch()
    assert b.bundles() == before
    b.ingest(raws[first], "first")
    for _ in range(3):
        b.import_batch()
    assert b.bundles()["items"][0]["fields"]["title"]["value"] == "Second"
    assert not b.status()["waiting"]
    invalid = json.loads(raws[second])
    invalid["body"]["protocol"] = 999
    invalid["sha256"] = checksum(canonical(invalid["body"]))
    b.ingest(canonical(invalid), "future")
    with pytest.raises(ReplicaError, match="upgrade"):
        b.save("synthetic-bundle", change(b, "title", "Unsafe"), "future-save")
    assert b.bundles()["items"][0]["fields"]["title"]["value"] == "Second"


# API clients and import contend through actual SQLite transactions, not an in-memory lock
def test_concurrent_writers_and_import(pair):
    a, b, ta, tb = pair
    basis = change(a, "title", "unused")["title"].basis
    b.save("synthetic-bundle", change(b, "notes", ["Imported concurrently"]), "imported")
    with b.connection() as db:
        raw = db.execute("SELECT raw FROM events WHERE local=1").fetchone()[0]
    a.ingest(raw)
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [
            pool.submit(
                a.save,
                "synthetic-bundle",
                {"title": Change(value=f"Title {i}", basis=basis)},
                f"client-{i}",
            )
            for i in range(12)
        ]
        futures.append(pool.submit(a.import_batch))
        for future in futures:
            future.result()
    fields = a.bundles()["items"][0]["fields"]
    assert len(fields["title"]["candidates"]) == 12
    assert fields["notes"]["value"] == ["Imported concurrently"]


# Discovery consumes bounded entries even when names are ignored or deliveries are duplicated
def test_bounded_discovery_and_path_confinement(pair, tmp_path):
    a, b, ta, tb = pair
    folder = ta.root / ".cairndex/replica/objects/00"
    folder.mkdir(exist_ok=True)
    for i in range(BATCH * 3):
        (folder / f"{i}.partial").write_text("partial")
    ta._scan = None
    ta.tick()
    assert ta._scan is not None
    outside = tmp_path / "outside"
    outside.mkdir()
    (ta.root / ".cairndex/replica/objects/01").symlink_to(outside, target_is_directory=True)
    before = list(outside.iterdir())
    with pytest.raises(OSError):
        ta.publish("01" + "a" * 62, b"synthetic")
    assert list(outside.iterdir()) == before


# New columns cannot quietly fall outside the reversible migration specification
def test_inventory_complete():
    from cairndex.persistence.base import Base
    from cairndex.replicas.inventory import CONVERSION_AVAILABLE, INVENTORY

    assert not CONVERSION_AVAILABLE
    assert set(INVENTORY) == set(Base.metadata.tables)
    for name, table in Base.metadata.tables.items():
        columns = [column for group in INVENTORY[name].values() for column in group.split()]
        assert len(columns) == len(set(columns))
        assert set(columns) == {column.name for column in table.columns}


# Real FastAPI dependency/auth/format paths exercise concurrent clients on one replica server
@pytest.fixture
def api(tmp_path):
    root = tmp_path / "api-root"
    create_fixture(root)
    engine = create_registry_engine(f"sqlite:///{tmp_path / 'registry.db'}")
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    app = create_app()

    def registry():
        with factory() as session:
            yield session
            session.commit()

    app.dependency_overrides[get_registry_db] = registry
    with TestClient(app) as client:
        reply = client.post("/api/v1/libraries/register", json={"root_path": str(root)})
        assert reply.status_code == 201, reply.text
        library = reply.json()
        base = f"/api/v1/libraries/{library['id']}"
        client.post(base + "/replica/exchange")
        yield client, base, root, library, app
        service.close(library["id"])
    engine.dispose()


# All noncapable mutators and legacy DB/lease paths refuse the new package
# Release/reopen affects this local replica only and retains its private state
def test_api_capabilities_release_and_private_storage(api):
    client, base, root, library, app = api
    assert library["package_format"] == "cairndex.replica-library"
    assert client.delete(base + "/replica/drafts/missing?revision=2147483648").status_code == 422
    state = client.get(base + "/replica/bundles").json()
    assert len(state["items"]) == 1
    assert not (root / ".cairndex/library.db").exists()
    assert not (root / ".cairndex/locks").exists()
    assert client.get(base + "/bundles/browse").status_code == 409
    assert client.post(base + "/ownership/takeover").status_code == 409
    assert client.put(base + "/write-mode", json={"enabled": True}).status_code == 409
    assert client.post(base + "/ownership/release").status_code == 200
    assert client.get(base + "/replica/bundles").status_code == 409
    assert client.post(base + "/ownership/reopen").status_code == 200
    assert client.get(base + "/replica/bundles").json() == state
    assert not (root / ".cairndex/locks").exists()


# Concurrent HTTP saves and exchange cannot lose a stale client's intent
# Registry and private transactions use distinct connections across worker threads
def test_concurrent_http_clients_and_import(api):
    client, base, root, library, app = api
    url = base + "/replica/bundles/synthetic-bundle"
    basis = client.get(base + "/replica/bundles").json()["items"][0]["fields"]["title"]["basis"]
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [
            pool.submit(
                client.post,
                url + "/edits",
                json={
                    "operation": f"http-{i}",
                    "changes": {"title": {"value": f"Client {i}", "basis": basis}},
                },
            )
            for i in range(8)
        ]
        futures.append(pool.submit(client.post, base + "/replica/exchange"))
        replies = [future.result() for future in futures]
    assert all(reply.status_code == 200 for reply in replies), [reply.text for reply in replies]
    fields = client.get(base + "/replica/bundles").json()["items"][0]["fields"]
    assert len(fields["title"]["candidates"]) == 8
    assert (
        client.post(
            url + "/edits",
            json={"operation": "missing-basis", "changes": {"title": {"value": "Bad"}}},
        ).status_code
        == 422
    )
    assert (
        client.post(
            url + "/edits",
            json={"operation": "lifetime", "changes": {"alive": {"value": False, "basis": basis}}},
        ).status_code
        == 422
    )


# A changed future manifest fences already-open stores and cached legacy sessions
@pytest.mark.parametrize(
    "format_name,version",
    [("cairndex.library", 999), ("unknown", 1), ("cairndex.replica-library", 999)],
)
def test_changed_format_fences_api(api, format_name, version):
    client, base, root, library, app = api
    marker = root / ".cairndex/manifest.json"
    manifest = json.loads(marker.read_text())
    manifest.update(format=format_name, format_version=version)
    marker.write_text(json.dumps(manifest))
    before = marker.read_bytes()
    for path in ("/replica/bundles", "/bundles/browse", "/ownership"):
        assert client.get(base + path).status_code == 409
    assert marker.read_bytes() == before
    assert not (root / ".cairndex/library.db").exists()


# Package fencing applies before an ordinary manifest can redirect storage paths
@pytest.mark.parametrize(
    "field,value",
    [
        ("format_version", 2),
        ("format_version", True),
        ("db", "../elsewhere.db"),
        ("content_root", "../outside"),
    ],
)
def test_legacy_format_layout_fencing(library_root, field, value):
    marker = pkg.manifest_path(library_root)
    raw = json.loads(marker.read_text())
    raw[field] = value
    marker.write_text(json.dumps(raw))
    with pytest.raises(PackageFormatError):
        pkg.read_manifest(library_root)


# Late autosave requests cannot resurrect an acknowledged draft or erase a newer generation
def test_draft_dismissal_receipts(pair):
    a, _, _, _ = pair
    changes = change(a, "title", "Private work")
    a.dismiss_draft("draft", 2)
    a.draft("draft", "synthetic-bundle", 1, changes)
    a.draft("draft", "synthetic-bundle", 2, changes)
    assert not a.drafts("synthetic-bundle")["items"]
    a.draft("draft", "synthetic-bundle", 3, changes)
    a.dismiss_draft("draft", 2)
    assert a.drafts("synthetic-bundle")["items"][0]["revision"] == 3
    a.dismiss_draft("draft", 3)
    assert not a.drafts("synthetic-bundle")["items"]


# Actual process death at transaction and file boundaries must preserve retryable intent
@pytest.mark.parametrize(
    "point",
    [
        "save_before_commit",
        "save_after_commit",
        "import_before_commit",
        "import_after_commit",
        "publish_before_rename",
        "publish_after_rename",
        "publish_before_receipt",
        "resolve_before_commit",
        "resolve_after_commit",
    ],
)
def test_abrupt_process_crash(pair, point):
    import subprocess
    import sys

    a, b, ta, tb = pair
    operation = "crash-edit"
    changes = change(a, "title", "Crash boundary")
    if point.startswith("import"):
        b.save("synthetic-bundle", change(b, "title", "Crash boundary"), operation)
        with b.connection() as db:
            raw = db.execute("SELECT raw FROM events WHERE local=1").fetchone()[0]
        a.ingest(raw)
    if point.startswith("resolve"):
        a.save("synthetic-bundle", change(a, "title", "Amber"), "before-A")
        b.save("synthetic-bundle", change(b, "title", "Blue"), "before-B")
        sync(ta, tb)
        changes = change(a, "title", "Crash boundary")
    if point.startswith("publish"):
        a.save("synthetic-bundle", changes, operation)
    script = """
import json, os, sys
from pathlib import Path
from cairndex.replicas.protocol import Descriptor, Change
from cairndex.replicas.store import Store
from cairndex.replicas.transport import Transport
folder, root, descriptor, changes, point = sys.argv[1:]
def fault(current):
    if current == point.replace("resolve_", "save_"):
        os._exit(79)
store = Store(Path(folder), Descriptor.model_validate_json(descriptor), fault=fault)
if point.startswith("import"):
    store.import_batch()
elif point.startswith("publish"):
    Transport(Path(root), store).tick()
else:
    parsed = {k: Change.model_validate(v) for k,v in json.loads(changes).items()}
    store.save("synthetic-bundle", parsed, "crash-edit", resolve=point.startswith("resolve"))
"""
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            script,
            str(a.path.parent),
            str(ta.root),
            a.descriptor.model_dump_json(),
            json.dumps({k: v.model_dump() for k, v in changes.items()}),
            point,
        ],
        timeout=15,
        capture_output=True,
    )
    assert result.returncode == 79, result.stderr.decode()
    reopened = Store(a.path.parent, a.descriptor)
    fields = reopened.bundles()["items"][0]["fields"]
    if point.endswith("before_commit"):
        assert fields["title"]["value"] != "Crash boundary"
    if point.startswith("import"):
        reopened.import_batch()
    elif not point.startswith("publish"):
        reopened.save("synthetic-bundle", changes, operation, resolve=point.startswith("resolve"))
    transport = Transport(ta.root, reopened)
    try:
        transport.tick()
        assert reopened.status()["outbox"] == 0
        assert reopened.bundles()["items"][0]["fields"]["title"]["value"] == "Crash boundary"
        with reopened.connection() as db:
            assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert not db.execute("PRAGMA foreign_key_check").fetchall()
            rows = db.execute("SELECT raw,id FROM events WHERE local=1").fetchall()
        for row in rows:
            assert (
                ta.root / ".cairndex/replica/objects" / row["id"][:2] / (row["id"] + ".json")
            ).read_bytes() == row["raw"]
    finally:
        transport.close()


# Atomic publication never replaces a destination created between existence check and commit
def test_publication_collision_and_repair(pair):
    a, _, ta, _ = pair
    event = a.save("synthetic-bundle", change(a, "title", "Published"), "published")
    path = ta.root / ".cairndex/replica/objects" / event[:2] / (event + ".json")

    def race(point):
        if point == "publish_before_rename":
            path.write_bytes(b"other publication")

    a.fault = race
    with pytest.raises(ReplicaError, match="concurrent publication"):
        ta.tick()
    assert path.read_bytes() == b"other publication"
    assert a.status()["outbox"] == 1
    path.unlink()
    a.fault = lambda point: None
    ta.tick()
    raw = path.read_bytes()
    path.unlink()
    ta.tick()
    assert path.read_bytes() == raw


# Cached background handles must stop before publishing into a changed package
def test_background_descriptor_fence(api):
    client, base, root, library, _ = api
    store = service._handles[library["id"]][0]
    store.save("synthetic-bundle", change(store, "title", "Private only"), "private-only")
    marker = pkg.manifest_path(root)
    descriptor = json.loads(marker.read_text())
    descriptor["epoch"] = "different-epoch"
    marker.write_text(json.dumps(descriptor))
    with pytest.raises(ReplicaError):
        service.exchange(library["id"])
    assert store.status()["outbox"] == 1
    assert store.status()["exchange_error"]


# Malformed values are structured client errors and preserve the prior committed projection
@pytest.mark.parametrize("field,value", [("title", ""), ("notes", "not a list"), ("rating", 6.0)])
def test_api_invalid_value(api, field, value):
    client, base, _, _, _ = api
    state = client.get(base + "/replica/bundles").json()
    response = client.post(
        base + "/replica/bundles/synthetic-bundle/edits",
        json={
            "operation": "bad-value",
            "changes": {
                field: {"value": value, "basis": state["items"][0]["fields"][field]["basis"]}
            },
        },
    )
    assert response.status_code == 422
    assert client.get(base + "/replica/bundles").json() == state


# Retained history and drafts stay complete through page boundaries without replaying events
def test_pagination_and_history_index(pair):
    a, _, _, _ = pair
    for i in range(65):
        changes = change(a, "title", f"Version {i}")
        a.save("synthetic-bundle", changes, f"page-{i}")
        a.draft(f"draft-{i:03}", "synthetic-bundle", 1, changes)
    for reader, count in [
        (lambda cursor: a.history("synthetic-bundle", "title", cursor), 66),
        (lambda cursor: a.drafts("synthetic-bundle", cursor), 65),
    ]:
        cursor, items = "", []
        while True:
            page = reader(cursor)
            assert len(page["items"]) <= 30
            items.extend(page["items"])
            if not page["next_cursor"]:
                break
            cursor = page["next_cursor"]
        assert len(items) == count
    with a.connection() as db:
        plan = db.execute(
            (
                "EXPLAIN QUERY PLAN SELECT event,value FROM revisions WHERE bundle=? AND field=? "
                "AND event>? ORDER BY event LIMIT 31"
            ),
            ("synthetic-bundle", "title", ""),
        ).fetchall()
    assert any("revisions_history" in row[3] for row in plan)


# An existing SQL connection must not bypass a newly incompatible package marker
def test_cached_legacy_connection_is_fenced(library_root, registry_session):
    from sqlalchemy import text

    from cairndex.core.errors import LibraryOwnershipUncertainError
    from cairndex.registry.library_engine import get_library_sessionmaker
    from cairndex.registry.services import register_existing_library

    library = register_existing_library(registry_session, root_path=str(library_root))
    maker = get_library_sessionmaker(library)
    marker = pkg.manifest_path(library_root)
    with maker() as session:
        assert session.scalar(text("SELECT COUNT(*) FROM asset_bundles")) == 0
        raw = json.loads(marker.read_text())
        raw["format_version"] = 999
        marker.write_text(json.dumps(raw))
        with pytest.raises(LibraryOwnershipUncertainError):
            session.execute(text("SELECT COUNT(*) FROM asset_bundles"))
        session.rollback()
    with pytest.raises(PackageFormatError):
        get_library_sessionmaker(library)


# Rebinding a provider directory or private state never silently redirects active work
def test_rebound_paths_are_fenced(pair, tmp_path):
    a, _, ta, _ = pair
    a.save("synthetic-bundle", change(a, "title", "Retained"), "rebind")
    old = tmp_path / "old-root"
    ta.root.rename(old)
    shutil.copytree(old, ta.root)
    with pytest.raises(ReplicaError, match="directory changed"):
        ta.tick()
    original = a.path.parent
    original.rename(tmp_path / "old-private")
    shutil.copytree(tmp_path / "old-private", original)
    with pytest.raises(ReplicaError, match="storage changed"):
        a.bundles()


# Provider-renamed duplicates remain valid while linked artifacts remain unverified
def test_aliases_and_unsafe_artifacts(pair, tmp_path):
    a, b, ta, tb = pair
    event = a.save("synthetic-bundle", change(a, "title", "Alias arrival"), "alias")
    ta.tick()
    raw = (ta.root / ".cairndex/replica/objects" / event[:2] / (event + ".json")).read_bytes()
    folder = tb.root / ".cairndex/replica/objects/00"
    folder.mkdir(exist_ok=True)
    (folder / "provider-conflict-copy.json").write_bytes(raw)
    target = tmp_path / "outside-object"
    target.write_bytes(raw)
    (folder / "linked.json").symlink_to(target)
    for _ in range(3):
        tb.tick()
    assert b.bundles()["items"][0]["fields"]["title"]["value"] == "Alias arrival"
    assert b.status()["waiting"] == 1
    assert not b.status()["blocked"]
    assert target.read_bytes() == raw
    (folder / "linked.json").unlink()
    (folder / "linked.json").write_bytes(raw)
    for _ in range(3):
        tb.tick()
    assert not b.status()["waiting"]


# A cached legacy heartbeat or graceful release cannot write into a newly incompatible package
@pytest.mark.parametrize("action", ["heartbeat", "release"])
def test_legacy_background_lease_fence(library_root, registry_session, action):
    from cairndex.ownership import get_lease_manager
    from cairndex.registry.services import register_existing_library

    library = register_existing_library(registry_session, root_path=str(library_root))
    manager = get_lease_manager()
    manager.acquire(library_id=library.id, root=library_root)
    lease = pkg.lease_path(library_root)
    before = lease.read_bytes()
    marker = pkg.manifest_path(library_root)
    data = json.loads(marker.read_text())
    data["format_version"] = 999
    marker.write_text(json.dumps(data))
    if action == "heartbeat":
        assert library.id in manager.heartbeat_once()
    else:
        manager.release(library.id)
    assert lease.read_bytes() == before
    assert not manager.holds(library.id)
