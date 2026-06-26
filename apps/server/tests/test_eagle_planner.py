"""Dry-run Eagle import planning (ADR-0004): counts, skips, merge hints."""

import json
from pathlib import Path

from cairndex.eagle.planner import plan_import
from cairndex.eagle.reader import read_library


def _library(root: Path, items: list[dict]) -> Path:
    lib = root / "L.library"
    images = lib / "images"
    images.mkdir(parents=True)
    (lib / "metadata.json").write_text(
        json.dumps({"folders": [{"id": "f1", "name": "Movies"}], "tagsGroups": []}),
        encoding="utf-8",
    )
    for it in items:
        info = images / f"{it['id']}.info"
        info.mkdir()
        (info / "metadata.json").write_text(json.dumps(it), encoding="utf-8")
        (info / f"{it['name']}.{it['ext']}").write_bytes(b"x")
    return lib


def test_plan_counts_and_skips(tmp_path: Path) -> None:
    lib = read_library(
        _library(
            tmp_path,
            [
                {"id": "A", "name": "alpha", "ext": "mp4", "tags": ["x"], "folders": ["f1"]},
                {"id": "B", "name": "beta", "ext": "mp4", "tags": ["y"]},
                {"id": "C", "name": "gone", "ext": "mp4", "isDeleted": True},
            ],
        )
    )

    plan = plan_import(lib, already_imported={"B"})
    assert plan.total_items == 3
    assert plan.new_bundles == 1  # A (B already imported, C deleted)
    assert plan.skipped_existing == 1
    assert plan.skipped_deleted == 1
    assert plan.new_item_ids == ("A",)
    assert plan.tags == 1  # only A's tags counted among new items
    assert plan.folders == 1


def test_merge_suggestions_group_by_base_name(tmp_path: Path) -> None:
    lib = read_library(
        _library(
            tmp_path,
            [
                {"id": "P1", "name": "movie.part1", "ext": "mkv", "folders": ["f1"]},
                {"id": "P2", "name": "movie.part2", "ext": "mkv", "folders": ["f1"]},
                {"id": "S", "name": "solo", "ext": "mkv", "folders": ["f1"]},
            ],
        )
    )

    plan = plan_import(lib, already_imported=set())
    assert plan.new_bundles == 3
    assert len(plan.merge_suggestions) == 1
    assert plan.merge_suggestions[0].item_ids == ("P1", "P2")
