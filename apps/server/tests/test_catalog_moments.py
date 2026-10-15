"""Portable moments are catalog rows: listed per bundle, written only through catalog jobs."""

import json
import shutil
import threading
import time

from cairndex.replicas.catalog import jobs
from tests.test_replica_media import authored, media_api, specimen  # noqa: F401

BUNDLE = "bundle-000001"


def run(client, base, store, operation, action, body):
    response = client.post(
        base + "/replica/catalog/jobs",
        json={"operation": operation, "action": action, "body": body},
    )
    assert response.status_code == 202, response.text
    jobs.run_one(store)
    # The service's own exchange can claim the job first and still be running it
    for _ in range(200):
        result = client.get(base + f"/replica/catalog/jobs/{operation}").json()
        if result["state"] not in ("queued", "running"):
            return result
        time.sleep(0.05)
    raise AssertionError("catalog job did not finish")


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
    assert client.get(base + "/replica/status").json()["moments_version"] == 4
    seeded = listed(client, base)
    assert [item["id"] for item in seeded["items"]] == ["media-moment"]
    assert seeded["items"][0]["comment"] == "Synthetic moment"
    assert seeded["items"][0]["tag_ids"] == [] and seeded["next_offset"] is None
    # The page names the files its moments mark, so the inspector needs no playlist
    assert [file["id"] for file in seeded["files"]] == ["media-direct"]
    assert seeded["files"][0]["media_kind"] == "video"

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


def bundle_tags(store):
    with store.connection(readonly=True) as db:
        return [
            entity
            for (entity,) in db.execute(
                "SELECT entity FROM catalog_rows WHERE family='asset_bundle_tags' "
                "AND json_extract(body,'$.bundle_id')=? ORDER BY entity",
                (BUNDLE,),
            )
        ]


def moment_tag(client, base, store, operation, tag, *, assigned):
    choices = client.get(
        base + "/replica/catalog/moments/media-moment/tags", params={"q": "Synthetic"}
    ).json()["items"]
    (choice,) = [item for item in choices if item["id"] == tag]
    assert choice["assigned"] is not assigned
    command = {
        "action": "moment_tag",
        "moment": "media-moment",
        "target": tag,
        "assigned": assigned,
        "observed": choice["observed"],
    }
    return preview_and_commit(client, base, store, operation, command)


# ADR-0025: a moment's tag is added to its bundle, and removing it leaves the bundle alone
def test_a_moment_tag_also_tags_the_bundle_one_way(media_api):  # noqa: F811
    client, base, store, _, _ = media_api
    cells = client.get(base + "/replica/catalog/creation/tags").json()["cells"]
    tag = json.loads(cells["id"])
    create = {
        "action": "create",
        "family": "tags",
        "cells": cells | {"name": json.dumps("Synthetic scene"), "parent_id": "null"},
    }
    assert preview_and_commit(client, base, store, "tag", create)["state"] == "succeeded"
    before = bundle_tags(store)

    assert moment_tag(client, base, store, "add", tag, assigned=True)["state"] == "succeeded"
    page = listed(client, base)
    assert page["items"][0]["tag_ids"] == [tag]
    assert page["tag_names"] == {tag: "Synthetic scene"}
    assert bundle_tags(store) == sorted([*before, f"{BUNDLE}~{tag}"])

    assert moment_tag(client, base, store, "remove", tag, assigned=False)["state"] == "succeeded"
    assert listed(client, base)["items"][0]["tag_ids"] == []
    assert bundle_tags(store) == sorted([*before, f"{BUNDLE}~{tag}"])

    # A stale choice is refused rather than applied over a change the owner did not see
    stale = client.get(base + "/replica/catalog/moments/media-moment/tags").json()["items"]
    (choice,) = [item for item in stale if item["id"] == tag]
    assert moment_tag(client, base, store, "again", tag, assigned=True)["state"] == "succeeded"
    command = {
        "action": "moment_tag",
        "moment": "media-moment",
        "target": tag,
        "assigned": True,
        "observed": choice["observed"],
    }
    refused = run(client, base, store, "stale", "preview", command)
    assert refused["state"] == "failed"
    assert refused["error"] == "Membership changed or requires conflict review; refresh choices"

    # Deleting the moment removes its tags with it; the bundle keeps the propagated tag
    delete = {"action": "delete", "family": "moments", "entity": "media-moment"}
    assert preview_and_commit(client, base, store, "forget-tagged", delete)["state"] == "succeeded"
    assert bundle_tags(store) == sorted([*before, f"{BUNDLE}~{tag}"])
    with store.connection(readonly=True) as db:
        assert not db.execute(
            "SELECT 1 FROM catalog_rows WHERE family='moment_tags' AND entity=?",
            (f"media-moment~{tag}",),
        ).fetchone()
    missing = client.get(base + "/replica/catalog/moments/media-moment/tags")
    assert missing.status_code >= 400


