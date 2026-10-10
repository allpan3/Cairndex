"""Portable libraries refuse source writes until their separate group is extracted."""

from pathlib import Path

import pytest
from sqlalchemy import Engine, inspect, text

from cairndex.core.config import get_settings
from cairndex.registry.engine import create_registry_engine
from tests.test_library_scoped import create


def test_portable_source_writes_are_unavailable(isolated_client, tmp_path):
    root = tmp_path / "library"
    identity, _ = create(isolated_client, root)
    source = root / "example.txt"
    source.write_bytes(b"Synthetic source")
    base = f"/api/v1/libraries/{identity}"
    assert isolated_client.put(base + "/write-mode", json={"enabled": True}).status_code == 409
    for operation, body in (
        ("rename", {"path": "example.txt", "new_name": "changed.txt"}),
        ("mkdir", {"path": "New directory"}),
        ("move", {"paths": ["example.txt"], "destination": "elsewhere"}),
    ):
        response = isolated_client.post(base + "/file-ops/" + operation, json=body)
        assert response.status_code == 409, response.text
    assert source.read_bytes() == b"Synthetic source"
    assert not (root / "changed.txt").exists()
    assert not (root / "New directory").exists()


def test_invalid_deployment_switch_is_rejected_at_startup() -> None:
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("CAIRNDEX_WRITE_MODE", "sure-why-not")
        get_settings.cache_clear()
        try:
            with pytest.raises(ValueError):
                get_settings()
        finally:
            get_settings.cache_clear()


def test_existing_registries_gain_the_write_mode_column(tmp_path: Path) -> None:
    """A registry created before ADR-0013 must come back read-only, not broken."""
    url = f"sqlite:///{(tmp_path / 'registry.db').as_posix()}"
    engine: Engine = create_registry_engine(database_url=url)
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE registered_libraries DROP COLUMN write_mode_enabled"))
        conn.execute(
            text(
                "INSERT INTO registered_libraries "
                "(id, library_uuid, name, root_path, manifest_path, status, schema_version, "
                " created_at, updated_at) "
                "VALUES ('01LEGACY', '01LEGACYUUID', 'Legacy', '/tmp/legacy', "
                "        '/tmp/legacy/.cairndex/manifest.json', 'available', 1, "
                "        '2026-01-01T00:00:00', '2026-01-01T00:00:00')"
            )
        )
    engine.dispose()

    reopened = create_registry_engine(database_url=url)
    try:
        columns = {c["name"] for c in inspect(reopened).get_columns("registered_libraries")}
        assert "write_mode_enabled" in columns
        with reopened.connect() as conn:
            stored = conn.execute(
                text("SELECT write_mode_enabled FROM registered_libraries WHERE id = '01LEGACY'")
            ).scalar()
        assert not stored
    finally:
        reopened.dispose()
