"""Shared-authority protection exercised through independent real library sessions"""

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from cairndex.metadata.session import begin_edit, read_basis
from cairndex.persistence.models import AssetBundle
from cairndex.services.bundles import create_bundle, update_bundle


# Retain the read basis explicitly rather than fetching a new one while saving
def basis(client: TestClient, library_id: str) -> str:
    response = client.get(f"/api/v1/libraries/{library_id}/metadata")
    assert response.status_code == 200, response.text
    return response.json()["basis"]


# Distinct operations get identities; exact retries retain the original headers
def headers(read: str) -> dict[str, str]:
    return {"X-Cairndex-Basis": read, "X-Cairndex-Operation": uuid4().hex}


# Missing edit context cannot silently overwrite current content
def test_legacy_client_requires_upgrade(raw_client: TestClient, library_id: str) -> None:
    response = raw_client.post(f"/api/v1/libraries/{library_id}/bundles", json={"title": "Amber"})
    assert response.status_code == 428, response.text
    assert response.json()["code"] == "edit_precondition_required"


# Different fields save independently while stale same-field drafts remain rejected
def test_fields_and_retry(raw_client: TestClient, library_id: str) -> None:
    client = raw_client
    base = f"/api/v1/libraries/{library_id}/bundles"
    created = client.post(base, json={"title": "Amber"}, headers=headers(basis(client, library_id)))
    assert created.status_code == 201, created.text
    url = f"{base}/{created.json()['id']}"
    read = created.headers["X-Cairndex-Basis"]
    first_headers = headers(read)
    first = client.patch(url, json={"title": "Blue"}, headers=first_headers)
    assert first.status_code == 200, first.text
    independent = client.patch(url, json={"notes": ["A note"]}, headers=headers(read))
    assert independent.status_code == 200, independent.text
    stale = client.patch(url, json={"title": "Green"}, headers=headers(read))
    assert stale.status_code == 409, stale.text
    assert stale.json()["details"]["current"] == "Blue"
    assert stale.json()["details"]["proposed"] == "Green"
    repeated = client.patch(url, json={"title": "Blue"}, headers=first_headers)
    assert repeated.status_code == 200, repeated.text
    assert repeated.content == first.content
    final = client.get(url).json()
    assert final["title"] == "Blue"
    assert final["notes"] == ["A note"]


# A choice acknowledges only the shown field; another arrival invalidates that choice
def test_review_is_exact_and_does_not_authorize_other_fields(
    raw_client: TestClient, library_id: str
) -> None:
    client = raw_client
    base = f"/api/v1/libraries/{library_id}/bundles"
    created = client.post(base, json={"title": "Amber"}, headers=headers(basis(client, library_id)))
    url = f"{base}/{created.json()['id']}"
    read = created.headers["X-Cairndex-Basis"]
    client.patch(url, json={"title": "Blue"}, headers=headers(read))
    stale = client.patch(url, json={"title": "Green"}, headers=headers(read))
    conflict = stale.json()["details"]
    reviewed = {conflict["unit"]: conflict["revision"]}
    client.patch(url, json={"title": "Violet"}, headers=headers(basis(client, library_id)))
    choice = client.patch(
        url,
        json={"title": "Green"},
        headers={
            **headers(read),
            "X-Cairndex-Review": json.dumps(reviewed),
        },
    )
    assert choice.status_code == 409
    assert choice.json()["details"]["current"] == "Violet"
    conflict = choice.json()["details"]
    reviewed[conflict["unit"]] = conflict["revision"]
    client.patch(url, json={"notes": ["New note"]}, headers=headers(basis(client, library_id)))
    both = client.patch(
        url,
        json={"title": "Green", "notes": ["Draft note"]},
        headers={
            **headers(read),
            "X-Cairndex-Review": json.dumps(reviewed),
        },
    )
    assert both.status_code == 409
    assert both.json()["details"]["unit"].endswith("/notes")
    assert client.get(url).json()["title"] == "Violet"
    accepted = client.patch(
        url,
        json={"title": "Green"},
        headers={
            **headers(read),
            "X-Cairndex-Review": json.dumps(reviewed),
        },
    )
    assert accepted.status_code == 200
    assert client.get(url).json()["notes"] == ["New note"]


