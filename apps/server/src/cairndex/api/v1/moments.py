"""Key-moment routes (plan 7).

Bundle-scoped for the same reason directory members are: the inspector reads
them by bundle, and the bundle is the route scope every other content surface
uses. Metadata-only throughout — marking, tagging, commenting, and forgetting a
moment write rows in the library DB and touch no file — so none of it sits behind
the write-mode gate (ADR-0013).

Its own module rather than more of ``bundles.py``: the two share a URL prefix and
nothing else, and ``bundles.py`` is already the largest router in the tree.
"""

from collections.abc import Callable
from pathlib import Path

from fastapi import APIRouter, HTTPException, Response, status
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.orm import Session

from cairndex.api.deps import IfMatchVersion, LibraryAccessDep, LibrarySession
from cairndex.api.schemas.bundles import SetIdsRequest
from cairndex.api.schemas.moments import (
    MomentCreate,
    MomentRead,
    MomentTags,
    MomentUpdate,
)
from cairndex.core.paths import resolve_within_root
from cairndex.domain.enums import MediaKind
from cairndex.media import moment_previews
from cairndex.persistence.engine import library_root_for_session
from cairndex.persistence.models import AssetBundle, AssetFile, Moment
from cairndex.services import moments as service

router = APIRouter(
    prefix="/libraries/{library_id}/bundles/{bundle_id}/moments",
    tags=["moments"],
)


def _tag_ids(owner: Moment | AssetBundle) -> list[str]:
    """Tag ids in a stable order.

    Sorted because the join table carries no order of its own, so the
    relationship's order is whatever the query planner returns — and a list that
    can reshuffle between two identical reads makes the client's chips reorder
    for no reason (AGENTS.md: deterministic ordering with a stable tie-breaker).
    """
    return sorted(tag.id for tag in owner.tags)


def _read(moment: Moment) -> MomentRead:
    return MomentRead.model_validate(moment).model_copy(update={"tag_ids": _tag_ids(moment)})


@router.get("", response_model=list[MomentRead])
def list_moments(bundle_id: str, db: LibrarySession) -> list[MomentRead]:
    """Every moment in the bundle, in time order across all of its videos."""
    return [_read(moment) for moment in service.list_moments(db, bundle_id)]


@router.post("", response_model=MomentRead, status_code=status.HTTP_201_CREATED)
def create_moment(bundle_id: str, payload: MomentCreate, db: LibrarySession) -> MomentRead:
    """Mark a moment, and start decoding the frame it marks.

    The poster is queued here rather than left to the first hover, because it is
    the *picture* rather than the motion: one keyframe seek and one JPEG, and
    without it the first hover of a brand-new moment shows the stale storyboard
    tile — the frame from up to 30 seconds before the mark, which is the thing
    the owner reported twice. The clip stays lazy (owner's choice, 2026-08-30):
    it is the expensive one, and a range has the streaming path to fall back on
    while it builds.

    Queued through `moment_previews.schedule`, *not* as a background task on this
    response: a background task runs before the session dependency commits, so
    the poster would hold its own moment's write invisible until ffmpeg finished
    — and the rail's refetch, twenty milliseconds later, would read an empty list
    and never ask again.

    Best-effort by construction. A failed build leaves no fingerprint, so the
    hover route simply tries again.
    """
    moment = service.create_moment(
        db,
        bundle_id,
        file_id=payload.file_id,
        start_s=payload.start_s,
        end_s=payload.end_s,
        comment=payload.comment,
        tag_ids=payload.tag_ids,
    )
    read = _read(moment)
    asset_file = db.get(AssetFile, moment.file_id)
    if asset_file is not None and asset_file.media_kind is MediaKind.VIDEO:
        library_root = library_root_for_session(db)
        source = Path(resolve_within_root(library_root, asset_file.relative_path))
        dest = moment_previews.poster_cache_path(library_root, moment.id)
        fingerprint = moment_previews.poster_fingerprint(
            asset_file.quick_fingerprint, moment.start_s
        )
        at = moment.start_s
        moment_previews.schedule(
            dest,
            lambda: moment_previews.request_poster(source, dest, at=at, fingerprint=fingerprint),
        )
    return read


@router.patch("/{moment_id}", response_model=MomentRead)
def update_moment(
    bundle_id: str,
    moment_id: str,
    payload: MomentUpdate,
    db: LibrarySession,
    if_match: IfMatchVersion = None,
) -> MomentRead:
    changes = payload.model_dump(exclude_unset=True)
    moment = service.update_moment(db, bundle_id, moment_id, changes, expected_version=if_match)
    return _read(moment)


