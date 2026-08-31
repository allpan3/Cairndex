"""Extract one version's section from CHANGELOG.md, for a release body.

`release.yml` used GitHub's generated notes, which list the pull requests merged
since the last tag. That is only a description of a release when every change
arrived through a pull request. v0.1.1 was mostly merged directly onto `main`
after the repository was recreated, so the generated notes named a single PR for
a release containing a feature, eleven fixes and a breaking change — and the
notes had to be rewritten by hand after the fact.

The changelog is already the curated record, written for the people who read
releases. This makes it the source.

    python infra/release_notes.py v0.2.0 > notes.md

Missing sections are an error rather than an empty release: the documented
release procedure says to move `Unreleased` under the new version *before*
tagging, and failing here is what makes forgetting that visible at the point it
can still be fixed.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# "## [0.1.1] — 2026-07-30" / "## [0.1.1] - 2026-07-30" / "## [0.1.1]".
# The repository uses an em dash; a hyphen is accepted so a hand-edited entry
# does not silently fail to match.
_HEADING = re.compile(r"^## \[(?P<version>[^\]]+)\]")


def version_from_tag(tag: str) -> str:
    """`v0.1.1` -> `0.1.1`. Any other shape is returned unchanged."""
    return tag[1:] if tag.startswith("v") else tag


def extract(changelog: str, version: str) -> str:
    """Return the body of the `## [version]` section, without its heading.

    Stops at the next `## ` heading, so a section keeps its own `### Added` /
    `### Fixed` subheadings and nothing from the release below it.
    """
    lines = changelog.splitlines()
    start: int | None = None
    for i, line in enumerate(lines):
        match = _HEADING.match(line)
        if match and match.group("version") == version:
            start = i + 1
            break

    if start is None:
        available = [
            m.group("version") for m in (_HEADING.match(line) for line in lines) if m
        ]
        raise SystemExit(
            f"CHANGELOG.md has no '## [{version}]' section.\n"
            f"Sections present: {', '.join(available) or '(none)'}\n"
            "Move the Unreleased entries under the new version before tagging "
            "(docs/deployment.md, 'Cutting a release')."
        )

    end = len(lines)
    for i in range(start, len(lines)):
        if lines[i].startswith("## "):
            end = i
            break

    body = "\n".join(lines[start:end]).strip()
    if not body:
        raise SystemExit(
            f"CHANGELOG.md section '## [{version}]' is empty. A release with no "
            "notes is almost certainly a mistake."
        )
    return body


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag", help="Release tag, e.g. v0.1.1 (or a bare version)")
    parser.add_argument(
        "--changelog",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "CHANGELOG.md",
        help="Path to CHANGELOG.md (defaults to the repository root)",
    )
    args = parser.parse_args(argv)

    version = version_from_tag(args.tag)
    print(extract(args.changelog.read_text(encoding="utf-8"), version))
    return 0


if __name__ == "__main__":
    sys.exit(main())
