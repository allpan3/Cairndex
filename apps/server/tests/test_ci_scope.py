"""Reduced CI must retain selected gates and never hide an incomplete matrix."""

import importlib.util
import subprocess
from pathlib import Path

import pytest
import yaml

SCRIPT = Path(__file__).resolve().parents[3] / "infra/ci_scope.py"
spec = importlib.util.spec_from_file_location("ci_scope", SCRIPT)
assert spec and spec.loader
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


def test_workflow_completion_covers_every_job_and_known_scope_condition():
    workflow = yaml.load(
        (SCRIPT.parent.parent / ".github/workflows/ci.yml").read_text(), Loader=yaml.BaseLoader
    )
    jobs = workflow["jobs"]
    assert set(jobs) == ci.JOBS | {"scope", "result"}
    assert set(jobs["result"]["needs"]) == ci.JOBS | {"scope"}
    assert jobs["result"]["if"] == "always()"
    for name in ci.JOBS:
        assert jobs[name]["needs"] == "scope"
        expected = (
            "needs.scope.outputs.mode != 'docs'"
            if name in ci.BACKEND_JOBS
            else "needs.scope.outputs.mode == 'full'"
        )
        assert jobs[name]["if"] == expected
    assert "paths-ignore" not in workflow["on"]["push"]
    assert not workflow["on"]["pull_request"]


@pytest.mark.parametrize(
    ("paths", "mode"),
    [
        ([], "docs"),
        (["README.md", "docs/STATUS.md"], "docs"),
        (["apps/server/tests/test_privacy_gate.py", "CHANGELOG.md"], "backend"),
        ([".github/privacy-allowlist.json"], "backend"),
        (["apps/server/src/cairndex/main.py", "apps/server/tests/test_auth.py"], "full"),
        (["apps/server/uv.lock"], "full"),
        (["apps/server/packaging/build_sidecar.py"], "full"),
        (["apps/web/src/app/Workspace.test.tsx"], "full"),
        (["infra/ci_scope.py"], "full"),
        ([".github/workflows/ci.yml"], "full"),
        (["unknown-config"], "full"),
        (["docs/openapi.json"], "full"),
        (["LICENSE"], "full"),
        (["THIRD-PARTY-NOTICES.md"], "full"),
        (["licenses/media/README.md"], "full"),
        (["apps/server/tests/line\nbreak.py"], "full"),
    ],
)
def test_scope_keeps_runtime_unknown_and_packaging_changes_in_the_full_matrix(paths, mode):
    assert ci.mode_for_paths(paths) == mode


def matrix(mode):
    selected = ci.JOBS if mode == "full" else ci.BACKEND_JOBS if mode == "backend" else set()
    return {
        "scope": {"result": "success", "outputs": {"mode": mode}},
        **{name: {"result": "success" if name in selected else "skipped"} for name in ci.JOBS},
    }


@pytest.mark.parametrize("mode", ["docs", "backend", "full"])
def test_completed_selected_scope_passes(mode):
    assert ci.result_passes(matrix(mode))


@pytest.mark.parametrize("result", ["failure", "cancelled", "skipped", "", "in_progress"])
@pytest.mark.parametrize("name", sorted(ci.JOBS))
def test_full_matrix_requires_every_job_to_succeed(name, result):
    needs = matrix("full")
    needs[name]["result"] = result
    assert not ci.result_passes(needs)


def test_reduced_scope_still_requires_backend_and_audits():
    for name in ci.BACKEND_JOBS:
        needs = matrix("backend")
        needs[name]["result"] = "skipped"
        assert not ci.result_passes(needs)
    needs = matrix("docs")
    needs["docker"]["result"] = "failure"
    assert not ci.result_passes(needs)


def test_missing_unknown_and_failed_scope_cannot_hide_skipped_jobs():
    for name in matrix("full"):
        needs = matrix("full")
        del needs[name]
        assert not ci.result_passes(needs)
    needs = matrix("docs")
    needs["scope"]["result"] = "failure"
    assert not ci.result_passes(needs)
    needs = matrix("docs")
    needs["scope"]["outputs"]["mode"] = "unknown"
    assert not ci.result_passes(needs)
    needs = matrix("full")
    needs["new-job"] = {"result": "failure"}
    assert not ci.result_passes(needs)
    assert not ci.result_passes([])


def git(repo, *arguments):
    return subprocess.check_output(["git", "-C", str(repo), *arguments], text=True).strip()


def test_rename_from_runtime_into_tests_keeps_both_paths_and_full_scope(tmp_path, monkeypatch):
    git(tmp_path, "init", "-q")
    git(tmp_path, "config", "user.name", "Synthetic Test")
    git(tmp_path, "config", "user.email", "synthetic@example.com")
    source = tmp_path / "apps/server/src/example.py"
    source.parent.mkdir(parents=True)
    source.write_text("synthetic = True\n")
    git(tmp_path, "add", "apps/server/src/example.py")
    git(tmp_path, "commit", "-qm", "synthetic source")
    before = git(tmp_path, "rev-parse", "HEAD")
    destination = tmp_path / "apps/server/tests/example.py"
    destination.parent.mkdir(parents=True)
    git(tmp_path, "mv", "apps/server/src/example.py", "apps/server/tests/example.py")
    git(tmp_path, "commit", "-qm", "synthetic rename")
    after = git(tmp_path, "rev-parse", "HEAD")
    monkeypatch.chdir(tmp_path)
    event = {"pull_request": {"base": {"sha": before}, "head": {"sha": after}}}
    assert ci.plan("pull_request", event) == "full"
    assert ci.plan("push", {"before": before, "after": after}) == "full"
    assert ci.plan("push", {"before": "0" * 40, "after": before}) == "full"


def test_dispatch_is_full_and_invalid_commits_fail_without_echoing_input():
    assert ci.plan("workflow_dispatch", {}) == "full"
    with pytest.raises(ValueError, match="Invalid CI event commit") as failure:
        ci.plan("push", {"before": "synthetic-private-input", "after": "a" * 40})
    assert "synthetic-private-input" not in str(failure.value)
