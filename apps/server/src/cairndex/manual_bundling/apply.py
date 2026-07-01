"""Explicit, metadata-only manual bundling mutations.

Each operation confirms a user grouping decision the same way grouping-plan
apply does: it re-parents ``AssetFile`` rows (keeping their ids so subtitles,
thumbnails, and notes survive), reaps provisional source bundles the move
emptied, and auto-links external subtitles — never touching the filesystem.

The source of every operation is restricted to *unbundled* files (scan-staged
provisional bundles). Moving a file out of an already-confirmed bundle is
intentionally not supported here yet (see docs/adr/0009).
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from cairndex.core.errors import NotFoundError, ValidationError
from cairndex.core.time import utcnow
from cairndex.domain.enums import (
    FileRole,
    GroupingSource,
    GroupingState,
    MediaKind,
)
from cairndex.grouping.membership import reap_source_bundles
from cairndex.grouping.suggester import (
    SUGGESTER_RULE_VERSION,
    FileObservation,
    _addition_roles,
    _assign_roles,
    _stem,
)
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.services.subtitles import auto_link_external_subtitles


@dataclass(frozen=True)
class ManualBundleResult:
    """Outcome of a manual bundling mutation, for cache invalidation + a summary."""

    bundle_id: str
    files_added: int = 0
    bundles_removed: int = 0
    subtitles_linked: int = 0
    created: bool = False


def _observation(row: AssetFile) -> FileObservation:
    return FileObservation(
        asset_file_id=row.id,
        relative_path=row.relative_path,
        media_kind=row.media_kind,
    )


def _load_unbundled_files(session: Session, file_ids: list[str]) -> list[AssetFile]:
    """Load the given files, requiring each to be an unbundled (scan-staged
    provisional) file. Deduplicates while preserving order."""
    rows: list[AssetFile] = []
    seen: set[str] = set()
    for file_id in file_ids:
        if file_id in seen:
            continue
        seen.add(file_id)
        row = session.get(AssetFile, file_id)
        if row is None:
            raise NotFoundError(f"file {file_id!r} does not exist")
        bundle = row.bundle
        is_unbundled = (
            bundle.grouping_state is GroupingState.PROVISIONAL
            and bundle.grouping_source is GroupingSource.SCAN_SUGGESTION
        )
        if not is_unbundled:
            raise ValidationError(
                f"file {file_id!r} is not an unbundled file; only scan-staged "
                "files can be manually bundled"
            )
        rows.append(row)
    return rows


def _apply_overrides(
    role_by_id: dict[str, FileRole], role_overrides: dict[str, FileRole] | None
) -> dict[str, FileRole]:
    if role_overrides:
        role_by_id = {**role_by_id, **role_overrides}
    return role_by_id


def _next_sequence(session: Session, bundle_id: str) -> int:
    current = session.scalar(
        select(func.coalesce(func.max(AssetFile.sequence), -1)).where(
            AssetFile.bundle_id == bundle_id
        )
    )
    return int(current if current is not None else -1) + 1


def add_unbundled_files_to_bundle(
    session: Session,
    target_bundle_id: str,
    file_ids: list[str],
    *,
    role_overrides: dict[str, FileRole] | None = None,
) -> ManualBundleResult:
    """Fold selected unbundled files into an existing *confirmed* bundle.

    Roles follow the grouping "addition" heuristic (an added image is an image,
    a video a part, a subtitle a subtitle), overridable per file. Sequences are
    appended after the bundle's existing files. Provisional source bundles the
    move empties are removed; external subtitles are re-linked.
    """
    target = session.get(AssetBundle, target_bundle_id)
    if target is None:
        raise NotFoundError(f"bundle {target_bundle_id!r} does not exist")
    if target.grouping_state is not GroupingState.CONFIRMED:
        raise ValidationError("target bundle must be a confirmed bundle")

    rows = _load_unbundled_files(session, file_ids)
    if not rows:
        raise ValidationError("select at least one unbundled file to add")

    proposed = _addition_roles([_observation(r) for r in rows])
    role_by_id = _apply_overrides({p.asset_file_id: p.role for p in proposed}, role_overrides)
    row_by_id = {r.id: r for r in rows}

    base_sequence = _next_sequence(session, target.id)
    source_bundles: set[AssetBundle] = set()
    for offset, p in enumerate(proposed):
        row = row_by_id[p.asset_file_id]
        source_bundles.add(row.bundle)
        row.bundle_id = target.id
        row.role = role_by_id[row.id]
        row.sequence = base_sequence + offset
    session.flush()

    removed = reap_source_bundles(session, source_bundles)
    subtitles = len(auto_link_external_subtitles(session, target.id))
    session.commit()
    return ManualBundleResult(
        bundle_id=target.id,
        files_added=len(rows),
        bundles_removed=removed,
        subtitles_linked=subtitles,
    )


def create_bundle_from_unbundled(
    session: Session,
    file_ids: list[str],
    *,
    title: str | None = None,
    role_overrides: dict[str, FileRole] | None = None,
) -> ManualBundleResult:
    """Confirm a new bundle from one or more selected unbundled files.

    One selected file's provisional bundle is reused as the confirmed target
    (preserving its id and any thumbnail cache); the other selected files move
    in and their now-empty provisional bundles are reaped. Roles follow the
    grouping heuristic (cover/primary aware), overridable per file.
    """
    rows = _load_unbundled_files(session, file_ids)
    if not rows:
        raise ValidationError("select at least one unbundled file to bundle")

    proposed = _assign_roles([_observation(r) for r in rows])
    role_by_id = _apply_overrides({p.asset_file_id: p.role for p in proposed}, role_overrides)
    row_by_id = {r.id: r for r in rows}

    # Reuse the first (natural-order) file's provisional bundle as the target so
    # its id/thumbnail identity survives, mirroring grouping-apply's merge.
    target = row_by_id[proposed[0].asset_file_id].bundle
    source_bundles: set[AssetBundle] = set()
    for p in proposed:
        row = row_by_id[p.asset_file_id]
        if row.bundle_id != target.id:
            source_bundles.add(row.bundle)
        row.bundle_id = target.id
        row.role = role_by_id[row.id]
        row.sequence = p.sequence
    session.flush()

    target.title = title or target.title or _default_title(rows)
    target.grouping_state = GroupingState.CONFIRMED
    target.grouping_source = GroupingSource.MANUAL
    target.grouping_rule_version = SUGGESTER_RULE_VERSION
    target.confirmed_at = utcnow()
    members = [row_by_id[p.asset_file_id] for p in proposed]
    cover = next((m for m in members if m.role is FileRole.COVER), None)
    primary = next((m for m in members if m.role is FileRole.PRIMARY_VIDEO), None)
    target.cover_file_id = cover.id if cover is not None else None
    target.primary_file_id = primary.id if primary is not None else None
    session.flush()

    removed = reap_source_bundles(session, source_bundles)
    subtitles = len(auto_link_external_subtitles(session, target.id))
    session.commit()
    return ManualBundleResult(
        bundle_id=target.id,
        files_added=len(rows),
        bundles_removed=removed,
        subtitles_linked=subtitles,
        created=True,
    )


def create_empty_bundle(session: Session, *, title: str | None = None) -> ManualBundleResult:
    """Create a confirmed, empty bundle (the owner will add files next)."""
    bundle = AssetBundle(
        title=(title or "").strip() or None,
        grouping_state=GroupingState.CONFIRMED,
        grouping_source=GroupingSource.MANUAL,
        confirmed_at=utcnow(),
    )
    session.add(bundle)
    session.commit()
    return ManualBundleResult(bundle_id=bundle.id, created=True)


def _default_title(rows: list[AssetFile]) -> str:
    """A sensible bundle title when the user gave none: the primary video's stem,
    else the first file's stem."""
    video = next((r for r in rows if r.media_kind is MediaKind.VIDEO), None)
    source = video or rows[0]
    return _stem(source.relative_path) or source.original_filename
