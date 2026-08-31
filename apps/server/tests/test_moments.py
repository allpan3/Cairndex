"""Moments — the instants and spans the owner marked inside a video (plan 7).

S1: the storage, the routes, and the tag propagation, with no UI yet. Two
properties carry most of the weight here. A moment belongs to a *file*, so it
must survive everything the file survives — a rename, a reparent, a trash — and
die only when the file does. And tag assignment propagates **one way**: it adds
to the bundle and nothing un-adds, which is the semantic §4.1 of the plan argues
for and the thing most likely to be broken by a later well-meaning change.
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import ValidationError
from cairndex.domain.enums import FileAvailability, GroupingState
from cairndex.persistence.models import AssetBundle, AssetFile, Moment, Tag, moment_tags
from cairndex.services import moments as service


def _video(library_root: Path, name: str = "clip.mp4") -> str:
    path = library_root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("not really a video")
    return name


def _link(client: TestClient, base: str, bundle_id: str, rel: str) -> str:
    resp = client.post(
        f"{base}/bundles/{bundle_id}/files",
        json={"relative_path": rel, "role": "primary_video", "media_kind": "video"},
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


def _tag(client: TestClient, base: str, name: str) -> str:
    resp = client.post(f"{base}/tags", json={"name": name})
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


def _mark(
    client: TestClient,
    base: str,
    bundle_id: str,
    file_id: str,
    start: float,
    end: float | None = None,
    **extra: object,
) -> Response:
    body: dict[str, object] = {"file_id": file_id, "start_s": start, **extra}
    if end is not None:
        body["end_s"] = end
    return client.post(f"{base}/bundles/{bundle_id}/moments", json=body)


def _bundle_tag_ids(client: TestClient, base: str, bundle_id: str) -> list[str]:
    resp = client.get(f"{base}/bundles/{bundle_id}/tags")
    assert resp.status_code == 200, resp.text
    return sorted(resp.json()["tag_ids"])


@pytest.fixture
def marked(client: TestClient, library_id: str, library_root: Path) -> dict[str, str]:
    """One bundle with one video linked, ready to be marked."""
    base = f"/api/v1/libraries/{library_id}"
    rel = _video(library_root)
    bundle_id = str(client.post(f"{base}/bundles", json={}).json()["id"])
    return {"base": base, "bundle_id": bundle_id, "file_id": _link(client, base, bundle_id, rel)}


@pytest.fixture
def builds_inline(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run preview builds where they are asked for, rather than on a thread.

    Production schedules them off the request on purpose (see
    `moment_previews.schedule`); these tests are about what the routes *do* with
    an artifact, not about when it lands, and a thread would only make them
    racy. The one test that cares about the ordering does not use this.
    """
    from cairndex.media import moment_previews

    monkeypatch.setattr(moment_previews, "schedule", lambda _dest, build: build())


# --- Frame vs range ----------------------------------------------------------
def test_a_frame_has_no_end_and_a_range_has_both(
    client: TestClient, marked: dict[str, str]
) -> None:
    """The null is the discriminator; nothing else says which shape a row is."""
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]

    frame = _mark(client, base, bundle_id, file_id, 12.5)
    assert frame.status_code == 201, frame.text
    assert frame.json()["start_s"] == 12.5
    assert frame.json()["end_s"] is None

    span = _mark(client, base, bundle_id, file_id, 30.0, 35.5)
    assert span.status_code == 201, span.text
    assert span.json()["end_s"] == 35.5


def test_a_range_must_end_after_it_starts(client: TestClient, marked: dict[str, str]) -> None:
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    assert _mark(client, base, bundle_id, file_id, 10.0, 10.0).status_code == 422
    assert _mark(client, base, bundle_id, file_id, 10.0, 4.0).status_code == 422
    assert _mark(client, base, bundle_id, file_id, -1.0).status_code == 422