# Additions preserve independent edges, while stale replacement cannot erase a new membership
def test_membership_and_delete_races(raw_client: TestClient, library_id: str) -> None:
    client = raw_client
    base = f"/api/v1/libraries/{library_id}"
    bundle = client.post(
        f"{base}/bundles", json={"title": "Amber"}, headers=headers(basis(client, library_id))
    ).json()
    tag_ids = [
        client.post(
            f"{base}/tags", json={"name": name}, headers=headers(basis(client, library_id))
        ).json()["id"]
        for name in ("Blue", "Green")
    ]
    read = basis(client, library_id)
    for tag_id in tag_ids:
        addition = client.post(
            f"{base}/bundles/batch",
            json={"bundle_ids": [bundle["id"]], "add_tag_ids": [tag_id]},
            headers=headers(read),
        )
        assert addition.status_code == 200, addition.text
    stale = client.put(
        f"{base}/bundles/{bundle['id']}/tags", json={"ids": []}, headers=headers(read)
    )
    assert stale.status_code == 409, stale.text
    assert set(client.get(f"{base}/bundles/{bundle['id']}/tags").json()["tag_ids"]) == set(tag_ids)
    stale_delete = client.delete(f"{base}/bundles/{bundle['id']}", headers=headers(read))
    assert stale_delete.status_code == 409, stale_delete.text
    tag_read = basis(client, library_id)
    client.patch(f"{base}/tags/{tag_ids[0]}", json={"color": "#123456"}, headers=headers(tag_read))
    deleted = client.delete(f"{base}/tags/{tag_ids[0]}", headers=headers(tag_read))
    assert deleted.status_code == 409, deleted.text


# Both independent SQLite transactions reach the writer reservation together
@pytest.mark.parametrize("disjoint", [False, True])
def test_actual_concurrent_transactions(engine: Engine, disjoint: bool) -> None:
    with Session(engine) as initial:
        row = create_bundle(initial, title="Amber")
        identity = row.id
        initial.commit()
        opening = read_basis(initial.connection())
    barrier = Barrier(2)

    def edit(index: int) -> str:
        with Session(engine) as db:
            barrier.wait(timeout=5)
            context, _ = begin_edit(
                db,
                basis=opening,
                operation=uuid4().hex,
                review=None,
                method="PATCH",
                path="synthetic",
                body=b"{}",
            )
            try:
                patch = {"notes": ["Independent"]} if disjoint and index else {"title": str(index)}
                update_bundle(db, identity, patch)
                db.commit()
                return "saved"
            except DBAPIError:
                assert context.conflict is not None
                db.rollback()
                return "conflict"

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(edit, range(2)))
    assert results.count("saved") == (2 if disjoint else 1)
    with Session(engine) as check:
        stored = check.get(AssetBundle, identity)
        assert stored is not None
        if disjoint:
            assert stored.title == "0"
            assert stored.notes == ["Independent"]
        else:
            assert stored.title in ("0", "1")


# A later failure rolls back earlier rows and never records a successful bulk receipt
def test_bulk_partial_failure_is_atomic(raw_client: TestClient, library_id: str) -> None:
    client = raw_client
    base = f"/api/v1/libraries/{library_id}/bundles"
    ids = []
    for title in ("Amber", "Blue"):
        result = client.post(
            base, json={"title": title}, headers=headers(basis(client, library_id))
        )
        ids.append(result.json()["id"])
    opening = basis(client, library_id)
    client.patch(f"{base}/{ids[1]}", json={"title": "Elsewhere"}, headers=headers(opening))
    attempted = client.post(
        f"{base}/batch-edit",
        json={"bundle_ids": ids, "patch": {"title": "Draft"}},
        headers=headers(opening),
    )
    assert attempted.status_code == 409, attempted.text
    assert client.get(f"{base}/{ids[0]}").json()["title"] == "Amber"
    assert client.get(f"{base}/{ids[1]}").json()["title"] == "Elsewhere"


