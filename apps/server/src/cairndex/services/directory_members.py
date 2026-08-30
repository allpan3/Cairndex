"""Directory members — a folder standing in for its files as one bundle row.

Plan 6. An album of a thousand photos should be one row in the inspector and one
row in the grouping dialog. This service records *which directories are
entities*; it never moves a file between bundles, never writes membership, and
never touches the filesystem. Which files a folder row stands for is derived at
read time from the index on ``asset_files.directory_path``.

That is what makes the pair of operations here symmetric and lossless:
``collapse_directory`` inserts one row and ``expand_directory`` deletes one, and
neither can lose a file row, an ``AssetFile.id``, a rating, a tag, or a saved
playback position, because none of those is consulted or written.
"""

from sqlalchemy import ColumnElement, Select, and_, case, func, or_, select
from sqlalchemy.orm import Session

from cairndex.core.errors import ConflictError, NotFoundError, ValidationError
from cairndex.core.paths import PathSafetyError, normalize_relative_path
from cairndex.domain.enums import FileAvailability
from cairndex.persistence.models import AssetBundle, AssetFile, BundleDirectoryMember

# One past "/" in ASCII ("/" is 0x2F, "0" is 0x30). A path is inside directory
# ``p`` exactly when it sorts in ``[p + "/", p + "0")``, which is the same set as
# ``LIKE 'p/%'`` but expressed as a range: SQLite will use the index on
# ``directory_path`` for it unconditionally, where a LIKE depends on collation
# and the ``case_sensitive_like`` pragma. It also sidesteps LIKE escaping — a
# real directory name may contain ``%`` or ``_``.
_AFTER_SEPARATOR = "0"


def _subtree_of(directory_path: str) -> ColumnElement[bool]:
    """Match ``directory_path`` itself and everything beneath it.

    A folder member stands for the whole folder, subfolders included: the owner's
    case is "every item in the folder is in the bundle", and opening the row
    hands off to the File Browser at that folder, which shows the subtree too.
    Matching only the exact directory would leave a nested album's files loose in
    the bundle, which is the problem this exists to solve.
    """
    return or_(
        AssetFile.directory_path == directory_path,
        and_(
            AssetFile.directory_path >= f"{directory_path}/",
            AssetFile.directory_path < f"{directory_path}{_AFTER_SEPARATOR}",
        ),
    )


def _require_bundle(session: Session, bundle_id: str) -> None:
    """404 for an unknown bundle.

    A local lookup rather than ``bundles.get_bundle``: the bundle service needs
    *this* module (to prune a folder row whose files have all left), and
    importing back the other way is a cycle. This is the lower layer, so it owns
    the two lines.
    """
    if session.get(AssetBundle, bundle_id) is None:
        raise NotFoundError(f"bundle {bundle_id!r} not found")


def normalize_directory_path(raw: str) -> str:
    """Validate a client-supplied directory into the stored form, or raise.

    Reuses the library-root path guard every other client path goes through
    (AGENTS.md: never trust a client-supplied absolute path), then strips a
    trailing slash so the value compares byte-for-byte with the
    ``AssetFile.directory_path`` the model's validator derives.
    """
    try:
        return normalize_relative_path(raw).rstrip("/")
    except PathSafetyError as exc:
        raise ValidationError(str(exc)) from exc


def list_members(session: Session, bundle_id: str) -> list[BundleDirectoryMember]:
    """This bundle's folder rows, in the bundle's own file order."""
    _require_bundle(session, bundle_id)
    stmt = (
        select(BundleDirectoryMember)
        .where(BundleDirectoryMember.bundle_id == bundle_id)
        .order_by(BundleDirectoryMember.sequence, BundleDirectoryMember.id)
    )
    return list(session.scalars(stmt))


def _files_under_stmt(bundle_id: str, directory_path: str) -> Select[tuple[AssetFile]]:
    return select(AssetFile).where(
        AssetFile.bundle_id == bundle_id,
        _subtree_of(directory_path),
    )