def test_a_moment_must_be_marked_on_a_file_the_bundle_holds(
    client: TestClient, library_id: str, library_root: Path, marked: dict[str, str]
) -> None:
    """The route is bundle-scoped, so a foreign file_id would file a moment under
    a bundle whose inspector does not show that video."""
    base = marked["base"]
    other_rel = _video(library_root, "elsewhere/other.mp4")
    other_bundle = str(client.post(f"{base}/bundles", json={}).json()["id"])
    other_file = _link(client, base, other_bundle, other_rel)

    refused = _mark(client, base, marked["bundle_id"], other_file, 1.0)
    assert refused.status_code == 422, refused.text
    assert _mark(
        client, base, marked["bundle_id"], "01JUNKJUNKJUNKJUNKJUNKJU", 1.0
    ).status_code == (422)


# --- Ordering ----------------------------------------------------------------
def test_moments_come_back_in_time_order_across_files(
    client: TestClient, marked: dict[str, str], library_root: Path
) -> None:
    """A moment list is a timeline. Grouping by file is the client's business —
    the rows arrive chronologically so it can do either."""
    base, bundle_id = marked["base"], marked["bundle_id"]
    second = _link(client, base, bundle_id, _video(library_root, "clip-02.mp4"))

    for start, file_id in [(40.0, marked["file_id"]), (5.0, second), (20.0, marked["file_id"])]:
        assert _mark(client, base, bundle_id, file_id, start).status_code == 201

    listed = client.get(f"{base}/bundles/{bundle_id}/moments")
    assert listed.status_code == 200, listed.text
    assert [row["start_s"] for row in listed.json()] == [5.0, 20.0, 40.0]


def test_two_moments_may_share_an_instant(client: TestClient, marked: dict[str, str]) -> None:
    """Deliberately no uniqueness rule: one frame can be worth two notes. The
    accidental double-press is the client's problem, where the frame rate is
    known (plan 7 §4.6)."""
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    assert _mark(client, base, bundle_id, file_id, 9.0).status_code == 201
    assert _mark(client, base, bundle_id, file_id, 9.0).status_code == 201
    assert len(client.get(f"{base}/bundles/{bundle_id}/moments").json()) == 2


# --- Tag propagation (plan 7 §4.1) -------------------------------------------
def test_a_moments_tag_becomes_the_bundles_tag(client: TestClient, marked: dict[str, str]) -> None:
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    tag_id = _tag(client, base, "establishing")
    assert _bundle_tag_ids(client, base, bundle_id) == []

    created = _mark(client, base, bundle_id, file_id, 12.0, 17.5, tag_ids=[tag_id])
    assert created.status_code == 201, created.text
    assert created.json()["tag_ids"] == [tag_id]
    assert _bundle_tag_ids(client, base, bundle_id) == [tag_id]


def test_propagation_is_a_union_not_a_replace(client: TestClient, marked: dict[str, str]) -> None:
    """The bundle keeps what the owner put there by hand — this adds, it does not
    rewrite. Same semantics as Paste Tags."""
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    by_hand, from_moment = _tag(client, base, "by-hand"), _tag(client, base, "from-moment")
    assert (
        client.put(f"{base}/bundles/{bundle_id}/tags", json={"ids": [by_hand]}).status_code == 200
    )

    moment_id = _mark(client, base, bundle_id, file_id, 3.0).json()["id"]
    answered = client.put(
        f"{base}/bundles/{bundle_id}/moments/{moment_id}/tags",
        json={"ids": [from_moment]},
    )
    assert answered.status_code == 200, answered.text
    assert answered.json()["tag_ids"] == [from_moment]
    # The answer carries the bundle's resulting tags, so the client need not
    # refetch to draw them.
    assert answered.json()["bundle_tag_ids"] == sorted([by_hand, from_moment])
    assert _bundle_tag_ids(client, base, bundle_id) == sorted([by_hand, from_moment])