# Intermediate writes in a transaction cannot hide an earlier unseen change from deletion checks
def test_edit_then_delete_cannot_mask_prior_conflict(engine: Engine) -> None:
    with Session(engine) as db:
        row = create_bundle(db, title="Amber")
        identity = row.id
        db.commit()
        opening = read_basis(db.connection())
        update_bundle(db, identity, {"notes": ["Other client"]})
        db.commit()
    with Session(engine) as db:
        context, _ = begin_edit(
            db,
            basis=opening,
            operation=uuid4().hex,
            review=None,
            method="DELETE",
            path="synthetic",
            body=b"{}",
        )
        row = update_bundle(db, identity, {"title": "Local"})
        db.delete(row)
        with pytest.raises(DBAPIError):
            db.flush()
        assert context.conflict is not None
        db.rollback()


# Add/remove checkboxes preserve independent edges even when a tag was just created elsewhere
@pytest.mark.parametrize(
    "family,edge,key",
    [("tags", "tags", "tag_ids"), ("collections", "collections", "collection_ids")],
)
def test_delta_memberships(raw_client, library_id, family, edge, key):
    client = raw_client
    base = f"/api/v1/libraries/{library_id}"
    created = client.post(
        f"{base}/bundles", json={"title": "Amber"}, headers=headers(basis(client, library_id))
    )
    url = f"{base}/bundles/{created.json()['id']}/{edge}"
    opening = basis(client, library_id)
    identities = [
        client.post(f"{base}/{family}", json={"name": name}, headers=headers(opening)).json()["id"]
        for name in ("Aster", "Birch")
    ]
    for identity in identities:
        response = client.post(url, json={"add_ids": [identity]}, headers=headers(opening))
        assert response.status_code == 200, response.text
    assert set(client.get(url).json()[key]) == set(identities)
    opening = basis(client, library_id)
    for identity in identities:
        response = client.post(url, json={"remove_ids": [identity]}, headers=headers(opening))
        assert response.status_code == 200, response.text
    assert client.get(url).json()[key] == []


# A plan restart cannot strand main-database drafts or duplicate a previously committed create
def test_plan_epoch_and_committed_retry(raw_client, library_id, engine):

    client = raw_client
    base = f"/api/v1/libraries/{library_id}"
    original = headers(basis(client, library_id))
    created = client.post(f"{base}/bundles", json={"title": "Amber"}, headers=original)
    opening = created.headers["X-Cairndex-Basis"]
    with Session(engine) as db:
        db.connection().exec_driver_sql(
            "UPDATE plans.metadata_clock SET epoch=?, revision=0", (uuid4().hex,)
        )
        db.commit()
    replay = client.post(f"{base}/bundles", json={"title": "Amber"}, headers=original)
    assert replay.content == created.content
    saved = client.patch(
        f"{base}/bundles/{created.json()['id']}", json={"title": "Blue"}, headers=headers(opening)
    )
    assert saved.status_code == 200, saved.text
    from cairndex.metadata.session import validate_basis

    context = validate_basis(opening, basis(client, library_id), None)
    assert not context.guard("plans/grouping/_/$plan", 0, "null", "null")