def files_under(
    session: Session, bundle_id: str, directory_path: str, *, include_trashed: bool = False
) -> list[AssetFile]:
    """The bundle's own files inside a directory, in the bundle's file order.

    Scoped to one bundle deliberately (plan 6 §4.2). A sibling file in the same
    folder that was filed into a *different* bundle keeps its own row there and
    is not collapsed here — a folder row is a member of one bundle and can only
    honestly speak for that bundle's files.
    """
    stmt = _files_under_stmt(bundle_id, directory_path)
    if not include_trashed:
        stmt = stmt.where(AssetFile.availability != FileAvailability.TRASHED)
    return list(session.scalars(stmt.order_by(AssetFile.sequence, AssetFile.id)))


def file_counts(session: Session, bundle_id: str) -> dict[str, int]:
    """Visible file count per folder row, keyed by member id.

    One query for the whole bundle rather than one per row, because the
    inspector draws every folder together and a per-row count would grow with
    the number of folders on a path that already runs on every open.

    The CASE is unambiguous because folder rows cannot nest (``_reject_overlap``)
    — their ranges are disjoint, so no file can fall in two of them and "the
    first arm that matches" is also the only arm that matches.
    """
    members = list_members(session, bundle_id)
    if not members:
        return {}
    subtrees = [(_subtree_of(member.directory_path), member.id) for member in members]
    owner = case(*subtrees, else_=None)
    rows = session.execute(
        select(owner.label("member_id"), func.count())
        .select_from(AssetFile)
        .where(
            AssetFile.bundle_id == bundle_id,
            AssetFile.availability != FileAvailability.TRASHED,
            or_(*(predicate for predicate, _ in subtrees)),
        )
        .group_by(owner)
    ).all()
    counted = {member_id: count for member_id, count in rows if member_id is not None}
    # A folder whose files are all trashed still has a row and still needs a
    # number; the GROUP BY cannot produce one for it.
    return {member.id: counted.get(member.id, 0) for member in members}


def _reject_overlap(session: Session, directory_path: str) -> None:
    """Refuse a folder that nests with one that already exists.

    The unique constraint only stops the *same* directory being claimed twice;
    a parent or a child of an existing entity is a different string. Nesting is
    still an open question (plan 6 §5.1) and this is the reversible answer:
    refusing costs one error message today and can be relaxed later, where
    allowing it and then forbidding it would need a migration and a rule for
    what to do with rows already nested.
    """
    existing = session.scalars(select(BundleDirectoryMember)).all()
    for member in existing:
        other = member.directory_path
        if other == directory_path:
            raise ConflictError(f"{directory_path!r} is already a folder member")
        if directory_path.startswith(f"{other}/"):
            raise ConflictError(f"{directory_path!r} is inside the folder member {other!r}")
        if other.startswith(f"{directory_path}/"):
            raise ConflictError(f"{directory_path!r} contains the folder member {other!r}")


def collapse_directory(
    session: Session, bundle_id: str, directory_path: str
) -> BundleDirectoryMember:
    """Make one of a bundle's directories stand in for its files as a single row.

    Metadata-only and instantly reversible by ``expand_directory``: no file row
    is written, so there is nothing to restore afterwards.
    """
    _require_bundle(session, bundle_id)
    normalized = normalize_directory_path(directory_path)
    _reject_overlap(session, normalized)

    files = files_under(session, bundle_id, normalized, include_trashed=True)
    if not files:
        # A folder row that stands for nothing would render as an empty row the
        # owner cannot explain and cannot fill — the files it would collapse are
        # in other bundles, or not indexed at all.
        raise ValidationError(f"bundle {bundle_id!r} has no files in {normalized!r}")

    member = BundleDirectoryMember(
        bundle_id=bundle_id,
        directory_path=normalized,
        # Land where the contents were, so collapsing does not also reorder the
        # bundle. ``min`` over the files it replaces is the only position that
        # leaves every other row where the owner last put it.
        sequence=min(f.sequence for f in files),
    )
    session.add(member)
    session.flush()
    return member


def expand_directory(session: Session, bundle_id: str, member_id: str) -> None:
    """Undo a collapse: the folder's files show individually again.

    Deleting the row is the whole operation. The files never stopped being
    members of the bundle — they were only drawn differently.
    """
    member = session.get(BundleDirectoryMember, member_id)
    if member is None or member.bundle_id != bundle_id:
        raise NotFoundError(f"folder member {member_id!r} is not part of bundle {bundle_id!r}")
    session.delete(member)
    session.flush()