def test_removing_a_moments_tag_leaves_the_bundle_tag(
    client: TestClient, marked: dict[str, str]
) -> None:
    """One way, by design. A propagated assignment and a hand-made one are the
    same row, so un-propagating would sometimes remove one the owner set."""
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    tag_id = _tag(client, base, "reaction")
    moment_id = _mark(client, base, bundle_id, file_id, 4.0, tag_ids=[tag_id]).json()["id"]

    cleared = client.put(f"{base}/bundles/{bundle_id}/moments/{moment_id}/tags", json={"ids": []})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["tag_ids"] == []
    assert _bundle_tag_ids(client, base, bundle_id) == [tag_id]


def test_deleting_a_moment_leaves_the_bundle_tag(
    client: TestClient, marked: dict[str, str]
) -> None:
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    tag_id = _tag(client, base, "highlight")
    moment_id = _mark(client, base, bundle_id, file_id, 6.0, tag_ids=[tag_id]).json()["id"]

    assert client.delete(f"{base}/bundles/{bundle_id}/moments/{moment_id}").status_code == 204
    assert client.get(f"{base}/bundles/{bundle_id}/moments").json() == []
    assert _bundle_tag_ids(client, base, bundle_id) == [tag_id]


def test_an_unknown_tag_is_refused_and_changes_nothing(
    client: TestClient, marked: dict[str, str]
) -> None:
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    refused = _mark(client, base, bundle_id, file_id, 8.0, tag_ids=["01JUNKJUNKJUNKJUNKJUNKJU"])
    assert refused.status_code == 422, refused.text
    assert client.get(f"{base}/bundles/{bundle_id}/moments").json() == []
    assert _bundle_tag_ids(client, base, bundle_id) == []


def test_propagation_does_not_consume_the_bundles_version(
    client: TestClient, marked: dict[str, str]
) -> None:
    """A version is the token for edits to the bundle itself. Spending one here
    would fail an unrelated in-flight bundle edit with a conflict the owner
    cannot explain."""
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    before = client.get(f"{base}/bundles/{bundle_id}").json()["version"]
    tag_id = _tag(client, base, "quiet")
    assert _mark(client, base, bundle_id, file_id, 2.0, tag_ids=[tag_id]).status_code == 201

    after = client.get(f"{base}/bundles/{bundle_id}")
    assert after.json()["version"] == before
    assert _bundle_tag_ids(client, base, bundle_id) == [tag_id]


# --- Editing -----------------------------------------------------------------
def test_a_range_can_be_turned_back_into_a_frame(
    client: TestClient, marked: dict[str, str]
) -> None:
    """An explicit null ends the span; an omitted field leaves it alone."""
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    moment_id = _mark(client, base, bundle_id, file_id, 10.0, 15.0).json()["id"]
    url = f"{base}/bundles/{bundle_id}/moments/{moment_id}"

    moved = client.patch(url, json={"start_s": 11.0})
    assert moved.status_code == 200, moved.text
    assert (moved.json()["start_s"], moved.json()["end_s"]) == (11.0, 15.0)

    framed = client.patch(url, json={"end_s": None})
    assert framed.status_code == 200, framed.text
    assert framed.json()["end_s"] is None


def test_an_edit_cannot_invert_the_span(client: TestClient, marked: dict[str, str]) -> None:
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    moment_id = _mark(client, base, bundle_id, file_id, 10.0, 15.0).json()["id"]
    url = f"{base}/bundles/{bundle_id}/moments/{moment_id}"
    assert client.patch(url, json={"start_s": 20.0}).status_code == 422
    assert client.patch(url, json={"end_s": 2.0}).status_code == 422
    unchanged = client.get(f"{base}/bundles/{bundle_id}/moments").json()
    assert (unchanged[0]["start_s"], unchanged[0]["end_s"]) == (10.0, 15.0)


