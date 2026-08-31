"""Moments — the instants and spans the owner marked inside a video (plan 7).

A moment is one ``start_s`` (a frame) or one ``start_s``/``end_s`` pair (a range)
belonging to one ``AssetFile``, with an optional comment and any number of
library tags. Metadata-only: nothing here reads or writes the filesystem.

**Tag assignment propagates to the bundle, one way.** Adding a tag to a moment
adds it to the moment's bundle; removing it from the moment, or deleting the
moment, does not take it off the bundle (plan 7 §4.1, ADR-0025). That keeps every
existing tag count, filter, and Smart Collection working unchanged — they read
``asset_bundle_tags`` and find a real row there — and it is the honest semantic:
a propagated assignment and a hand-made one are the same row, so un-propagating
would sometimes remove a tag the owner set on the bundle themselves.
"""

from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.core.time import utcnow
from cairndex.persistence.concurrency import guard_and_bump_version
from cairndex.persistence.models import AssetBundle, AssetFile, Moment, Tag


def _require_bundle(session: Session, bundle_id: str) -> AssetBundle:
    bundle = session.get(AssetBundle, bundle_id)
    if bundle is None:
        raise NotFoundError(f"bundle {bundle_id!r} not found")
    return bundle


def _require_member_file(session: Session, bundle_id: str, file_id: str) -> AssetFile:
    """The file a new moment is being marked on, proved to be in this bundle.

    The route is bundle-scoped, so accepting a ``file_id`` from elsewhere would
    file a moment under a bundle whose inspector shows a file it does not hold.
    """
    asset_file = session.get(AssetFile, file_id)
    if asset_file is None or asset_file.bundle_id != bundle_id:
        raise ValidationError(f"file {file_id!r} is not part of bundle {bundle_id!r}")
    return asset_file


def _ordered(stmt: Select[tuple[Moment]]) -> Select[tuple[Moment]]:
    """Chronological, tie-broken by id.

    A moment list is a timeline, so time is the only order it can have; the id
    breaks ties so two moments marked at one instant do not swap between reads.
    Sorting by file first would be a second opinion about the *bundle's* order,
    which ``AssetFile.sequence`` already owns — the client groups by file from
    the rows it already has.
    """
    return stmt.order_by(Moment.start_s, Moment.id)


def list_moments(session: Session, bundle_id: str) -> list[Moment]:
    _require_bundle(session, bundle_id)
    stmt = _ordered(select(Moment).where(Moment.bundle_id == bundle_id))
    return list(session.scalars(stmt))


def get_moment(session: Session, bundle_id: str, moment_id: str) -> Moment:
    moment = session.get(Moment, moment_id)
    if moment is None or moment.bundle_id != bundle_id:
        raise NotFoundError(f"moment {moment_id!r} is not part of bundle {bundle_id!r}")
    return moment


def _validate_span(start_s: float, end_s: float | None) -> None:
    """The two rules the DB also holds, raised here as a 422 rather than a 500.

    Clamping to the *file's duration* deliberately stays with the client, which
    knows the duration exactly and already clamps a marked range against it. The
    server would be second-guessing that from probe metadata that may be absent.
    """
    if start_s < 0:
        raise ValidationError("start_s must not be negative")
    if end_s is not None and end_s <= start_s:
        raise ValidationError("end_s must be after start_s")


def _resolve_tags(session: Session, tag_ids: list[str]) -> list[Tag]:
    unique_ids = list(dict.fromkeys(tag_ids))
    if not unique_ids:
        return []
    found = list(session.scalars(select(Tag).where(Tag.id.in_(unique_ids))))
    if len(found) != len(unique_ids):
        missing = set(unique_ids) - {tag.id for tag in found}
        raise ValidationError(f"unknown tag ids: {sorted(missing)}")
    by_id = {tag.id: tag for tag in found}
    return [by_id[tag_id] for tag_id in unique_ids]


