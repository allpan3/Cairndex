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
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

from cairndex.domain.enums import FileRole, MediaKind, ProposalKind, StemMode

# Bumped whenever the heuristic changes in a way worth re-surfacing. Recorded on
# provisional bundles/plans so a re-scan can tell stale suggestions apart.
SUGGESTER_RULE_VERSION = 5

# Image stems that name a cover/poster regardless of the bundle's subject.
_COVER_STEMS = frozenset({"cover", "poster", "thumbnail", "thumb", "folder", "front"})

# Trailing "...part 2 / pt2 / cd1 / disc 3" markers that indicate one work split
# across several video files (multipart), as opposed to bare numbering (ep1, ep2)
# which usually means separate items.
_PART_MARKER = re.compile(r"[._\-\s]*(?:part|pt|cd|disc|disk)[._\-\s]*0*(\d+)$", re.IGNORECASE)
_SUBJECT_DELIMITER = re.compile(r"[._\-\s]+")
_SEMANTIC_DELIMITER = re.compile(r"\s+(?:-|–|—)\s+")
_RENDITION_SEGMENT = re.compile(
    r"[._\-\s]+(?:360p|480p|576p|720p|1080p|1440p|2160p|[248]k|uhd|fhd|hd)"
    r"(?=(?:[._\-\s]+\[[^\]]+\])*$)",
    re.IGNORECASE,
)

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
    stem_modes: dict[str, StemMode] = field(default_factory=dict)


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


# Remove a trailing rendition label while preserving title and release tags
def _fold_rendition_suffix(stem: str) -> str:
    """Remove a conservative trailing quality marker such as ``720p`` or ``4K``."""
    return _RENDITION_SEGMENT.sub("", stem)


# Normalize separators in a raw title chunk
def _normalize_text(value: str) -> str:
    """Normalize separators in text that is not necessarily a filename."""
    return " ".join(part for part in _SUBJECT_DELIMITER.split(value.casefold()) if part)


# Normalize separators while retaining the complete filename subject
def _normalized_stem(name: str, *, fold_rendition: bool = False) -> str:
    """Return a comparable full stem across spaces, dots, dashes, and underscores."""
    stem = _stem(name).casefold()
    if fold_rendition:
        stem = _fold_rendition_suffix(stem)
    return _normalize_text(stem)


# Select the literal or rendition-folded stem for the requested sensitivity
def _comparison_stem(name: str, mode: StemMode) -> str:
    """Return the filename stem used by one grouping sensitivity."""
    return _normalized_stem(name, fold_rendition=mode is not StemMode.NARROW)


# Split a filename into owner-meaningful chunks for the wider grouping mode
def _semantic_segments(name: str) -> tuple[str, ...]:
    """Return spaced-dash title chunks, falling back to normalized tokens."""
    stem = _fold_rendition_suffix(_stem(name).casefold())
    chunks = [
        _normalize_text(chunk)
        for chunk in _SEMANTIC_DELIMITER.split(stem)
        if _normalize_text(chunk)
    ]
    if len(chunks) > 1:
        return tuple(chunks)
    return tuple(_normalize_text(stem).split())


# Derive wider keys that retain a subject and its source/series qualifier
def _wide_stem_keys(files: list[FileObservation]) -> tuple[dict[str, str], int]:
    """Return stable semantic-prefix keys and the shared key depth."""
    segments = [_semantic_segments(file.relative_path) for file in files]
    depth = min(2, max((len(value) for value in segments), default=1))
    keys = {
        file.asset_file_id: " | ".join(value[:depth])
        for file, value in zip(files, segments, strict=True)
    }
    return keys, depth


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


def _bundle_reason(files: list[FileObservation]) -> tuple[float, str]:
    videos = [f for f in files if f.media_kind is MediaKind.VIDEO]
    sidecars = len(files) - len(videos)
    if len(files) == 1:
        # No reason text: "single file on its own" restates what the row already
        # shows (one file), and a library of loose files repeats it hundreds of
        # times (owner-reported noise, 2026-07-29).
        return 0.5, ""
    if len(videos) == 1:
        return 0.9, f"one video with {sidecars} sidecar file(s)"
    if _is_multipart(videos):
        return 0.75, f"{len(videos)} parts of one video"
    return 0.5, "grouped by folder"