def test_a_moments_start_cannot_be_cleared(client: TestClient, marked: dict[str, str]) -> None:
    """Every field on the update is nullable so ``end_s`` and ``comment`` can be
    cleared. A start cannot be — without the guard the null reached ``float()``
    and answered 500 instead of saying what was wrong."""
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    moment_id = _mark(client, base, bundle_id, file_id, 7.0).json()["id"]
    url = f"{base}/bundles/{bundle_id}/moments/{moment_id}"

    assert client.patch(url, json={"start_s": None}).status_code == 422
    assert client.get(f"{base}/bundles/{bundle_id}/moments").json()[0]["start_s"] == 7.0


def test_a_blank_comment_leaves_no_comment(client: TestClient, marked: dict[str, str]) -> None:
    """An emptied box should leave nothing behind, not an empty string that
    renders as a zero-height line."""
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    moment_id = _mark(client, base, bundle_id, file_id, 1.0, comment="  a note  ").json()["id"]
    url = f"{base}/bundles/{bundle_id}/moments/{moment_id}"

    listed = client.get(f"{base}/bundles/{bundle_id}/moments").json()
    assert listed[0]["comment"] == "a note"
    assert client.patch(url, json={"comment": "   "}).json()["comment"] is None


def test_a_stale_edit_is_rejected(client: TestClient, marked: dict[str, str]) -> None:
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    created = _mark(client, base, bundle_id, file_id, 1.0).json()
    url = f"{base}/bundles/{bundle_id}/moments/{created['id']}"

    assert (
        client.patch(url, json={"comment": "first"}, headers={"If-Match": "1"}).status_code == 200
    )
    stale = client.patch(url, json={"comment": "second"}, headers={"If-Match": "1"})
    assert stale.status_code == 409, stale.text


def test_a_moment_from_another_bundle_is_not_found_here(
    client: TestClient, marked: dict[str, str], library_root: Path
) -> None:
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    moment_id = _mark(client, base, bundle_id, file_id, 1.0).json()["id"]
    stranger = str(client.post(f"{base}/bundles", json={}).json()["id"])

    assert client.get(f"{base}/bundles/{stranger}/moments").json() == []
    assert (
        client.patch(
            f"{base}/bundles/{stranger}/moments/{moment_id}", json={"comment": "x"}
        ).status_code
        == 404
    )
    assert client.delete(f"{base}/bundles/{stranger}/moments/{moment_id}").status_code == 404


def test_an_unknown_bundle_is_not_found(client: TestClient, library_id: str) -> None:
    base = f"/api/v1/libraries/{library_id}"
    assert client.get(f"{base}/bundles/01JUNKJUNKJUNKJUNKJUNKJU/moments").status_code == 404


# --- Lifecycle ---------------------------------------------------------------
def test_dropping_the_file_row_takes_its_moments(
    client: TestClient, marked: dict[str, str], session: Session
) -> None:
    """The DB-level cascade, which is what the paths that genuinely drop a file
    row rely on — emptying the trash, and dropping a bundle that has become
    empty. A moment inside a file the library no longer indexes has nothing left
    to point at."""
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    tag_id = _tag(client, base, "gone")
    assert _mark(client, base, bundle_id, file_id, 3.0, tag_ids=[tag_id]).status_code == 201

    asset_file = session.get(AssetFile, file_id)
    assert asset_file is not None
    session.delete(asset_file)
    session.commit()

    session.expire_all()
    assert session.query(Moment).count() == 0
    # The join rows go with it; the *tag* does not, and neither does the
    # bundle assignment it caused (plan 7 §4.1).
    assert session.execute(select(moment_tags)).all() == []
    assert session.query(Tag).count() == 1


def test_forgetting_a_missing_file_takes_its_moments(
    client: TestClient, marked: dict[str, str], session: Session
) -> None:
    """The API path onto that cascade: a member proved gone from disk is dropped
    rather than re-staged, so its moments go too."""
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    assert _mark(client, base, bundle_id, file_id, 3.0).status_code == 201

    asset_file = session.get(AssetFile, file_id)
    assert asset_file is not None
    asset_file.availability = FileAvailability.MISSING
    session.commit()

    forgotten = client.post(
        f"{base}/bundles/{bundle_id}/files/forget-missing", json={"file_ids": [file_id]}
    )
    assert forgotten.status_code == 200, forgotten.text
    session.expire_all()
    assert session.query(Moment).count() == 0


