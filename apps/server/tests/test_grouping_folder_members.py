"""A proposed folder row in a grouping plan (plan 6 S3).

The suggester proposes a directory as one row above a threshold, the plan stores
that decision, the review dialog can decline it, and apply turns the survivors
into real folder members. The threshold decides only what to *propose*, so the
tests that matter most are the ones pinning what it must never swallow.
"""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileRole, MediaKind, ProposalKind
from cairndex.grouping import FileObservation, suggest_grouping
from cairndex.grouping.suggester import FOLDER_MEMBER_THRESHOLD
from cairndex.persistence.models import BundleDirectoryMember
from cairndex.scanning.scanner import scan_library


def _f(path: str, kind: MediaKind = MediaKind.IMAGE) -> FileObservation:
    return FileObservation(
        asset_file_id=path,
        relative_path=path,
        media_kind=kind,
        grouping_confirmed=False,
        bundle_id=None,
        bundle_title=None,
    )


def _album(directory: str, count: int) -> list[FileObservation]:
    return [_f(f"{directory}/shot{index:03d}.jpg") for index in range(count)]


def test_an_album_becomes_one_bundle_holding_the_folder() -> None:
    """The complaint this exists to answer: without it, forty photos are forty
    single-photo bundle proposals wrapped in a collection — forty rows to review."""
    plan = suggest_grouping(_album("album", 40))
    assert len(plan.proposals) == 1
    proposal = plan.proposals[0]
    assert proposal.kind is ProposalKind.BUNDLE
    assert proposal.directories == ("album",)
    # Collapsing is a drawing decision: every photo is still in the bundle, so
    # each keeps its search, tags, rating and resume position.
    assert len(proposal.files) == 40


def test_a_work_with_an_album_subfolder_is_one_bundle() -> None:
    """The owner's original case, stated 2026-07-28 and missed until they ran it:
    "every item in the folder to be in a bundle (along with other files not in
    the folder)".

    A folder holding a clip, a poster and a subfolder of photos is one work. It
    used to become a *collection* — the clip one bundle, the album another — so
    the thing the owner was looking at had no single row at all.
    """
    files = [
        _f("trip/clip.mp4", MediaKind.VIDEO),
        _f("trip/poster.jpg"),
        *_album("trip/album", 40),
    ]
    plan = suggest_grouping(files)
    assert len(plan.proposals) == 1
    proposal = plan.proposals[0]
    assert proposal.kind is ProposalKind.BUNDLE
    assert proposal.directory == "trip"
    assert proposal.directories == ("trip/album",)
    # Every file, so the album's photos land in the same bundle as the clip.
    assert len(proposal.files) == 42


def test_two_albums_and_nothing_else_stay_a_collection() -> None:
    """Nothing ties them together but the folder they share, and a folder of
    albums is what a collection is for."""
    plan = suggest_grouping([*_album("trip/day1", 20), *_album("trip/day2", 20)])
    kinds = {p.kind for p in plan.proposals}
    assert ProposalKind.CONTAINER in kinds
    albums = [p for p in plan.proposals if p.directories]
    assert sorted(p.directory for p in albums) == ["trip/day1", "trip/day2"]


def test_two_separate_videos_beside_an_album_stay_a_collection() -> None:
    """With two subjects at the top there is no answer to which one the album
    belongs to, so merging would be a guess. It stays a collection."""
    files = [
        _f("trip/one.mp4", MediaKind.VIDEO),
        _f("trip/two.mp4", MediaKind.VIDEO),
        *_album("trip/album", 20),
    ]
    plan = suggest_grouping(files)
    assert any(p.kind is ProposalKind.CONTAINER for p in plan.proposals)
    top = [p for p in plan.proposals if p.directory == "trip" and p.kind is ProposalKind.BUNDLE]
    assert all(p.directories == () for p in top)


def test_a_subfolder_that_is_its_own_work_is_not_absorbed() -> None:
    """Only *albums* merge upward. A subfolder holding a film with its sidecars
    is a separate work, and absorbing it would hide it."""
    files = [
        _f("trip/clip.mp4", MediaKind.VIDEO),
        _f("trip/sub/film.mp4", MediaKind.VIDEO),
        _f("trip/sub/film.jpg"),
        _f("trip/sub/film.en.srt", MediaKind.SUBTITLE),
    ]
    plan = suggest_grouping(files)
    assert any(p.kind is ProposalKind.CONTAINER for p in plan.proposals)
    assert all(p.directories == () for p in plan.proposals)


