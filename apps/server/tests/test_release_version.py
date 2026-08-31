"""Tests for the repository release-version gate."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[3] / "infra" / "release_version.py"
_spec = importlib.util.spec_from_file_location("release_version", _SCRIPT)
assert _spec is not None and _spec.loader is not None
release_version = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(release_version)


# Build the smallest complete version map used by the pure validator
def versions(version: str = "1.2.3") -> dict[str, str]:
    return {"VERSION": version, "another source": version}


def test_accepts_synchronized_metadata_and_matching_tag():
    assert release_version.validate_versions(versions(), "v1.2.3") == "1.2.3"


def test_reports_every_disagreeing_source():
    values = versions()
    values["package.json"] = "1.2.2"
    values["Cargo.toml"] = "2.0.0"
    with pytest.raises(SystemExit) as excinfo:
        release_version.validate_versions(values)
    message = str(excinfo.value)
    assert "package.json: 1.2.2" in message
    assert "Cargo.toml: 2.0.0" in message


def test_rejects_a_tag_for_other_bytes():
    with pytest.raises(SystemExit, match="does not match"):
        release_version.validate_versions(versions(), "v1.2.4")


def test_rejects_an_unversioned_release_ref():
    with pytest.raises(SystemExit, match="must start"):
        release_version.validate_versions(versions(), "1.2.3")


def test_accepts_manual_dispatch_from_the_named_tag():
    release_version.validate_dispatch_ref("workflow_dispatch", "tag", "v1.2.3", "v1.2.3")


@pytest.mark.parametrize(
    ("ref_type", "ref_name", "tag"),
    [
        ("branch", "main", "v1.2.3"),
        ("tag", "v1.2.2", "v1.2.3"),
        ("tag", "v1.2.3", None),
    ],
)
def test_rejects_manual_dispatch_with_mismatched_provenance(
    ref_type: str, ref_name: str, tag: str | None
):
    with pytest.raises(SystemExit, match="same tag"):
        release_version.validate_dispatch_ref("workflow_dispatch", ref_type, ref_name, tag)


def test_tag_push_does_not_apply_manual_dispatch_rules():
    release_version.validate_dispatch_ref("push", "tag", "v1.2.3", "v1.2.3")


@pytest.mark.parametrize("version", ["1.2", "v1.2.3", "01.2.3", "1.2.3-"])
def test_rejects_invalid_repository_versions(version: str):
    with pytest.raises(SystemExit, match="semantic version"):
        release_version.validate_versions(versions(version))


def test_real_repository_metadata_is_synchronized():
    expected = (_SCRIPT.parent.parent / "VERSION").read_text(encoding="utf-8").strip()
    assert release_version.validate_versions(release_version.collect_versions()) == expected