def test_removing_a_file_from_a_bundle_carries_its_moments_with_it(
    client: TestClient, marked: dict[str, str], session: Session
) -> None:
    """Removing a *present* file dissolves its membership rather than dropping the
    row — it is re-staged into its own one-file bundle, keeping its
    ``AssetFile.id``. So the moments are not lost; they move with the video, and
    are found under the bundle that now holds it.

    Worth pinning because "delete the file from the bundle" reads like it should
    destroy them, and the desirable behaviour is the opposite."""
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    moment_id = _mark(client, base, bundle_id, file_id, 3.0).json()["id"]

    assert client.delete(f"{base}/bundles/{bundle_id}/files/{file_id}").status_code == 204
    session.expire_all()

    moved = session.get(Moment, moment_id)
    assert moved is not None
    assert moved.bundle_id != bundle_id
    assert [row["id"] for row in client.get(f"{base}/bundles/{bundle_id}/moments").json()] == []
    staged = client.get(f"{base}/bundles/{moved.bundle_id}/moments").json()
    assert [row["id"] for row in staged] == [moment_id]


def test_deleting_an_unbundled_bundle_takes_its_moments(
    client: TestClient, marked: dict[str, str], session: Session
) -> None:
    """Deleting a *provisional* bundle is how a loose file leaves the library: the
    file row goes with it, and so do its moments."""
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    assert _mark(client, base, bundle_id, file_id, 3.0).status_code == 201

    bundle = session.get(AssetBundle, bundle_id)
    assert bundle is not None
    bundle.grouping_state = GroupingState.PROVISIONAL
    session.commit()

    assert client.delete(f"{base}/bundles/{bundle_id}").status_code == 204
    session.expire_all()
    assert session.query(Moment).count() == 0


def test_a_moment_follows_its_file_into_another_bundle(
    client: TestClient, marked: dict[str, str], session: Session
) -> None:
    """The denormalized ``bundle_id`` is maintained by the same ``before_flush``
    listener that carries playback progress. Left behind, the moment would show
    in the inspector of a bundle that no longer holds the video."""
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    moment_id = _mark(client, base, bundle_id, file_id, 3.0).json()["id"]
    destination = str(client.post(f"{base}/bundles", json={}).json()["id"])

    asset_file = session.get(AssetFile, file_id)
    assert asset_file is not None
    asset_file.bundle_id = destination
    session.commit()

    moved = session.get(Moment, moment_id)
    assert moved is not None
    session.refresh(moved)
    assert moved.bundle_id == destination
    assert [row["id"] for row in client.get(f"{base}/bundles/{destination}/moments").json()] == [
        moment_id
    ]


def test_a_renamed_file_keeps_its_moments(
    client: TestClient, marked: dict[str, str], session: Session
) -> None:
    """Move repair preserves ``AssetFile.id`` (AGENTS.md), so a moment marked
    before a rename is still there after it — this pins that it stays true."""
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    moment_id = _mark(client, base, bundle_id, file_id, 3.0).json()["id"]

    asset_file = session.get(AssetFile, file_id)
    assert asset_file is not None
    asset_file.relative_path = "renamed/elsewhere.mp4"
    session.commit()

    assert [row["id"] for row in client.get(f"{base}/bundles/{bundle_id}/moments").json()] == [
        moment_id
    ]


# --- Bootstrap ---------------------------------------------------------------
def test_a_library_that_predates_the_feature_gains_empty_tables(session: Session) -> None:
    """``create_all`` never adds a table to an existing DB, so the additive pass
    in ``persistence.engine`` is what brings an older library up to shape."""
    tables = set(sa_inspect(session.get_bind()).get_table_names())
    assert {"moments", "moment_tags"} <= tables