# Split a mixed direct-media directory into video-centered bundle candidates
def _bundle_groups(
    media: list[FileObservation], mode: StemMode = StemMode.BALANCED
) -> list[list[FileObservation]]:
    """Group direct media into proposed bundle file sets.

    A folder with a single subject remains one bundle. A folder with multiple
    unrelated videos becomes one video-centered bundle per subject, with
    sidecars attached by the leading delimiter-separated prefix. Image-only
    folders intentionally stay one file per proposal so photo dumps do not
    collapse just because camera filenames share a prefix.
    """
    if not media:
        return []
    videos = sorted((f for f in media if f.media_kind is MediaKind.VIDEO), key=_obs_sort_key)
    if _is_multipart(videos):
        return [media]
    if not videos:
        return [[f] for f in sorted(media, key=_obs_sort_key)]
    if len(videos) == 1 and mode is not StemMode.NARROW:
        return [media]

    wide_keys, wide_depth = _wide_stem_keys(videos)
    groups_by_key: dict[str, list[FileObservation]] = {}
    for video in videos:
        key = (
            wide_keys[video.asset_file_id]
            if mode is StemMode.WIDE
            else _comparison_stem(video.relative_path, mode)
        )
        groups_by_key.setdefault(key, []).append(video)
    groups = list(groups_by_key.values())

    prefix_counts: dict[str, int] = {}
    for group in groups:
        prefix = _subject_prefix(group[0].relative_path)
        prefix_counts[prefix] = prefix_counts.get(prefix, 0) + 1
    group_by_prefix = {
        _subject_prefix(group[0].relative_path): group
        for group in groups
        if prefix_counts[_subject_prefix(group[0].relative_path)] == 1
    }
    stems_by_group = [
        {_comparison_stem(video.relative_path, mode) for video in group} for group in groups
    ]
    group_by_wide_key = {key: group for key, group in groups_by_key.items()}
    unassigned: list[FileObservation] = []
    for f in sorted((x for x in media if x.media_kind is not MediaKind.VIDEO), key=_obs_sort_key):
        stem = _comparison_stem(f.relative_path, mode)
        exact_matches = [
            group
            for video_stems, group in zip(stems_by_group, groups, strict=True)
            if stem in video_stems
        ]
        suffix_matches = [
            group
            for video_stems, group in zip(stems_by_group, groups, strict=True)
            if any(stem.startswith(f"{video_stem} ") for video_stem in video_stems)
        ]
        wide_key = " | ".join(_semantic_segments(f.relative_path)[:wide_depth])
        matched_group = (
            exact_matches[0]
            if len(exact_matches) == 1
            else (
                suffix_matches[0]
                if not exact_matches and len(suffix_matches) == 1
                else group_by_wide_key.get(wide_key)
                if mode is StemMode.WIDE
                else group_by_prefix.get(_subject_prefix(f.relative_path))
                if mode is StemMode.BALANCED
                else None
            )
        )
        if matched_group is None:
            unassigned.append(f)
        else:
            matched_group.append(f)
    groups.extend([f] for f in unassigned)
    return groups


