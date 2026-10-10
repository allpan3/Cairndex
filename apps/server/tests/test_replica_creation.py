"""Synthetic creation must publish one complete identity without a legacy database."""

import errno
import json
import os
import shutil
import subprocess
import sys

import pytest

from cairndex.core.errors import DomainError
from cairndex.devtools.replica_creation_fixture import prepare_disposable
from cairndex.registry import library_package, services
from cairndex.replicas.binding import BindingLock
from cairndex.replicas.catalog.controls import creation
from cairndex.replicas.catalog.creation import complete, prepare
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.inventory import CONVERSION_AVAILABLE
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.transport import Transport
from tests.test_replica_catalog import edit, exchange, preview, save, submit


def open_store(root, private):
    descriptor = library_package.read_manifest(root).replica
    store = CatalogStore(private, descriptor)
    transport = Transport(root, store)
    try:
        for _ in range(8):
            transport.tick()
    finally:
        transport.close()
    return store


def author(store):
    with store.connection() as db:
        return db.execute("SELECT value FROM config WHERE key='replica'").fetchone()[0]


def test_empty_catalog_can_create_edit_and_reconstruct(tmp_path):
    fixture = prepare_disposable(parent=tmp_path)
    descriptor = complete(fixture)
    before = {p.relative_to(fixture.root): p.read_bytes() for p in fixture.root.rglob("*.json")}
    assert complete(fixture) == descriptor
    assert before == {
        p.relative_to(fixture.root): p.read_bytes() for p in fixture.root.rglob("*.json")
    }
    assert descriptor.format_version == 3
    assert not CONVERSION_AVAILABLE
    assert not list(fixture.root.rglob("*.db*"))
    assert not (fixture.root / ".cairndex/locks").exists()
    a = open_store(fixture.root, tmp_path / "author-a")
    assert a.status()["ready"] and a.entities("asset_bundles")["items"] == []
    row = {key: json.loads(value) for key, value in creation("asset_bundles")["cells"].items()}
    row["title"] = "Synthetic initial title"
    receipt = preview(a, {"action": "create", "family": "asset_bundles", "row": row})
    submit(a, receipt, "create-bundle")
    b = open_store(fixture.root, tmp_path / "author-b")
    exchange(a, b)
    assert author(a) != author(b)
    save(a, edit(a, "asset_bundles", row["id"], "title", "Amber"), "amber")
    save(b, edit(b, "asset_bundles", row["id"], "title", "Blue"), "blue")
    exchange(a, b)
    assert len(b.entity("asset_bundles", row["id"])["fields"]["title"]["candidates"]) == 2
    a.draft("private-draft", "asset_bundles/" + row["id"], 1, {"input": "Unsent text"})
    for source in (a, b):
        transport = Transport(fixture.root, source)
        try:
            for _ in range(8):
                transport.tick()
        finally:
            transport.close()
    peer = tmp_path / "peer-package"
    shutil.copytree(fixture.root, peer)
    c = open_store(peer, tmp_path / "author-c")
    assert c.entity("asset_bundles", row["id"])["has_conflicts"]
    assert len({author(a), author(b), author(c)}) == 3
    assert c.drafts("asset_bundles/" + row["id"])["items"] == []
    assert complete(fixture) == descriptor
    assert not list(peer.rglob("*.db*"))


@pytest.mark.parametrize(
    "point",
    [
        "creation_after_validation",
        "creation_after_object",
        "creation_before_manifest",
        "creation_after_manifest_temp",
        "creation_after_manifest_link",
        "creation_after_manifest",
    ],
)
def test_process_exit_retries_same_creation(tmp_path, point):
    fixture = prepare_disposable(parent=tmp_path)
    intent = (fixture.private / "creation.json").read_bytes()
    script = """
import os, sys
from pathlib import Path
from cairndex.devtools.replica_creation_fixture import DisposableCreation
from cairndex.replicas.catalog.creation import complete
def fault(current):
    if current == sys.argv[2]:
        os._exit(79)
complete(DisposableCreation(Path(sys.argv[1])), fault=fault)
"""
    result = subprocess.run(
        [sys.executable, "-c", script, str(fixture.directory), point],
        capture_output=True,
        timeout=20,
    )
    assert result.returncode == 79, result.stderr.decode()
    visible = point in {"creation_after_manifest_link", "creation_after_manifest"}
    assert (fixture.root / ".cairndex/manifest.json").exists() == visible
    if visible:
        assert open_store(fixture.root, tmp_path / "interrupted-reader").status()["ready"]
    else:
        with pytest.raises(DomainError):
            library_package.read_manifest(fixture.root)
    descriptor = complete(fixture)
    assert descriptor.model_dump(mode="json") == json.loads(intent)["descriptor"]
    assert (fixture.private / "creation.json").read_bytes() == intent
    assert open_store(fixture.root, tmp_path / "reader").status()["ready"]