# A failed durable commit returns a structured error and keeps the operation safe to retry
def test_commit_failure_never_reports_success(raw_client, library_id, monkeypatch):
    from sqlalchemy.exc import OperationalError

    client = raw_client
    base = f"/api/v1/libraries/{library_id}/bundles"
    created = client.post(base, json={"title": "Amber"}, headers=headers(basis(client, library_id)))
    url = f"{base}/{created.json()['id']}"
    retained = headers(created.headers["X-Cairndex-Basis"])
    original = Session.commit
    failed = False

    def fail_once(db):
        nonlocal failed
        if db.info.get("metadata_edit") and not failed:
            failed = True
            raise OperationalError("COMMIT", {}, Exception("synthetic failure"))
        original(db)

    monkeypatch.setattr(Session, "commit", fail_once)
    response = client.patch(url, json={"title": "Blue"}, headers=retained)
    assert response.status_code == 503, response.text
    assert client.get(url).json()["title"] == "Amber"
    retry = client.patch(url, json={"title": "Blue"}, headers=retained)
    assert retry.status_code == 200, retry.text
    assert client.get(url).json()["title"] == "Blue"


# Returning to an earlier value does not erase the intervening edit's conflict clock
def test_aba_and_observations(raw_client, library_id):
    client = raw_client
    base = f"/api/v1/libraries/{library_id}/bundles"
    created = client.post(base, json={"title": "Amber"}, headers=headers(basis(client, library_id)))
    url = f"{base}/{created.json()['id']}"
    opening = created.headers["X-Cairndex-Basis"]
    for title in ("Blue", "Amber"):
        assert (
            client.patch(
                url, json={"title": title}, headers=headers(basis(client, library_id))
            ).status_code
            == 200
        )
    assert client.patch(url, json={"title": "Green"}, headers=headers(opening)).status_code == 409
    before = basis(client, library_id)
    assert client.post(f"{url}/opened").status_code == 204
    assert basis(client, library_id) == before


# The same mandatory contract covers every scalar authoring family, including indivisible note lists
@pytest.mark.parametrize(
    "family,created,first,independent,stale",
    [
        (
            "collections",
            {"name": "Amber"},
            {"name": "Blue"},
            {"note": "Independent"},
            {"name": "Green"},
        ),
        ("tags", {"name": "Amber"}, {"name": "Blue"}, {"color": "#123456"}, {"name": "Green"}),
        (
            "smart-collections",
            {"name": "Amber", "filter": {"version": 1, "root": None}},
            {"name": "Blue"},
            {"default_sort": "rating"},
            {"name": "Green"},
        ),
        (
            "bundles",
            {"notes": ["First", "Second"]},
            {"notes": ["Second", "First"]},
            {"rating": 3.5},
            {"notes": ["First", "New", "Second"]},
        ),
    ],
)
def test_authored_family_fields(raw_client, library_id, family, created, first, independent, stale):
    client = raw_client
    base = f"/api/v1/libraries/{library_id}/{family}"
    response = client.post(base, json=created, headers=headers(basis(client, library_id)))
    assert response.status_code == 201, response.text
    url = f"{base}/{response.json()['id']}"
    opening = response.headers["X-Cairndex-Basis"]
    assert client.patch(url, json=first, headers=headers(opening)).status_code == 200
    accepted = client.patch(url, json=independent, headers=headers(opening))
    assert accepted.status_code == 200, accepted.text
    rejected = client.patch(url, json=stale, headers=headers(opening))
    assert rejected.status_code == 409, rejected.text
    current = client.get(url).json()
    assert all(current[key] == value for key, value in (first | independent).items())