def test_the_service_refuses_a_negative_start_before_touching_the_db(
    session: Session, marked: dict[str, str]
) -> None:
    """The DB holds the same two rules as CHECK constraints; the service raises
    them as a 422 so a client sees a message rather than a 500."""
    with pytest.raises(ValidationError, match="must not be negative"):
        service.create_moment(session, marked["bundle_id"], file_id=marked["file_id"], start_s=-0.5)


# --- The pre-cut preview clip ------------------------------------------------
# The clip exists so a hover does not have to open the original, seek into the
# middle of it, and decode forward from a keyframe before showing the frame that
# was marked (owner, 2026-08-30). What matters for correctness is not the
# encoding but the *contract*: absent means "not yet, and now queued", the span
# is part of the cache identity, and the cache is disposable.
def test_an_unbuilt_clip_is_absent_and_queues_its_own_build(
    client: TestClient, marked: dict[str, str], monkeypatch: pytest.MonkeyPatch, builds_inline: None
) -> None:
    from cairndex.media import moment_previews

    asked: list[tuple[float, float]] = []
    monkeypatch.setattr(
        moment_previews,
        "_encode_clip",
        lambda source, dest, *, start, duration: (
            asked.append((start, duration)) or dest.write_bytes(b"mp4")
        ),
    )
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    moment_id = _mark(client, base, bundle_id, file_id, 12.0, 17.0).json()["id"]

    # First ask: nothing to serve, but the request is what schedules the cut.
    first = client.get(f"{base}/bundles/{bundle_id}/moments/{moment_id}/clip.mp4")
    assert first.status_code == 404
    assert asked == [(12.0, 5.0)]  # start, and the span's length

    # Second ask, after the build: the clip itself, cacheable forever.
    second = client.get(f"{base}/bundles/{bundle_id}/moments/{moment_id}/clip.mp4")
    assert second.status_code == 200
    assert second.headers["content-type"] == "video/mp4"
    assert "immutable" in second.headers["cache-control"]


def test_deleting_the_cache_costs_the_wait_and_not_the_feature(
    client: TestClient,
    marked: dict[str, str],
    library_root: Path,
    monkeypatch: pytest.MonkeyPatch,
    builds_inline: None,
) -> None:
    """The owner asked directly: if the cache is removed, is it broken? No."""
    from cairndex.media import moment_previews

    monkeypatch.setattr(
        moment_previews,
        "_encode_clip",
        lambda source, dest, *, start, duration: dest.write_bytes(b"mp4"),
    )
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    moment_id = _mark(client, base, bundle_id, file_id, 12.0, 17.0).json()["id"]
    client.get(f"{base}/bundles/{bundle_id}/moments/{moment_id}/clip.mp4")
    assert client.get(f"{base}/bundles/{bundle_id}/moments/{moment_id}/clip.mp4").status_code == 200

    # Wipe the whole derived-media cache, the way a user reclaiming disk would.
    from cairndex.registry import library_package

    cache = library_package.cache_dir(library_root)
    for child in cache.rglob("*"):
        if child.is_file():
            child.unlink()

    # Back to "not yet" — which the client answers by streaming the original —
    # and rebuilt on the asking.
    assert client.get(f"{base}/bundles/{bundle_id}/moments/{moment_id}/clip.mp4").status_code == 404
    assert client.get(f"{base}/bundles/{bundle_id}/moments/{moment_id}/clip.mp4").status_code == 200


def test_a_frame_moment_has_no_clip_to_serve(client: TestClient, marked: dict[str, str]) -> None:
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    moment_id = _mark(client, base, bundle_id, file_id, 12.0).json()["id"]
    resp = client.get(f"{base}/bundles/{bundle_id}/moments/{moment_id}/clip.mp4")
    assert resp.status_code == 404
    assert "range" in resp.json()["detail"]


