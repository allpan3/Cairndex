"""File metadata round trips, filename compatibility and retained shared edit bases"""

import json
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from cairndex.persistence.models import AssetFile


# Keep each request identity attached to the caller's observed snapshot
def _headers(basis: str) -> dict[str, str]:
    return {"X-Cairndex-Basis": basis, "X-Cairndex-Operation": uuid4().hex}


# Create one actual synthetic source with metadata through the protected API
def _link(client: TestClient, library_id: str, root: Path, **metadata):
    (root / "filenameonly.txt").write_bytes(b"synthetic source bytes")
    base = f"/api/v1/libraries/{library_id}"
    opening = client.get(f"{base}/metadata").json()["basis"]
    bundle = client.post(f"{base}/bundles", json={"title": "Amber"}, headers=_headers(opening))
    assert bundle.status_code == 201, bundle.text
    url = f"{base}/bundles/{bundle.json()['id']}/files"
    response = client.post(
        url,
        json={
            "relative_path": "filenameonly.txt",
            "role": "attachment",
            "media_kind": "other",
            **metadata,
        },
        headers=_headers(bundle.headers["X-Cairndex-Basis"]),
    )
    assert response.status_code == 201, response.text
    return base, url, response


# Null, empty and non-HTTP origins retain their exact meaning across writes and fresh sessions
@pytest.mark.parametrize(
    "source", [None, "", "magnet:?xt=urn:btih:synthetic", "ed2k://fixture", "  Origin\n原文  "]
)
def test_saved_values_read_edit_clear_and_reopen(
    raw_client, library_id, library_root, engine, source
):
    client = raw_client
    note = "  Opening note\n原文  "
    _, url, created = _link(client, library_id, library_root, note=note, source=source)
    identity = created.json()["id"]
    for row in (created.json(), client.get(url).json()[0]):
        assert row["note"] == note and row["source"] == source
        assert row["display_title"] == "filenameonly.txt"
    current = created
    for patch, expected_note, expected_source in (
        ({"note": "Edited note"}, "Edited note", source),
        ({"source": "ed2k://new-origin"}, "Edited note", "ed2k://new-origin"),
        ({"sequence": 3}, "Edited note", "ed2k://new-origin"),
        ({"note": ""}, "", "ed2k://new-origin"),
        ({"note": None}, None, "ed2k://new-origin"),
        ({"source": None}, None, None),
    ):
        current = client.patch(
            f"{url}/{identity}", json=patch, headers=_headers(current.headers["X-Cairndex-Basis"])
        )
        assert current.status_code == 200, current.text
        assert current.json()["note"] == expected_note
        assert current.json()["source"] == expected_source
        read = client.get(url).json()[0]
        assert read["id"] == identity
        assert read["note"] == expected_note and read["source"] == expected_source
        with Session(engine) as reopened:
            stored = reopened.get(AssetFile, identity)
            assert stored.note == expected_note and stored.source == expected_source
    assert (library_root / "filenameonly.txt").read_bytes() == b"synthetic source bytes"


# Compatibility echoes neither infer aliases nor overwrite any saved legacy value
@pytest.mark.parametrize(
    "echo", [{}, {"display_title": None}, {"display_title": "filenameonly.txt"}]
)
def test_filename_echo_preserves_legacy_metadata(
    isolated_client, library_id, library_root, engine, echo
):
    client = isolated_client
    _, url, created = _link(client, library_id, library_root, **echo)
    assert created.json()["note"] is None and created.json()["source"] is None
    identity = created.json()["id"]
    with Session(engine) as db:
        row = db.get(AssetFile, identity)
        row.display_title = "Legacy retained value"
        row.note = "Keep note"
        row.source = "magnet:keep-origin"
        db.commit()
    result = client.patch(f"{url}/{identity}", json=echo)
    assert result.status_code == 200, result.text
    assert result.json()["display_title"] == "filenameonly.txt"
    assert result.json()["note"] == "Keep note"
    assert result.json()["source"] == "magnet:keep-origin"
    with Session(engine) as db:
        assert db.get(AssetFile, identity).display_title == "Legacy retained value"


# An invalid name fails the entire request before notes, clocks, versions or legacy data change
@pytest.mark.parametrize("name", ["Custom name", "", "FILENAMEONLY.TXT", "folder/filenameonly.txt"])
def test_custom_names_rejected_atomically(isolated_client, library_id, library_root, engine, name):
    client = isolated_client
    base, url, created = _link(client, library_id, library_root, note="Keep", source="ed2k:keep")
    identity = created.json()["id"]
    with Session(engine) as db:
        db.get(AssetFile, identity).display_title = "Retained legacy title"
        db.commit()
        original = dict(db.execute(select(AssetFile.__table__)).mappings().one())
    basis = client.get(f"{base}/metadata").json()["basis"]
    for method, path, body in (
        ("PATCH", f"{url}/{identity}", {"note": "Must not save", "source": None}),
        ("POST", url, {"relative_path": "other.txt", "role": "attachment", "media_kind": "other"}),
    ):
        result = client.request(method, path, json={**body, "display_title": name})
        assert result.status_code == 422, result.text
        assert result.json()["code"] == "validation_error"
        assert "Custom file names are not supported" in result.json()["message"]
        assert client.get(f"{base}/metadata").json()["basis"] == basis
        with Session(engine) as db:
            assert dict(db.execute(select(AssetFile.__table__)).mappings().one()) == original


