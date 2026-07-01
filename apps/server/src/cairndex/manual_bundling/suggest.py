"""Read-only ranked suggestions for the manual bundling assistant.

All three generators work purely from the library DB and the FTS search index —
never a filesystem scan — and reuse the grouping suggester's name-parsing so a
manual suggestion matches what scan-time grouping would have produced:

- :func:`suggest_target_bundles` — for selected unbundled files, the confirmed
  bundles they most likely belong to.
- :func:`suggest_unbundled_files_for_bundle` — for a bundle, the unbundled files
  that most likely belong in it (sidecars, covers, subtitles, parts).
- :func:`suggest_bundle_from_files` — for a seed selection, a proposed
  title/roles plus nearby unbundled files worth including.

Scoring leads with content locality (same folder, shared subject prefix) and
falls back to token overlap, mirroring the grouping heuristic's stance: every
suggestion carries a human-readable reason, and nothing is auto-applied.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from cairndex.core.paths import PathSafetyError, normalize_relative_path
from cairndex.domain.enums import FileRole, GroupingSource, GroupingState, MediaKind
from cairndex.grouping.suggester import (
    _COVER_STEMS,
    _assign_roles,
    _basename,
    _dirname,
    _part_base,
    _stem,
    _subject_prefix,
)
from cairndex.grouping.suggester import (
    FileObservation as _Observation,
)
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.scanning.media_types import classify
from cairndex.search import matching_ids_select, to_match_query

# Cap the candidate set each generator scores, so suggestions stay fast on large
# libraries: candidates come only from bounded folder/FTS lookups, never a full
# table scan.
_CANDIDATE_CAP = 200
_MAX_MATCH_TERMS = 16

_TOKEN = re.compile(r"[^a-z0-9]+")


@dataclass(frozen=True)
class TargetSuggestion:
    bundle_id: str
    title: str | None
    confidence: float
    reason: str


@dataclass(frozen=True)
class FileSuggestion:
    file_id: str
    relative_path: str
    media_kind: MediaKind
    confidence: float
    reason: str


@dataclass(frozen=True)
class ProposedRole:
    file_id: str
    relative_path: str
    role: FileRole
    sequence: int


@dataclass(frozen=True)
class BundleDraft:
    """A proposed confirmed bundle from a seed selection: a title + per-file
    roles for the seed, plus nearby unbundled files worth adding."""

    proposed_title: str
    roles: list[ProposedRole] = field(default_factory=list)
    additional: list[FileSuggestion] = field(default_factory=list)


@dataclass(frozen=True)
class _Context:
    """The name signals a target is described by, for scoring candidates."""

    tokens: frozenset[str]
    dirs: frozenset[str]
    prefixes: frozenset[str]


# --- name signals ------------------------------------------------------------


def _tokens(relative_path: str, *, title: str | None = None) -> set[str]:
    """Meaningful lowercase tokens from a path's stem + parent-dir name (and an
    optional title), dropping 1-char noise."""
    stem = _stem(relative_path).lower()
    parent = _basename(_dirname(relative_path)).lower()
    blob = f"{parent} {stem} {(title or '').lower()}"
    return {t for t in _TOKEN.split(blob) if len(t) >= 2}


def _file_context(rows: list[tuple[str, MediaKind]], *, title: str | None = None) -> _Context:
    tokens: set[str] = set(_TOKEN.split((title or "").lower())) if title else set()
    tokens = {t for t in tokens if len(t) >= 2}
    dirs: set[str] = set()
    prefixes: set[str] = set()
    for relative_path, _kind in rows:
        tokens |= _tokens(relative_path)
        dirs.add(_dirname(relative_path))
        prefix = _subject_prefix(relative_path)
        if prefix:
            prefixes.add(prefix)
    return _Context(frozenset(tokens), frozenset(dirs), frozenset(prefixes))


def _score(relative_path: str, media_kind: MediaKind, ctx: _Context) -> tuple[float, str] | None:
    """Score one candidate file against a target context. Returns a (confidence,
    reason) pair, or ``None`` when there is no meaningful signal."""
    score = 0.0
    reasons: list[str] = []
    candidate_dir = _dirname(relative_path)
    candidate_prefix = _subject_prefix(relative_path)

    if candidate_dir and candidate_dir in ctx.dirs:
        score += 0.5
        reasons.append("same folder")
    if candidate_prefix and candidate_prefix in ctx.prefixes:
        score += 0.3
        reasons.append(f"shares name “{candidate_prefix}”")
    common = _tokens(relative_path) & ctx.tokens
    if common:
        score += min(0.3, 0.1 * len(common))
        if not reasons:
            preview = ", ".join(sorted(common)[:3])
            reasons.append(f"similar name ({preview})")

    # Sidecar / multipart hints reinforce an already-related file.
    stem = _stem(relative_path).lower()
    if reasons:
        if stem in _COVER_STEMS:
            score += 0.15
            reasons.append("looks like a cover")
        if media_kind is MediaKind.SUBTITLE:
            score += 0.1
            reasons.append("subtitle sidecar")
        if _part_base(relative_path) is not None:
            score += 0.1
            reasons.append("multipart part")

    if score <= 0 or not reasons:
        return None
    return min(0.99, score), "; ".join(dict.fromkeys(reasons))  # dedupe, keep order


# --- candidate gathering (bounded DB/FTS lookups) ----------------------------


def _like_prefix(directory: str) -> str:
    escaped = directory.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"{escaped}/%"


def _or_match(tokens: frozenset[str]) -> str | None:
    """An FTS5 OR of prefix terms, e.g. ``"cosmos"* OR "ep"*``. ``to_match_query``
    sanitizes each token (they are already ``[a-z0-9]``) into a safe quoted term."""
    picked = sorted(tokens)[:_MAX_MATCH_TERMS]
    terms = [to_match_query(t) for t in picked]
    usable = [t for t in terms if t]
    return " OR ".join(usable) if usable else None


def _dir_bundle_ids(
    session: Session, dirs: frozenset[str], *, confirmed: bool, cap: int
) -> set[str]:
    state = GroupingState.CONFIRMED if confirmed else GroupingState.PROVISIONAL
    ids: set[str] = set()
    for directory in dirs:
        if not directory or len(ids) >= cap:
            continue
        stmt: Select[tuple[str]] = (
            select(AssetFile.bundle_id)
            .join(AssetBundle, AssetFile.bundle_id == AssetBundle.id)
            .where(AssetBundle.grouping_state == state)
            .where(AssetFile.relative_path.like(_like_prefix(directory), escape="\\"))
            .limit(cap)
        )
        if not confirmed:
            stmt = stmt.where(AssetBundle.grouping_source == GroupingSource.SCAN_SUGGESTION)
        ids.update(session.scalars(stmt).all())
    return ids


def _fts_bundle_ids(
    session: Session, tokens: frozenset[str], *, confirmed: bool, cap: int
) -> set[str]:
    match = _or_match(tokens)
    if match is None:
        return set()
    matched = session.scalars(matching_ids_select(match).limit(cap)).all()
    if not matched:
        return set()
    state = GroupingState.CONFIRMED if confirmed else GroupingState.PROVISIONAL
    stmt = (
        select(AssetBundle.id)
        .where(AssetBundle.id.in_(matched))
        .where(AssetBundle.grouping_state == state)
    )
    if not confirmed:
        stmt = stmt.where(AssetBundle.grouping_source == GroupingSource.SCAN_SUGGESTION)
    return set(session.scalars(stmt).all())


def _unbundled_files_for(
    session: Session, ctx: _Context, *, exclude: set[str], cap: int
) -> list[AssetFile]:
    ids = _dir_bundle_ids(session, ctx.dirs, confirmed=False, cap=cap)
    ids |= _fts_bundle_ids(session, ctx.tokens, confirmed=False, cap=cap)
    if not ids:
        return []
    rows = session.scalars(
        select(AssetFile).where(AssetFile.bundle_id.in_(ids)).limit(cap * 2)
    ).all()
    return [r for r in rows if r.id not in exclude]


# --- generators --------------------------------------------------------------


@dataclass(frozen=True)
class _Seed:
    """A selected file for suggestion, from either a linked ``file_id`` or a
    File-View ``relative_path``. ``identity`` is the file id when linked, else the
    path (used only as a role key; unlinked paths have no row yet)."""

    identity: str
    relative_path: str
    media_kind: MediaKind
    name: str


def _seeds(
    session: Session, file_ids: list[str] | None, relative_paths: list[str] | None
) -> list[_Seed]:
    """Read-only resolution of selected ids/paths to seeds (no staging), deduped
    by path. Unlinked paths are classified for a media kind."""
    seeds: list[_Seed] = []
    seen: set[str] = set()
    for fid in dict.fromkeys(file_ids or []):
        row = session.get(AssetFile, fid)
        if row is None or row.relative_path in seen:
            continue
        seen.add(row.relative_path)
        seeds.append(_Seed(row.id, row.relative_path, row.media_kind, row.original_filename))
    for raw in relative_paths or []:
        try:
            rel = normalize_relative_path(raw)
        except PathSafetyError:
            continue
        if rel in seen:
            continue
        seen.add(rel)
        existing = session.scalar(select(AssetFile).where(AssetFile.relative_path == rel))
        name = rel.rsplit("/", 1)[-1]
        if existing is not None:
            seeds.append(_Seed(existing.id, rel, existing.media_kind, existing.original_filename))
        else:
            classification = classify(name)
            kind = classification[0] if classification else MediaKind.OTHER
            seeds.append(_Seed(rel, rel, kind, name))
    return seeds


def suggest_target_bundles(
    session: Session,
    file_ids: list[str] | None = None,
    *,
    relative_paths: list[str] | None = None,
    limit: int = 10,
) -> list[TargetSuggestion]:
    """Rank confirmed bundles the selected unbundled files most likely join."""
    selected = _seeds(session, file_ids, relative_paths)
    if not selected:
        return []
    selected_ctx = _file_context([(s.relative_path, s.media_kind) for s in selected])

    candidate_ids = _dir_bundle_ids(session, selected_ctx.dirs, confirmed=True, cap=_CANDIDATE_CAP)
    candidate_ids |= _fts_bundle_ids(
        session, selected_ctx.tokens, confirmed=True, cap=_CANDIDATE_CAP
    )
    if not candidate_ids:
        return []

    bundles = session.scalars(select(AssetBundle).where(AssetBundle.id.in_(candidate_ids))).all()
    files_by_bundle: dict[str, list[tuple[str, MediaKind]]] = defaultdict(list)
    for bundle_id, relative_path, media_kind in session.execute(
        select(AssetFile.bundle_id, AssetFile.relative_path, AssetFile.media_kind).where(
            AssetFile.bundle_id.in_(candidate_ids)
        )
    ):
        files_by_bundle[bundle_id].append((relative_path, media_kind))

    suggestions: list[TargetSuggestion] = []
    for bundle in bundles:
        bundle_ctx = _file_context(files_by_bundle.get(bundle.id, []), title=bundle.title)
        best: tuple[float, str] | None = None
        for seed in selected:
            scored = _score(seed.relative_path, seed.media_kind, bundle_ctx)
            if scored is not None and (best is None or scored[0] > best[0]):
                best = scored
        if best is not None:
            suggestions.append(
                TargetSuggestion(bundle.id, bundle.title, round(best[0], 3), best[1])
            )
    suggestions.sort(key=lambda s: (-s.confidence, (s.title or "").lower(), s.bundle_id))
    return suggestions[:limit]


def suggest_unbundled_files_for_bundle(
    session: Session, bundle_id: str, *, limit: int = 30
) -> list[FileSuggestion]:
    """Rank unbundled files that most likely belong in ``bundle_id``."""
    bundle = session.get(AssetBundle, bundle_id)
    if bundle is None:
        return []
    own_files = session.execute(
        select(AssetFile.relative_path, AssetFile.media_kind).where(
            AssetFile.bundle_id == bundle_id
        )
    ).all()
    ctx = _file_context([(p, k) for p, k in own_files], title=bundle.title)

    candidates = _unbundled_files_for(session, ctx, exclude=set(), cap=_CANDIDATE_CAP)
    suggestions: list[FileSuggestion] = []
    for row in candidates:
        scored = _score(row.relative_path, row.media_kind, ctx)
        if scored is not None:
            suggestions.append(
                FileSuggestion(
                    row.id, row.relative_path, row.media_kind, round(scored[0], 3), scored[1]
                )
            )
    suggestions.sort(key=lambda s: (-s.confidence, s.relative_path))
    return suggestions[:limit]


def suggest_bundle_from_files(
    session: Session,
    file_ids: list[str] | None = None,
    *,
    relative_paths: list[str] | None = None,
    limit: int = 30,
) -> BundleDraft:
    """Propose a title + per-file roles for a seed selection, plus nearby
    unbundled files worth including."""
    selected = _seeds(session, file_ids, relative_paths)
    if not selected:
        return BundleDraft(proposed_title="")

    observations = [_Observation(s.identity, s.relative_path, s.media_kind) for s in selected]
    by_id = {s.identity: s for s in selected}
    roles = [
        ProposedRole(p.asset_file_id, by_id[p.asset_file_id].relative_path, p.role, p.sequence)
        for p in _assign_roles(observations)
    ]

    video = next((s for s in selected if s.media_kind is MediaKind.VIDEO), selected[0])
    proposed_title = _stem(video.relative_path) or video.name

    seed_ctx = _file_context([(s.relative_path, s.media_kind) for s in selected])
    seed_ids = {s.identity for s in selected}
    seed_paths = {s.relative_path for s in selected}
    additional: list[FileSuggestion] = []
    for row in _unbundled_files_for(session, seed_ctx, exclude=seed_ids, cap=_CANDIDATE_CAP):
        if row.relative_path in seed_paths:
            continue  # a selected path that is already a provisional row
        scored = _score(row.relative_path, row.media_kind, seed_ctx)
        if scored is not None:
            additional.append(
                FileSuggestion(
                    row.id, row.relative_path, row.media_kind, round(scored[0], 3), scored[1]
                )
            )
    additional.sort(key=lambda s: (-s.confidence, s.relative_path))
    return BundleDraft(proposed_title=proposed_title, roles=roles, additional=additional[:limit])