def settled(client, url):
    for _ in range(600):
        response = client.get(url)
        if response.status_code != 404:
            return response
        time.sleep(0.05)
    raise AssertionError("moment preview was not built")


# Tests share one private store, so each makes its own moment and counts only new previews
def marked(client, base, store, operation, start, end):
    command = creation(client, base, "media-direct", start, end)
    assert preview_and_commit(client, base, store, operation, command)["state"] == "succeeded"
    return json.loads(command["cells"]["id"])


def previews(store, suffix):
    return set((store.path.parent / "cache" / "moment-previews").glob(f"*/*{suffix}"))


# A preview is made in the background from the observed generation, into the private cache
def test_moment_previews_use_the_private_cache_and_current_generation(media_api):  # noqa: F811
    client, base, store, _, roots = media_api
    moment = marked(client, base, store, "mark-previewed", 20.0, 24.0)
    before = authored(store)
    posters, clips = previews(store, "-poster.jpg"), previews(store, "-clip.mp4")
    poster = base + f"/replica/media/moments/{moment}/poster.jpg"
    clip = base + f"/replica/media/moments/{moment}/clip.mp4"
    queued = client.get(poster)
    assert queued.status_code == 404
    assert queued.json()["message"] == "Moment preview is not ready yet"
    frame = settled(client, poster)
    assert frame.status_code == 200 and frame.content.startswith(b"\xff\xd8")
    assert frame.headers["cache-control"] == "private, no-store"
    span = settled(client, clip)
    assert span.status_code == 200 and span.headers["content-type"] == "video/mp4"
    assert span.content[4:8] == b"ftyp"
    assert len(previews(store, "-poster.jpg") - posters) == 1
    assert len(previews(store, "-clip.mp4") - clips) == 1
    assert not (roots[0] / ".cairndex/cache").exists()

    # A changed source never serves the old preview; the next request makes a new one
    source = roots[0] / "Playback/movie.mp4"
    copy = source.with_suffix(".new")
    shutil.copyfile(source, copy)
    copy.replace(source)
    assert client.get(poster).status_code == 404
    assert settled(client, poster).status_code == 200
    assert len(previews(store, "-poster.jpg") - posters) == 2
    assert authored(store) == before

    # A frame has no clip, and a missing moment has no preview
    frame_moment = marked(client, base, store, "mark-unclipped", 10.5, None)
    refused = client.get(base + f"/replica/media/moments/{frame_moment}/clip.mp4")
    assert refused.status_code == 404
    assert refused.json()["message"] == "Only range moments have a preview clip"
    assert client.get(base + "/replica/media/moments/missing/poster.jpg").status_code == 404


# Release takes a running preview away, and the next request after Reopen makes it
def test_moment_preview_release_aborts_running_work(media_api, monkeypatch):  # noqa: F811
    from cairndex.core.abort import OperationAborted, aborted
    from cairndex.media import moment_previews

    client, base, store, _, _ = media_api
    moment = marked(client, base, store, "mark-released", 30.0, None)
    started = threading.Event()
    real = moment_previews._encode_poster

    def wait_for_abort(*args, **kwargs):
        started.set()
        for _ in range(200):
            if aborted():
                raise OperationAborted
            time.sleep(0.05)
        raise AssertionError("release did not abort the preview")

    monkeypatch.setattr(moment_previews, "_encode_poster", wait_for_abort)
    poster = base + f"/replica/media/moments/{moment}/poster.jpg"
    assert client.get(poster).status_code == 404
    assert started.wait(timeout=10)
    assert client.post(base + "/ownership/release").status_code == 200
    assert client.post(base + "/ownership/reopen").status_code == 200
    monkeypatch.setattr(moment_previews, "_encode_poster", real)
    assert settled(client, poster).status_code == 200
    cache = store.path.parent / "cache" / "moment-previews"
    assert not list(cache.glob("*/*.partial.*"))
