"""Local availability reads stay bounded to requested synthetic paths."""

from cairndex.replicas.catalog.file_browser import entry, observe_entries


def test_page_observation_refuses_links_and_does_not_enumerate(tmp_path, monkeypatch):
    root = tmp_path / "library"
    root.mkdir()
    (root / "present.mp4").write_bytes(b"synthetic video")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "other.mp4").write_bytes(b"private to synthetic test")
    (root / "linked.mp4").symlink_to(outside / "other.mp4")
    (root / "linked-folder").symlink_to(outside, target_is_directory=True)
    paths = [
        "present.mp4",
        "missing.mp4",
        "linked.mp4",
        "linked-folder/other.mp4",
        "../outside/other.mp4",
    ]
    entries = [entry(path, "file", str(index), "bundle") for index, path in enumerate(paths)]

    def forbid(*_args, **_kwargs):
        raise AssertionError("A page observation must not enumerate a directory")

    monkeypatch.setattr("os.scandir", forbid)
    observe_entries(root, entries)
    assert entries[0].local_state == "observed"
    assert entries[0].size_bytes == len(b"synthetic video")
    assert entries[0].modified_at is not None
    assert [value.local_state for value in entries[1:]] == ["unavailable"] * 4
    assert all(value.size_bytes is None for value in entries[1:])