# File descriptions stay independent and a moment's two time bounds remain one unit
@pytest.mark.parametrize("moment", [False, True])
def test_file_and_moment_fields(raw_client, library_id, moment):
    client = raw_client
    base = f"/api/v1/libraries/{library_id}"
    bundle = client.post(
        f"{base}/bundles", json={"title": "Amber"}, headers=headers(basis(client, library_id))
    ).json()
    files = f"{base}/bundles/{bundle['id']}/files"
    file = client.post(
        files,
        json={"relative_path": "clip.mp4", "role": "primary_video", "media_kind": "video"},
        headers=headers(basis(client, library_id)),
    )
    assert file.status_code == 201, file.text
    url = f"{files}/{file.json()['id']}"
    first, independent, stale = (
        {"display_title": "Blue"},
        {"note": "Separate"},
        {"display_title": "Green"},
    )
    if moment:
        moments = f"{base}/bundles/{bundle['id']}/moments"
        row = client.post(
            moments,
            json={"file_id": file.json()["id"], "start_s": 2, "end_s": 10},
            headers=headers(basis(client, library_id)),
        )
        assert row.status_code == 201, row.text
        url = f"{moments}/{row.json()['id']}"
        first, independent, stale = {"start_s": 3}, {"comment": "Separate"}, {"end_s": 12}
    opening = basis(client, library_id)
    saved = client.patch(url, json=first, headers=headers(opening))
    assert saved.status_code == 200, saved.text
    saved = client.patch(url, json=independent, headers=headers(opening))
    assert saved.status_code == 200, saved.text
    rejected = client.patch(url, json=stale, headers=headers(opening))
    assert rejected.status_code == 409, rejected.text
    assert rejected.json()["details"]["unit"].endswith("/$span" if moment else "/display_title")
    if moment:
        assert rejected.json()["details"]["current"]["start_s"] == 3


# An unseen hierarchy change invalidates a whole arrangement without blocking independent names
def test_structure_and_deletion(raw_client, library_id):
    client = raw_client
    base = f"/api/v1/libraries/{library_id}"
    nodes = [
        client.post(
            f"{base}/collections", json={"name": name}, headers=headers(basis(client, library_id))
        ).json()
        for name in ("Aster", "Birch", "Cedar")
    ]
    opening = basis(client, library_id)
    one = client.patch(
        f"{base}/collections/{nodes[0]['id']}",
        json={"parent_id": nodes[1]["id"]},
        headers=headers(opening),
    )
    assert one.status_code == 200, one.text
    two = client.patch(
        f"{base}/collections/{nodes[2]['id']}",
        json={"parent_id": nodes[1]["id"]},
        headers=headers(opening),
    )
    assert two.status_code == 409, two.text
    assert not two.json()["details"]["reviewable"]
    conflict = two.json()["details"]
    override = client.patch(
        f"{base}/collections/{nodes[2]['id']}",
        json={"parent_id": nodes[1]["id"]},
        headers={
            **headers(opening),
            "X-Cairndex-Review": json.dumps({conflict["unit"]: conflict["revision"]}),
        },
    )
    assert override.status_code == 409, override.text
    assert client.get(f"{base}/collections/{nodes[2]['id']}").json()["parent_id"] is None
    assert (
        client.delete(f"{base}/collections/{nodes[1]['id']}", headers=headers(opening)).status_code
        == 409
    )


# New route families must publish mandatory authoring preconditions
def test_openapi_authored_route_census():
    from cairndex.main import create_app

    schema = create_app().openapi()
    prefixes = ("bundles", "collections", "tags", "tag-groups", "smart-collections", "grouping")
    excluded = ("/browse", "/opened", "/cursor", "/delete-with-files")
    count = 0
    for path, methods in schema["paths"].items():
        if not path.startswith("/api/v1/libraries/{library_id}/"):
            continue
        relative = path.split("/{library_id}/", 1)[1]
        expected = relative.split("/", 1)[0] in prefixes and not relative.endswith(excluded)
        expected |= relative == "fast-add" or relative.endswith("/cover-frame")
        expected |= relative in {
            "manual-bundling/add-files",
            "manual-bundling/create-bundle",
            "manual-bundling/empty-bundle",
        }
        if not expected:
            continue
        for method, operation in methods.items():
            if method not in {"post", "put", "patch", "delete"}:
                continue
            required = {
                item["name"]
                for item in operation.get("parameters", [])
                if item.get("required") and item["in"] == "header"
            }
            assert {"X-Cairndex-Basis", "X-Cairndex-Operation"} <= required, (method, path)
            count += 1
    assert count >= 40