def test_the_span_is_part_of_the_clips_cache_identity() -> None:
    """A moved span must not keep serving the clip of where it used to be."""
    from cairndex.media import moment_previews

    same = moment_previews.clip_fingerprint("abc:123", 12.0, 17.0)
    assert moment_previews.clip_fingerprint("abc:123", 12.0, 17.0) == same
    assert moment_previews.clip_fingerprint("abc:123", 12.5, 17.0) != same
    assert moment_previews.clip_fingerprint("abc:123", 12.0, 18.0) != same
    # ...and neither must a re-imported source with different bytes.
    assert moment_previews.clip_fingerprint("abc:999", 12.0, 17.0) != same


# --- The poster frame --------------------------------------------------------
# The still under a hover preview used to be a storyboard tile, which is sampled
# every 2 to 30 seconds and holds the frame at the *start* of the interval
# containing the mark — so it was reliably not the frame that was marked, and on
# a long video not even inside the range (owner, 2026-08-30, twice). Every moment
# now carries its own decoded frame, span or instant.
def test_marking_a_moment_starts_decoding_the_frame_it_marks(
    client: TestClient,
    marked: dict[str, str],
    library_root: Path,
    monkeypatch: pytest.MonkeyPatch,
    builds_inline: None,
) -> None:
    from cairndex.media import moment_previews

    asked: list[float] = []
    monkeypatch.setattr(
        moment_previews,
        "_encode_poster",
        lambda source, dest, *, at: asked.append(at) or dest.write_bytes(b"jpg"),
    )
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    moment_id = _mark(client, base, bundle_id, file_id, 41.5).json()["id"]

    # Queued by the save, not left to the first hover: without it the first hover
    # of a brand-new moment shows the stale tile, which is the whole complaint.
    assert asked == [41.5]
    resp = client.get(f"{base}/bundles/{bundle_id}/moments/{moment_id}/poster.jpg")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/jpeg"
    assert "immutable" in resp.headers["cache-control"]


def test_a_frame_moment_has_a_poster_even_though_it_has_no_clip(
    client: TestClient, marked: dict[str, str], monkeypatch: pytest.MonkeyPatch, builds_inline: None
) -> None:
    """The kind that had nothing but the stale tile, and no second act to fix it."""
    from cairndex.media import moment_previews

    monkeypatch.setattr(
        moment_previews, "_encode_poster", lambda source, dest, *, at: dest.write_bytes(b"jpg")
    )
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    moment_id = _mark(client, base, bundle_id, file_id, 41.5).json()["id"]

    assert (
        client.get(f"{base}/bundles/{bundle_id}/moments/{moment_id}/poster.jpg").status_code == 200
    )
    # ...and still no clip, because there is no span to cut.
    assert client.get(f"{base}/bundles/{bundle_id}/moments/{moment_id}/clip.mp4").status_code == 404


def test_an_unbuilt_poster_is_absent_and_queues_its_own_build(
    client: TestClient,
    marked: dict[str, str],
    library_root: Path,
    monkeypatch: pytest.MonkeyPatch,
    builds_inline: None,
) -> None:
    """The lazy path, which covers moments predating the feature and a wiped cache."""
    from cairndex.media import moment_previews
    from cairndex.registry import library_package

    monkeypatch.setattr(
        moment_previews, "_encode_poster", lambda source, dest, *, at: dest.write_bytes(b"jpg")
    )
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    moment_id = _mark(client, base, bundle_id, file_id, 41.5).json()["id"]
    assert (
        client.get(f"{base}/bundles/{bundle_id}/moments/{moment_id}/poster.jpg").status_code == 200
    )

    for child in library_package.cache_dir(library_root).rglob("*"):
        if child.is_file():
            child.unlink()

    assert (
        client.get(f"{base}/bundles/{bundle_id}/moments/{moment_id}/poster.jpg").status_code == 404
    )
    assert (
        client.get(f"{base}/bundles/{bundle_id}/moments/{moment_id}/poster.jpg").status_code == 200
    )


