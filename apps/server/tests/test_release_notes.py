"""Tests for infra/release_notes.py, which builds a release body from CHANGELOG.md.

The script lives outside the server package (it is repository tooling, used by
.github/workflows/release.yml), so it is loaded by path. This is the only Python
test suite in the repository, and an extractor that silently returns the wrong
section would put the wrong text on a published release.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[3] / "infra" / "release_notes.py"
_spec = importlib.util.spec_from_file_location("release_notes", _SCRIPT)
assert _spec is not None and _spec.loader is not None
release_notes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(release_notes)


CHANGELOG = """# Changelog

Preamble that must never reach a release body.

## [Unreleased]

_Nothing yet._

## [2.0.0] — 2026-08-01

### Added

- A thing.

### Fixed

- Another thing.

## [1.9.0] — 2026-07-01

### Added

- An older thing that belongs to the release below, not above.
"""


def test_extracts_only_the_named_section():
    body = release_notes.extract(CHANGELOG, "2.0.0")
    assert "A thing." in body
    assert "Another thing." in body
    # Neither the release below nor the file preamble leaks in.
    assert "older thing" not in body
    assert "Preamble" not in body
    assert "Unreleased" not in body


def test_keeps_subheadings_but_drops_its_own_heading():
    body = release_notes.extract(CHANGELOG, "2.0.0")
    assert body.startswith("### Added")
    assert "### Fixed" in body
    assert "## [2.0.0]" not in body


def test_reads_the_last_section_in_the_file():
    # The final section has no `## ` after it; the scan must stop at EOF, not
    # run off the end or return nothing.
    body = release_notes.extract(CHANGELOG, "1.9.0")
    assert "An older thing" in body


def test_tag_prefix_is_optional():
    assert release_notes.version_from_tag("v0.1.1") == "0.1.1"
    assert release_notes.version_from_tag("0.1.1") == "0.1.1"
    # A prerelease tag keeps its suffix, so it looks for its own section rather
    # than silently publishing the release version's notes.
    assert release_notes.version_from_tag("v0.1.1-rc.2") == "0.1.1-rc.2"


def test_missing_section_fails_loudly_and_says_what_exists():
    # The documented procedure is to move Unreleased under the new version
    # before tagging. Forgetting it must fail at tag time, not ship empty notes.
    with pytest.raises(SystemExit) as excinfo:
        release_notes.extract(CHANGELOG, "3.0.0")
    message = str(excinfo.value)
    assert "3.0.0" in message
    assert "2.0.0" in message  # names what it did find


def test_empty_section_is_an_error():
    empty = "# Changelog\n\n## [1.0.0] — 2026-01-01\n\n## [0.9.0] — 2025-12-01\n\n- old\n"
    with pytest.raises(SystemExit) as excinfo:
        release_notes.extract(empty, "1.0.0")
    assert "empty" in str(excinfo.value)


def test_the_real_changelog_has_the_released_version():
    # Guards the actual file and the format the release extractor depends on
    changelog = (_SCRIPT.parent.parent / "CHANGELOG.md").read_text(encoding="utf-8")
    body = release_notes.extract(changelog, "0.2.0")
    assert "###" in body