@router.put("/{moment_id}/tags", response_model=MomentTags)
def set_moment_tags(
    bundle_id: str, moment_id: str, payload: SetIdsRequest, db: LibrarySession
) -> MomentTags:
    """Replace this moment's tags; the new ones join the bundle's as well.

    Takes the same ``{"ids": [...]}`` envelope as ``PUT /bundles/{id}/tags``, so
    a client setting tags on either owner sends the same body shape.
    """
    moment, bundle = service.set_moment_tags(db, bundle_id, moment_id, payload.ids)
    return MomentTags(
        moment_id=moment.id,
        tag_ids=_tag_ids(moment),
        bundle_tag_ids=_tag_ids(bundle),
    )


@router.delete("/{moment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_moment(bundle_id: str, moment_id: str, db: LibrarySession) -> None:
    """Forget a moment. Tags it put on the bundle stay there (plan 7 §4.1)."""
    service.delete_moment(db, bundle_id, moment_id)


def _preview_source(db: Session, moment: Moment) -> tuple[Path, str | None]:
    """The file a moment's previews are cut from, and the bytes they depend on."""
    asset_file = db.get(AssetFile, moment.file_id)
    if asset_file is None or asset_file.media_kind is not MediaKind.VIDEO:
        raise HTTPException(status_code=404, detail="this moment has no video source")
    library_root = library_root_for_session(db)
    source = Path(resolve_within_root(library_root, asset_file.relative_path))
    return source, asset_file.quick_fingerprint


def _ready(dest: Path, media_type: str) -> FileResponse:
    return FileResponse(
        str(dest),
        media_type=media_type,
        filename=dest.name,
        headers={"Cache-Control": moment_previews.CACHE_CONTROL},
    )


def _queued(dest: Path, build: Callable[[], None]) -> JSONResponse:
    """A 404 that schedules its own build.

    "Not yet", not "never": the client falls back to what it can already show, so
    no hover ever waits on ffmpeg. That is also what makes the cache disposable —
    delete ``.cairndex/cache/`` and previews still work, less well, and come back
    as rows are hovered (owner asked, 2026-08-30).

    Scheduled off the request rather than attached to the response, because a
    background task delays the teardown of the library access dependency and so
    holds it across an ffmpeg run. On the write route the same mechanism was worse
    — see `create_moment`.
    """
    moment_previews.schedule(dest, build)
    return JSONResponse(status_code=404, content={"detail": "preview is not built yet"})


@router.get("/{moment_id}/poster.jpg")
def get_moment_poster(bundle_id: str, moment_id: str, access: LibraryAccessDep) -> Response:
    """The frame a moment marks, as the still under its hover preview.

    For every moment, not only a span: a frame moment has nothing else to show,
    and the storyboard tile it used to fall back on is sampled on a 2-to-30
    second grid, so it held the frame from the *start* of the interval containing
    the mark rather than the mark itself (owner, 2026-08-30).

    A scoped session so the response body is not streamed while a DB connection
    is held, and the values a background build needs are read out here rather
    than handing a session to a thread.
    """
    with access.session() as db:
        moment = service.get_moment(db, bundle_id, moment_id)
        source, quick_fingerprint = _preview_source(db, moment)
        dest = moment_previews.poster_cache_path(library_root_for_session(db), moment.id)
        fingerprint = moment_previews.poster_fingerprint(quick_fingerprint, moment.start_s)
        ready = moment_previews.is_current(dest, fingerprint)
        at = moment.start_s

    if ready:
        return _ready(dest, "image/jpeg")
    return _queued(
        dest, lambda: moment_previews.request_poster(source, dest, at=at, fingerprint=fingerprint)
    )


@router.get("/{moment_id}/clip.mp4")
def get_moment_clip(bundle_id: str, moment_id: str, access: LibraryAccessDep) -> Response:
    """The pre-cut preview clip for a range moment, if it has been built yet.

    Plays from byte 0, so a hover pays no header round trip, no seek, and no
    decoding forward from the preceding keyframe — and its first frame is the
    marked in-point.
    """
    with access.session() as db:
        moment = service.get_moment(db, bundle_id, moment_id)
        if moment.end_s is None:
            raise HTTPException(status_code=404, detail="only range moments have a preview clip")
        source, quick_fingerprint = _preview_source(db, moment)
        dest = moment_previews.clip_cache_path(library_root_for_session(db), moment.id)
        fingerprint = moment_previews.clip_fingerprint(
            quick_fingerprint, moment.start_s, moment.end_s
        )
        ready = moment_previews.is_current(dest, fingerprint)
        start, end = moment.start_s, moment.end_s

    if ready:
        return _ready(dest, "video/mp4")
    return _queued(
        dest,
        lambda: moment_previews.request_clip(
            source, dest, start=start, end=end, fingerprint=fingerprint
        ),
    )