def test_a_movie_folder_is_never_swallowed() -> None:
    # The failure that killed two earlier designs: a film, its parts, subtitles
    # and covers are several files in one directory and emphatically not an album.
    plan = suggest_grouping(
        [
            _f("movie/film.mp4", MediaKind.VIDEO),
            _f("movie/film.part2.mp4", MediaKind.VIDEO),
            _f("movie/film.en.srt", MediaKind.SUBTITLE),
            _f("movie/poster.jpg"),
            _f("movie/cover.jpg"),
        ]
    )
    assert all(p.directories == () for p in plan.proposals)


def test_the_threshold_is_a_floor_not_a_guess() -> None:
    short = suggest_grouping(_album("a", FOLDER_MEMBER_THRESHOLD - 1))
    exact = suggest_grouping(_album("a", FOLDER_MEMBER_THRESHOLD))
    assert all(p.directories == () for p in short.proposals)
    assert any(p.directories == ("a",) for p in exact.proposals)


def test_a_folder_bundle_still_names_a_real_file_as_its_cover() -> None:
    """A folder is never the cover (plan 6 §2), so the bundle must still point at
    an image *inside* it — otherwise a collapsed album renders blank in the grid."""
    plan = suggest_grouping(_album("album", 40))
    roles = {pf.asset_file_id: pf.role for pf in plan.proposals[0].files}
    covers = [file_id for file_id, role in roles.items() if role is FileRole.COVER]
    assert len(covers) == 1
    assert covers[0].startswith("album/")


def _plan_via_api(client: TestClient, base: str) -> dict:  # type: ignore[type-arg]
    created = client.post(f"{base}/grouping/plans", json={})
    assert created.status_code == 201, created.text
    return created.json()


def _seed_album(library_root, directory: str, count: int) -> None:  # type: ignore[no-untyped-def]
    folder = library_root / directory
    folder.mkdir(parents=True, exist_ok=True)
    for index in range(count):
        (folder / f"shot{index:03d}.jpg").write_bytes(b"\xff\xd8\xff\xd9")


