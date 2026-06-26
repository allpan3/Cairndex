"""Dry-run planner for an Eagle import (ADR-0004, AGENTS.md §7).

``plan_import`` reads a parsed library and a set of already-imported ids and
produces an ``ImportPlan`` — counts plus advisory merge suggestions — with **no
database writes**. The API/UI show this report; only an explicit commit (the
executor) applies it.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field

from cairndex.eagle.reader import EagleItem, EagleLibrary

# Trailing tokens that usually denote a *part of* one logical asset rather than
# a distinct work: part/disc numbers, cover/poster art, common language codes.
_GROUPING_SUFFIX = re.compile(
    r"[ ._-]*(?:"
    r"part[ ._-]?\d+|cd\d+|disc\d+|\d{1,2}of\d{1,2}|"
    r"cover|poster|thumb(?:nail)?|backdrop|fanart|"
    r"en|eng|english|fr|fre|french|es|spa|spanish|de|ger|german|ja|jpn|forced"
    r")$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class MergeSuggestion:
    reason: str
    item_ids: tuple[str, ...]


@dataclass(frozen=True)
class ImportPlan:
    library_path: str
    total_items: int
    new_bundles: int
    skipped_existing: int
    skipped_deleted: int
    folders: int
    tags: int
    tag_groups: int
    merge_suggestions: tuple[MergeSuggestion, ...]
    warnings: tuple[str, ...]
    new_item_ids: tuple[str, ...] = field(default=())


def _group_stem(name: str) -> str:
    """Strip a trailing part/cover/language token so siblings share a stem."""
    return _GROUPING_SUFFIX.sub("", name).strip().lower() or name.lower()


def _merge_suggestions(items: list[EagleItem]) -> list[MergeSuggestion]:
    by_key: dict[tuple[tuple[str, ...], str], list[EagleItem]] = defaultdict(list)
    for it in items:
        by_key[(it.folder_ids, _group_stem(it.name))].append(it)

    suggestions: list[MergeSuggestion] = []
    for (_folders, stem), group in by_key.items():
        if len(group) > 1:
            suggestions.append(
                MergeSuggestion(
                    reason=f"{len(group)} items share the base name {stem!r}",
                    item_ids=tuple(sorted(i.id for i in group)),
                )
            )
    return sorted(suggestions, key=lambda s: s.item_ids)


def plan_import(library: EagleLibrary, already_imported: set[str]) -> ImportPlan:
    deleted = [i for i in library.items if i.is_deleted]
    live = [i for i in library.items if not i.is_deleted]
    new = [i for i in live if i.id not in already_imported]
    skipped_existing = sum(1 for i in live if i.id in already_imported)

    distinct_tags = {t for i in new for t in i.tags}
    distinct_tags |= {t for g in library.tag_groups for t in g.tags}

    return ImportPlan(
        library_path=str(library.path),
        total_items=len(library.items),
        new_bundles=len(new),
        skipped_existing=skipped_existing,
        skipped_deleted=len(deleted),
        folders=len(library.folders),
        tags=len(distinct_tags),
        tag_groups=len(library.tag_groups),
        merge_suggestions=tuple(_merge_suggestions(new)),
        warnings=library.warnings,
        new_item_ids=tuple(i.id for i in new),
    )
