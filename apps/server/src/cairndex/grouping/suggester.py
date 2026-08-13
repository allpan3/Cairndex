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

from cairndex.domain.enums import DEFAULT_STEM_LEVEL, FileRole, MediaKind, ProposalKind

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
    # Existing logical collection represented by this structural context node
    target_collection_id: str | None = None
    # True only for a synthesized read-only node standing in for a live
    # collection. A suggester-authored folder container may also carry a
    # ``target_collection_id`` (so apply reuses that collection instead of
    # duplicating it) while staying fully editable.
    is_collection_context: bool = False


@dataclass(frozen=True)
class GroupingPlan:
    rule_version: int
    proposals: tuple[GroupingProposal, ...]
    # Per-directory stem levels that differ from ``DEFAULT_STEM_LEVEL``; a
    # directory absent here was grouped at the default.
    stem_levels: dict[str, int] = field(default_factory=dict)


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


def _folded_stem(name: str) -> str:
    """``name``'s stem, case-folded, with a trailing rendition tag removed."""
    return _fold_rendition_suffix(_stem(name).casefold())


# Normalize separators while retaining the complete filename subject
def _normalized_stem(name: str, *, fold_rendition: bool = False) -> str:
    """Return a comparable full stem across spaces, dots, dashes, and underscores."""
    stem = _stem(name).casefold()
    if fold_rendition:
        stem = _fold_rendition_suffix(stem)
    return _normalize_text(stem)


@dataclass(frozen=True)
class _StemKey:
    """The part of a filename that one folder's stem level compares.

    The dial's only definition — every caller asking "do these two names match?"
    goes through here, so widening cannot mean one thing for videos and another
    for their sidecars. That is how the three-mode version drifted: ``wide``
    grouped by a separate semantic-chunk key that ``_owner_match_score`` never
    used, so addition matching silently stayed at the balanced key.

    Built **per folder**, because the dial is absolute: at level ``L`` every name
    in the folder is compared on its first ``max - L + 1`` segments, where ``max``
    is :func:`max_stem_level` for that folder. So level 1 compares whole stems,
    level ``max`` compares first segments only, and ``depth`` and ``level`` move
    in opposite directions through the same range.

    Level 0 is the one rung outside that scheme: the complete stem with its
    rendition tag intact. Folding ``4K [tag]`` versus ``720p`` is not expressible
    as a segment count, which is why it is its own rung at the bottom rather than
    part of the ladder — and why the default (level 1, folded whole stems) is what
    every existing library already groups by.

    A *relative* dial — "drop ``L - 1`` trailing segments from each name" — is the
    obvious first design and is quietly broken. Two names with different segment
    counts then yield keys of different lengths, which can never be equal, so
    nothing merges at all until the top rung clamps every name to one segment and
    the whole folder merges at once.
    """

    level: int
    # Leading segments compared. Meaningless at level 0, which compares the lot.
    depth: int

    @classmethod
    def for_names(cls, names: Iterable[str], level: int) -> _StemKey:
        level = max(0, level)
        return cls(level, max(1, max_stem_level(names) - level + 1))

    def of(self, name: str) -> str:
        """The comparable key for one filename at this folder's level."""
        if self.level <= 0:
            return _normalized_stem(name)
        return " ".join(_normalized_stem(name, fold_rendition=True).split()[: self.depth])


def max_stem_level(names: Iterable[str]) -> int:
    """The top of the stem dial for a folder holding ``names``.

    The level at which every name is compared on its first segment alone, so
    widening further cannot change any grouping — the longest name's segment
    count. Reported to the client because it depends on the folder's own
    filenames: a folder of one-word names has nothing to widen at all (the
    maximum is ``DEFAULT_STEM_LEVEL``), while a folder of long dotted release
    names has many rungs left.
    """
    # Counted rather than normalized: this runs over every file in a plan on
    # every plan response, and the joined string ``_normalized_stem`` builds is
    # thrown away here.
    longest = max(
        (sum(1 for part in _SUBJECT_DELIMITER.split(_folded_stem(name)) if part) for name in names),
        default=1,
    )
    return max(DEFAULT_STEM_LEVEL, longest)


