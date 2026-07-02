"""Tag/collection hierarchy + tag-group membership (AGENTS.md §15)."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, ValidationError
from cairndex.persistence.models import AssetBundle, AssetFile, Collection, Tag
from cairndex.services import bundles as bundle_service
from cairndex.services import collections as collection_service
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


def test_deleting_parent_with_children_is_blocked(session: Session) -> None:
    # First-version safe delete: a tag with child tags cannot be deleted (no
    # cascade); the owner must move/delete the children first.
    parent = tag_service.create_tag(session, name="parent")
    child = tag_service.create_tag(session, name="child", parent_id=parent.id)
    with pytest.raises(ConflictError):
        tag_service.delete_tag(session, parent.id)

    session.expire_all()
    assert session.get(Tag, parent.id) is not None  # still there
    assert session.get(Tag, child.id) is not None


def test_deleting_leaf_tag_removes_assignments(session: Session) -> None:
    tag = tag_service.create_tag(session, name="leaf")
    bundle = bundle_service.create_bundle(session, title="b")
    bundle_service.set_bundle_tags(session, bundle.id, [tag.id])
    session.commit()

    tag_service.delete_tag(session, tag.id)
    session.expire_all()
    assert session.get(Tag, tag.id) is None
    # The bundle survives (metadata-only) with its tag assignment gone (FK cascade).
    reloaded = bundle_service.get_bundle(session, bundle.id)
    assert [t.id for t in reloaded.tags] == []


def test_reparent_moves_tag_under_new_parent(session: Session) -> None:
    # The All Tags page reparents by drag (via update_tag); reordering siblings is
    # no longer a thing (the tree is name-ordered).
    a = tag_service.create_tag(session, name="a")
    b = tag_service.create_tag(session, name="b")
    tag_service.update_tag(session, b.id, parent_id=a.id, set_parent=True)
    session.expire_all()
    assert session.get(Tag, b.id).parent_id == a.id


# --- Collection hierarchy ----------------------------------------------------
def test_collection_descendants_and_cycle_guard(session: Session) -> None:
    root = collection_service.create_collection(session, name="root")
    sub = collection_service.create_collection(session, name="sub", parent_id=root.id)
    leaf = collection_service.create_collection(session, name="leaf", parent_id=sub.id)

    assert set(collection_service.collection_descendant_ids(session, root.id)) == {
        root.id,
        sub.id,
        leaf.id,
    }
    with pytest.raises(ValidationError):
        collection_service.update_collection(session, root.id, parent_id=leaf.id, set_parent=True)


def test_new_collection_appends_after_siblings_in_manual_order(session: Session) -> None:
    a = collection_service.create_collection(session, name="a")
    b = collection_service.create_collection(session, name="b")
    c = collection_service.create_collection(session, name="c")
    # Each top-level collection appends after the previous one.
    assert [a.sort_order, b.sort_order, c.sort_order] == [0, 1, 2]
    # Nested collections have their own per-parent order sequence.
    child1 = collection_service.create_collection(session, name="c1", parent_id=a.id)
    child2 = collection_service.create_collection(session, name="c2", parent_id=a.id)
    assert [child1.sort_order, child2.sort_order] == [0, 1]


def test_reorder_collections_rewrites_one_sibling_group(session: Session) -> None:
    a = collection_service.create_collection(session, name="a")
    b = collection_service.create_collection(session, name="b")
    c = collection_service.create_collection(session, name="c")

    collection_service.reorder_collections(session, parent_id=None, ordered_ids=[c.id, a.id, b.id])
    assert [c.sort_order, a.sort_order, b.sort_order] == [0, 1, 2]

    # A partial or cross-parent list is rejected so the order stays well-defined.
    with pytest.raises(ValidationError):
        collection_service.reorder_collections(session, parent_id=None, ordered_ids=[c.id, a.id])


def test_cleanup_collection_order_sorts_every_sibling_group_by_name(session: Session) -> None:
    root = collection_service.create_collection(session, name="root")
    # Deliberately create children out of alphabetical order.
    charlie = collection_service.create_collection(session, name="charlie", parent_id=root.id)
    alpha = collection_service.create_collection(session, name="alpha", parent_id=root.id)
    bravo = collection_service.create_collection(session, name="bravo", parent_id=root.id)

    collection_service.cleanup_collection_order(session)
    assert [alpha.sort_order, bravo.sort_order, charlie.sort_order] == [0, 1, 2]

    collection_service.cleanup_collection_order(session, descending=True)
    assert [charlie.sort_order, bravo.sort_order, alpha.sort_order] == [0, 1, 2]


def test_deleting_collection_floats_children_by_default(session: Session) -> None:
    root = collection_service.create_collection(session, name="root")
    sub = collection_service.create_collection(session, name="sub", parent_id=root.id)

    collection_service.delete_collection(session, root.id)
    session.expire_all()

    assert session.get(Collection, root.id) is None
    reloaded = session.get(Collection, sub.id)
    assert reloaded is not None  # child survives, floated to the root
    assert reloaded.parent_id is None


def test_deleting_collection_cascade_removes_subtree_but_keeps_bundles(session: Session) -> None:
    root = collection_service.create_collection(session, name="root")
    sub = collection_service.create_collection(session, name="sub", parent_id=root.id)
    leaf = collection_service.create_collection(session, name="leaf", parent_id=sub.id)
    bundle = bundle_service.create_bundle(session, title="kept")
    bundle_service.set_bundle_collections(session, bundle.id, [leaf.id])

    collection_service.delete_collection(session, root.id, cascade=True)
    session.expire_all()

    # The whole subtree is gone…
    assert session.get(Collection, root.id) is None
    assert session.get(Collection, sub.id) is None
    assert session.get(Collection, leaf.id) is None
    # …but the bundle is metadata-only removed from the collection, not deleted.
    assert session.get(AssetBundle, bundle.id) is not None


def test_collection_note_is_editable_and_clearable(session: Session) -> None:
    c = collection_service.create_collection(session, name="c")
    assert c.note is None
    collection_service.update_collection(session, c.id, note="a folder note", set_note=True)
    session.expire_all()
    assert session.get(Collection, c.id).note == "a folder note"
    # Whitespace-only note clears back to NULL.
    collection_service.update_collection(session, c.id, note="   ", set_note=True)
    session.expire_all()
    assert session.get(Collection, c.id).note is None


def test_collection_stats_count_direct_leaf_bundles_and_subcollections(session: Session) -> None:
    root = collection_service.create_collection(session, name="root")
    sub_a = collection_service.create_collection(session, name="a", parent_id=root.id)
    sub_b = collection_service.create_collection(session, name="b", parent_id=root.id)
    collection_service.create_collection(session, name="a1", parent_id=sub_a.id)

    b_direct = bundle_service.create_bundle(session, title="direct")
    bundle_service.set_bundle_collections(session, b_direct.id, [root.id])
    b_nested = bundle_service.create_bundle(session, title="nested")
    bundle_service.set_bundle_collections(session, b_nested.id, [sub_a.id])
    # A bundle in two subcollections must be counted once for total_bundles.
    b_shared = bundle_service.create_bundle(session, title="shared")
    bundle_service.set_bundle_collections(session, b_shared.id, [sub_a.id, sub_b.id])

    stats = collection_service.collection_stats(session, root.id)
    assert stats.direct_bundles == 1  # only b_direct is directly in root
    assert stats.total_bundles == 3  # direct + nested + shared (distinct across subtree)
    assert stats.subcollections == 2  # sub_a, sub_b (direct children only)


def test_collection_cover_prefers_chosen_bundle_then_auto_picks(session: Session) -> None:
    from cairndex.domain.enums import FileRole, MediaKind

    root = collection_service.create_collection(session, name="root")
    sub = collection_service.create_collection(session, name="sub", parent_id=root.id)

    # A bundle with a thumbnailable file, nested in a subcollection.
    nested = bundle_service.create_bundle(session, title="nested")
    session.add(
        AssetFile(
            bundle_id=nested.id,
            relative_path="a.jpg",
            original_filename="a.jpg",
            display_title="a.jpg",
            role=FileRole.OTHER,
            media_kind=MediaKind.IMAGE,
        )
    )
    bundle_service.set_bundle_collections(session, nested.id, [sub.id])
    session.flush()

    # No explicit cover → auto-picks the nested bundle from the subtree.
    assert collection_service.resolve_cover_bundle_id(session, root.id) == nested.id

    # An explicit, valid cover wins.
    chosen = bundle_service.create_bundle(session, title="chosen")
    bundle_service.set_bundle_collections(session, chosen.id, [root.id])
    collection_service.update_collection(
        session, root.id, cover_bundle_id=chosen.id, set_cover=True
    )
    assert collection_service.resolve_cover_bundle_id(session, root.id) == chosen.id

    # A stale cover (bundle deleted) falls back to auto-pick.
    bundle_service.delete_bundle(session, chosen.id)
    session.expire_all()
    assert collection_service.resolve_cover_bundle_id(session, root.id) == nested.id


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


def test_group_membership_lists_in_assigned_order(session: Session) -> None:
    group = group_service.create_tag_group(session, name="G")
    a = tag_service.create_tag(session, name="a")
    b = tag_service.create_tag(session, name="b")
    # set_group_tags stamps membership sort_order from the given order, and
    # list_group_tag_ids returns it in that order.
    group_service.set_group_tags(session, group.id, [b.id, a.id])
    session.commit()
    assert group_service.list_group_tag_ids(session, group.id) == [b.id, a.id]


# --- API smoke ---------------------------------------------------------------
def test_tag_and_group_api_flow(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    parent = client.post(f"{base}/tags", json={"name": "genre"}).json()
    child = client.post(f"{base}/tags", json={"name": "thriller", "parent_id": parent["id"]}).json()
    assert child["parent_id"] == parent["id"]

    group = client.post(f"{base}/tag-groups", json={"name": "Genre"}).json()
    put = client.put(f"{base}/tag-groups/{group['id']}/tags", json={"tag_ids": [child["id"]]})
    assert put.status_code == 200
    assert put.json()["tag_ids"] == [child["id"]]

    listed = client.get(f"{base}/tags").json()
    assert {t["id"] for t in listed["items"]} == {parent["id"], child["id"]}


def test_tag_reparent_and_safe_delete_api(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    parent = client.post(f"{base}/tags", json={"name": "parent"}).json()
    a = client.post(f"{base}/tags", json={"name": "a"}).json()

    # Reparent "a" under "parent" via PATCH (the All Tags drag gesture).
    r = client.patch(f"{base}/tags/{a['id']}", json={"parent_id": parent["id"]})
    assert r.status_code == 200
    assert r.json()["parent_id"] == parent["id"]

    # Deleting the parent (now has a child) is blocked with 409.
    assert client.delete(f"{base}/tags/{parent['id']}").status_code == 409

    # A leaf tag deletes fine.
    assert client.delete(f"{base}/tags/{a['id']}").status_code == 204
