"""Tests for the object-level publication privacy gate."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[3] / "infra" / "privacy_gate.py"
_spec = importlib.util.spec_from_file_location("privacy_gate", _SCRIPT)
assert _spec is not None and _spec.loader is not None
privacy_gate = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = privacy_gate
_spec.loader.exec_module(privacy_gate)


# Run one deterministic Git command inside a disposable repository
def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout.strip()


# Create a repository with an identity that is explicitly safe to publish
def initialized_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "user.name", "Synthetic Contributor")
    git(repo, "config", "user.email", "you@example.com")
    return repo


# Build a credential-shaped value without committing a scanner trigger literally
def github_token() -> str:
    return "gh" + "p_" + "A" * 30


# Detect high-confidence credentials while keeping their bytes out of diagnostics
def test_scans_secrets_without_echoing_them():
    token = github_token()
    findings = privacy_gate.scan_text(f"value={token}", "fixture", [])
    assert findings == ["fixture:1: GitHub credential"]
    assert token not in findings[0]


# Distinguish synthetic home paths and emails from likely owner identifiers
def test_allows_placeholders_and_rejects_personal_identifiers():
    assert privacy_gate.scan_text("/Users/owner/Library you@example.com", "fixture", []) == []
    private_user = "actual" + "-person"
    private_path = "/" + "Users" + f"/{private_user}/Library"
    private_email = private_user + "@invalid" + ".dev"
    findings = privacy_gate.scan_text(f"{private_path} {private_email}", "fixture", [])
    assert "fixture:1: POSIX home path" in findings
    assert "fixture:1: non-placeholder email address" in findings


# Keep an owner-supplied literal redacted even when it causes a failure
def test_private_literal_findings_are_redacted():
    private_value = "owner-only-catalogue-name"
    findings = privacy_gate.scan_text(private_value, "fixture", [private_value])
    assert findings == ["fixture:1: private pattern #1"]
    assert private_value not in findings[0]


# Require review for flag-like files and new repository-root entries
def test_path_policy_catches_incident_shapes():
    allowlist = privacy_gate.load_allowlist()
    flag_findings = privacy_gate.scan_path("-D", "path", allowlist, [])
    root_findings = privacy_gate.scan_path("private-scratch", "path", allowlist, [])
    assert "path: flag-like path component" in flag_findings
    assert "path: unreviewed repository-root entry" in root_findings


# Match each established binary to its exact reviewed bytes and path
def test_real_binary_allowlist_matches_repository_assets():
    allowlist = privacy_gate.load_allowlist()
    for allowance in allowlist.binaries.values():
        for relative_path in allowance.paths:
            data = (_SCRIPT.parent.parent / relative_path).read_bytes()
            assert hashlib.sha256(data).hexdigest() == allowance.sha256
            assert privacy_gate.scan_blob(data, "fixture", {relative_path}, allowlist, []) == []


# Reject an opaque payload even when its path has no media extension
def test_unreviewed_binary_is_fatal():
    allowlist = privacy_gate.load_allowlist()
    data = b"\x89PNG\r\n\x1a\n" + b"synthetic bytes"
    findings = privacy_gate.scan_blob(data, "fixture", {"docs/evidence"}, allowlist, [])
    assert findings == [f"blob fixture: unreviewed binary blob {hashlib.sha256(data).hexdigest()}"]


# Scan blobs from intermediate commits even when the final tree deleted them
def test_range_scan_finds_a_deleted_secret_blob(tmp_path: Path):
    repo = initialized_repo(tmp_path)
    docs = repo / "docs"
    docs.mkdir()
    (docs / "readme.md").write_text("synthetic\n", encoding="utf-8")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "initial synthetic fixture")
    base = git(repo, "rev-parse", "HEAD")

    (docs / "temporary.md").write_text(github_token(), encoding="utf-8")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "temporarily add fixture")
    (docs / "temporary.md").unlink()
    git(repo, "add", "-u")
    git(repo, "commit", "-qm", "remove fixture")

    findings, commits, blobs = privacy_gate.scan_range(
        repo,
        "HEAD",
        base,
        False,
        privacy_gate.load_allowlist(),
        [],
    )
    assert commits == 2
    assert blobs >= 1
    assert any("GitHub credential" in finding for finding in findings)


# Scan the exact index bytes before Git creates a reachable commit
def test_staged_scan_rejects_new_binary(tmp_path: Path):
    repo = initialized_repo(tmp_path)
    docs = repo / "docs"
    docs.mkdir()
    (docs / "evidence").write_bytes(b"\x89PNG\r\n\x1a\n" + b"synthetic bytes")
    git(repo, "add", ".")

    findings, paths = privacy_gate.scan_staged(repo, privacy_gate.load_allowlist(), [])
    assert paths == 1
    assert any("unreviewed binary blob" in finding for finding in findings)


# Scan exact PR metadata and commit coordinates from the GitHub event payload
def test_github_event_scans_pr_title_and_deleted_blobs(tmp_path: Path):
    repo = initialized_repo(tmp_path)
    docs = repo / "docs"
    docs.mkdir()
    (docs / "readme.md").write_text("synthetic\n", encoding="utf-8")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "initial synthetic fixture")
    base = git(repo, "rev-parse", "HEAD")
    (docs / "temporary.md").write_text("clean fixture\n", encoding="utf-8")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "add clean fixture")
    head = git(repo, "rev-parse", "HEAD")

    event_path = tmp_path / "event.json"
    event_path.write_text(
        json.dumps(
            {
                "pull_request": {
                    "base": {"sha": base},
                    "head": {"sha": head, "ref": "feature/synthetic"},
                    "title": github_token(),
                    "body": "Synthetic PR body",
                }
            }
        ),
        encoding="utf-8",
    )
    findings, summary = privacy_gate.scan_github_event(
        repo, event_path, privacy_gate.load_allowlist(), []
    )
    assert "1 PR commits" in summary
    assert "PR title:1: GitHub credential" in findings


# Install hooks without ever placing the local pattern profile in the worktree
def test_installer_uses_git_private_storage(tmp_path: Path):
    repo = initialized_repo(tmp_path)
    assert privacy_gate.install_hooks(repo) == 0
    assert git(repo, "config", "--get", "core.hooksPath") == ".githooks"
    pattern_path = repo / git(repo, "rev-parse", "--git-path", "cairndex-private-patterns")
    assert pattern_path.is_file()
    assert str(repo) in pattern_path.read_text(encoding="utf-8")
    assert not (repo / "cairndex-private-patterns").exists()
