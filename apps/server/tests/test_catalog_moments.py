"""Portable moments are catalog rows: listed per bundle, written only through catalog jobs."""

import json

from cairndex.replicas.catalog import jobs
from tests.test_replica_media import media_api, specimen  # noqa: F401

BUNDLE = "bundle-000001"


def run(client, base, store, operation, action, body):
    response = client.post(
        base + "/replica/catalog/jobs",
        json={"operation": operation, "action": action, "body": body},
    )
    assert response.status_code == 202, response.text
    jobs.run_one(store)
    return client.get(base + f"/replica/catalog/jobs/{operation}").json()


# The viewer commits its own preview at once, as the web client does
def preview_and_commit(client, base, store, operation, command):
    prepared = run(client, base, store, operation, "preview", command)
    assert prepared["state"] == "succeeded", prepared["error"]
    body = {"job": operation, "receipt": prepared["receipt"]}
    return run(client, base, store, f"commit_{operation}", "commit_preview", body)


def listed(client, base, **params):
    response = client.get(base + f"/replica/catalog/bundles/{BUNDLE}/moments", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def creation(client, base, file_id, start, end):
    cells = client.get(base + "/replica/catalog/creation/moments").json()["cells"]
    return {
        "action": "create",
        "family": "moments",
        "cells": cells
        | {
            "bundle_id": json.dumps(BUNDLE),
            "file_id": json.dumps(file_id),
            "start_s": json.dumps(start),
            "end_s": json.dumps(end),
        },
    }


def test_moments_are_listed_and_edited_through_catalog_jobs(media_api):  # noqa: F811
    client, base, store, _, _ = media_api
    assert client.get(base + "/replica/status").json()["moments_version"] == 1
    seeded = listed(client, base)
    assert [item["id"] for item in seeded["items"]] == ["media-moment"]
    assert seeded["items"][0]["comment"] == "Synthetic moment"
    assert seeded["items"][0]["tag_ids"] == [] and seeded["next_offset"] is None

    # A frame before the seeded span lists first: start time orders the rail
    command = creation(client, base, "media-direct", 10.5, None)
    created = json.loads(command["cells"]["id"])
    assert preview_and_commit(client, base, store, "mark", command)["state"] == "succeeded"
    page = listed(client, base)
    assert [item["id"] for item in page["items"]] == [created, "media-moment"]
    assert page["items"][0]["start_s"] == 10.5 and page["items"][0]["end_s"] is None
    first = listed(client, base, limit=1)
    assert len(first["items"]) == 1 and first["next_offset"] == 1
    assert listed(client, base, offset=1)["items"][0]["id"] == "media-moment"

    # A comment edit carries the observed bases of the comment and the moment itself
    entity = client.get(base + f"/replica/catalog/entities/moments/{created}").json()
    comment, alive = entity["fields"]["comment"], entity["fields"]["$alive"]
    save = {
        "changes": [
            {
                "unit": comment["unit"],
                "value": json.dumps("Synthetic note"),
                "basis": comment["basis"],
            },
            {"unit": alive["unit"], "value": "true", "basis": alive["basis"]},
        ],
        "parents": entity["parents"],
        "resolve": False,
        "recover": False,
    }
    assert run(client, base, store, "comment", "save", save)["state"] == "succeeded"
    assert listed(client, base)["items"][0]["comment"] == "Synthetic note"

    delete = {"action": "delete", "family": "moments", "entity": created}
    assert preview_and_commit(client, base, store, "forget", delete)["state"] == "succeeded"
    assert [item["id"] for item in listed(client, base)["items"]] == ["media-moment"]
    assert (
        client.get(base + f"/replica/catalog/bundles/{BUNDLE}/moments?limit=501").status_code == 422
    )


def test_a_moment_must_be_marked_on_a_file_of_its_bundle(media_api):  # noqa: F811
    client, base, store, _, _ = media_api
    with store.connection(readonly=True) as db:
        (other,) = db.execute(
            "SELECT entity FROM catalog_rows WHERE family='asset_files' "
            "AND json_extract(body,'$.bundle_id')!=? LIMIT 1",
            (BUNDLE,),
        ).fetchone()
    command = creation(client, base, other, 1.0, None)
    prepared = run(client, base, store, "misfiled", "preview", command)
    assert prepared["state"] == "failed"
    assert prepared["error"] == "A moment must be marked on a file of its bundle"
    assert [item["id"] for item in listed(client, base)["items"]] == ["media-moment"]