def split_for_collection(media: list[FileObservation]) -> list[list[FileObservation]]:
    """Split one bundle's files into per-subject bundles for a collection.

    Used when the owner overrides the suggester and says a folder is a
    *collection* rather than one bundle. Deliberately **not**
    ``_bundle_groups(..., NARROW)``: that returns the whole folder as a single
    group whenever the videos look like parts of one title
    (``_is_multipart`` short-circuits ahead of the mode check), and a folder of
    parts is precisely the shape this override exists to reject. Asking it to
    split would return the input unchanged.

    One group per video, with each non-video file attached to the video whose
    stem it matches, so covers and subtitles follow their video instead of
    becoming bundles of their own. A file matching nothing becomes its own
    bundle, as it would in a normal suggestion.

    May return a single group, which means *this cannot become a collection* —
    there would be nothing to divide. Callers must check
    (``plan_store._bundle_to_container`` refuses it). A folder holding one video
    is one subject however many sidecars it has; splitting per file there would
    put a subtitle in a bundle of its own, and wrapping the lot in a collection
    of one identical bundle is the shape that let the owner nest collections
    forever (owner-reported, 2026-07-30).
    """
    if not media:
        return []
    videos = sorted((f for f in media if f.media_kind is MediaKind.VIDEO), key=_obs_sort_key)
    others = sorted((f for f in media if f.media_kind is not MediaKind.VIDEO), key=_obs_sort_key)
    if len(videos) == 1:
        return [sorted(media, key=_obs_sort_key)]
    if not videos:
        # No subject to centre a bundle on — a photo dump divides per file.
        return [[f] for f in sorted(media, key=_obs_sort_key)]

    groups = [[video] for video in videos]
    stems = [_comparison_stem(video.relative_path, StemMode.NARROW) for video in videos]
    unassigned: list[FileObservation] = []
    for f in others:
        stem = _comparison_stem(f.relative_path, StemMode.NARROW)
        exact = [i for i, video_stem in enumerate(stems) if stem == video_stem]
        prefix = [i for i, video_stem in enumerate(stems) if stem.startswith(f"{video_stem} ")]
        matched = exact[0] if len(exact) == 1 else prefix[0] if len(prefix) == 1 else None
        if matched is None:
            unassigned.append(f)
        else:
            groups[matched].append(f)
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
    first_video_id = videos[0].asset_file_id if videos else None
    for sequence, f in enumerate(ordered):
        role = _role_for(f, multipart, cover_id)
        if (
            f.media_kind is MediaKind.VIDEO
            and len(videos) > 1
            and not multipart
            and f.asset_file_id != first_video_id
        ):
            role = FileRole.ALTERNATE_VERSION
        proposed.append(ProposedFile(f.asset_file_id, role, sequence))
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


def _shared_stem_title(files: list[FileObservation]) -> str | None:
    """The filename part these files have in common, or ``None`` if they have none.

    A bundle formed by matching a prefix was titled after its *first* file, which
    carried that one file's tail — so a group of four became
    "StudioAlpha.19.12.20.Lead.Player.#2.Session.Behind.The.Scenes", naming the
    bundle after one member and implying the rest are behind-the-scenes clips
    (owner-reported, 2026-07-30). The shared part is what actually grouped them,
    so it is what the bundle is called.

    Computed on the raw stems rather than the normalized comparison forms, so the
    title keeps the owner's own delimiters and casing, then trimmed back to a
    delimiter so it never ends mid-token ("…19.12.2" from a pair of dates becomes
    "…19.12").
    """
    stems = [_stem(file.relative_path) for file in files]
    if len(stems) < 2:
        return None
    shared = stems[0]
    for stem in stems[1:]:
        limit = min(len(shared), len(stem))
        index = 0
        while index < limit and shared[index] == stem[index]:
            index += 1
        shared = shared[:index]
        if not shared:
            return None
    # Drop a trailing partial token, and the delimiter run before it.
    boundaries = list(_SUBJECT_DELIMITER.finditer(shared))
    if boundaries and boundaries[-1].end() == len(shared):
        shared = shared[: boundaries[-1].start()]  # ends on a delimiter run
    elif boundaries:
        shared = shared[: boundaries[-1].start()]  # ends mid-token
    return shared or None


def _bundle_proposal(
    files: list[FileObservation],
    directory: str,
    parent: str | None,
    *,
    owns_directory: bool,
    stem_mode: StemMode = StemMode.BALANCED,
) -> GroupingProposal:
    confidence, reason = _bundle_reason(files)
    videos = [file for file in files if file.media_kind is MediaKind.VIDEO]
    if stem_mode is StemMode.WIDE and len(videos) > 1 and not _is_multipart(videos):
        confidence, reason = 0.55, f"{len(files)} files matched by a wider stem prefix"
    # A bundle that fills its whole folder takes the folder's name. Otherwise:
    # several files grouped together are titled by the part they share, and a
    # single subject by its own filename.
    subjects = videos if len(videos) > 1 else ([] if videos else files)
    title = (
        _basename(directory)
        if owns_directory and directory
        else (_shared_stem_title(subjects) or _stem(files[0].relative_path))
    )
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
    directory: str, parent: str | None, *, child_count: int
) -> GroupingProposal:
    """A collection suggestion for one folder.

    Deliberately carries no ``reason``: the three call sites had each grown their
    own phrasing for the same fact ("holds 2 sub-item(s)", "3 unrelated files",
    "2 filename-matched bundle(s) from 5 files"), so the same kind of row read
    differently depending on which branch produced it — and the row already shows
    the bundles it holds (owner-reported, 2026-07-29). Bundle rows keep their
    reason, which says something the row does not ("3 parts of one video").
    """
    confidence = 0.85 if child_count > 1 else 0.6
    return GroupingProposal(
        kind=ProposalKind.CONTAINER,
        directory=directory,
        parent_directory=parent,
        title=_basename(directory),
        confidence=confidence,
        reason="",
        files=(),
    )


