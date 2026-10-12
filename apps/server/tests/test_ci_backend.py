"""The optimized runner must preserve disk safety tests and clean owned fixtures."""

import json
import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "infra/ci_backend.sh"
DISK_TESTS = {"tests/test_backup_restore_scripts.py", "tests/test_portable_source_operations.py"}


@pytest.mark.parametrize("fail_at", [None, 1, 2])
def test_both_partitions_cover_the_suite_and_preserve_failure_status(tmp_path, fail_at):
    tools = tmp_path / "tools"
    tools.mkdir()
    stub = tools / "uv"
    stub.write_text(
        "#!/usr/bin/env python3\n"
        "import json,os,sys\n"
        "from pathlib import Path\n"
        "receipt=Path(os.environ['CI_TEST_RECEIPT'])\n"
        "calls=json.loads(receipt.read_text()) if receipt.exists() else []\n"
        "calls.append({'arguments':sys.argv[1:],'tmpdir':os.environ['TMPDIR']})\n"
        "receipt.write_text(json.dumps(calls))\n"
        "Path(os.environ['TMPDIR'],'synthetic-fixture').write_text('synthetic')\n"
        "sys.exit(7 if str(len(calls))==os.environ.get('CI_TEST_FAIL_AT') else 0)\n"
    )
    stub.chmod(0o755)
    # Spaced parents exercise quoting and survive success/failure cleanup.
    memory, disk = tmp_path / "memory parent", tmp_path / "disk parent"
    memory.mkdir()
    disk.mkdir()
    marker = memory / "existing-synthetic-entry"
    marker.write_text("keep")
    receipt = tmp_path / "receipt.json"
    env = {
        **os.environ,
        "PATH": str(tools) + os.pathsep + os.environ["PATH"],
        "CAIRNDEX_CI_MEMORY_PARENT": str(memory),
        "RUNNER_TEMP": str(disk),
        "CI_TEST_RECEIPT": str(receipt),
        "CI_TEST_FAIL_AT": str(fail_at),
    }
    result = subprocess.run(["bash", str(SCRIPT), "-q"], env=env, capture_output=True)
    assert result.returncode == (7 if fail_at else 0), result.stderr
    calls = json.loads(receipt.read_text())
    assert len(calls) == (1 if fail_at == 1 else 2)
    first = calls[0]["arguments"]
    assert set(arg.removeprefix("--ignore=") for arg in first if arg.startswith("--ignore=")) == (
        DISK_TESTS
    )
    assert first[:2] == ["run", "pytest"] and first[-1] == "-q"
    if len(calls) == 2:
        assert set(arg for arg in calls[1]["arguments"] if arg.startswith("tests/")) == DISK_TESTS
        assert Path(calls[1]["tmpdir"]).parent == disk
    assert Path(calls[0]["tmpdir"]).parent == memory
    assert not list(disk.iterdir())
    assert list(memory.iterdir()) == [marker]
    assert marker.read_text() == "keep"
