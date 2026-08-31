"""Validate Cairndex release metadata and an optional release tag.

All Cairndex surfaces ship from one repository and one release workflow. Their
package metadata is duplicated because Python, npm, Cargo, and Tauri each need
their own native file, so this gate makes that duplication explicit and safe.

    python3 infra/release_version.py
    python3 infra/release_version.py --tag v0.2.0
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
_VERSION = re.compile(
    r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)


# Read a UTF-8 JSON object and reject another top-level shape
def _json_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit(f"{path}: expected a JSON object")
    return value


# Read a version from one named TOML table without requiring Python 3.11
def _toml_table_version(path: Path, table_name: str) -> str:
    active_table = ""
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            active_table = stripped
            continue
        if active_table != f"[{table_name}]":
            continue
        match = re.fullmatch(r'version\s*=\s*"([^"]+)"', stripped)
        if match:
            return match.group(1)
    raise SystemExit(f"{path}: no version in [{table_name}]")


# Find one named package in a TOML lockfile
def _locked_package_version(path: Path, package_name: str) -> str:
    matches: list[str] = []
    for block in path.read_text(encoding="utf-8").split("[[package]]"):
        name = re.search(r'^name\s*=\s*"([^"]+)"$', block, re.MULTILINE)
        version = re.search(r'^version\s*=\s*"([^"]+)"$', block, re.MULTILINE)
        if name and name.group(1) == package_name and version:
            matches.append(version.group(1))
    if len(matches) != 1:
        raise SystemExit(f"{path}: expected one {package_name!r} package, found {len(matches)}")
    return matches[0]


# Collect every release-bearing metadata value with a useful error label
def collect_versions(repo_root: Path = REPO_ROOT) -> dict[str, str]:
    web_package = _json_object(repo_root / "apps/web/package.json")
    web_lock = _json_object(repo_root / "apps/web/package-lock.json")
    desktop_package = _json_object(repo_root / "apps/desktop/package.json")
    desktop_lock = _json_object(repo_root / "apps/desktop/package-lock.json")
    tauri_config = _json_object(repo_root / "apps/desktop/src-tauri/tauri.conf.json")

    return {
        "VERSION": (repo_root / "VERSION").read_text(encoding="utf-8").strip(),
        "apps/server/pyproject.toml": _toml_table_version(
            repo_root / "apps/server/pyproject.toml", "project"
        ),
        "apps/server/uv.lock": _locked_package_version(
            repo_root / "apps/server/uv.lock", "cairndex-server"
        ),
        "apps/web/package.json": str(web_package["version"]),
        "apps/web/package-lock.json": str(web_lock["version"]),
        "apps/web/package-lock.json packages['']": str(web_lock["packages"][""]["version"]),
        "apps/desktop/package.json": str(desktop_package["version"]),
        "apps/desktop/package-lock.json": str(desktop_lock["version"]),
        "apps/desktop/package-lock.json packages['']": str(desktop_lock["packages"][""]["version"]),
        "apps/desktop/src-tauri/Cargo.toml": _toml_table_version(
            repo_root / "apps/desktop/src-tauri/Cargo.toml", "package"
        ),
        "apps/desktop/src-tauri/Cargo.lock": _locked_package_version(
            repo_root / "apps/desktop/src-tauri/Cargo.lock", "cairndex-desktop"
        ),
        "apps/desktop/src-tauri/tauri.conf.json": str(tauri_config["version"]),
    }


# Return the shared version or fail with every disagreeing source
def validate_versions(versions: dict[str, str], tag: str | None = None) -> str:
    canonical = versions.get("VERSION", "")
    if not _VERSION.fullmatch(canonical):
        raise SystemExit(f"VERSION is not a valid semantic version: {canonical!r}")

    disagreements = {name: value for name, value in versions.items() if value != canonical}
    if disagreements:
        lines = [f"release version mismatch; VERSION is {canonical}:"]
        lines.extend(f"  {name}: {value}" for name, value in disagreements.items())
        raise SystemExit("\n".join(lines))

    if tag is not None:
        if not tag.startswith("v"):
            raise SystemExit(f"release tag must start with 'v': {tag!r}")
        tag_version = tag[1:]
        if tag_version != canonical:
            raise SystemExit(f"release tag {tag!r} does not match repository version {canonical!r}")

    return canonical


# Reject a manual dispatch whose provenance ref differs from its release tag
def validate_dispatch_ref(
    event_name: str | None,
    ref_type: str | None,
    ref_name: str | None,
    tag: str | None,
) -> None:
    if event_name != "workflow_dispatch":
        return
    if tag is None or ref_type != "tag" or ref_name != tag:
        raise SystemExit(
            "manual release must be dispatched from the same tag passed as --tag "
            f"(ref_type={ref_type!r}, ref_name={ref_name!r}, tag={tag!r})"
        )


# Run the repository gate
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="Release tag to compare, e.g. v0.1.1")
    parser.add_argument("--event-name", help="GitHub event name for dispatch validation")
    parser.add_argument("--ref-type", help="GitHub ref type for dispatch validation")
    parser.add_argument("--ref-name", help="GitHub ref name for dispatch validation")
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=REPO_ROOT,
        help="Repository root (defaults to the script's parent repository)",
    )
    args = parser.parse_args(argv)
    validate_dispatch_ref(args.event_name, args.ref_type, args.ref_name, args.tag)
    version = validate_versions(collect_versions(args.repo_root), args.tag)
    suffix = f" and tag {args.tag}" if args.tag else ""
    print(f"release version OK: {version}{suffix}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