def _propagate_tags_to_bundle(session: Session, bundle: AssetBundle, tags: list[Tag]) -> None:
    """Union the moment's tags into its bundle's (plan 7 §4.1).

    A union, matching **Paste Tags**: it adds what is being assigned and keeps
    what is already there. ``bundle.updated_at`` is bumped so the inspector's
    cover key and any cached read notice, but the *version* is not — a version is
    the optimistic-concurrency token for edits the owner made to the bundle
    itself, and consuming one here would make an unrelated in-flight bundle edit
    fail with a conflict the owner cannot explain.
    """
    assigned = {tag.id for tag in bundle.tags}
    added = [tag for tag in tags if tag.id not in assigned]
    if not added:
        return
    bundle.tags.extend(added)
    bundle.updated_at = utcnow()


def create_moment(
    session: Session,
    bundle_id: str,
    *,
    file_id: str,
    start_s: float,
    end_s: float | None = None,
    comment: str | None = None,
    tag_ids: list[str] | None = None,
) -> Moment:
    """Mark a moment. ``end_s`` absent (or null) marks a frame rather than a span.

    Duplicates are allowed — two moments may share an instant with different
    comments and tags — so there is no uniqueness rule here. The accidental
    double-press is caught by the client, which knows the frame rate and can
    offer the existing row instead of adding a second (plan 7 §4.6).
    """
    bundle = _require_bundle(session, bundle_id)
    _require_member_file(session, bundle_id, file_id)
    _validate_span(start_s, end_s)
    tags = _resolve_tags(session, tag_ids or [])

    moment = Moment(
        bundle_id=bundle_id,
        file_id=file_id,
        start_s=start_s,
        end_s=end_s,
        comment=_clean_comment(comment),
        tags=tags,
    )
    session.add(moment)
    _propagate_tags_to_bundle(session, bundle, tags)
    session.flush()
    return moment


def _clean_comment(comment: str | None) -> str | None:
    """Blank is absent. A comment box emptied out should leave no comment behind,
    rather than an empty string that renders as a zero-height line."""
    if comment is None:
        return None
    stripped = comment.strip()
    return stripped or None


def update_moment(
    session: Session,
    bundle_id: str,
    moment_id: str,
    changes: dict[str, object],
    *,
    expected_version: int | None = None,
) -> Moment:
    """Move a moment's ends or rewrite its comment.

    ``changes`` carries only the fields the client explicitly set, so passing
    ``end_s: null`` turns a range back into a frame while omitting it leaves the
    span alone — the same "set to null vs leave unchanged" distinction
    ``update_bundle`` draws.
    """
    moment = get_moment(session, bundle_id, moment_id)
    guard_and_bump_version(moment, expected_version)

    start_s = moment.start_s
    end_s = moment.end_s
    if "start_s" in changes:
        start_s = float(changes["start_s"])  # type: ignore[arg-type]
    if "end_s" in changes:
        raw_end = changes["end_s"]
        end_s = None if raw_end is None else float(raw_end)  # type: ignore[arg-type]
    _validate_span(start_s, end_s)
    moment.start_s = start_s
    moment.end_s = end_s

    if "comment" in changes:
        moment.comment = _clean_comment(changes["comment"])  # type: ignore[arg-type]

    moment.updated_at = utcnow()
    session.flush()
    return moment


def set_moment_tags(
    session: Session, bundle_id: str, moment_id: str, tag_ids: list[str]
) -> tuple[Moment, AssetBundle]:
    """Replace a moment's tags, and add the new set to its bundle.

    Returns the bundle as well so the route can answer with the resulting bundle
    tags: the client's chips then update from the same answer that changed them,
    rather than from a later refetch that can disagree with it.
    """
    moment = get_moment(session, bundle_id, moment_id)
    bundle = _require_bundle(session, bundle_id)
    tags = _resolve_tags(session, tag_ids)
    moment.tags = tags
    moment.updated_at = utcnow()
    _propagate_tags_to_bundle(session, bundle, tags)
    session.flush()
    return moment, bundle


def delete_moment(session: Session, bundle_id: str, moment_id: str) -> None:
    """Forget a moment. Its tags stay on the bundle (plan 7 §4.1)."""
    moment = get_moment(session, bundle_id, moment_id)
    session.delete(moment)
    session.flush()