def bundle_by_directory(session: Session) -> dict[str, str]:
    """Every entity directory in the library, mapped to the bundle that owns it.

    One query over a table with a row per folder the owner has collapsed — tens,
    not thousands — so the scanner can consult it once per pass rather than per
    file.
    """
    return {
        member.directory_path: member.bundle_id
        for member in session.scalars(select(BundleDirectoryMember))
    }


def owning_bundle_for(relative_path: str, by_directory: dict[str, str]) -> str | None:
    """The bundle a newly-found file should join because it landed in its folder.

    Walks the path's ancestors nearest-first. Nesting is refused, so at most one
    can match; walking nearest-first anyway means this still does the sane thing
    if that rule is ever relaxed.

    Costs the path's depth, not the number of folder members — a scan asks this
    for every new file it finds.
    """
    if not by_directory:
        return None
    parent = relative_path.rpartition("/")[0]
    while parent:
        owner = by_directory.get(parent)
        if owner is not None:
            return owner
        parent = parent.rpartition("/")[0]
    return None


def repair_after_moves(session: Session, moves: list[tuple[str, str]]) -> int:
    """Follow folder members through a scan's moved-file repairs (plan 6 §4.4).

    ``moves`` is ``(old_relative_path, new_relative_path)`` for every file the
    scan repaired. Move repair rewrites ``relative_path`` and re-derives
    ``directory_path``, so a renamed folder's *files* repair themselves; only the
    row naming the directory is left pointing at a path that no longer exists.

    For each folder member, the files that moved out of it imply where it went.
    The implied destination is computed by stripping each file's path *below* the
    folder, so a file nested two levels down votes for the folder's new location
    rather than its own parent's.

    One implied destination and the row follows. Several, and the folder is not a
    folder anymore — the row is dropped and its files list individually, which is
    a visible, harmless failure and the right one: the alternative is a row
    pointing at nothing. Dropped too if something else already claims the
    destination, since a directory belongs to at most one bundle.

    Returns how many rows were repaired or dropped.
    """
    if not moves:
        return 0
    members = list(session.scalars(select(BundleDirectoryMember)))
    if not members:
        return 0
    claimed = {member.directory_path for member in members}
    touched = 0

    for member in members:
        prefix = f"{member.directory_path}/"
        destinations: set[str] = set()
        for old_path, new_path in moves:
            if not old_path.startswith(prefix):
                continue
            below = old_path[len(prefix) :]
            # The file kept its position inside the folder, so whatever precedes
            # that suffix is where the folder now is. A file that also changed
            # name or depth says nothing about the folder and is skipped rather
            # than guessed at.
            if new_path.endswith(f"/{below}"):
                destinations.add(new_path[: -len(below) - 1])
        if not destinations:
            continue
        touched += 1
        moved_to = next(iter(destinations)) if len(destinations) == 1 else None
        if moved_to is None or (moved_to in claimed and moved_to != member.directory_path):
            session.delete(member)
            claimed.discard(member.directory_path)
            continue
        claimed.discard(member.directory_path)
        claimed.add(moved_to)
        member.directory_path = moved_to
    session.flush()
    return touched


def prune_empty(session: Session, bundle_id: str) -> int:
    """Drop folder rows this bundle no longer has any files under.

    A folder row stands for files; once none of them are the bundle's any more it
    stands for nothing, and renders as "Folder · 0 files" with no way to fill it.
    Removing a file from a bundle repoints it, so the last removal has to take
    the row with it.

    Counts **trashed files too**, deliberately. Trashing keeps a file in its
    bundle and only changes its availability, so a bundle whose folder is
    entirely in the trash must keep the row — Put back has to find it there
    (ADR-0013). Only a file that actually left the bundle counts as gone.
    """
    # Queries directly rather than through ``list_members``, which 404s on an
    # unknown bundle: forgetting the last missing file deletes the bundle it
    # emptied, and a cleanup pass must tolerate arriving after that. The cascade
    # has already taken its folder rows in that case, so there is nothing to do.
    members = session.scalars(
        select(BundleDirectoryMember)
        .where(BundleDirectoryMember.bundle_id == bundle_id)
        .order_by(BundleDirectoryMember.sequence, BundleDirectoryMember.id)
    ).all()
    removed = 0
    for member in members:
        if files_under(session, bundle_id, member.directory_path, include_trashed=True):
            continue
        session.delete(member)
        removed += 1
    if removed:
        session.flush()
    return removed