def test_a_plan_round_trips_its_folder_rows_and_applies_them(
    client: TestClient, library_id: str, library_root, session: Session
) -> None:  # type: ignore[no-untyped-def]
    base = f"/api/v1/libraries/{library_id}"
    (library_root / "trip").mkdir(parents=True)
    (library_root / "trip" / "clip.mp4").write_bytes(b"\x00" * 32)
    _seed_album(library_root, "trip/album", 30)
    scan_library(session, library_root)

    plan = _plan_via_api(client, base)
    with_folder = [p for p in plan["proposals"] if p["directories"]]
    assert with_folder, "expected a folder row in the plan"
    proposal = with_folder[0]
    folder = proposal["directories"][0]
    assert folder["directory_path"] == "trip/album"
    assert folder["name"] == "album"
    # The count is how many rows the folder replaces, from this proposal's files.
    assert folder["file_count"] == 30

    applied = client.post(
        f"{base}/grouping/plans/{plan['id']}/apply",
        json={"proposal_ids": [proposal["id"]]},
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["folders_collapsed"] == 1
    session.expire_all()
    members = session.query(BundleDirectoryMember).all()
    assert [m.directory_path for m in members] == ["trip/album"]


def test_declining_a_folder_row_leaves_the_files_enumerated(
    client: TestClient, library_id: str, library_root, session: Session
) -> None:  # type: ignore[no-untyped-def]
    base = f"/api/v1/libraries/{library_id}"
    (library_root / "trip").mkdir(parents=True)
    (library_root / "trip" / "clip.mp4").write_bytes(b"\x00" * 32)
    _seed_album(library_root, "trip/album", 30)
    scan_library(session, library_root)

    plan = _plan_via_api(client, base)
    proposal = next(p for p in plan["proposals"] if p["directories"])
    folder = proposal["directories"][0]
    before = len(proposal["files"])

    url = (
        f"{base}/grouping/plans/{plan['id']}/proposals/{proposal['id']}/directories/{folder['id']}"
    )
    declined = client.put(url, json={"expanded": True})
    assert declined.status_code == 200, declined.text
    body = declined.json()
    # The row survives, marked declined, so the decision can be taken back —
    # looking inside a folder must not be a one-way door.
    assert [d["expanded"] for d in body["directories"]] == [True]
    # Declining changes only how the suggestion is drawn — the same files are
    # still in it, which is why nothing has to be restored.
    assert len(body["files"]) == before

    applied = client.post(
        f"{base}/grouping/plans/{plan['id']}/apply",
        json={"proposal_ids": [proposal["id"]]},
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["folders_collapsed"] == 0
    session.expire_all()
    assert session.query(BundleDirectoryMember).count() == 0


def test_a_shelf_of_releases_is_not_an_album() -> None:
    """The movie-folder trap at scale, and the reason the rule counts subjects
    rather than files.

    Three hundred releases in one flat folder are 900 files — far past any
    file-count threshold — but only 300 subjects, each a video with a cover and a
    subtitle sharing its stem. Collapsing that would hide 300 separate works
    behind one row, which is the mistake that killed two earlier designs.
    """
    files: list[FileObservation] = []
    for index in range(300):
        stem = f"shelf/item{index:04d}"
        files.append(_f(f"{stem}.mp4", MediaKind.VIDEO))
        files.append(_f(f"{stem}.jpg"))
        files.append(_f(f"{stem}.en.srt", MediaKind.SUBTITLE))
    plan = suggest_grouping(files)
    assert all(p.directories == () for p in plan.proposals)
    assert len([p for p in plan.proposals if p.kind is ProposalKind.BUNDLE]) == 300


def test_one_stray_sidecar_does_not_disqualify_an_album() -> None:
    """Being defeated by a single file is how a feature earns a reputation for
    not working, so the singleton rule carries a little slack."""
    files = [*_album("album", 40), _f("album/shot000.jpg.txt", MediaKind.OTHER)]
    plan = suggest_grouping(files)
    assert any(p.directories == ("album",) for p in plan.proposals)


def test_converting_a_collection_to_a_bundle_keeps_its_folder_rows(
    client: TestClient, library_id: str, library_root, session: Session
) -> None:  # type: ignore[no-untyped-def]
    """Owner-reported 2026-08-28: "as soon as I turn the collection into a
    bundle, folder is gone".

    Converting merges the descendants' files into the surviving proposal, and a
    folder row is a statement about how some of those files are drawn — so
    dropping it un-collapsed the album at the exact moment the owner said "this
    folder is one bundle", which is the likeliest thing to do to a folder that
    has one.
    """
    base = f"/api/v1/libraries/{library_id}"
    # Two separate videos at the top keep the suggester on the collection path,
    # so there is a collection to convert.
    (library_root / "trip").mkdir(parents=True)
    for name in ("one.mp4", "two.mp4"):
        (library_root / "trip" / name).write_bytes(b"\x00" * 32)
    _seed_album(library_root, "trip/album", 20)
    scan_library(session, library_root)

    plan = _plan_via_api(client, base)
    container = next(p for p in plan["proposals"] if p["kind"] == "container")
    album = next(p for p in plan["proposals"] if p["directories"])
    assert album["directories"][0]["directory_path"] == "trip/album"

    converted = client.put(
        f"{base}/grouping/plans/{plan['id']}/proposals/{container['id']}/kind",
        json={"kind": "bundle"},
    )
    assert converted.status_code == 200, converted.text
    merged = next(p for p in converted.json()["proposals"] if p["id"] == container["id"])

    assert merged["kind"] == "bundle"
    assert [d["directory_path"] for d in merged["directories"]] == ["trip/album"]
    # The album's photos came along, and the folder row still stands for them.
    assert merged["directories"][0]["file_count"] == 20
    assert len(merged["files"]) == 22

    applied = client.post(
        f"{base}/grouping/plans/{plan['id']}/apply",
        json={"proposal_ids": [container["id"]]},
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["folders_collapsed"] == 1
    session.expire_all()
    assert [m.directory_path for m in session.query(BundleDirectoryMember).all()] == ["trip/album"]


def test_declining_a_folder_row_is_reversible(
    client: TestClient, library_id: str, library_root, session: Session
) -> None:  # type: ignore[no-untyped-def]
    """Owner-reported 2026-08-28: the only way to see inside a folder was to
    flatten it, and there was no way back. Both directions now."""
    base = f"/api/v1/libraries/{library_id}"
    (library_root / "trip").mkdir(parents=True)
    (library_root / "trip" / "clip.mp4").write_bytes(b"\x00" * 32)
    _seed_album(library_root, "trip/album", 30)
    scan_library(session, library_root)

    plan = _plan_via_api(client, base)
    proposal = next(p for p in plan["proposals"] if p["directories"])
    folder = proposal["directories"][0]
    url = (
        f"{base}/grouping/plans/{plan['id']}/proposals/{proposal['id']}/directories/{folder['id']}"
    )

    assert client.put(url, json={"expanded": True}).json()["directories"][0]["expanded"] is True
    back = client.put(url, json={"expanded": False})
    assert back.status_code == 200, back.text
    assert back.json()["directories"][0]["expanded"] is False
    # The count still describes the folder, whichever way it is being drawn.
    assert back.json()["directories"][0]["file_count"] == 30

    applied = client.post(
        f"{base}/grouping/plans/{plan['id']}/apply",
        json={"proposal_ids": [proposal["id"]]},
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["folders_collapsed"] == 1
    session.expire_all()
    assert [m.directory_path for m in session.query(BundleDirectoryMember).all()] == ["trip/album"]