# File reads carry bases for independent edits, exact same-field review and durable receipt replay
def test_file_conflicts_review_and_retry(raw_client, library_id, library_root):
    client = raw_client
    _, url, created = _link(
        client, library_id, library_root, note="Opening", source="magnet:opening"
    )
    target = f"{url}/{created.json()['id']}"
    read = client.get(url)
    opening = read.headers["X-Cairndex-Basis"]
    first_headers = _headers(opening)
    first = client.patch(target, json={"note": "First"}, headers=first_headers)
    assert first.status_code == 200, first.text
    independent = client.patch(
        target, json={"source": "ed2k:independent"}, headers=_headers(opening)
    )
    assert independent.status_code == 200, independent.text
    assert independent.json()["note"] == "First"
    stale = client.patch(target, json={"note": None}, headers=_headers(opening))
    assert stale.status_code == 409, stale.text
    conflict = stale.json()["details"]
    assert conflict["current"] == "First" and conflict["proposed"] is None
    assert conflict["unit"].endswith("/note") and conflict["reviewable"]
    reviewed = {conflict["unit"]: conflict["revision"]}
    both = client.patch(
        target,
        json={"note": None, "source": None},
        headers={**_headers(opening), "X-Cairndex-Review": json.dumps(reviewed)},
    )
    assert both.status_code == 409 and both.json()["details"]["unit"].endswith("/source")
    assert client.get(url).json()[0]["note"] == "First"
    accepted = client.patch(
        target,
        json={"note": None},
        headers={**_headers(opening), "X-Cairndex-Review": json.dumps(reviewed)},
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["source"] == "ed2k:independent"
    replay = client.patch(target, json={"note": "First"}, headers=first_headers)
    assert replay.status_code == 200 and replay.content == first.content
    assert replay.json()["source"] == "magnet:opening"  # Receipt is the original readback
    assert client.get(url).json()[0]["note"] is None
    reused = client.patch(target, json={"note": "Changed bytes"}, headers=first_headers)
    assert reused.status_code == 409
    no_basis = client.patch(target, json={"source": None})
    assert no_basis.status_code == 428
    stale_version = client.patch(
        target,
        json={"source": None},
        headers={
            **_headers(accepted.headers["X-Cairndex-Basis"]),
            "If-Match": str(created.json()["version"]),
        },
    )
    assert stale_version.status_code == 409
    assert client.get(url).json()[0]["source"] == "ed2k:independent"


# A failed durable save never reports cleared values or leaves a successful retry receipt
def test_file_commit_failure_retains_values_and_retry(
    raw_client, library_id, library_root, monkeypatch
):
    client = raw_client
    _, url, created = _link(client, library_id, library_root, note="Keep", source="ed2k:keep")
    target = f"{url}/{created.json()['id']}"
    retained = _headers(created.headers["X-Cairndex-Basis"])
    original = Session.commit
    failed = False

    # Fail once at the same durable boundary used by the production route
    def fail_once(db):
        nonlocal failed
        if db.info.get("metadata_edit") and not failed:
            failed = True
            raise OperationalError("COMMIT", {}, Exception("synthetic failure"))
        original(db)

    monkeypatch.setattr(Session, "commit", fail_once)
    patch = {"note": None, "source": None}
    response = client.patch(target, json=patch, headers=retained)
    assert response.status_code == 503, response.text
    assert client.get(url).json()[0]["source"] == "ed2k:keep"
    assert client.get(url).json()[0]["note"] == "Keep"
    retry = client.patch(target, json=patch, headers=retained)
    assert retry.status_code == 200, retry.text
    assert retry.json()["note"] is None and retry.json()["source"] is None


# File-note changes affect free text while origins remain explicit source predicates only
def test_file_note_search_and_source_filters(isolated_client, library_id, library_root, engine):
    client = isolated_client
    base, url, created = _link(
        client, library_id, library_root, note="noteonly", source="ed2k:sourceonly"
    )
    identity = created.json()["id"]
    with Session(engine) as db:
        db.get(AssetFile, identity).display_title = "legacyonly"
        db.commit()

    # Exercise both filtered and unfiltered public browse contracts
    def count(*, search=None, field=None, value=None):
        body = {"q": search}
        if field:
            body["filter"] = {
                "version": 1,
                "root": {"field": field, "operator": "contains", "value": value},
            }
        response = client.post(f"{base}/bundles/browse", json=body)
        assert response.status_code == 200, response.text
        return response.json()["total"]

    assert count(search="noteonly") == 1
    for term in ("filenameonly", "legacyonly", "sourceonly"):
        assert count(search=term) == 0
    assert count(field="source", value="sourceonly") == 1
    assert count(field="filename", value="filenameonly") == 1
    assert count(field="notes", value="noteonly") == 0  # Structured notes tests bundle notes
    assert client.patch(f"{url}/{identity}", json={"note": "editedonly"}).status_code == 200
    assert count(search="noteonly") == 0 and count(search="editedonly") == 1
    assert count(search="editedonly", field="source", value="sourceonly") == 1
    assert client.patch(f"{url}/{identity}", json={"note": None, "source": None}).status_code == 200
    assert count(search="editedonly") == 0 and count(field="source", value="sourceonly") == 0


# Reorder and cover response shapes retain the same file metadata as list and PATCH
def test_other_file_responses_preserve_metadata(isolated_client, library_id, library_root):
    client = isolated_client
    base, url, created = _link(client, library_id, library_root, note="Keep", source="ed2k:keep")
    identity = created.json()["id"]
    ordered = client.put(f"{url}/order", json={"ordered_ids": [identity]})
    assert ordered.status_code == 200, ordered.text
    assert ordered.json()[0]["note"] == "Keep"
    assert ordered.json()[0]["source"] == "ed2k:keep"
    # Non-video cover operations fail without altering unrelated metadata
    rejected = client.post(f"{base}/files/{identity}/cover-frame", json={"time": 1})
    assert rejected.status_code == 422
    assert client.get(url).json()[0]["source"] == "ed2k:keep"
