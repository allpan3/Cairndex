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

Scoring leads with content locality (folder proximity, shared subject prefix) and
falls back to token overlap, mirroring the grouping heuristic's stance: every
suggestion carries a human-readable reason, and nothing is auto-applied.

Locality is a *containment* relation, read in whichever direction the generator
needs: a bundle is a candidate home for a file when the bundle's folder encloses
(or is) the file's, and an unbundled file is a candidate member when it sits in
the bundle's folder or beneath it. Both directions resolve through the indexed
``asset_files.directory_path`` — an equality probe per enclosing directory, a
range probe per subtree — because these generators run on dialog open, on
libraries with millions of rows.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import Select, and_, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

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

# How far up the tree a bundle may sit and still be offered for a file landing
# beneath it. Bounded for two reasons: it fixes the number of indexed probes per
# lookup, and past a few levels the signal is noise — every import into a deep
# tree would otherwise match whatever bundle happens to live near the library
# root. Three levels covers the shapes that occur (a file added into a bundle's
# own folder, or one or two folders below it).
_MAX_ANCESTOR_LEVELS = 3

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


def _ancestors(directory: str, *, levels: int = _MAX_ANCESTOR_LEVELS) -> list[str]:
    """``directory`` and up to ``levels`` enclosing directories, nearest first.

    The library root (``""``) is deliberately **not** in the chain. It encloses
    every path in the library, so matching on it is not evidence of anything: it
    would make every root-level bundle a candidate for every import, and give
    every bundle the same locality credit on a library that keeps its files at
    the top. Name signals are the only meaningful ones there, and they still run.
    """
    chain = [directory] if directory else []
    current = directory
    for _ in range(levels):
        current = _dirname(current)
        if not current:
            break
        chain.append(current)
    return chain


def _enclosing_distance(directory: str, ctx_dirs: frozenset[str]) -> int | None:
    """How far above ``directory`` the nearest context directory sits: 0 when one
    of them *is* it, 1 for its parent, and so on. ``None`` when none encloses it
    within the bounded walk."""
    for distance, ancestor in enumerate(_ancestors(directory)):
        if ancestor in ctx_dirs:
            return distance
    return None


def _proximity_reason(distance: int) -> str:
    if distance == 0:
        return "same folder"
    if distance == 1:
        return "parent folder"
    return f"{distance} folders up"


def _score(relative_path: str, media_kind: MediaKind, ctx: _Context) -> tuple[float, str] | None:
    """Score one candidate file against a target context. Returns a (confidence,
    reason) pair, or ``None`` when there is no meaningful signal."""
    score = 0.0
    reasons: list[str] = []
    candidate_dir = _dirname(relative_path)
    candidate_prefix = _subject_prefix(relative_path)

    # Folder proximity, decaying with distance: sharing a folder is the strongest
    # single signal there is, a folder or two below it is a real but weaker one.
    # Deliberately blended with the name terms rather than dominating them — an
    # exact name match one folder up beats an unrelated bundle in the same folder,
    # which is the ordering the owner would pick by hand.
    distance = _enclosing_distance(candidate_dir, ctx.dirs)
    if distance is not None:
        score += 0.5 / (distance + 1)
        reasons.append(_proximity_reason(distance))
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


def _or_match(tokens: frozenset[str]) -> str | None:
    """An FTS5 OR of prefix terms, e.g. ``"cosmos"* OR "ep"*``. ``to_match_query``
    sanitizes each token (they are already ``[a-z0-9]``) into a safe quoted term."""
    picked = sorted(tokens)[:_MAX_MATCH_TERMS]
    terms = [to_match_query(t) for t in picked]
    usable = [t for t in terms if t]
    return " OR ".join(usable) if usable else None


def _bundle_ids_where(
    session: Session, locality: ColumnElement[bool], *, confirmed: bool, cap: int
) -> set[str]:
    """Bundle ids in the requested grouping state whose files satisfy ``locality``."""
    state = GroupingState.CONFIRMED if confirmed else GroupingState.PROVISIONAL
    stmt: Select[tuple[str]] = (
        select(AssetFile.bundle_id)
        .join(AssetBundle, AssetFile.bundle_id == AssetBundle.id)
        .where(AssetBundle.grouping_state == state)
        .where(locality)
        .limit(cap)
    )
    if not confirmed:
        stmt = stmt.where(AssetBundle.grouping_source == GroupingSource.SCAN_SUGGESTION)
    return set(session.scalars(stmt).all())


def _enclosing_bundle_ids(
    session: Session, dirs: frozenset[str], *, confirmed: bool, cap: int
) -> set[str]:
    """Bundles holding a file in one of ``dirs`` or in a directory enclosing it.

    One indexed equality probe per distinct directory in the bounded ancestor
    walk, folded into a single ``IN``. This is the direction the import question
    needs: a file landing in a subfolder should find the bundle that lives above
    it.
    """
    wanted = {ancestor for directory in dirs for ancestor in _ancestors(directory)}
    if not wanted:
        return set()
    return _bundle_ids_where(
        session, AssetFile.directory_path.in_(sorted(wanted)), confirmed=confirmed, cap=cap
    )


def _within_bundle_ids(
    session: Session, dirs: frozenset[str], *, confirmed: bool, cap: int
) -> set[str]:
    """Bundles holding a file in one of ``dirs`` or in any directory beneath it.

    The subtree test is a half-open range on the indexed ``directory_path`` rather
    than a ``LIKE`` prefix, because SQLite cannot use an index for ``LIKE`` at all
    under its default case-insensitive rules — that spelling read the whole
    ``asset_files`` table once per directory, on dialog open. ``"/"`` is 0x2F, so
    ``"0"`` is the next byte and bounds the subtree exactly: every descendant
    starts with ``dir + "/"``, and nothing else falls in the range (a sibling like
    ``Set1-old`` sorts below it, ``Set1x`` above).

    The library root is skipped: its subtree is the entire library, which is both
    a table scan and evidence of nothing.
    """
    clauses = [
        or_(
            AssetFile.directory_path == directory,
            and_(
                AssetFile.directory_path >= f"{directory}/",
                AssetFile.directory_path < f"{directory}0",
            ),
        )
        for directory in sorted(dirs)
        if directory
    ]
    if not clauses:
        return set()
    return _bundle_ids_where(session, or_(*clauses), confirmed=confirmed, cap=cap)


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
    # Read the other way round: unbundled files worth folding in are the ones
    # sitting in the target's folder or under it.
    ids = _within_bundle_ids(session, ctx.dirs, confirmed=False, cap=cap)
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
            if classification is None:
                # Not linkable media: skip it so the preview matches what apply would
                # actually bundle (apply skips non-media too — D4 review P1-5).
                continue
            seeds.append(_Seed(rel, rel, classification[0], name))
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

    candidate_ids = _enclosing_bundle_ids(
        session, selected_ctx.dirs, confirmed=True, cap=_CANDIDATE_CAP
    )
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
