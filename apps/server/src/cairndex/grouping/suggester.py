"""Read-only grouping suggester (ADR-0009 phase 2).

Pure functions only: given the files observed in a library (and which of them
already belong to a *confirmed* grouping), propose how the rest should be
grouped. The output is a durable-shaped :class:`GroupingPlan` of BUNDLE and
CONTAINER proposals with per-file roles, ordering, a confidence, and a
human-readable reason. Nothing here touches the database or the filesystem; the
suggestions are reviewed and applied by a later, conflict-aware step.

Heuristic stance (ADR-0009 §"Folder classification"): lead with content signals,
use names as a secondary hint, and never claim certainty — every proposal shows
its reason so a fuzzy guess is easy to override.

- A folder with a single clear subject (one video plus sidecars, or a multipart
  video) is a **BUNDLE**.
- A folder of unrelated items (a photo dump) or one holding sub-bundles is a
  **CONTAINER**: a logical-collection suggestion whose members are the bundles
  found inside it (ADR-0009 — a CONTAINER never implies a filesystem move).
- Files already in a confirmed bundle are left untouched (confirmed user
  decisions win over heuristics).
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from enum import StrEnum

from cairndex.domain.enums import FileRole, MediaKind

# Bumped whenever the heuristic changes in a way worth re-surfacing. Recorded on
# provisional bundles/plans so a re-scan can tell stale suggestions apart.
SUGGESTER_RULE_VERSION = 1

# Image stems that name a cover/poster regardless of the bundle's subject.
_COVER_STEMS = frozenset({"cover", "poster", "thumbnail", "thumb", "folder", "front"})

# Trailing "...part 2 / pt2 / cd1 / disc 3" markers that indicate one work split
# across several video files (multipart), as opposed to bare numbering (ep1, ep2)
# which usually means separate items.
_PART_MARKER = re.compile(r"[._\-\s]*(?:part|pt|cd|disc|disk)[._\-\s]*0*(\d+)$", re.IGNORECASE)


class ProposalKind(StrEnum):
    BUNDLE = "bundle"
    CONTAINER = "container"


@dataclass(frozen=True)
class FileObservation:
    """One scan-observed file fed to the suggester.

    ``grouping_confirmed`` marks files whose current bundle the user has already
    confirmed; the suggester excludes them so it never re-proposes a settled
    grouping.
    """

    asset_file_id: str
    relative_path: str  # normalized, library-root-relative POSIX path
    media_kind: MediaKind
    grouping_confirmed: bool = False


@dataclass(frozen=True)
class ProposedFile:
    asset_file_id: str
    role: FileRole
    sequence: int


@dataclass(frozen=True)
class GroupingProposal:
    """A single proposed BUNDLE or CONTAINER.

    ``directory`` is the library-relative folder the proposal was derived from
    (``""`` for the library root). ``parent_directory`` is the directory of the
    nearest enclosing CONTAINER proposal, or ``None`` for a top-level proposal —
    it links a child bundle/container to the collection that would contain it.
    ``files`` carries the member files+roles for a BUNDLE and is empty for a
    CONTAINER (whose members are the proposals that name it as parent).
    """

    kind: ProposalKind
    directory: str
    parent_directory: str | None
    title: str
    confidence: float
    reason: str
    files: tuple[ProposedFile, ...] = ()


@dataclass(frozen=True)
class GroupingPlan:
    rule_version: int
    proposals: tuple[GroupingProposal, ...]


# --- internal directory tree -------------------------------------------------


@dataclass
class _Dir:
    path: str  # "" for root
    files: list[FileObservation] = field(default_factory=list)
    children: dict[str, _Dir] = field(default_factory=dict)


def _dirname(rel: str) -> str:
    head, sep, _ = rel.rpartition("/")
    return head if sep else ""


def _basename(rel: str) -> str:
    return rel.rsplit("/", 1)[-1]


def _stem(name: str) -> str:
    base = _basename(name)
    stem, _, _ = base.rpartition(".")
    return stem or base


def _natural_key(name: str) -> list[object]:
    """Sort key that orders ``ep2`` before ``ep10`` (numeric runs compared as
    ints), case-insensitively."""
    parts = re.split(r"(\d+)", _basename(name).lower())
    return [int(p) if p.isdigit() else p for p in parts]


def _build_tree(files: Iterable[FileObservation]) -> _Dir:
    root = _Dir(path="")
    for f in files:
        directory = _dirname(f.relative_path)
        node = root
        if directory:
            for part in directory.split("/"):
                child_path = f"{node.path}/{part}" if node.path else part
                node = node.children.setdefault(part, _Dir(path=child_path))
        node.files.append(f)
    return root


# --- classification ----------------------------------------------------------


def _part_base(name: str) -> str | None:
    """Return the shared base of a multipart name (``cosmos`` for
    ``cosmos.part2``), or ``None`` if the name has no part marker."""
    stem = _stem(name)
    m = _PART_MARKER.search(stem)
    if m is None:
        return None
    return stem[: m.start()].rstrip("._- ").lower() or None


def _is_multipart(videos: list[FileObservation]) -> bool:
    """True if 2+ videos share one base via explicit part markers."""
    if len(videos) < 2:
        return False
    bases = {_part_base(v.relative_path) for v in videos}
    return len(bases) == 1 and None not in bases


def _is_bundle(files: list[FileObservation]) -> bool:
    """Whether a folder's direct media read as one subject (a BUNDLE) rather
    than a collection of unrelated items (a CONTAINER)."""
    if len(files) <= 1:
        return True
    videos = [f for f in files if f.media_kind is MediaKind.VIDEO]
    if len(videos) == 1:
        return True  # one video + sidecars (images/subs/attachments)
    return _is_multipart(videos)  # several parts of one work


def _bundle_reason(files: list[FileObservation]) -> tuple[float, str]:
    videos = [f for f in files if f.media_kind is MediaKind.VIDEO]
    sidecars = len(files) - len(videos)
    if len(files) == 1:
        return 0.5, "single file on its own"
    if len(videos) == 1:
        return 0.9, f"one video with {sidecars} sidecar file(s)"
    if _is_multipart(videos):
        return 0.75, f"{len(videos)} parts of one video"
    return 0.5, "grouped by folder"


# --- role assignment ---------------------------------------------------------


def _assign_roles(files: list[FileObservation]) -> tuple[ProposedFile, ...]:
    ordered = sorted(files, key=lambda f: _natural_key(f.relative_path))
    videos = [f for f in ordered if f.media_kind is MediaKind.VIDEO]
    multipart = _is_multipart(videos)
    images = [f for f in ordered if f.media_kind is MediaKind.IMAGE]
    cover_id = _pick_cover(images)

    proposed: list[ProposedFile] = []
    for sequence, f in enumerate(ordered):
        proposed.append(ProposedFile(f.asset_file_id, _role_for(f, multipart, cover_id), sequence))
    return tuple(proposed)


def _pick_cover(images: list[FileObservation]) -> str | None:
    """The cover is an image named cover/poster/thumb…; otherwise the first
    image (ADR-0009)."""
    for img in images:
        if _stem(img.relative_path).lower() in _COVER_STEMS:
            return img.asset_file_id
    return images[0].asset_file_id if images else None


def _role_for(f: FileObservation, multipart: bool, cover_id: str | None) -> FileRole:
    match f.media_kind:
        case MediaKind.VIDEO:
            return FileRole.VIDEO_PART if multipart else FileRole.PRIMARY_VIDEO
        case MediaKind.IMAGE:
            return FileRole.COVER if f.asset_file_id == cover_id else FileRole.IMAGE
        case MediaKind.SUBTITLE:
            return FileRole.SUBTITLE
        case _:
            return FileRole.ATTACHMENT


# --- proposal builders -------------------------------------------------------


def _bundle_proposal(
    files: list[FileObservation], directory: str, parent: str | None
) -> GroupingProposal:
    confidence, reason = _bundle_reason(files)
    title = _basename(directory) if directory else _stem(files[0].relative_path)
    if len(files) == 1 and directory:
        # A lone file inside a container reads better titled by its own name.
        title = _stem(files[0].relative_path)
    return GroupingProposal(
        kind=ProposalKind.BUNDLE,
        directory=directory,
        parent_directory=parent,
        title=title,
        confidence=confidence,
        reason=reason,
        files=_assign_roles(files),
    )


def _container_proposal(
    directory: str, parent: str | None, *, child_count: int, reason: str
) -> GroupingProposal:
    confidence = 0.85 if child_count > 1 else 0.6
    return GroupingProposal(
        kind=ProposalKind.CONTAINER,
        directory=directory,
        parent_directory=parent,
        title=_basename(directory),
        confidence=confidence,
        reason=reason,
        files=(),
    )


def _classify(node: _Dir, parent: str | None) -> list[GroupingProposal]:
    """Recursively turn a directory subtree into proposals.

    ``parent`` is the enclosing CONTAINER directory (``None`` at the top). The
    root directory itself is never proposed as a container — its loose files and
    sub-bundles sit at the top level.
    """
    is_root = node.path == ""
    # Children first: a folder that holds sub-bundles is itself a container, so
    # its children's parent is this folder (or None at the root).
    child_parent = None if is_root else node.path
    child_proposals: list[GroupingProposal] = []
    for name in sorted(node.children):
        child_proposals.extend(_classify(node.children[name], child_parent))

    has_subbundles = bool(child_proposals)
    media = node.files
    proposals: list[GroupingProposal] = []

    if has_subbundles and not is_root:
        # This folder is a CONTAINER for the bundles found beneath it.
        direct_count = (1 if media and _is_bundle(media) else len(media)) + len(
            {p.directory for p in child_proposals if p.parent_directory == node.path}
        )
        proposals.append(
            _container_proposal(
                node.path,
                parent,
                child_count=direct_count,
                reason=f"holds {direct_count} sub-item(s)",
            )
        )
        proposals.extend(_direct_media_proposals(media, node.path, parent_for_children=node.path))
        proposals.extend(child_proposals)
        return proposals

    if has_subbundles and is_root:
        proposals.extend(_direct_media_proposals(media, "", parent_for_children=None))
        proposals.extend(child_proposals)
        return proposals

    # Leaf folder (no sub-bundles).
    if not media:
        return []
    if _is_bundle(media):
        proposals.append(_bundle_proposal(media, node.path, parent))
        return proposals
    if is_root:
        # Unrelated loose files at the root: one bundle each, no root container.
        proposals.extend(_bundle_proposal([f], "", None) for f in media)
        return proposals
    # A container of unrelated items: one single-file bundle per item.
    proposals.append(
        _container_proposal(
            node.path,
            parent,
            child_count=len(media),
            reason=f"{len(media)} unrelated files",
        )
    )
    proposals.extend(_bundle_proposal([f], node.path, node.path) for f in media)
    return proposals


def _direct_media_proposals(
    media: list[FileObservation], directory: str, *, parent_for_children: str | None
) -> list[GroupingProposal]:
    """Proposals for a container's own direct media (those not in a subfolder)."""
    if not media:
        return []
    if _is_bundle(media):
        return [_bundle_proposal(media, directory, parent_for_children)]
    return [_bundle_proposal([f], directory, parent_for_children) for f in media]


def suggest_grouping(files: Iterable[FileObservation]) -> GroupingPlan:
    """Propose a grouping for ``files``. Confirmed groupings are excluded, so
    re-running over a partly-confirmed library only suggests the open items."""
    open_files = [f for f in files if not f.grouping_confirmed]
    tree = _build_tree(open_files)
    proposals = _classify(tree, parent=None)
    return GroupingPlan(rule_version=SUGGESTER_RULE_VERSION, proposals=tuple(proposals))
