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

from cairndex.domain.enums import FileRole, MediaKind, ProposalKind

# Bumped whenever the heuristic changes in a way worth re-surfacing. Recorded on
# provisional bundles/plans so a re-scan can tell stale suggestions apart.
SUGGESTER_RULE_VERSION = 4

# Image stems that name a cover/poster regardless of the bundle's subject.
_COVER_STEMS = frozenset({"cover", "poster", "thumbnail", "thumb", "folder", "front"})

# Trailing "...part 2 / pt2 / cd1 / disc 3" markers that indicate one work split
# across several video files (multipart), as opposed to bare numbering (ep1, ep2)
# which usually means separate items.
_PART_MARKER = re.compile(r"[._\-\s]*(?:part|pt|cd|disc|disk)[._\-\s]*0*(\d+)$", re.IGNORECASE)
_SUBJECT_DELIMITER = re.compile(r"[._\-\s]+")

_MEDIA_SEQUENCE_RANK = {
    MediaKind.VIDEO: 0,
    MediaKind.AUDIO: 1,
    MediaKind.IMAGE: 2,
}


@dataclass(frozen=True)
class FileObservation:
    """One scan-observed file fed to the suggester.

    ``grouping_confirmed`` marks files whose current bundle the user has already
    confirmed; the suggester excludes those from new groupings but uses them to
    recognize which directories a confirmed bundle already owns, so a newly
    discovered file there is suggested as an *addition* (``bundle_id`` /
    ``bundle_title`` name that owning bundle) rather than a fresh bundle.
    """

    asset_file_id: str
    relative_path: str  # normalized, library-root-relative POSIX path
    media_kind: MediaKind
    grouping_confirmed: bool = False
    bundle_id: str | None = None
    bundle_title: str | None = None


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
    # When set, this is an *addition* proposal (ADR-0009 phase 5): its files
    # default to joining an existing confirmed bundle.
    target_bundle_id: str | None = None
    # Snapshot title for the reversible existing-bundle destination
    target_bundle_title: str | None = None
    # Owner override that turns an addition candidate into a fresh bundle
    create_new_bundle: bool = False
    # Existing bundle whose identity this proposal should preserve if the owner
    # edits a confirmed grouping before apply
    base_bundle_id: str | None = None


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


# Normalize filename stems to the leading subject token used for sidecar matching
def _subject_prefix(name: str) -> str:
    """Return the leading filename subject before sidecar delimiters."""
    stem = _stem(name).lower()
    return _SUBJECT_DELIMITER.split(stem, maxsplit=1)[0]


# Normalize separators while retaining the complete filename subject
def _normalized_stem(name: str) -> str:
    """Return a comparable full stem across spaces, dots, dashes, and underscores."""
    return " ".join(part for part in _SUBJECT_DELIMITER.split(_stem(name).casefold()) if part)


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


# Split a mixed direct-media directory into video-centered bundle candidates
def _bundle_groups(media: list[FileObservation]) -> list[list[FileObservation]]:
    """Group direct media into proposed bundle file sets.

    A folder with a single subject remains one bundle. A folder with multiple
    unrelated videos becomes one video-centered bundle per subject, with
    sidecars attached by the leading delimiter-separated prefix. Image-only
    folders intentionally stay one file per proposal so photo dumps do not
    collapse just because camera filenames share a prefix.
    """
    if not media:
        return []
    if _is_bundle(media):
        return [media]

    videos = sorted((f for f in media if f.media_kind is MediaKind.VIDEO), key=_obs_sort_key)
    if not videos:
        return [[f] for f in sorted(media, key=_obs_sort_key)]

    groups: list[list[FileObservation]] = [[video] for video in videos]
    prefix_counts: dict[str, int] = {}
    for video in videos:
        prefix = _subject_prefix(video.relative_path)
        prefix_counts[prefix] = prefix_counts.get(prefix, 0) + 1
    group_by_prefix = {
        _subject_prefix(video.relative_path): group
        for video, group in zip(videos, groups, strict=True)
        if prefix_counts[_subject_prefix(video.relative_path)] == 1
    }
    video_stems = [_normalized_stem(video.relative_path) for video in videos]
    unassigned: list[FileObservation] = []
    for f in sorted((x for x in media if x.media_kind is not MediaKind.VIDEO), key=_obs_sort_key):
        stem = _normalized_stem(f.relative_path)
        exact_matches = [
            group
            for video_stem, group in zip(video_stems, groups, strict=True)
            if stem == video_stem
        ]
        suffix_matches = [
            group
            for video_stem, group in zip(video_stems, groups, strict=True)
            if stem.startswith(f"{video_stem} ")
        ]
        group = (
            exact_matches[0]
            if len(exact_matches) == 1
            else suffix_matches[0]
            if not exact_matches and len(suffix_matches) == 1
            else group_by_prefix.get(_subject_prefix(f.relative_path))
        )
        if group is None:
            unassigned.append(f)
        else:
            group.append(f)
    groups.extend([f] for f in unassigned)
    return groups


