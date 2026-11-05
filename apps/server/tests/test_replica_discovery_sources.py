"""Pinned discovery parents preserve source checks without repeated ancestor opens."""

import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import pytest

from cairndex.replicas import discovery_sources as sources
from cairndex.replicas.protocol import ReplicaError


def subject(tmp_path):
    root = tmp_path / "Library"
    folder = root / "Scenes"
    folder.mkdir(parents=True)
    path = folder / "scene.mp4"
    path.write_bytes(b"synthetic original")
    walker = sources.walk(root)
    entry = next(item for item in walker if item is not None)
    return root, path, walker, entry


def test_unchanged_entry_reuses_evidence_without_leaf_open(tmp_path, monkeypatch):
    root, path, walker, entry = subject(tmp_path)
    try:
        cached = sources.inspect(root, entry.path)

        def unexpected(*args, **kwargs):
            pytest.fail("Unchanged directory metadata should avoid opening the leaf")

        with monkeypatch.context() as patch:
            patch.setattr(os, "open", unexpected)
            assert sources.inspect(root, entry.path, cached, entry=entry) == cached
    finally:
        walker.close()


@pytest.mark.parametrize("replacement", ["symlink", "fifo", "directory"])
def test_replaced_leaf_is_refused(tmp_path, replacement):
    root, path, walker, entry = subject(tmp_path)
    try:
        path.unlink()
        if replacement == "symlink":
            outside = tmp_path / "outside.mp4"
            outside.write_bytes(b"outside the library")
            path.symlink_to(outside)
        elif replacement == "fifo":
            os.mkfifo(path)
        else:
            path.mkdir()
        with pytest.raises((OSError, ReplicaError)):
            sources.inspect(root, entry.path, entry=entry)
    finally:
        walker.close()


@pytest.mark.parametrize("cached", [False, True])
def test_moved_parent_is_refused_even_on_cache_hit(tmp_path, cached):
    root, path, walker, entry = subject(tmp_path)
    try:
        previous = sources.inspect(root, entry.path) if cached else None
        path.parent.rename(tmp_path / "Elsewhere")
        with pytest.raises(ReplicaError, match="directory moved"):
            sources.inspect(root, entry.path, previous, entry=entry)
    finally:
        walker.close()


def test_changed_listing_cannot_fall_back_to_stale_fstat_cache(tmp_path, monkeypatch):
    root, path, walker, entry = subject(tmp_path)
    try:
        before = path.stat()
        cached = sources.inspect(root, entry.path)
        path.write_bytes(b"synthetic modified")
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
        entry = replace(entry, info=path.stat())
        assert sources.generation(entry.path, entry.info) != cached["generation"]
        real_fstat = os.fstat

        def stale(handle):
            info = real_fstat(handle)
            return before if info.st_ino == before.st_ino else info

        with monkeypatch.context() as patch:
            patch.setattr(os, "fstat", stale)
            observed = sources.inspect(root, entry.path, cached, entry=entry)
        assert observed["evidence"] != cached["evidence"]
    finally:
        walker.close()


def test_parent_moved_during_read_is_refused(tmp_path, monkeypatch):
    root, path, walker, entry = subject(tmp_path)
    original = os.pread

    def moved(handle, size, offset):
        path.parent.rename(tmp_path / "Elsewhere")
        return original(handle, size, offset)

    try:
        with monkeypatch.context() as patch:
            patch.setattr(os, "pread", moved)
            with pytest.raises(ReplicaError, match="directory moved"):
                sources.inspect(root, entry.path, entry=entry)
    finally:
        walker.close()


def test_pinned_walk_preserves_relative_path_validation(tmp_path):
    root = tmp_path / "Library"
    root.mkdir()
    (root / "C:scene.mp4").write_bytes(b"synthetic")
    walker = sources.walk(root)
    try:
        entry = next(walker)
        assert entry is not None
        with pytest.raises(ValueError, match="absolute path"):
            sources.inspect(root, entry.path, entry=entry)
    finally:
        walker.close()


def test_device_change_requires_fresh_content_reads(tmp_path, monkeypatch):
    from types import SimpleNamespace

    root, path, walker, entry = subject(tmp_path)
    try:
        cached = sources.inspect(root, entry.path)
        previous_mount = SimpleNamespace(
            **{
                name: getattr(entry.info, name)
                for name in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
            }
        )
        previous_mount.st_dev += 1
        cached["generation"] = sources.generation(entry.path, previous_mount)
        reads = []
        original = os.pread

        def read(handle, size, offset):
            reads.append(size)
            return original(handle, size, offset)

        with monkeypatch.context() as patch:
            patch.setattr(os, "pread", read)
            observed = sources.inspect(root, entry.path, cached, entry=entry)
        assert reads == [path.stat().st_size]
        assert observed["evidence"] == cached["evidence"]
        assert observed["generation"] != cached["generation"]
    finally:
        walker.close()


def test_failed_submission_closes_duplicated_parent(tmp_path, monkeypatch):
    root, _, walker, entry = subject(tmp_path)
    copies = []
    original = os.dup

    def duplicate(handle):
        copied = original(handle)
        copies.append(copied)
        return copied

    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pass
        with monkeypatch.context() as patch:
            patch.setattr(os, "dup", duplicate)
            with pytest.raises(RuntimeError, match="shutdown"):
                sources.submit(pool, root, entry, None)
        assert len(copies) == 1
        with pytest.raises(OSError):
            os.fstat(copies[0])
        assert os.fstat(entry.parent)
    finally:
        walker.close()
