"""Fail closed when a Git publication range contains likely private material.

The gate scans Git objects rather than only the final working tree. That matters
because a secret or screenshot introduced and deleted by a later commit remains
reachable through the pull-request commit graph. Generic high-confidence rules
run everywhere; a local untracked pattern file adds owner-specific literals
without publishing those private values in this repository.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
ALLOWLIST_PATH = REPO_ROOT / ".github" / "privacy-allowlist.json"
MAX_UNREVIEWED_BLOB_BYTES = 1024 * 1024
ZERO_OID = "0" * 40

_PLACEHOLDER_USERS = {
    "app",
    "cairndex",
    "example",
    "me",
    "owner",
    "runner",
    "user",
    "username",
    "…",
    "...",
}
_PLACEHOLDER_VALUE_PARTS = {
    "changeme",
    "change-me",
    "example",
    "fake",
    "placeholder",
    "replace-me",
    "sample",
    "synthetic",
    "test",
}
_KNOWN_SECRET_RULES = (
    (
        "private-key material",
        re.compile(r"-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----"),
    ),
    (
        "GitHub credential",
        re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
    ),
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    (
        "OpenAI credential",
        re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b"),
    ),
    (
        "Slack credential",
        re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    ),
    (
        "Google API credential",
        re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"),
    ),
)
_QUOTED_SECRET = re.compile(
    r"(?i)\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)"
    r"\s*[:=]\s*(['\"])(?P<value>[^'\"\r\n]{12,})\1"
)
_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_POSIX_HOME = re.compile(r"/(?:Users|home)/([^/\s'\"`]+)")
_WINDOWS_HOME = re.compile(r"(?i)\b[A-Z]:\\Users\\([^\\\s'\"`]+)")
_COMMIT_IDENTITY_EMAIL = re.compile(
    r"^(?P<prefix>(?:author|committer) .+ <)[^<>\r\n]+(?P<suffix>> \d+ [+-]\d{4})$",
    re.MULTILINE,
)
_BINARY_MAGIC = (
    b"\x89PNG\r\n\x1a\n",
    b"\xff\xd8\xff",
    b"GIF87a",
    b"GIF89a",
    b"%PDF-",
    b"PK\x03\x04",
    b"SQLite format 3\x00",
    b"\x7fELF",
    b"\xca\xfe\xba\xbe",
    b"\xcf\xfa\xed\xfe",
)


# Describe one reviewed binary independently of its filename
@dataclass(frozen=True)
class BinaryAllowance:
    sha256: str
    paths: frozenset[str]
    purpose: str
    provenance: str


# Hold the repository-root and binary publication policy
@dataclass(frozen=True)
class PrivacyAllowlist:
    root_entries: frozenset[str]
    binaries: dict[str, BinaryAllowance]


# Run Git with byte-preserving output and a stable repository root
def _git(repo_root: Path, *args: str, input_bytes: bytes | None = None) -> bytes:
    process = subprocess.run(
        ["git", "-c", "core.quotePath=false", *args],
        cwd=repo_root,
        input=input_bytes,
        capture_output=True,
        check=False,
    )
    if process.returncode:
        message = process.stderr.decode("utf-8", errors="replace").strip()
        raise SystemExit(f"git {' '.join(args)} failed: {message}")
    return process.stdout


# Stream Git objects through one process so whole-history audits stay fast
def _cat_objects(repo_root: Path, object_ids: list[str]) -> Iterator[tuple[str, str, bytes]]:
    process = subprocess.Popen(
        ["git", "cat-file", "--batch"],
        cwd=repo_root,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stdin is not None and process.stdout is not None
    try:
        for oid in object_ids:
            process.stdin.write(f"{oid}\n".encode())
            process.stdin.flush()
            header = process.stdout.readline().decode("ascii", errors="replace").strip()
            fields = header.split()
            if len(fields) != 3 or fields[1] == "missing":
                raise SystemExit(f"git cat-file could not read object {oid[:12]}")
            object_type = fields[1]
            size = int(fields[2])
            data = process.stdout.read(size)
            if process.stdout.read(1) != b"\n":
                raise SystemExit("git cat-file returned malformed batch output")
            yield oid, object_type, data
    finally:
        process.stdin.close()
        return_code = process.wait()
        if return_code:
            assert process.stderr is not None
            message = process.stderr.read().decode("utf-8", errors="replace").strip()
            raise SystemExit(f"git cat-file --batch failed: {message}")


# Load the reviewed root-path and immutable binary inventory
def load_allowlist(path: Path = ALLOWLIST_PATH) -> PrivacyAllowlist:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema") != 1:
        raise SystemExit(f"{path}: unsupported privacy allowlist schema")

    binaries: dict[str, BinaryAllowance] = {}
    for item in payload.get("binaries", []):
        digest = str(item["sha256"]).lower()
        allowance = BinaryAllowance(
            sha256=digest,
            paths=frozenset(str(value) for value in item["paths"]),
            purpose=str(item["purpose"]).strip(),
            provenance=str(item["provenance"]).strip(),
        )
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise SystemExit(f"{path}: invalid binary SHA-256")
        if not allowance.paths or not allowance.purpose or not allowance.provenance:
            raise SystemExit(f"{path}: every binary needs paths, purpose, and provenance")
        if digest in binaries:
            raise SystemExit(f"{path}: duplicate binary SHA-256")
        binaries[digest] = allowance

    return PrivacyAllowlist(
        root_entries=frozenset(str(value) for value in payload["allowed_root_entries"]),
        binaries=binaries,
    )


# Resolve configured private-literal files without printing their locations
def _configured_pattern_paths(repo_root: Path, explicit: list[Path]) -> list[Path]:
    paths = list(explicit)
    configured = subprocess.run(
        ["git", "config", "--path", "--get-all", "cairndex.privacyPatternsFile"],
        cwd=repo_root,
        capture_output=True,
        check=False,
    )
    if configured.returncode not in {0, 1}:
        raise SystemExit("could not read cairndex.privacyPatternsFile from Git config")
    for raw in configured.stdout.decode("utf-8", errors="strict").splitlines():
        if raw.strip():
            paths.append(Path(raw.strip()).expanduser())

    environment_path = os.environ.get("CAIRNDEX_PRIVACY_PATTERNS_FILE", "").strip()
    if environment_path:
        paths.append(Path(environment_path).expanduser())

    private_git_path = Path(
        _git(
            repo_root,
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "cairndex-private-patterns",
        )
        .decode("utf-8", errors="strict")
        .strip()
    )
    if private_git_path.exists():
        paths.append(private_git_path)

    unique: list[Path] = []
    for path in paths:
        resolved = path.resolve()
        if resolved not in unique:
            unique.append(resolved)
    return unique


# Load literal private values while keeping them outside Git output
def load_private_patterns(
    repo_root: Path, explicit: list[Path], require_patterns: bool
) -> list[str]:
    patterns: list[str] = []
    for path in _configured_pattern_paths(repo_root, explicit):
        if not path.is_file():
            raise SystemExit("configured private-pattern file is missing")
        for line in path.read_text(encoding="utf-8").splitlines():
            value = line.strip()
            if value and not value.startswith("#"):
                patterns.append(value)

    if require_patterns and not patterns:
        raise SystemExit(
            "no local private patterns configured; run `just install-privacy-hooks` "
            "and populate the private pattern file before publication"
        )
    return patterns


# Identify binary or opaque payloads without trusting a filename extension
def is_binary(data: bytes) -> bool:
    if any(data.startswith(magic) for magic in _BINARY_MAGIC):
        return True
    if b"\x00" in data[:8192]:
        return True
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return True
    return False


# Add high-confidence secret, path, email, and owner-literal findings
def scan_text(text: str, label: str, private_patterns: list[str]) -> list[str]:
    findings: list[str] = []
    for rule_name, pattern in _KNOWN_SECRET_RULES:
        for match in pattern.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            findings.append(f"{label}:{line}: {rule_name}")

    for match in _QUOTED_SECRET.finditer(text):
        value = match.group("value").casefold()
        if not any(part in value for part in _PLACEHOLDER_VALUE_PARTS):
            line = text.count("\n", 0, match.start()) + 1
            findings.append(f"{label}:{line}: quoted credential-like value")

    for pattern_name, pattern in (
        ("POSIX home path", _POSIX_HOME),
        ("Windows home path", _WINDOWS_HOME),
    ):
        for match in pattern.finditer(text):
            if match.group(1).casefold() not in _PLACEHOLDER_USERS:
                line = text.count("\n", 0, match.start()) + 1
                findings.append(f"{label}:{line}: {pattern_name}")

    for match in _EMAIL.finditer(text):
        address = match.group(0).casefold()
        if not (
            address.startswith("noreply@")
            or address.endswith("@users.noreply.github.com")
            or address == "noreply@github.com"
            or address.endswith("@example.com")
            or address.endswith("@example.org")
            or address.endswith("@example.net")
            or re.search(r"@\d+x\.[a-z0-9]+$", address)
        ):
            line = text.count("\n", 0, match.start()) + 1
            findings.append(f"{label}:{line}: non-placeholder email address")

    folded = text.casefold()
    for index, private_pattern in enumerate(private_patterns, start=1):
        start = folded.find(private_pattern.casefold())
        if start >= 0:
            line = text.count("\n", 0, start) + 1
            findings.append(f"{label}:{line}: private pattern #{index}")
    return findings


# Scan commit messages and metadata while accepting standard Git identity emails
def scan_commit(data: bytes, oid: str, private_patterns: list[str]) -> list[str]:
    metadata = data.decode("utf-8", errors="replace")
    metadata = _COMMIT_IDENTITY_EMAIL.sub(r"\g<prefix>you@example.com\g<suffix>", metadata)
    return scan_text(metadata, f"commit {oid[:12]}", private_patterns)


# Reject suspicious or previously unreviewed publication paths
def scan_path(
    path: str, label: str, allowlist: PrivacyAllowlist, private_patterns: list[str]
) -> list[str]:
    findings = scan_text(path, label, private_patterns)
    if not path or path.startswith("/") or "\x00" in path or "\n" in path or "\r" in path:
        findings.append(f"{label}: malformed or absolute repository path")
        return findings

    parts = PurePosixPath(path).parts
    if parts and parts[0] not in allowlist.root_entries:
        findings.append(f"{label}: unreviewed repository-root entry")
    if any(part.startswith("-") for part in parts):
        findings.append(f"{label}: flag-like path component")
    return findings


# Scan one Git blob and enforce immutable binary provenance
def scan_blob(
    data: bytes,
    oid: str,
    paths: set[str],
    allowlist: PrivacyAllowlist,
    private_patterns: list[str],
) -> list[str]:
    label = f"blob {oid[:12]}"
    digest = hashlib.sha256(data).hexdigest()
    binary = is_binary(data)
    if binary:
        allowance = allowlist.binaries.get(digest)
        if allowance is None:
            return [f"{label}: unreviewed binary blob {digest}"]
        unexpected_paths = paths - set(allowance.paths)
        if unexpected_paths:
            return [f"{label}: allowlisted binary used at an unreviewed path"]
        return []

    findings: list[str] = []
    if len(data) > MAX_UNREVIEWED_BLOB_BYTES:
        findings.append(f"{label}: unreviewed text blob exceeds 1 MiB")
    text = data.decode("utf-8", errors="strict")
    findings.extend(scan_text(text, label, private_patterns))
    return findings


# Resolve annotated tags and other revisions to commit objects
def _commit_oid(repo_root: Path, revision: str) -> str:
    return _git(repo_root, "rev-parse", f"{revision}^{{commit}}").decode().strip()


# Enumerate commits and newly reachable objects for one publication range
def _range_objects(
    repo_root: Path, head: str, base: str | None, all_history: bool
) -> tuple[list[str], dict[str, set[str]]]:
    head_oid = _commit_oid(repo_root, head)
    if all_history:
        revision = head_oid
    else:
        if base is None:
            raise SystemExit("a base revision is required for a range audit")
        base_oid = _commit_oid(repo_root, base)
        merge_base = _git(repo_root, "merge-base", base_oid, head_oid).decode().strip()
        revision = f"{merge_base}..{head_oid}"

    commits = _git(repo_root, "rev-list", "--reverse", revision).decode().splitlines()
    objects: dict[str, set[str]] = {}
    records = _git(repo_root, "rev-list", "--objects", "-z", revision).split(b"\x00")
    current_oid: str | None = None
    for record in records:
        if not record:
            continue
        if record.startswith(b"path="):
            if current_oid is None:
                raise SystemExit("git rev-list returned a path without an object")
            path = record.removeprefix(b"path=").decode("utf-8", errors="surrogateescape")
            objects[current_oid].add(path)
        else:
            current_oid = record.decode("ascii", errors="strict")
            objects.setdefault(current_oid, set())
    return commits, objects


# Scan every commit, path, and blob that a push or pull request would expose
def scan_range(
    repo_root: Path,
    head: str,
    base: str | None,
    all_history: bool,
    allowlist: PrivacyAllowlist,
    private_patterns: list[str],
) -> tuple[list[str], int, int]:
    commits, objects = _range_objects(repo_root, head, base, all_history)
    findings: list[str] = []
    blob_count = 0
    for oid, object_type, data in _cat_objects(repo_root, list(objects)):
        paths = objects[oid]
        for path in paths:
            findings.extend(
                scan_path(path, f"path in object {oid[:12]}", allowlist, private_patterns)
            )
        if object_type == "commit":
            findings.extend(scan_commit(data, oid, private_patterns))
        elif object_type == "blob":
            blob_count += 1
            findings.extend(scan_blob(data, oid, paths, allowlist, private_patterns))
    return findings, len(commits), blob_count


# Scan the exact index snapshot before Git creates a commit
def scan_staged(
    repo_root: Path, allowlist: PrivacyAllowlist, private_patterns: list[str]
) -> tuple[list[str], int]:
    paths = [
        value.decode("utf-8", errors="surrogateescape")
        for value in _git(repo_root, "diff", "--cached", "--name-only", "-z").split(b"\x00")
        if value
    ]
    findings: list[str] = []
    for path in paths:
        findings.extend(scan_path(path, "staged path", allowlist, private_patterns))
        stage = _git(repo_root, "ls-files", "--stage", "--", path).decode().strip()
        if not stage:
            continue
        oid = stage.split(maxsplit=2)[1]
        data = _git(repo_root, "cat-file", "blob", oid)
        findings.extend(scan_blob(data, oid, {path}, allowlist, private_patterns))
    return findings, len(paths)


# Read pull-request or push coordinates without interpolating untrusted text in a shell
def scan_github_event(
    repo_root: Path,
    event_path: Path,
    allowlist: PrivacyAllowlist,
    private_patterns: list[str],
) -> tuple[list[str], str]:
    event: dict[str, Any] = json.loads(event_path.read_text(encoding="utf-8"))
    if "pull_request" in event:
        pull_request = event["pull_request"]
        findings, commits, blobs = scan_range(
            repo_root,
            str(pull_request["head"]["sha"]),
            str(pull_request["base"]["sha"]),
            False,
            allowlist,
            private_patterns,
        )
        findings.extend(
            scan_text(str(pull_request.get("title") or ""), "PR title", private_patterns)
        )
        findings.extend(scan_text(str(pull_request.get("body") or ""), "PR body", private_patterns))
        findings.extend(
            scan_text(str(pull_request["head"].get("ref") or ""), "PR branch", private_patterns)
        )
        return findings, f"{commits} PR commits and {blobs} newly reachable blobs"

    before = str(event.get("before") or ZERO_OID)
    after = str(event.get("after") or "HEAD")
    if before == ZERO_OID or not before.strip("0"):
        findings, commits, blobs = scan_range(
            repo_root, after, None, True, allowlist, private_patterns
        )
    else:
        findings, commits, blobs = scan_range(
            repo_root, after, before, False, allowlist, private_patterns
        )
    return findings, f"{commits} pushed commits and {blobs} newly reachable blobs"


# Report only a count because every finding remains derived from sensitive input
def report(findings: list[str], summary: str, private_pattern_count: int) -> int:
    if findings:
        print("PRIVACY GATE FAILED", file=sys.stderr)
        print(
            f"{len(set(findings))} private-content finding(s); details withheld",
            file=sys.stderr,
        )
        print("No push, pull request, tag, release, or image publication is safe.", file=sys.stderr)
        return 1
    print(f"privacy gate OK: {summary}; {private_pattern_count} private patterns")
    return 0


# Install tracked hooks and initialize the Git-private literal profile
def install_hooks(repo_root: Path) -> int:
    _git(repo_root, "config", "core.hooksPath", ".githooks")
    pattern_path = Path(
        _git(
            repo_root,
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "cairndex-private-patterns",
        )
        .decode("utf-8", errors="strict")
        .strip()
    )
    if not pattern_path.exists():
        values = {
            str(repo_root),
            f"{repo_root.anchor}{repo_root.parts[1]}/{repo_root.parts[2]}/"
            if len(repo_root.parts) >= 3
            else str(repo_root),
        }
        pattern_path.write_text(
            "# One case-insensitive private literal per line\n"
            "# This file stays inside Git metadata and is never committed\n"
            + "\n".join(sorted(values))
            + "\n",
            encoding="utf-8",
        )
    print("privacy hooks installed; maintain literals in Git's cairndex-private-patterns file")
    return 0


# Parse one explicit audit mode so callers cannot accidentally scan nothing
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--staged", action="store_true", help="scan the current Git index")
    mode.add_argument("--base", help="base revision for a commit-range audit")
    mode.add_argument(
        "--all-history", action="store_true", help="scan all history reachable from --head"
    )
    mode.add_argument("--github-event", type=Path, help="scan a GitHub pull_request or push event")
    mode.add_argument("--text-file", type=Path, help="scan one commit/PR metadata file")
    mode.add_argument("--install-hooks", action="store_true", help="install tracked local hooks")
    parser.add_argument("--head", default="HEAD", help="head revision for range/history audit")
    parser.add_argument("--pr-title-file", type=Path, help="scan the proposed pull-request title")
    parser.add_argument("--pr-body-file", type=Path, help="scan the proposed pull-request body")
    parser.add_argument("--label", default="publication text", help="label for --text-file")
    parser.add_argument("--pattern-file", type=Path, action="append", default=[])
    parser.add_argument("--require-private-patterns", action="store_true")
    parser.add_argument("--repo-root", type=Path, default=REPO_ROOT)
    args = parser.parse_args(argv)

    repo_root = args.repo_root.resolve()
    if args.install_hooks:
        return install_hooks(repo_root)
    allowlist = load_allowlist(repo_root / ".github" / "privacy-allowlist.json")
    private_patterns = load_private_patterns(
        repo_root, args.pattern_file, args.require_private_patterns
    )

    findings: list[str]
    summary: str
    if args.staged:
        findings, paths = scan_staged(repo_root, allowlist, private_patterns)
        summary = f"{paths} staged paths"
    elif args.base is not None:
        findings, commits, blobs = scan_range(
            repo_root, args.head, args.base, False, allowlist, private_patterns
        )
        summary = f"{commits} commits and {blobs} newly reachable blobs"
    elif args.all_history:
        findings, commits, blobs = scan_range(
            repo_root, args.head, None, True, allowlist, private_patterns
        )
        summary = f"{commits} commits and {blobs} reachable blobs"
    elif args.github_event:
        findings, summary = scan_github_event(
            repo_root, args.github_event, allowlist, private_patterns
        )
    else:
        text = args.text_file.read_text(encoding="utf-8")
        findings = scan_text(text, args.label, private_patterns)
        summary = args.label

    for label, path in (
        ("proposed PR title", args.pr_title_file),
        ("proposed PR body", args.pr_body_file),
    ):
        if path is not None:
            findings.extend(scan_text(path.read_text(encoding="utf-8"), label, private_patterns))
    return report(findings, summary, len(private_patterns))


if __name__ == "__main__":
    sys.exit(main())
