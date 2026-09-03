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


# Allow Git identity emails while continuing to scan the commit message
def test_commit_identity_email_is_public_metadata():
    identity_email = "maintainer" + "@invalid" + ".dev"
    metadata = (
        "tree 0000000000000000000000000000000000000000\n"
        f"author Synthetic Maintainer <{identity_email}> 1 +0000\n"
        f"committer Synthetic Maintainer <{identity_email}> 1 +0000\n\n"
        "safe message\n"
    ).encode()
    assert privacy_gate.scan_commit(metadata, "fixture", []) == []

    message = metadata + f"Mention {identity_email} here\n".encode()
    findings = privacy_gate.scan_commit(message, "fixture", [])
    assert findings == ["commit fixture:6: non-placeholder email address"]


# Allow only Dependabot's known GitHub service sign-off, not arbitrary message emails
def test_dependabot_public_service_signoff_is_not_private_content():
    metadata = (
        b"tree 0000000000000000000000000000000000000000\n"
        b"author Synthetic Maintainer <you@example.com> 1 +0000\n"
        b"committer Synthetic Maintainer <you@example.com> 1 +0000\n\n"
        b"Bump a synthetic dependency\n\n"
    )
    service_email = b"support" + b"@github.com"
    trailer = b"Signed-off-by: dependabot[bot] <" + service_email + b">\n"
    assert privacy_gate.scan_commit(metadata + trailer, "fixture", []) == []

    mention = metadata + b"Mention " + service_email + b" here\n"
    assert privacy_gate.scan_commit(mention, "fixture", []) == [
        "commit fixture:7: non-placeholder email address"
    ]

    other_signer = metadata + b"Signed-off-by: other[bot] <" + service_email + b">\n"
    assert privacy_gate.scan_commit(other_signer, "fixture", []) == [
        "commit fixture:7: non-placeholder email address"
    ]


# Never echo diagnostics derived from private input at the publication boundary
def test_failure_report_withholds_finding_details(capsys):
    private_derived_finding = "fixture:1: owner-only-catalogue-name"
    assert privacy_gate.report([private_derived_finding], "fixture", 1) == 1
    captured = capsys.readouterr()
    assert "1 private-content finding(s); details withheld" in captured.err
    assert private_derived_finding not in captured.err


# Require review for flag-like files and new repository-root entries
def test_path_policy_catches_incident_shapes():
    allowlist = privacy_gate.load_allowlist()
    flag_findings = privacy_gate.scan_path("-D", "path", allowlist, [])
    root_findings = privacy_gate.scan_path("private-scratch", "path", allowlist, [])
    assert "path: flag-like path component" in flag_findings
    assert "path: unreviewed repository-root entry" in root_findings


# Reject the two shapes that reached a commit unnoticed on 2026-09-02
def test_artifact_and_vendored_paths_are_rejected():
    allowlist = privacy_gate.load_allowlist()
    findings = privacy_gate.scan_publication_policy(
        [
            "apps/desktop/vendor/muda/src/lib.rs",
            "apps/desktop/vendor/muda/target/debug/deps/muda.rmeta",
            "apps/web/node_modules/left-pad/index.js",
            # Outside an artifact directory, so this exercises the suffix rule
            # alone — each path reports the first rule it breaks, not all of them.
            "apps/desktop/prebuilt/libmuda.rlib",
            "apps/server/src/cairndex/main.py",
        ],
        added_bytes=1024,
        allowlist=allowlist,
    )
    reasons = "\n".join(findings)
    assert "build, dependency, or cache output" in reasons
    assert "undeclared vendored third-party tree" in reasons
    assert "compiled or packaged output" in reasons
    # Every message is a rule and a count. A path can itself be user data — a
    # filename out of the owner's library — so none may appear here.
    assert not any("muda" in item or "left-pad" in item for item in findings)
    assert not any("prebuilt" in item for item in findings)
    assert all(item.startswith(privacy_gate.POLICY_PREFIX) for item in findings)


# A vendored tree is a decision, not a surprise: declared, it passes
def test_declared_vendored_tree_is_allowed():
    base = privacy_gate.load_allowlist()
    declared = privacy_gate.PrivacyAllowlist(
        root_entries=base.root_entries,
        binaries=base.binaries,
        vendored_trees=(
            privacy_gate.VendoredTree(
                prefix="apps/desktop/vendor/muda",
                purpose="test fixture",
                provenance="test fixture",
            ),
        ),
    )
    assert (
        privacy_gate.scan_publication_policy(
            ["apps/desktop/vendor/muda/src/lib.rs"], added_bytes=1, allowlist=declared
        )
        == []
    )


# Trip on volume alone, whatever the files contain: `git add -A` once staged
# 1,876 files of build output, and only a private-pattern match stopped it
def test_bulk_add_and_byte_budget_are_tripwires():
    allowlist = privacy_gate.load_allowlist()
    many = [
        f"apps/web/src/generated/file{index}.ts"
        for index in range(privacy_gate.MAX_SCANNED_PATHS + 1)
    ]
    bulk = privacy_gate.scan_publication_policy(many, added_bytes=0, allowlist=allowlist)
    assert any("bulk-add tripwire" in item for item in bulk)

    heavy = privacy_gate.scan_publication_policy(
        ["apps/web/src/App.tsx"],
        added_bytes=privacy_gate.MAX_ADDED_BYTES + 1,
        allowlist=allowlist,
    )
    assert any("publication budget" in item for item in heavy)

    assert (
        privacy_gate.scan_publication_policy(
            ["apps/web/src/App.tsx"], added_bytes=1024, allowlist=allowlist
        )
        == []
    )


# A whole-history audit is not a bulk add: it is the repository
def test_volume_tripwires_do_not_apply_to_history_audits():
    allowlist = privacy_gate.load_allowlist()
    many = [f"apps/web/src/file{index}.ts" for index in range(privacy_gate.MAX_SCANNED_PATHS + 1)]
    assert (
        privacy_gate.scan_publication_policy(
            many,
            added_bytes=privacy_gate.MAX_ADDED_BYTES * 40,
            allowlist=allowlist,
            enforce_volume=False,
        )
        == []
    )
    # …but the path rules still hold there, since build output and undeclared
    # vendoring are wrong at any point in history.
    assert privacy_gate.scan_publication_policy(
        ["apps/web/node_modules/left-pad/index.js"],
        added_bytes=0,
        allowlist=allowlist,
        enforce_volume=False,
    )


# Name the rule that fired while still withholding private detail
def test_policy_findings_are_printed_and_private_ones_are_not(capsys):
    status = privacy_gate.report(
        [
            f"{privacy_gate.POLICY_PREFIX}build output must never be committed (2 path(s))",
            "blob abc123: private literal in a filename",
        ],
        "2 staged paths",
        2,
    )
    captured = capsys.readouterr()
    assert status == 1
    assert "build output must never be committed" in captured.err
    assert "1 private-content finding(s); details withheld" in captured.err
    assert "private literal in a filename" not in captured.err


# This repository vendors nothing today, and the gate should say so
def test_repository_declares_no_vendored_trees():
    assert privacy_gate.load_allowlist().vendored_trees == ()


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