def _classify(
    node: _Dir,
    parent: str | None,
    stem_modes: Mapping[str, StemMode],
) -> list[GroupingProposal]:
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
        child_proposals.extend(_classify(node.children[name], child_parent, stem_modes))

    has_subbundles = bool(child_proposals)
    media = node.files
    stem_mode = stem_modes.get(node.path, StemMode.BALANCED)
    proposals: list[GroupingProposal] = []

    if has_subbundles and not is_root:
        # This folder is a CONTAINER for the bundles found beneath it.
        direct_count = len(_bundle_groups(media, stem_mode)) + len(
            {p.directory for p in child_proposals if p.parent_directory == node.path}
        )
        proposals.append(_container_proposal(node.path, parent, child_count=direct_count))
        proposals.extend(
            _direct_media_proposals(
                media, node.path, parent_for_children=node.path, stem_mode=stem_mode
            )
        )
        proposals.extend(child_proposals)
        return proposals

    if has_subbundles and is_root:
        proposals.extend(
            _direct_media_proposals(media, "", parent_for_children=None, stem_mode=stem_mode)
        )
        proposals.extend(child_proposals)
        return proposals

    # Leaf folder (no sub-bundles).
    if not media:
        return []
    groups = _bundle_groups(media, stem_mode)
    if len(groups) == 1:
        proposals.append(
            _bundle_proposal(groups[0], node.path, parent, owns_directory=True, stem_mode=stem_mode)
        )
        return proposals
    if is_root:
        # Unrelated loose files at the root: bundle by subject where possible, no root container
        proposals.extend(
            _direct_media_proposals(media, "", parent_for_children=None, stem_mode=stem_mode)
        )
        return proposals
    # A container of unrelated items: one child bundle per subject or file
    proposals.append(_container_proposal(node.path, parent, child_count=len(groups)))
    proposals.extend(
        _direct_media_proposals(
            media, node.path, parent_for_children=node.path, stem_mode=stem_mode
        )
    )
    return proposals


def _direct_media_proposals(
    media: list[FileObservation],
    directory: str,
    *,
    parent_for_children: str | None,
    stem_mode: StemMode,
) -> list[GroupingProposal]:
    """Proposals for a container's own direct media (those not in a subfolder)."""
    groups = _bundle_groups(media, stem_mode)
    return [
        _bundle_proposal(
            group,
            directory,
            parent_for_children,
            owns_directory=len(groups) == 1,
            stem_mode=stem_mode,
        )
        for group in groups
    ]


@dataclass(frozen=True)
class _Owner:
    bundle_id: str
    title: str | None
    files: tuple[FileObservation, ...]


def _confirmed_owners(confirmed: list[FileObservation]) -> dict[str, list[_Owner]]:
    """Map each directory to every confirmed bundle represented there."""
    files_by_dir_bundle: dict[tuple[str, str], list[FileObservation]] = {}
    title_by_bundle: dict[str, str | None] = {}
    for f in confirmed:
        if f.bundle_id is None:
            continue
        key = (_dirname(f.relative_path), f.bundle_id)
        files_by_dir_bundle.setdefault(key, []).append(f)
        title_by_bundle[f.bundle_id] = f.bundle_title
    owners: dict[str, list[_Owner]] = {}
    for (directory, bundle_id), files in files_by_dir_bundle.items():
        owners.setdefault(directory, []).append(
            _Owner(bundle_id, title_by_bundle.get(bundle_id), tuple(files))
        )
    return owners