@pytest.mark.parametrize(
    "damage", ["missing-intent", "corrupt-intent", "root", "marker", "link", "legacy", "descriptor"]
)
def test_unsafe_retry_preserves_inputs(tmp_path, damage):
    fixture = prepare_disposable(parent=tmp_path)
    marker = fixture.root / ".cairndex"
    if damage == "missing-intent":
        (fixture.private / "creation.json").unlink()
    elif damage == "corrupt-intent":
        (fixture.private / "creation.json").write_bytes(b"{partial")
    elif damage == "root":
        fixture.root.rename(fixture.directory / "original")
        marker.mkdir(parents=True)
    elif damage == "marker":
        marker.rename(fixture.root / "original-marker")
        marker.mkdir()
    elif damage == "link":
        marker.rmdir()
        target = tmp_path / "outside"
        target.mkdir()
        marker.symlink_to(target, target_is_directory=True)
    elif damage == "legacy":
        (marker / "library.db").write_bytes(b"synthetic legacy bytes")
    else:
        (marker / "manifest.json").write_bytes(b"synthetic competing descriptor")
    before = {p: p.read_bytes() for p in fixture.directory.rglob("*") if p.is_file()}
    with pytest.raises(ReplicaError):
        complete(fixture)
    assert all(p.read_bytes() == raw for p, raw in before.items())
    assert not (marker / "replica").exists()


def test_creation_refuses_changed_immutable_object(tmp_path):
    fixture = prepare_disposable(parent=tmp_path)
    descriptor = complete(fixture)
    path = (
        fixture.root
        / ".cairndex/replica/objects"
        / descriptor.genesis[:2]
        / (descriptor.genesis + ".json")
    )
    path.write_bytes(b"synthetic corrupt object")
    with pytest.raises(ReplicaError, match="published object changed"):
        complete(fixture)
    assert path.read_bytes() == b"synthetic corrupt object"


def test_private_creation_lock_and_preparation_are_exclusive(tmp_path):
    fixture = prepare_disposable(parent=tmp_path)
    descriptor = complete(fixture)
    guard = BindingLock(fixture.private, descriptor)
    try:
        with pytest.raises(ReplicaError, match="active"):
            complete(fixture)
    finally:
        guard.close()
    with pytest.raises(ReplicaError, match="new empty fixture"):
        prepare(fixture)


def test_incomplete_creation_cannot_register_or_become_legacy(tmp_path, registry_session):
    fixture = prepare_disposable(parent=tmp_path)
    with pytest.raises(DomainError):
        services.register_existing_library(registry_session, root_path=str(fixture.root))
    with pytest.raises(DomainError):
        services.create_library(registry_session, root_path=str(fixture.root), display_name="Other")
    assert not list(fixture.root.rglob("*.db*"))
    assert not (fixture.root / ".cairndex/manifest.json").exists()
    complete(fixture)
    library = services.register_existing_library(registry_session, root_path=str(fixture.root))
    assert library.package_format == "cairndex.replica-library"
    ordinary = tmp_path / "ordinary"
    ordinary.mkdir()
    ordinary_library = services.create_library(
        registry_session, root_path=str(ordinary), display_name="Normal"
    )
    assert ordinary_library.package_format == "cairndex.replica-library"
    assert not (ordinary / ".cairndex/library.db").exists()