# Stable ordering helper for file observations
def _obs_sort_key(f: FileObservation) -> list[object]:
    """Sort observations by natural relative path order."""
    return _natural_key(f.relative_path)


# Put playable media first without disturbing natural order within each group
def _media_first(files: list[FileObservation]) -> list[FileObservation]:
    """Order video, audio, and image first; preserve natural order otherwise."""
    naturally_ordered = sorted(files, key=_obs_sort_key)
    return sorted(naturally_ordered, key=lambda f: _MEDIA_SEQUENCE_RANK.get(f.media_kind, 3))


# --- role assignment ---------------------------------------------------------


# Assign cover and media roles without changing an owner-reviewed sequence
def _roles_in_order(ordered: list[FileObservation]) -> tuple[ProposedFile, ...]:
    """Assign roles to observations in their current order."""
    videos = [f for f in ordered if f.media_kind is MediaKind.VIDEO]
    multipart = _is_multipart(videos)
    images = [f for f in ordered if f.media_kind is MediaKind.IMAGE]
    cover_id = _pick_cover(images)

    proposed: list[ProposedFile] = []
    for sequence, f in enumerate(ordered):
        proposed.append(ProposedFile(f.asset_file_id, _role_for(f, multipart, cover_id), sequence))
    return tuple(proposed)


# Assign default roles after applying the media-first suggestion order
def _assign_roles(files: list[FileObservation]) -> tuple[ProposedFile, ...]:
    """Assign roles and the default media-first sequence."""
    return _roles_in_order(_media_first(files))


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
    files: list[FileObservation],
    directory: str,
    parent: str | None,
    *,
    owns_directory: bool,
) -> GroupingProposal:
    confidence, reason = _bundle_reason(files)
    # A bundle that fills its whole folder takes the folder's name; one of several
    # bundles split out of a container reads better titled by its own file.
    title = _basename(directory) if owns_directory and directory else _stem(files[0].relative_path)
    source_bundle_ids = {file.bundle_id for file in files}
    base_bundle_id = next(iter(source_bundle_ids)) if len(source_bundle_ids) == 1 else None
    return GroupingProposal(
        kind=ProposalKind.BUNDLE,
        directory=directory,
        parent_directory=parent,
        title=title,
        confidence=confidence,
        reason=reason,
        files=_assign_roles(files),
        base_bundle_id=base_bundle_id,
    )


