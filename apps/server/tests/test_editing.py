"""Phase 4 editing/organization: file update/reorder, batch ops, tag counts."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.core.errors import ValidationError
from cairndex.domain.enums import FileRole, MediaKind
from cairndex.services import bundles as bundle_service
from cairndex.services import folders as folder_service
from cairndex.services import storage_roots as root_service
from cairndex.services import tags as tag_service
from cairndex.services.browse import tag_counts


def _root(session: Session) -> str:
    return root_service.create_storage_root(session, name="r", canonical_path="/mnt/r").id


def _file(session: Session, bundle_id: str, root_id: str, path: str):
    return bundle_service.add_file(
        session,
        bundle_id,
        storage_root_id=root_id,
        relative_path=path,
        role=FileRole.VIDEO_PART,
        media_kind=MediaKind.VIDEO,
    )


def test_update_file_fields(session: Session) -> None:
    root_id = _root(session)
    bundle = bundle_service.create_bundle(session, title="b")
    f = _file(session, bundle.id, root_id, "a.mp4")
    session.flush()

    updated = bundle_service.update_file(
        session, bundle.id, f.id, {"display_title": "Part 1", "role": FileRole.PRIMARY_VIDEO}
    )
    assert updated.display_title == "Part 1"
    assert updated.role == FileRole.PRIMARY_VIDEO


def test_reorder_files_sets_sequence(session: Session) -> None:
    root_id = _root(session)
    bundle = bundle_service.create_bundle(session, title="b")
    a = _file(session, bundle.id, root_id, "a.mp4")
    b = _file(session, bundle.id, root_id, "b.mp4")
    c = _file(session, bundle.id, root_id, "c.mp4")
    session.flush()

    reordered = bundle_service.reorder_files(session, bundle.id, [c.id, a.id, b.id])
    assert [f.id for f in reordered] == [c.id, a.id, b.id]
    assert [f.sequence for f in reordered] == [0, 1, 2]
    # list_files returns them in the new order.
    assert [f.id for f in bundle_service.list_files(session, bundle.id)] == [c.id, a.id, b.id]


def test_reorder_rejects_mismatched_ids(session: Session) -> None:
    root_id = _root(session)
    bundle = bundle_service.create_bundle(session, title="b")
    a = _file(session, bundle.id, root_id, "a.mp4")
    session.flush()
    with pytest.raises(ValidationError):
        bundle_service.reorder_files(session, bundle.id, [a.id, "nonexistent"])


def test_batch_add_and_remove_tags_and_folders(session: Session) -> None:
    b1 = bundle_service.create_bundle(session, title="b1")
    b2 = bundle_service.create_bundle(session, title="b2")
    tag = tag_service.create_tag(session, name="t")
    folder = folder_service.create_folder(session, name="f")
    session.flush()

    count = bundle_service.batch_update_bundles(
        session, bundle_ids=[b1.id, b2.id], add_tag_ids=[tag.id], add_folder_ids=[folder.id]
    )
    assert count == 2
    session.refresh(b1)
    assert {t.id for t in b1.tags} == {tag.id}
    assert {f.id for f in b1.folders} == {folder.id}

    # Idempotent re-add + a remove.
    bundle_service.batch_update_bundles(
        session, bundle_ids=[b1.id], add_tag_ids=[tag.id], remove_folder_ids=[folder.id]
    )
    session.refresh(b1)
    assert {t.id for t in b1.tags} == {tag.id}  # still one, not duplicated
    assert b1.folders == []


def test_tag_counts(session: Session) -> None:
    tag = tag_service.create_tag(session, name="t")
    unused = tag_service.create_tag(session, name="u")
    bundle = bundle_service.create_bundle(session, title="b")
    bundle_service.set_bundle_tags(session, bundle.id, [tag.id])
    session.commit()

    counts = tag_counts(session)
    assert counts[tag.id] == 1
    assert counts[unused.id] == 0


def test_editing_routes_and_ordering(client: TestClient) -> None:
    # /bundles/batch is not shadowed by /{bundle_id}; tag /counts works.
    b1 = client.post("/api/v1/bundles", json={"title": "b1"}).json()["id"]
    tag = client.post("/api/v1/tags", json={"name": "t"}).json()["id"]

    batch = client.post("/api/v1/bundles/batch", json={"bundle_ids": [b1], "add_tag_ids": [tag]})
    assert batch.status_code == 200
    assert batch.json()["updated"] == 1

    counts = client.get("/api/v1/tags/counts")
    assert counts.status_code == 200
    assert counts.json()["counts"][tag] == 1
