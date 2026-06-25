"""Tag/folder hierarchy + tag-group membership (AGENTS.md §15)."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, ValidationError
from cairndex.persistence.models import Tag
from cairndex.services import folders as folder_service
from cairndex.services import tag_groups as group_service
from cairndex.services import tags as tag_service


# --- Tag hierarchy -----------------------------------------------------------
def test_descendant_ids_walk_the_subtree(session: Session) -> None:
    genre = tag_service.create_tag(session, name="genre")
    thriller = tag_service.create_tag(session, name="thriller", parent_id=genre.id)
    psych = tag_service.create_tag(session, name="psychological", parent_id=thriller.id)
    tag_service.create_tag(session, name="unrelated")

    with_self = set(tag_service.tag_descendant_ids(session, genre.id))
    assert with_self == {genre.id, thriller.id, psych.id}

    without_self = set(tag_service.tag_descendant_ids(session, genre.id, include_self=False))
    assert without_self == {thriller.id, psych.id}


def test_reparent_into_own_descendant_is_rejected(session: Session) -> None:
    a = tag_service.create_tag(session, name="a")
    b = tag_service.create_tag(session, name="b", parent_id=a.id)
    # Moving 'a' under its child 'b' would create a cycle.
    with pytest.raises(ValidationError):
        tag_service.update_tag(session, a.id, parent_id=b.id, set_parent=True)


def test_sibling_name_conflict(session: Session) -> None:
    parent = tag_service.create_tag(session, name="p")
    tag_service.create_tag(session, name="dup", parent_id=parent.id)
    with pytest.raises(ConflictError):
        tag_service.create_tag(session, name="dup", parent_id=parent.id)


def test_deleting_parent_floats_children_to_root(session: Session) -> None:
    parent = tag_service.create_tag(session, name="parent")
    child = tag_service.create_tag(session, name="child", parent_id=parent.id)
    tag_service.delete_tag(session, parent.id)
    session.expire_all()

    reloaded = session.get(Tag, child.id)
    assert reloaded is not None
    assert reloaded.parent_id is None  # SET NULL, child survives


# --- Folder hierarchy --------------------------------------------------------
def test_folder_descendants_and_cycle_guard(session: Session) -> None:
    root = folder_service.create_folder(session, name="root")
    sub = folder_service.create_folder(session, name="sub", parent_id=root.id)
    leaf = folder_service.create_folder(session, name="leaf", parent_id=sub.id)

    assert set(folder_service.folder_descendant_ids(session, root.id)) == {
        root.id,
        sub.id,
        leaf.id,
    }
    with pytest.raises(ValidationError):
        folder_service.update_folder(session, root.id, parent_id=leaf.id, set_parent=True)


# --- Tag groups (many-to-many, independent of hierarchy) ---------------------
def test_tag_belongs_to_multiple_groups_without_changing_hierarchy(session: Session) -> None:
    parent = tag_service.create_tag(session, name="genre")
    tag = tag_service.create_tag(session, name="thriller", parent_id=parent.id)
    g1 = group_service.create_tag_group(session, name="Genre")
    g2 = group_service.create_tag_group(session, name="Mood")

    group_service.set_group_tags(session, g1.id, [tag.id])
    group_service.set_group_tags(session, g2.id, [tag.id])
    session.expire_all()

    reloaded = session.get(Tag, tag.id)
    assert reloaded is not None
    assert {g.id for g in reloaded.groups} == {g1.id, g2.id}
    # Group membership must not alter the semantic parent.
    assert reloaded.parent_id == parent.id


def test_set_group_tags_replaces_membership(session: Session) -> None:
    group = group_service.create_tag_group(session, name="G")
    a = tag_service.create_tag(session, name="a")
    b = tag_service.create_tag(session, name="b")

    group_service.set_group_tags(session, group.id, [a.id])
    group_service.set_group_tags(session, group.id, [b.id])
    session.expire_all()
    assert {t.id for t in group_service.get_tag_group(session, group.id).tags} == {b.id}


def test_set_group_tags_rejects_unknown_tag(session: Session) -> None:
    group = group_service.create_tag_group(session, name="G")
    with pytest.raises(ValidationError):
        group_service.set_group_tags(session, group.id, ["nope"])


# --- API smoke ---------------------------------------------------------------
def test_tag_and_group_api_flow(client: TestClient) -> None:
    parent = client.post("/api/v1/tags", json={"name": "genre"}).json()
    child = client.post("/api/v1/tags", json={"name": "thriller", "parent_id": parent["id"]}).json()
    assert child["parent_id"] == parent["id"]

    group = client.post("/api/v1/tag-groups", json={"name": "Genre"}).json()
    put = client.put(f"/api/v1/tag-groups/{group['id']}/tags", json={"tag_ids": [child["id"]]})
    assert put.status_code == 200
    assert put.json()["tag_ids"] == [child["id"]]

    listed = client.get("/api/v1/tags").json()
    assert {t["id"] for t in listed["items"]} == {parent["id"], child["id"]}