def test_partial_and_conflict_filename_delivery_waits_for_complete_seed(tmp_path):
    fixture = prepare_disposable(parent=tmp_path)
    descriptor = complete(fixture)
    a = open_store(fixture.root, tmp_path / "first")
    with a.connection() as db:
        artifacts = list(db.execute("SELECT id,raw FROM events"))
    b = CatalogStore(tmp_path / "second", descriptor)
    root = next(row for row in artifacts if row["id"] == descriptor.genesis)
    b.ingest(root["raw"], "provider conflict.json")
    b.import_batch()
    assert not b.status()["ready"]
    for row in reversed(artifacts):
        b.ingest(row["raw"], row["id"] + " (conflicted copy).json")
        b.ingest(row["raw"])
    for _ in range(4):
        b.import_batch()
    assert b.status()["ready"]
    assert b.entities("asset_bundles")["items"] == []


@pytest.mark.parametrize("failure", ["disk-full", "no-hard-links"])
def test_publication_failure_keeps_private_intent_for_retry(tmp_path, monkeypatch, failure):
    fixture = prepare_disposable(parent=tmp_path)
    intent = (fixture.private / "creation.json").read_bytes()
    original = os.link

    def refused(*args, **kwargs):
        raise OSError(
            errno.ENOSPC if failure == "disk-full" else errno.ENOTSUP, "Synthetic failure"
        )

    monkeypatch.setattr(os, "link", refused)
    with pytest.raises(OSError):
        complete(fixture)
    assert not (fixture.root / ".cairndex/manifest.json").exists()
    assert (fixture.private / "creation.json").read_bytes() == intent
    monkeypatch.setattr(os, "link", original)
    descriptor = complete(fixture)
    assert descriptor.genesis == json.loads(intent)["descriptor"]["genesis"]


def test_competing_descriptor_is_never_replaced(tmp_path):
    fixture = prepare_disposable(parent=tmp_path)
    marker = fixture.root / ".cairndex/manifest.json"

    def compete(point):
        if point == "creation_after_manifest_temp":
            marker.write_bytes(b"Synthetic competing creation")

    with pytest.raises(ReplicaError, match="descriptor changed"):
        complete(fixture, fault=compete)
    assert marker.read_bytes() == b"Synthetic competing creation"


def test_changed_seed_before_descriptor_is_not_activated(tmp_path):
    fixture = prepare_disposable(parent=tmp_path)

    def damage(point):
        if point == "creation_before_manifest":
            next((fixture.root / ".cairndex/replica/objects").rglob("*.json")).write_bytes(
                b"partial"
            )

    with pytest.raises(ReplicaError, match="seed changed"):
        complete(fixture, fault=damage)
    assert not (fixture.root / ".cairndex/manifest.json").exists()


@pytest.mark.parametrize(
    "error_number",
    [errno.ENOTSUP, errno.ENOSPC, errno.EACCES],
)
def test_http_creation_storage_failure_preserves_exact_retry(
    tmp_path, isolated_client, monkeypatch, error_number
):
    root = tmp_path / "synthetic-storage"
    root.mkdir()
    source = root / "original.txt"
    source.write_bytes(b"Synthetic source remains unchanged")
    original = os.link

    def refused(*args, **kwargs):
        if kwargs.get("src_dir_fd") is not None:
            raise OSError(error_number, "Synthetic private storage detail")
        return original(*args, **kwargs)

    monkeypatch.setattr(os, "link", refused)
    body = {"root_path": str(root), "display_name": "Synthetic storage"}
    response = isolated_client.post("/api/v1/libraries/create", json=body)
    assert response.status_code == 422, response.text
    message = response.json()["message"]
    assert "Synthetic private storage detail" not in message
    assert str(root) not in message
    if error_number == errno.ENOTSUP:
        assert "exclusive metadata publication" in message
    else:
        assert "Incomplete metadata is retained for review" in message
    assert source.read_bytes() == b"Synthetic source remains unchanged"
    assert not (root / ".cairndex/manifest.json").exists()
    monkeypatch.setattr(os, "link", original)
    response = isolated_client.post("/api/v1/libraries/create", json=body)
    assert response.status_code == 201, response.text
    assert source.read_bytes() == b"Synthetic source remains unchanged"