def test_a_posters_identity_ignores_the_out_point() -> None:
    """Moving only the end of a span leaves its first frame exactly where it was."""
    from cairndex.media import moment_previews

    same = moment_previews.poster_fingerprint("abc:123", 12.0)
    assert moment_previews.poster_fingerprint("abc:123", 12.0) == same
    assert moment_previews.poster_fingerprint("abc:123", 12.5) != same
    assert moment_previews.poster_fingerprint("abc:999", 12.0) != same


def test_a_poster_survives_its_own_clip_being_built(
    client: TestClient, marked: dict[str, str], monkeypatch: pytest.MonkeyPatch, builds_inline: None
) -> None:
    """A moment's two artifacts must not share a fingerprint sidecar.

    They did, because `derived_cache` derives the sidecar and the lock with
    `with_suffix` — so `{id}.mp4` and `{id}.jpg` both resolved to
    `{id}.fingerprint`, the clip's value overwrote the poster's, and every range
    moment served a 404 for its poster from then on. The visible symptom was the
    owner's original complaint surviving the fix: ranges kept showing the stale
    storyboard tile, while frame moments — which have only a poster — were fine.
    """
    from cairndex.media import moment_previews

    monkeypatch.setattr(
        moment_previews, "_encode_poster", lambda source, dest, *, at: dest.write_bytes(b"jpg")
    )
    monkeypatch.setattr(
        moment_previews,
        "_encode_clip",
        lambda source, dest, *, start, duration: dest.write_bytes(b"mp4"),
    )
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    moment_id = _mark(client, base, bundle_id, file_id, 12.0, 17.0).json()["id"]
    poster = f"{base}/bundles/{bundle_id}/moments/{moment_id}/poster.jpg"
    clip = f"{base}/bundles/{bundle_id}/moments/{moment_id}/clip.mp4"

    assert client.get(poster).status_code == 200
    # Building the clip must not disturb the poster...
    client.get(clip)
    assert client.get(clip).status_code == 200
    assert client.get(poster).status_code == 200
    # ...nor the other way round, however many times either is asked for.
    assert client.get(poster).status_code == 200
    assert client.get(clip).status_code == 200


def test_a_slow_poster_build_never_hides_the_moment_it_belongs_to(
    client: TestClient, marked: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Saving a moment must not wait on — or be hidden by — its own preview.

    Deliberately without `builds_inline`: the point here *is* the ordering.
    Starlette runs a response's background tasks before FastAPI exits the
    `yield` dependency that commits the library session, so a poster queued as a
    background task held its own moment's write invisible for as long as ffmpeg
    took. The rail refetches about 20ms after the POST, so it read an empty list
    and never asked again — the row did not appear until the app was reloaded
    (owner-reported, 2026-08-30). Measured at 2121ms of invisibility with the
    encode slowed to 2000ms.
    """
    import threading

    from cairndex.media import moment_previews

    started, release, finished = threading.Event(), threading.Event(), threading.Event()

    def block(source: Path, dest: Path, *, at: float) -> None:
        started.set()
        release.wait(5)
        dest.write_bytes(b"jpg")
        finished.set()

    monkeypatch.setattr(moment_previews, "_encode_poster", block)
    base, bundle_id, file_id = marked["base"], marked["bundle_id"], marked["file_id"]
    try:
        created = _mark(client, base, bundle_id, file_id, 12.0, 17.0)
        assert created.status_code == 201, created.text

        # The build is under way...
        assert started.wait(5), "the poster build never started"
        # ...and the request did not wait for it. On a background task the POST
        # would not have returned until this was set.
        assert not finished.is_set()

        # And the write is already visible, which is the whole bug: the rail's
        # refetch lands here, in this window.
        listed = client.get(f"{base}/bundles/{bundle_id}/moments")
        assert [row["id"] for row in listed.json()] == [created.json()["id"]]
    finally:
        release.set()
