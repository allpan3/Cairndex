"""Eagle import executor + API: mapping, idempotency, dry-run vs commit."""

import json
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from cairndex.persistence.models import (
    AssetBundle,
    AssetFile,
    Collection,
    ImportRecord,
    Tag,
    TagGroup,
)
from cairndex.services import eagle as eagle_service


def _library(root: Path) -> Path:
    lib = root / "Lib.library"
    images = lib / "images"
    images.mkdir(parents=True)
    (lib / "metadata.json").write_text(
        json.dumps(
            {
                "folders": [
                    {"id": "f_mov", "name": "Movies", "children": [{"id": "f_24", "name": "2024"}]}
                ],
                "tagsGroups": [{"name": "Genre", "tags": ["action"]}],
            }
        ),
        encoding="utf-8",
    )

    def item(item_id: str, meta: dict) -> None:
        info = images / f"{item_id}.info"
        info.mkdir()
        (info / "metadata.json").write_text(json.dumps({"id": item_id, **meta}), encoding="utf-8")
        (info / f"{meta['name']}.{meta['ext']}").write_bytes(b"data")

    item(
        "IT1",
        {
            "name": "The Matrix",
            "ext": "mp4",
            "tags": ["action", "scifi"],
            "folders": ["f_24"],
            "annotation": "note",
            "url": "magnet:?xt=1",
            "star": 4,
        },
    )
    item("IT2", {"name": "deleted", "ext": "mp4", "isDeleted": True})
    return lib


def test_import_maps_everything_and_is_idempotent(session: Session, tmp_path: Path) -> None:
    lib = _library(tmp_path)
    result = eagle_service.import_library(session, str(lib))
    session.commit()

    assert result.bundles_created == 1  # IT1 only (IT2 deleted)
    assert result.skipped == 1
    assert result.collections_created == 2  # Movies + 2024

    bundle = session.scalar(select(AssetBundle))
    assert bundle is not None
    assert bundle.title == "The Matrix"
    assert bundle.note == "note"
    assert bundle.rating == 4
    assert {t.name for t in bundle.tags} == {"action", "scifi"}
    assert {c.name for c in bundle.collections} == {"2024"}

    f = session.scalar(select(AssetFile))
    assert f is not None
    assert f.relative_path == "IT1.info/The Matrix.mp4"
    assert f.source == "magnet:?xt=1"

    # The "Genre" group exists with the "action" tag.
    group = session.scalar(select(TagGroup).where(TagGroup.name == "Genre"))
    assert group is not None and "action" in {t.name for t in group.tags}

    # Re-importing the same library creates nothing new.
    again = eagle_service.import_library(session, str(lib))
    session.commit()
    assert again.bundles_created == 0
    assert again.collections_created == 0
    assert session.scalar(select(func.count()).select_from(AssetBundle)) == 1
    assert session.scalar(select(func.count()).select_from(ImportRecord)) == 1
    assert session.scalar(select(func.count()).select_from(Collection)) == 2
    assert session.scalar(select(func.count()).select_from(Tag)) == 2


def test_preview_then_import_api(client: TestClient, session: Session, tmp_path: Path) -> None:
    lib = _library(tmp_path)

    preview = client.post("/api/v1/eagle/preview", json={"library_path": str(lib)})
    assert preview.status_code == 200
    body = preview.json()
    assert body["new_bundles"] == 1
    assert body["skipped_deleted"] == 1
    assert body["folders"] == 2

    done = client.post("/api/v1/eagle/import", json={"library_path": str(lib)})
    assert done.status_code == 200
    assert done.json()["bundles_created"] == 1

    # Preview after import reports nothing new to do.
    after = client.post("/api/v1/eagle/preview", json={"library_path": str(lib)}).json()
    assert after["new_bundles"] == 0
    assert after["skipped_existing"] == 1


def test_preview_rejects_bad_path(client: TestClient) -> None:
    r = client.post("/api/v1/eagle/preview", json={"library_path": "/no/such/library"})
    assert r.status_code == 422