def _space_prefixes(stem: str) -> list[str]:
    """Every proper prefix of ``stem`` that ends on a token boundary.

    ``"a b c"`` gives ``["a b", "a"]``. Lets a sidecar find the video stems it
    extends without being compared against every one of them.
    """
    prefixes: list[str] = []
    cut = stem.rfind(" ")
    while cut > 0:
        prefixes.append(stem[:cut])
        cut = stem.rfind(" ", 0, cut)
    return prefixes


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
    media: list[FileObservation], level: int = DEFAULT_STEM_LEVEL
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
    if len(videos) == 1 and level >= DEFAULT_STEM_LEVEL:
        return [media]

    # One key for the whole folder, so a sidecar is compared on exactly as much
    # of its name as the videos were.
    keys = _StemKey.for_names([f.relative_path for f in media], level)
    groups_by_key: dict[str, list[FileObservation]] = {}
    for video in videos:
        groups_by_key.setdefault(keys.of(video.relative_path), []).append(video)
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
    unassigned: list[FileObservation] = []
    for f in sorted((x for x in media if x.media_kind is not MediaKind.VIDEO), key=_obs_sort_key):
        stem = keys.of(f.relative_path)
        # Every group is keyed by exactly one stem (that is how it was formed), so
        # "the group whose stem this sidecar equals" is a dict lookup, and "the
        # groups whose stem this sidecar *extends*" is one lookup per
        # space-delimited prefix of the sidecar's own stem.
        #
        # This used to scan every group for every sidecar, with a nested scan over
        # each group's stems inside it — quadratic in the size of the folder. One
        # folder of 1,600 subjects spent 10.2 million `startswith` calls here and
        # 4.3 seconds; a folder of several thousand took minutes, and Narrow or
        # Widen re-runs the whole suggester (owner-reported, 2026-08-13).
        exact_match = groups_by_key.get(stem)
        extended = [
            found
            for prefix in _space_prefixes(stem)
            if (found := groups_by_key.get(prefix)) is not None
        ]
        # Last resort for a sidecar that matches no video stem at all: the leading
        # filename token, when exactly one group owns it. Withheld at level 0,
        # where the owner has asked for the complete filename to be what matches.
        matched_group = (
            exact_match
            if exact_match is not None
            else (
                extended[0]
                if len(extended) == 1
                else group_by_prefix.get(_subject_prefix(f.relative_path))
                if level >= DEFAULT_STEM_LEVEL
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
    ``_bundle_groups(..., 0)``: that returns the whole folder as a single
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
    # The complete stem — level 0 of the dial. Dividing a folder the owner has
    # just called a collection is the one place that wants the strictest possible
    # matching, whatever that folder's stem level happens to be set to.
    stems = [_normalized_stem(video.relative_path) for video in videos]
    unassigned: list[FileObservation] = []
    for f in others:
        stem = _normalized_stem(f.relative_path)
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
    # Nothing to trim when every stem *is* the shared part: the prefix is not
    # partial, it is the whole name. Reachable only since sidecars joined the
    # comparison (a video and its cover often share their filename exactly), and
    # without this guard an identical pair lost everything after its last
    # delimiter — "A - B - 4K" became "A - B".
    if all(stem == shared for stem in stems):
        return shared or None

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
    stem_level: int = DEFAULT_STEM_LEVEL,
) -> GroupingProposal:
    confidence, reason = _bundle_reason(files)
    videos = [file for file in files if file.media_kind is MediaKind.VIDEO]
    # Only *above* the default: a widened folder groups by less of each filename
    # than the suggester would choose, so say so and rank it below a bundle that
    # matched on its own. At the default level the row is an ordinary suggestion.
    if stem_level > DEFAULT_STEM_LEVEL and len(videos) > 1 and not _is_multipart(videos):
        confidence, reason = 0.55, f"{len(files)} files matched by a widened stem"
    # A bundle that fills its whole folder takes the folder's name. Otherwise:
    # several files grouped together are titled by the part they share, and a
    # single subject by its own filename.
    #
    # With two or more videos the sidecars are excluded, because a cover named
    # for the folder rather than for a video would drag the shared prefix shorter
    # than the thing it is naming. With one video the sidecars are exactly what
    # gives the useful name: a release video and its cover share the release's
    # own identifier, so `n0203 - long title.mp4` + `n0203.jpg` is "n0203" rather
    # than the video's whole filename (owner-reported, 2026-08-13). When they
    # share no prefix at all — `cosmos.mp4` + `poster.jpg` — `_shared_stem_title`
    # returns None and the fallback below still names it after the video.
    subjects = videos if len(videos) > 1 else files
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
    stem_levels: Mapping[str, int],
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
        child_proposals.extend(_classify(node.children[name], child_parent, stem_levels))

    has_subbundles = bool(child_proposals)
    media = node.files
    stem_level = stem_levels.get(node.path, DEFAULT_STEM_LEVEL)
    proposals: list[GroupingProposal] = []
    # Once per folder, for every branch below. Grouping sorts the folder and
    # builds a stem key per file, so doing it twice was pure repetition.
    groups = _bundle_groups(media, stem_level) if media else []

    if has_subbundles and not is_root:
        # This folder is a CONTAINER for the bundles found beneath it.
        direct_count = len(groups) + len(
            {p.directory for p in child_proposals if p.parent_directory == node.path}
        )
        proposals.append(_container_proposal(node.path, parent, child_count=direct_count))
        proposals.extend(
            _direct_media_proposals(
                groups, node.path, parent_for_children=node.path, stem_level=stem_level
            )
        )
        proposals.extend(child_proposals)
        return proposals

    if has_subbundles and is_root:
        proposals.extend(
            _direct_media_proposals(groups, "", parent_for_children=None, stem_level=stem_level)
        )
        proposals.extend(child_proposals)
        return proposals

    # Leaf folder (no sub-bundles).
    if not media:
        return []
    if len(groups) == 1:
        proposals.append(
            _bundle_proposal(
                groups[0], node.path, parent, owns_directory=True, stem_level=stem_level
            )
        )
        return proposals
    if is_root:
        # Unrelated loose files at the root: bundle by subject where possible, no root container
        proposals.extend(
            _direct_media_proposals(groups, "", parent_for_children=None, stem_level=stem_level)
        )
        return proposals
    # A container of unrelated items: one child bundle per subject or file
    proposals.append(_container_proposal(node.path, parent, child_count=len(groups)))
    proposals.extend(
        _direct_media_proposals(
            groups, node.path, parent_for_children=node.path, stem_level=stem_level
        )
    )
    return proposals


def _direct_media_proposals(
    groups: list[list[FileObservation]],
    directory: str,
    *,
    parent_for_children: str | None,
    stem_level: int,
) -> list[GroupingProposal]:
    """Proposals for a container's own direct media (those not in a subfolder).

    Takes the grouping rather than the files: every caller has already grouped
    this folder to decide *whether* to make a container of it, and grouping is the
    expensive part — it sorts the folder naturally and builds a stem key per file.
    Recomputing it here ran the whole thing twice per folder, a third of the time
    it took a plan to appear (owner-reported, 2026-08-13).
    """
    return [
        _bundle_proposal(
            group,
            directory,
            parent_for_children,
            owns_directory=len(groups) == 1,
            stem_level=stem_level,
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
def _owner_match_score(owner: _Owner, files: list[FileObservation], keys: _StemKey) -> int:
    """Rank exact and prefix stem matches without using directory alone.

    A widened folder needs no special case here any more: the level shortens both
    sides' stems before they are compared, so the same two tiers cover the whole
    dial. The three-mode version had a third tier that only ``wide`` used, and it
    compared a *different* notion of similarity from the one ``wide`` grouped by.
    """
    owner_anchors = [file for file in owner.files if file.media_kind is MediaKind.VIDEO]
    fresh_anchors = [file for file in files if file.media_kind is MediaKind.VIDEO]
    owner_anchors = owner_anchors or list(owner.files)
    fresh_anchors = fresh_anchors or files
    owner_stems = {keys.of(file.relative_path) for file in owner_anchors}
    fresh_stems = {keys.of(file.relative_path) for file in fresh_anchors}
    if owner_stems & fresh_stems:
        return 3
    if any(
        fresh.startswith(f"{owner} ") or owner.startswith(f"{fresh} ")
        for owner in owner_stems
        for fresh in fresh_stems
    ):
        return 2
    return 0


# Choose a unique best stem match, with a one-group/one-owner directory fallback
def _match_owner(
    owners: list[_Owner],
    files: list[FileObservation],
    keys: _StemKey,
    *,
    group_count: int,
    allow_directory_fallback: bool,
) -> _Owner | None:
    """Return one unambiguous confirmed target for a fresh file group."""
    scored = [(owner, _owner_match_score(owner, files, keys)) for owner in owners]
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


def _enclosing_container(directory: str, container_directories: set[str]) -> str | None:
    """The collection suggestion an item in ``directory`` belongs inside.

    Its own folder when that folder is being proposed as a collection, otherwise
    the nearest ancestor that is. ``None`` when nothing encloses it, which is the
    top level.
    """
    candidate = directory
    while candidate:
        if candidate in container_directories:
            return candidate
        parent = _dirname(candidate)
        if parent == candidate:
            break
        candidate = parent
    return None


def _addition_proposal(
    owner: _Owner, files: list[FileObservation], container_directories: set[str]
) -> GroupingProposal:
    directory = _dirname(files[0].relative_path)
    return GroupingProposal(
        kind=ProposalKind.BUNDLE,
        directory=directory,
        # Where the files live decides where the suggestion sits, exactly as it
        # does for a fresh bundle from the same folder. This was hardcoded to
        # None, so an addition always sat at the top level — outside the very
        # collection its folder was being proposed as, which reads as though it
        # were unrelated to its siblings (owner-reported, 2026-07-30).
        parent_directory=_enclosing_container(directory, container_directories),
        title=_new_bundle_title(files, directory),
        confidence=0.8,
        reason=f"add {len(files)} new file(s) to existing bundle",
        files=_addition_roles(files),
        target_bundle_id=owner.bundle_id,
        target_bundle_title=owner.title or _basename(directory),
    )


def suggest_grouping(
    files: Iterable[FileObservation],
    stem_levels: Mapping[str, int] | None = None,
) -> GroupingPlan:
    """Propose a grouping for ``files``.

    Confirmed groupings are excluded from *new* proposals, but a newly discovered
    file in a directory already owned by a confirmed bundle becomes an **addition**
    to that bundle (ADR-0009 phase 5) rather than a fresh bundle — so a re-scan
    never disturbs a confirmed grouping, it only suggests folding new files in.
    """
    files = list(files)
    stem_levels = dict(stem_levels or {})
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
        level = stem_levels.get(directory, DEFAULT_STEM_LEVEL)
        groups = _bundle_groups(candidates, level)
        # Built from the same names ``_bundle_groups`` just used, so a settled
        # bundle is matched on exactly as much of its filename as the grouping was.
        keys = _StemKey.for_names([f.relative_path for f in candidates], level)
        directory_owners = owners.get(directory, [])
        only_sidecars = all(file.media_kind is not MediaKind.VIDEO for file in candidates)
        for group in groups:
            owner = _match_owner(
                directory_owners,
                group,
                keys,
                group_count=len(groups),
                allow_directory_fallback=only_sidecars,
            )
            if owner is None:
                fresh.extend(group)
            else:
                additions.setdefault(owner.bundle_id, (owner, []))[1].extend(group)

    # Classify first: an addition's parent is one of the collections this produces,
    # so the set of proposed collection folders has to exist before they are built.
    proposals = _classify(_build_tree(fresh), parent=None, stem_levels=stem_levels)
    container_directories = {p.directory for p in proposals if p.kind is ProposalKind.CONTAINER}
    addition_proposals = [
        _addition_proposal(owner, group, container_directories)
        for owner, group in additions.values()
    ]
    return GroupingPlan(
        rule_version=SUGGESTER_RULE_VERSION,
        proposals=(*addition_proposals, *proposals),
        stem_levels=stem_levels,
    )
