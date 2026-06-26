"""Read-only parser for an Eagle ``.library`` directory (ADR-0004, AGENTS.md §7).

We read the durable on-disk format — never the running Eagle app, and never
opening the library for writing:

    <name>.library/
      metadata.json                      # folders (nested), tagsGroups
      images/<ITEMID>.info/metadata.json # one per item (+ the asset file)

Everything here is pure and side-effect-free except reading files. Malformed
items are skipped and reported rather than aborting the whole import.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from cairndex.core.errors import ValidationError


@dataclass(frozen=True)
class EagleFolder:
    id: str
    name: str
    parent_id: str | None


@dataclass(frozen=True)
class EagleTagGroup:
    name: str
    tags: tuple[str, ...]


@dataclass(frozen=True)
class EagleItem:
    id: str
    name: str
    ext: str
    tags: tuple[str, ...]
    folder_ids: tuple[str, ...]
    annotation: str | None
    url: str | None
    star: int | None  # 1–5, or None when unrated (Eagle stores 0 for unrated)
    is_deleted: bool
    # Path of the asset relative to ``images/`` — e.g. "ABC123.info/photo.jpg".
    file_relpath: str


@dataclass(frozen=True)
class EagleLibrary:
    path: Path
    images_dir: Path
    folders: tuple[EagleFolder, ...]
    tag_groups: tuple[EagleTagGroup, ...]
    items: tuple[EagleItem, ...]
    warnings: tuple[str, ...] = field(default=())


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValidationError(f"could not read {path.name}: {exc}") from exc


def _flatten_folders(raw: list[dict[str, Any]], parent_id: str | None) -> list[EagleFolder]:
    out: list[EagleFolder] = []
    for node in raw:
        fid, name = node.get("id"), node.get("name")
        if not fid or not name:
            continue
        out.append(EagleFolder(id=str(fid), name=str(name), parent_id=parent_id))
        children = node.get("children")
        if isinstance(children, list):
            out.extend(_flatten_folders(children, str(fid)))
    return out


def _parse_tag_groups(raw: list[dict[str, Any]]) -> list[EagleTagGroup]:
    groups: list[EagleTagGroup] = []
    for g in raw:
        name = g.get("name")
        tags = g.get("tags")
        if not name or not isinstance(tags, list):
            continue
        groups.append(EagleTagGroup(name=str(name), tags=tuple(str(t) for t in tags)))
    return groups


def _parse_item(info_dir: Path) -> EagleItem | None:
    meta_path = info_dir / "metadata.json"
    if not meta_path.is_file():
        return None
    data = _load_json(meta_path)
    if not isinstance(data, dict):
        return None
    item_id = data.get("id")
    name = data.get("name")
    ext = data.get("ext")
    if not item_id or name is None or not ext:
        return None

    star = data.get("star")
    rating = int(star) if isinstance(star, int) and star > 0 else None
    raw_tags = data.get("tags")
    tags = raw_tags if isinstance(raw_tags, list) else []
    raw_folders = data.get("folders")
    folders = raw_folders if isinstance(raw_folders, list) else []

    filename = f"{name}.{ext}"
    return EagleItem(
        id=str(item_id),
        name=str(name),
        ext=str(ext).lower(),
        tags=tuple(str(t) for t in tags),
        folder_ids=tuple(str(f) for f in folders),
        annotation=(str(data["annotation"]) or None) if data.get("annotation") else None,
        url=(str(data["url"]) or None) if data.get("url") else None,
        star=rating,
        is_deleted=bool(data.get("isDeleted", False)),
        file_relpath=f"{info_dir.name}/{filename}",
    )


def read_library(library_path: Path) -> EagleLibrary:
    """Parse an Eagle ``.library`` directory (read-only)."""
    if not library_path.is_dir():
        raise ValidationError(f"not an Eagle library directory: {library_path}")
    images_dir = library_path / "images"
    if not images_dir.is_dir():
        raise ValidationError(f"missing images/ directory in {library_path}")

    library_meta = _load_json(library_path / "metadata.json")
    if not isinstance(library_meta, dict):
        raise ValidationError("library metadata.json is not an object")

    folders = _flatten_folders(library_meta.get("folders") or [], None)
    tag_groups = _parse_tag_groups(library_meta.get("tagsGroups") or [])

    items: list[EagleItem] = []
    warnings: list[str] = []
    for info_dir in sorted(images_dir.iterdir()):
        if not info_dir.is_dir() or not info_dir.name.endswith(".info"):
            continue
        try:
            item = _parse_item(info_dir)
        except ValidationError as exc:
            warnings.append(str(exc))
            continue
        if item is None:
            warnings.append(f"skipped unreadable item dir {info_dir.name}")
        else:
            items.append(item)

    return EagleLibrary(
        path=library_path,
        images_dir=images_dir,
        folders=tuple(folders),
        tag_groups=tuple(tag_groups),
        items=tuple(items),
        warnings=tuple(warnings),
    )