# Score one fresh bundle candidate against one settled bundle in the same directory
def _owner_match_score(owner: _Owner, files: list[FileObservation], mode: StemMode) -> int:
    """Rank exact/rendition/suffix stem matches without using directory alone."""
    owner_anchors = [file for file in owner.files if file.media_kind is MediaKind.VIDEO]
    fresh_anchors = [file for file in files if file.media_kind is MediaKind.VIDEO]
    owner_anchors = owner_anchors or list(owner.files)
    fresh_anchors = fresh_anchors or files
    owner_stems = {_comparison_stem(file.relative_path, mode) for file in owner_anchors}
    fresh_stems = {_comparison_stem(file.relative_path, mode) for file in fresh_anchors}
    if owner_stems & fresh_stems:
        return 3
    if any(
        fresh.startswith(f"{owner} ") or owner.startswith(f"{fresh} ")
        for owner in owner_stems
        for fresh in fresh_stems
    ):
        return 2
    if mode is StemMode.WIDE:
        common = max(
            (
                int(
                    _semantic_segments(owner.relative_path)[:2]
                    == _semantic_segments(fresh.relative_path)[:2]
                )
                for owner in owner_anchors
                for fresh in fresh_anchors
            ),
            default=0,
        )
        return 1 if common > 0 else 0
    return 0


# Choose a unique best stem match, with a one-group/one-owner directory fallback
def _match_owner(
    owners: list[_Owner],
    files: list[FileObservation],
    mode: StemMode,
    *,
    group_count: int,
    allow_directory_fallback: bool,
) -> _Owner | None:
    """Return one unambiguous confirmed target for a fresh file group."""
    scored = [(owner, _owner_match_score(owner, files, mode)) for owner in owners]
    best = max((score for _, score in scored), default=0)
    matches = [owner for owner, score in scored if score == best and score > 0]
    if len(matches) == 1:
        return matches[0]
    if not matches and len(owners) == 1 and (group_count == 1 or allow_directory_fallback):
        return owners[0]
    return None


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


def suggest_grouping(
    files: Iterable[FileObservation],
    stem_modes: Mapping[str, StemMode] | None = None,
) -> GroupingPlan:
    """Propose a grouping for ``files``.

    Confirmed groupings are excluded from *new* proposals, but a newly discovered
    file in a directory already owned by a confirmed bundle becomes an **addition**
    to that bundle (ADR-0009 phase 5) rather than a fresh bundle — so a re-scan
    never disturbs a confirmed grouping, it only suggests folding new files in.
    """
    files = list(files)
    stem_modes = dict(stem_modes or {})
    confirmed = [f for f in files if f.grouping_confirmed]
    owners = _confirmed_owners(confirmed)

    additions: dict[str, tuple[_Owner, list[FileObservation]]] = {}
    fresh: list[FileObservation] = []
    unconfirmed_by_dir: dict[str, list[FileObservation]] = {}
    for file in files:
        if not file.grouping_confirmed:
            unconfirmed_by_dir.setdefault(_dirname(file.relative_path), []).append(file)
    for directory in sorted(unconfirmed_by_dir):
        candidates = unconfirmed_by_dir[directory]
        mode = stem_modes.get(directory, StemMode.BALANCED)
        groups = _bundle_groups(candidates, mode)
        directory_owners = owners.get(directory, [])
        only_sidecars = all(file.media_kind is not MediaKind.VIDEO for file in candidates)
        for group in groups:
            owner = _match_owner(
                directory_owners,
                group,
                mode,
                group_count=len(groups),
                allow_directory_fallback=only_sidecars,
            )
            if owner is None:
                fresh.extend(group)
            else:
                additions.setdefault(owner.bundle_id, (owner, []))[1].extend(group)

    addition_proposals = [_addition_proposal(owner, group) for owner, group in additions.values()]
    proposals = _classify(_build_tree(fresh), parent=None, stem_modes=stem_modes)
    return GroupingPlan(
        rule_version=SUGGESTER_RULE_VERSION,
        proposals=(*addition_proposals, *proposals),
        stem_modes=stem_modes,
    )
