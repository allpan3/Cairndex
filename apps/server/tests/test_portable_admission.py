"""Normal creation and admission have one supported storage format."""

import pytest

from cairndex.core.config import get_settings
from cairndex.registry import library_package as pkg
from cairndex.registry import services
from cairndex.replicas.catalog import creation
from cairndex.replicas.protocol import ReplicaError


def test_normal_creation_preserves_source_files_and_retries(registry_session, tmp_path):
    root = tmp_path / "normal"
    root.mkdir()
    source = root / "example.txt"
    source.write_bytes(b"synthetic source")
    first = services.create_library(registry_session, root_path=str(root), display_name="Example")
    second = services.create_library(registry_session, root_path=str(root), display_name="Example")
    assert second.id == first.id
    assert first.package_format == "cairndex.replica-library"
    assert pkg.read_manifest(root).format_version == 3
    assert source.read_bytes() == b"synthetic source"
    assert not list(root.rglob("*.db*"))


def test_normal_creation_resumes_exact_intent_after_interruption(
    registry_session, tmp_path, monkeypatch
):
    root = tmp_path / "normal"
    root.mkdir()
    complete = creation.complete

    def interrupted(target):
        def fault(stage):
            if stage == "creation_before_manifest":
                raise OSError("synthetic interruption")

        return complete(target, fault=fault)

    monkeypatch.setattr(creation, "complete", interrupted)
    with pytest.raises(OSError):
        services.create_library(registry_session, root_path=str(root), display_name="Example")
    intents = list((get_settings().data_dir / "library-creations").glob("*/creation.json"))
    intent = next(
        path
        for path in intents
        if creation.CreationIntent.model_validate_json(path.read_bytes()).root_identity
        == [root.stat().st_dev, root.stat().st_ino]
    )
    original = intent.read_bytes()
    monkeypatch.setattr(creation, "complete", complete)
    result = services.create_library(registry_session, root_path=str(root), display_name="Example")
    assert intent.read_bytes() == original
    assert (
        result.library_uuid
        == creation.CreationIntent.model_validate_json(original).descriptor.library_uuid
    )


def test_legacy_open_and_create_are_refused_without_changes(isolated_client, tmp_path):
    root = tmp_path / "old"
    root.mkdir()
    pkg.create_package(root, "Synthetic old library")
    original = {
        path.relative_to(root): path.read_bytes() for path in root.rglob("*") if path.is_file()
    }
    result = isolated_client.post("/api/v1/libraries/register", json={"root_path": str(root)})
    assert result.status_code == 409
    assert "Legacy library format is not supported" in result.json()["message"]
    result = isolated_client.post(
        "/api/v1/libraries/create", json={"root_path": str(root), "display_name": "Example"}
    )
    assert result.status_code == 409
    assert original == {
        path.relative_to(root): path.read_bytes() for path in root.rglob("*") if path.is_file()
    }


def test_existing_marker_without_creation_intent_cannot_be_adopted(registry_session, tmp_path):
    root = tmp_path / "incomplete"
    (root / ".cairndex").mkdir(parents=True)
    with pytest.raises(ReplicaError, match="cannot be overwritten"):
        services.create_library(registry_session, root_path=str(root), display_name="Example")
    assert not list((root / ".cairndex").iterdir())


def test_old_registry_rows_cannot_bypass_format_admission(
    isolated_client, registry_session, tmp_path
):
    root = tmp_path / "old-registered"
    root.mkdir()
    manifest = pkg.create_package(root, "Old fixture")
    library = services._insert(registry_session, manifest=manifest, root=root)
    registry_session.commit()
    base = "/api/v1/libraries/" + library.id
    before = {
        path.relative_to(root): path.read_bytes() for path in root.rglob("*") if path.is_file()
    }
    for suffix in (
        "/replica/status",
        "/bundles/browse",
        "/auth/status",
        "/ownership",
        "/write-mode",
        "/files/example/content",
        "/private-recovery/tasks",
    ):
        response = isolated_client.get(base + suffix)
        assert response.status_code == 409, (suffix, response.text)
        assert "Legacy library format is not supported" in response.json()["message"]
    assert isolated_client.put(base + "/write-mode", json={"enabled": True}).status_code == 409
    assert isolated_client.post(base + "/ownership/reopen").status_code == 409
    assert before == {
        path.relative_to(root): path.read_bytes() for path in root.rglob("*") if path.is_file()
    }
    assert isolated_client.delete(base).status_code == 204
    assert (root / ".cairndex/library.db").is_file()
