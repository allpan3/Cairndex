"""Read-only parsing of a (synthetic) Eagle .library directory (ADR-0004)."""

import json
from pathlib import Path

import pytest

from cairndex.core.errors import ValidationError
from cairndex.eagle.reader import read_library


def build_library(root: Path) -> Path:
    """Create a minimal but representative synthetic Eagle library on disk."""
    lib = root / "My.library"
    images = lib / "images"
    images.mkdir(parents=True)

    (lib / "metadata.json").write_text(
        json.dumps(
            {
                "folders": [
                    {
                        "id": "fold_a",
                        "name": "Movies",
                        "children": [{"id": "fold_a1", "name": "2024", "children": []}],
                    },
                    {"id": "fold_b", "name": "Photos"},
                ],
                "tagsGroups": [{"name": "Genre", "tags": ["action", "drama"]}],
            }
        ),
        encoding="utf-8",
    )

    def item(item_id: str, meta: dict) -> None:
        info = images / f"{item_id}.info"
        info.mkdir()
        (info / "metadata.json").write_text(json.dumps({"id": item_id, **meta}), encoding="utf-8")
        (info / f"{meta['name']}.{meta['ext']}").write_bytes(b"x")

    item(
        "IT1",
        {
            "name": "The Matrix",
            "ext": "MP4",
            "tags": ["action", "scifi"],
            "folders": ["fold_a1"],
            "annotation": "great",
            "url": "https://example.com/m",
            "star": 5,
        },
    )
    item("IT2", {"name": "kitten", "ext": "jpg", "folders": ["fold_b"], "star": 0})
    item("IT3", {"name": "trash", "ext": "png", "isDeleted": True})
    return lib


def test_reads_folders_groups_and_items(tmp_path: Path) -> None:
    lib = read_library(build_library(tmp_path))

    # Nested folders are flattened with parent linkage.
    by_id = {f.id: f for f in lib.folders}
    assert by_id["fold_a1"].parent_id == "fold_a"
    assert by_id["fold_a"].parent_id is None
    assert {f.name for f in lib.folders} == {"Movies", "2024", "Photos"}

    assert lib.tag_groups[0].name == "Genre"
    assert lib.tag_groups[0].tags == ("action", "drama")

    items = {i.id: i for i in lib.items}
    assert set(items) == {"IT1", "IT2", "IT3"}
    m = items["IT1"]
    assert m.name == "The Matrix"
    assert m.ext == "mp4"  # lowercased
    assert m.tags == ("action", "scifi")
    assert m.folder_ids == ("fold_a1",)
    assert m.annotation == "great"
    assert m.url == "https://example.com/m"
    assert m.star == 5
    # Relative path keeps the on-disk extension case (the field is lowercased).
    assert m.file_relpath == "IT1.info/The Matrix.MP4"

    # star 0 → unrated; isDeleted preserved for the planner to skip.
    assert items["IT2"].star is None
    assert items["IT3"].is_deleted is True


def test_rejects_non_library(tmp_path: Path) -> None:
    with pytest.raises(ValidationError):
        read_library(tmp_path / "does-not-exist")
    (tmp_path / "empty").mkdir()
    with pytest.raises(ValidationError):  # missing images/
        read_library(tmp_path / "empty")
