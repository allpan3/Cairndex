"""Path-safety tests (AGENTS.md §15: traversal rejection is mandatory)."""

import os
from pathlib import Path

import pytest

from cairndex.core.paths import (
    PathSafetyError,
    normalize_relative_path,
    resolve_within_root,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("movie/a.mp4", "movie/a.mp4"),
        ("./movie/a.mp4", "movie/a.mp4"),
        ("movie//a.mp4", "movie/a.mp4"),
        ("movie/./sub/a.mp4", "movie/sub/a.mp4"),
        ("a.mp4", "a.mp4"),
        ("dir/", "dir"),
    ],
)
def test_normalize_accepts_and_cleans(raw: str, expected: str) -> None:
    assert normalize_relative_path(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "/etc/passwd",
        "\\windows\\system32",
        "C:\\secrets",
        "../escape",
        "a/../../etc/passwd",
        "movie/../../etc",
        "with\x00null",
    ],
)
def test_normalize_rejects_unsafe(raw: str) -> None:
    with pytest.raises(PathSafetyError):
        normalize_relative_path(raw)


def test_resolve_returns_path_inside_root(tmp_path: Path) -> None:
    root = tmp_path / "media"
    root.mkdir()
    resolved = resolve_within_root(root, "movie/a.mp4")
    assert resolved == (root / "movie" / "a.mp4").resolve()
    assert resolved.is_relative_to(root.resolve())


def test_resolve_rejects_absolute_relative_path(tmp_path: Path) -> None:
    with pytest.raises(PathSafetyError):
        resolve_within_root(tmp_path, "/etc/passwd")


def test_resolve_rejects_parent_traversal(tmp_path: Path) -> None:
    root = tmp_path / "media"
    root.mkdir()
    with pytest.raises(PathSafetyError):
        resolve_within_root(root, "../../etc/passwd")


def test_resolve_rejects_symlink_escape(tmp_path: Path) -> None:
    root = tmp_path / "media"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("top secret")

    # A symlink inside the root that points outside it must not be a way out.
    escape_link = root / "escape"
    os.symlink(outside, escape_link)

    with pytest.raises(PathSafetyError):
        resolve_within_root(root, "escape/secret.txt")


def test_resolve_allows_symlink_that_stays_inside_root(tmp_path: Path) -> None:
    root = tmp_path / "media"
    (root / "real").mkdir(parents=True)
    (root / "real" / "a.mp4").write_text("data")

    inside_link = root / "alias"
    os.symlink(root / "real", inside_link)

    resolved = resolve_within_root(root, "alias/a.mp4")
    assert resolved.is_relative_to(root.resolve())
    assert resolved.read_text() == "data"
