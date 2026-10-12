"""Plan conservative CI scope and verify the complete selected job result.

Only documentation and backend-test/declaration changes avoid the full matrix.
Unknown paths and manual dispatches keep every existing gate. Output never
includes changed paths or event content, which may itself contain private data.
"""

import argparse
import json
import os
import re
import subprocess
from collections.abc import Sequence
from pathlib import Path

JOBS = frozenset(
    {
        "dependency-audit",
        "backend",
        "sidecar",
        "frontend",
        "fullstack-e2e",
        "desktop-linux",
        "desktop-macos",
        "docker",
    }
)
BACKEND_JOBS = frozenset({"dependency-audit", "backend"})
MODES = frozenset({"docs", "backend", "full"})
_SHA = re.compile(r"[0-9a-fA-F]{40}\Z")


def mode_for_paths(paths: Sequence[str]) -> str:
    """Reduce scope only when every changed path has a known narrow purpose."""
    backend = False
    for path in paths:
        if any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in path):
            return "full"
        # Licenses enter both distributable packages and images. API artifacts
        # are contracts, even when stored under the documentation directory.
        if path in {"LICENSE", "THIRD-PARTY-NOTICES.md", "docs/openapi.json"} or path.startswith(
            "licenses/"
        ):
            return "full"
        if path.startswith("docs/") or path.endswith(".md") or path == ".gitignore":
            continue
        if path.startswith("apps/server/tests/") or path == ".github/privacy-allowlist.json":
            backend = True
            continue
        return "full"
    return "backend" if backend else "docs"


def _sha(value: object) -> str:
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        raise ValueError("Invalid CI event commit")
    return value


def _git(arguments: Sequence[str]) -> str:
    result = subprocess.run(["git", *arguments], capture_output=True, check=False)
    if result.returncode:
        raise ValueError("Unable to determine CI changes")
    return result.stdout.decode("utf-8", errors="surrogateescape")


def plan(event_name: str, event: object) -> str:
    """Diff exact event commits, including both ends of renames and deletions."""
    if event_name == "workflow_dispatch":
        return "full"
    if not isinstance(event, dict):
        raise ValueError("Invalid CI event")
    if event_name == "pull_request":
        pr = event.get("pull_request")
        if not isinstance(pr, dict):
            raise ValueError("Invalid CI pull request event")
        base, head = pr.get("base"), pr.get("head")
        if not isinstance(base, dict) or not isinstance(head, dict):
            raise ValueError("Invalid CI pull request commits")
        before, after = _sha(base.get("sha")), _sha(head.get("sha"))
        comparison = f"{before}...{after}"
    elif event_name == "push":
        before, after = _sha(event.get("before")), _sha(event.get("after"))
        if before == "0" * 40:
            paths = _git(["ls-tree", "-r", "--name-only", "-z", after])
            return mode_for_paths([path for path in paths.split("\0") if path])
        comparison = f"{before}..{after}"
    else:
        raise ValueError("Unsupported CI event")
    paths = _git(["diff", "--no-renames", "--name-only", "-z", comparison, "--"])
    return mode_for_paths([path for path in paths.split("\0") if path])


def result_passes(needs: object) -> bool:
    """Fail closed on failed/cancelled/missing or unexpectedly skipped jobs."""
    if not isinstance(needs, dict) or set(needs) != JOBS | {"scope"}:
        return False
    scope = needs["scope"]
    if not isinstance(scope, dict) or scope.get("result") != "success":
        return False
    outputs = scope.get("outputs")
    if not isinstance(outputs, dict):
        return False
    mode = outputs.get("mode")
    if not isinstance(mode, str) or mode not in MODES:
        return False
    required = JOBS if mode == "full" else BACKEND_JOBS if mode == "backend" else frozenset()
    for name in JOBS:
        job = needs[name]
        if not isinstance(job, dict):
            return False
        allowed = {"success"} if name in required else {"success", "skipped"}
        result = job.get("result")
        if not isinstance(result, str) or result not in allowed:
            return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "result"))
    args = parser.parse_args()
    try:
        if args.command == "plan":
            event: object = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
            mode = plan(os.environ["GITHUB_EVENT_NAME"], event)
            with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
                output.write(f"mode={mode}\n")
            print(f"CI scope: {mode}")
            return 0
        needs: object = json.loads(os.environ["CI_NEEDS"])
        if result_passes(needs):
            print("CI result: every selected job passed")
            return 0
        print("CI result: selected jobs did not all pass")
        return 1
    except (KeyError, OSError, ValueError):
        print("CI configuration or event validation failed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