# Derive the title an addition candidate would use as a fresh bundle
def _new_bundle_title(files: list[FileObservation], directory: str) -> str:
    """Use the normal fresh-bundle naming rule without claiming the directory."""
    return _bundle_proposal(_media_first(files), directory, None, owns_directory=False).title


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
        direct_count = len(_bundle_groups(media)) + len(
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
        proposals.append(_bundle_proposal(media, node.path, parent, owns_directory=True))
        return proposals
    if is_root:
        # Unrelated loose files at the root: bundle by subject where possible, no root container
        proposals.extend(_direct_media_proposals(media, "", parent_for_children=None))
        return proposals
    # A container of unrelated items: one child bundle per subject or file
    groups = _bundle_groups(media)
    grouped_count = sum(len(group) > 1 for group in groups)
    proposals.append(
        _container_proposal(
            node.path,
            parent,
            child_count=len(groups),
            reason=(
                f"{len(groups)} filename-matched bundle(s) from {len(media)} files"
                if grouped_count
                else f"{len(media)} unrelated files"
            ),
        )
    )
    proposals.extend(_direct_media_proposals(media, node.path, parent_for_children=node.path))
    return proposals


def _direct_media_proposals(
    media: list[FileObservation], directory: str, *, parent_for_children: str | None
) -> list[GroupingProposal]:
    """Proposals for a container's own direct media (those not in a subfolder)."""
    groups = _bundle_groups(media)
    return [
        _bundle_proposal(group, directory, parent_for_children, owns_directory=len(groups) == 1)
        for group in groups
    ]


@dataclass(frozen=True)
class _Owner:
    bundle_id: str
    title: str | None


def _confirmed_owners(confirmed: list[FileObservation]) -> dict[str, _Owner]:
    """Map a directory to the confirmed bundle that owns it.

    A directory is owned only when every confirmed file in it belongs to the
    same bundle; a directory split across several confirmed bundles is ambiguous
    and gets no owner, so additions there fall back to normal suggestion.
    """
    bundles_by_dir: dict[str, set[str]] = {}
    title_by_bundle: dict[str, str | None] = {}
    for f in confirmed:
        if f.bundle_id is None:
            continue
        bundles_by_dir.setdefault(_dirname(f.relative_path), set()).add(f.bundle_id)
        title_by_bundle[f.bundle_id] = f.bundle_title
    owners: dict[str, _Owner] = {}
    for directory, bundle_ids in bundles_by_dir.items():
        if len(bundle_ids) == 1:
            bundle_id = next(iter(bundle_ids))
            owners[directory] = _Owner(bundle_id, title_by_bundle.get(bundle_id))
    return owners


# Assign addition roles without changing an owner-reviewed sequence
def _addition_roles_in_order(ordered: list[FileObservation]) -> tuple[ProposedFile, ...]:
    """Assign roles for files joining an existing confirmed bundle."""
    proposed: list[ProposedFile] = []
    for sequence, f in enumerate(ordered):
        match f.media_kind:
            case MediaKind.SUBTITLE:
                role = FileRole.SUBTITLE
            case MediaKind.IMAGE:
                role = FileRole.IMAGE
            case MediaKind.VIDEO:
                role = FileRole.VIDEO_PART
            case _:
                role = FileRole.ATTACHMENT
        proposed.append(ProposedFile(f.asset_file_id, role, sequence))
    return tuple(proposed)


# Assign addition roles after applying the media-first suggestion order
def _addition_roles(files: list[FileObservation]) -> tuple[ProposedFile, ...]:
    """Assign addition roles and the default media-first sequence."""
    return _addition_roles_in_order(_media_first(files))


def _addition_proposal(owner: _Owner, files: list[FileObservation]) -> GroupingProposal:
    directory = _dirname(files[0].relative_path)
    return GroupingProposal(
        kind=ProposalKind.BUNDLE,
        directory=directory,
        parent_directory=None,
        title=_new_bundle_title(files, directory),
        confidence=0.8,
        reason=f"add {len(files)} new file(s) to existing bundle",
        files=_addition_roles(files),
        target_bundle_id=owner.bundle_id,
        target_bundle_title=owner.title or _basename(directory),
    )


def suggest_grouping(files: Iterable[FileObservation]) -> GroupingPlan:
    """Propose a grouping for ``files``.

    Confirmed groupings are excluded from *new* proposals, but a newly discovered
    file in a directory already owned by a confirmed bundle becomes an **addition**
    to that bundle (ADR-0009 phase 5) rather than a fresh bundle — so a re-scan
    never disturbs a confirmed grouping, it only suggests folding new files in.
    """
    files = list(files)
    confirmed = [f for f in files if f.grouping_confirmed]
    owners = _confirmed_owners(confirmed)

    additions: dict[str, tuple[_Owner, list[FileObservation]]] = {}
    fresh: list[FileObservation] = []
    for f in files:
        if f.grouping_confirmed:
            continue
        owner = owners.get(_dirname(f.relative_path))
        if owner is not None:
            additions.setdefault(owner.bundle_id, (owner, []))[1].append(f)
        else:
            fresh.append(f)

    addition_proposals = [_addition_proposal(owner, group) for owner, group in additions.values()]
    proposals = _classify(_build_tree(fresh), parent=None)
    return GroupingPlan(
        rule_version=SUGGESTER_RULE_VERSION,
        proposals=(*addition_proposals, *proposals),
    )
