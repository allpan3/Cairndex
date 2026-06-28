"""Phase 4 editing/organization: file update/reorder, batch ops, tag counts."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.core.errors import ValidationError
from cairndex.domain.enums import FileRole, MediaKind
from cairndex.persistence.models import AssetFile
from cairndex.services import bundles as bundle_service
from cairndex.services import collections as collection_service
from cairndex.services import tags as tag_service
from cairndex.services.browse import tag_counts


def _file(session: Session, bundle_id: str, path: str) -> AssetFile:
    return bundle_service.add_file(
        session,
        bundle_id,
        relative_path=path,
        role=FileRole.VIDEO_PART,
        media_kind=MediaKind.VIDEO,
    )


def test_update_file_fields(session: Session) -> None:
    bundle = bundle_service.create_bundle(session, title="b")
    f = _file(session, bundle.id, "a.mp4")
    session.flush()

    updated = bundle_service.update_file(
        session, bundle.id, f.id, {"display_title": "Part 1", "role": FileRole.PRIMARY_VIDEO}
    )
    assert updated.display_title == "Part 1"
    assert updated.role == FileRole.PRIMARY_VIDEO


def test_reorder_files_sets_sequence(session: Session) -> None:
    bundle = bundle_service.create_bundle(session, title="b")
    a = _file(session, bundle.id, "a.mp4")
    b = _file(session, bundle.id, "b.mp4")
    c = _file(session, bundle.id, "c.mp4")
    session.flush()

    reordered = bundle_service.reorder_files(session, bundle.id, [c.id, a.id, b.id])
    assert [f.id for f in reordered] == [c.id, a.id, b.id]
    assert [f.sequence for f in reordered] == [0, 1, 2]
    assert [f.id for f in bundle_service.list_files(session, bundle.id)] == [c.id, a.id, b.id]


def test_reorder_rejects_mismatched_ids(session: Session) -> None:
    bundle = bundle_service.create_bundle(session, title="b")
    a = _file(session, bundle.id, "a.mp4")
    session.flush()
    with pytest.raises(ValidationError):
        bundle_service.reorder_files(session, bundle.id, [a.id, "nonexistent"])


def test_batch_add_and_remove_tags_and_collections(session: Session) -> None:
    b1 = bundle_service.create_bundle(session, title="b1")
    b2 = bundle_service.create_bundle(session, title="b2")
    tag = tag_service.create_tag(session, name="t")
    collection = collection_service.create_collection(session, name="c")
    session.flush()

    count = bundle_service.batch_update_bundles(
        session,
        bundle_ids=[b1.id, b2.id],
        add_tag_ids=[tag.id],
        add_collection_ids=[collection.id],
    )
    assert count == 2
    session.refresh(b1)
    assert {t.id for t in b1.tags} == {tag.id}
    assert {c.id for c in b1.collections} == {collection.id}

    bundle_service.batch_update_bundles(
        session, bundle_ids=[b1.id], add_tag_ids=[tag.id], remove_collection_ids=[collection.id]
    )
    session.refresh(b1)
    assert {t.id for t in b1.tags} == {tag.id}
    assert b1.collections == []


def test_tag_counts(session: Session) -> None:
    tag = tag_service.create_tag(session, name="t")
    unused = tag_service.create_tag(session, name="u")
    bundle = bundle_service.create_bundle(session, title="b")
    bundle_service.set_bundle_tags(session, bundle.id, [tag.id])
    session.commit()

    counts = tag_counts(session)
    assert counts[tag.id] == 1
    assert counts[unused.id] == 0


def test_editing_routes_and_ordering(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    b1 = client.post(f"{base}/bundles", json={"title": "b1"}).json()["id"]
    tag = client.post(f"{base}/tags", json={"name": "t"}).json()["id"]

    batch = client.post(f"{base}/bundles/batch", json={"bundle_ids": [b1], "add_tag_ids": [tag]})
    assert batch.status_code == 200
    assert batch.json()["updated"] == 1

    counts = client.get(f"{base}/tags/counts")
    assert counts.status_code == 200
    assert counts.json()["counts"][tag] == 1
