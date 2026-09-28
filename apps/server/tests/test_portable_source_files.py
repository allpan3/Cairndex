"""Source primitives operate only on disposable files and metadata directories."""

import os

import pytest

from cairndex.core.paths import PathSafetyError
from cairndex.file_ops.exclusive import relocate
from cairndex.replicas.protocol import ReplicaError
from cairndex.replicas.source_files import capture, observation, snapshot, source_path


def test_exclusive_move_preserves_a_competing_destination(tmp_path):
    (tmp_path / "source").write_bytes(b"synthetic source")
    (tmp_path / "target").write_bytes(b"synthetic destination")
    handle = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        with pytest.raises(FileExistsError):
            relocate(handle, "source", handle, "target")
        assert (tmp_path / "source").read_bytes() == b"synthetic source"
        assert (tmp_path / "target").read_bytes() == b"synthetic destination"
        relocate(handle, "source", handle, "vacant")
        assert not (tmp_path / "source").exists()
        assert (tmp_path / "vacant").read_bytes() == b"synthetic source"
    finally:
        os.close(handle)


@pytest.mark.parametrize(
    "path", ["/escape", "../escape", ".cairndex/file", "a/.hidden", "a/../b", "a//b", "a/", "a\\b"]
)
def test_source_paths_refuse_hidden_and_escaping_names(path):
    with pytest.raises((ReplicaError, PathSafetyError)):
        source_path(path)


def test_snapshot_is_independent_of_external_in_place_edits(tmp_path):
    source = tmp_path / "photo.bin"
    source.write_bytes(b"synthetic original")
    expected = observation(tmp_path, source.name)
    progress = []
    evidence = snapshot(
        tmp_path,
        source.name,
        "operation-one",
        "source",
        expected,
        progress=progress.append,
        limit=1024,
    )
    capture(tmp_path, source.name, "operation-one", "captured-source", expected)
    versions = tmp_path / ".cairndex/source-operations/operation-one"
    assert evidence["size"] == len(b"synthetic original")
    assert progress == [0, evidence["size"]]
    (versions / "captured-source").write_bytes(b"external changed bytes")
    assert (versions / "source").read_bytes() == b"synthetic original"


def test_snapshot_refuses_changed_review_and_symlink(tmp_path):
    source = tmp_path / "photo.bin"
    source.write_bytes(b"before")
    expected = observation(tmp_path, source.name)
    source.write_bytes(b"after")
    with pytest.raises(ReplicaError):
        snapshot(
            tmp_path,
            source.name,
            "operation-one",
            "source",
            expected,
            progress=lambda _: None,
            limit=1024,
        )
    outside = tmp_path / "outside"
    outside.mkdir()
    (tmp_path / "link").symlink_to(outside, target_is_directory=True)
    with pytest.raises(OSError):
        observation(tmp_path, "link/file")


def test_size_limit_does_not_change_source(tmp_path):
    source = tmp_path / "photo.bin"
    source.write_bytes(b"synthetic original")
    expected = observation(tmp_path, source.name)
    with pytest.raises(ReplicaError, match="byte limit"):
        snapshot(
            tmp_path,
            source.name,
            "operation-one",
            "source",
            expected,
            progress=lambda _: None,
            limit=1,
        )
    assert source.read_bytes() == b"synthetic original"


@pytest.mark.parametrize("partial", [b"wrong", b"synthetic original too long"])
def test_partial_snapshot_refuses_corrupt_retained_prefix(tmp_path, partial):
    source = tmp_path / "source.bin"
    source.write_bytes(b"synthetic original")
    target = tmp_path / ".cairndex/source-operations/partial"
    target.mkdir(parents=True)
    (target / "source.partial").write_bytes(partial)
    with pytest.raises(ReplicaError):
        snapshot(
            tmp_path,
            source.name,
            "partial",
            "source",
            observation(tmp_path, source.name),
            progress=lambda _: None,
            limit=1024,
        )
    assert (target / "source.partial").read_bytes() == partial
    assert source.read_bytes() == b"synthetic original"


def test_partial_snapshot_refuses_hard_link_before_any_write(tmp_path):
    source = tmp_path / "source.bin"
    source.write_bytes(b"synthetic original")
    unrelated = tmp_path / "unrelated.bin"
    unrelated.write_bytes(b"synthetic")
    target = tmp_path / ".cairndex/source-operations/linked"
    target.mkdir(parents=True)
    os.link(unrelated, target / "source.partial")
    with pytest.raises(ReplicaError):
        snapshot(
            tmp_path,
            source.name,
            "linked",
            "source",
            observation(tmp_path, source.name),
            progress=lambda _: None,
            limit=1024,
        )
    assert unrelated.read_bytes() == b"synthetic"


def test_partial_snapshot_resumes_and_handles_empty_file(tmp_path):
    for name, content in [("empty", b""), ("resumed", b"synthetic original")]:
        source = tmp_path / name
        source.write_bytes(content)
        target = tmp_path / ".cairndex/source-operations" / name
        target.mkdir(parents=True)
        (target / "source.partial").write_bytes(content[:4])
        for _ in range(2):
            result = snapshot(
                tmp_path,
                name,
                name,
                "source",
                observation(tmp_path, name),
                progress=lambda _: None,
                limit=1024,
            )
            assert result["size"] == len(content)
            assert (target / "source").read_bytes() == content
