"""Undo removes newly created identities without inventing pre-operation content."""

import pytest

from tests.test_portable_source_operations import fixture, perform


@pytest.mark.parametrize("action", ["copy", "move"])
def test_directory_replace_undo_restores_different_tree_members(tmp_path, action):
    root, store = fixture(tmp_path)
    (root / "original/nested").mkdir(parents=True)
    (root / "original/empty").mkdir()
    (root / "original/nested/old.txt").write_bytes(b"synthetic old file")
    perform(store, root, "seed-target", "copy", "original", "target")
    (root / "incoming").mkdir()
    (root / "incoming/new.txt").write_bytes(b"synthetic new file")
    with store.connection(readonly=True) as db:
        before = dict(
            db.execute("SELECT path,entity FROM catalog_paths WHERE family='asset_files'")
        )
    perform(store, root, "replace-tree", action, "incoming", "target", "replace")
    assert (root / "target/new.txt").read_bytes() == b"synthetic new file"
    perform(store, root, "undo-replace", "undo", prior="replace-tree")
    assert (root / "target/nested/old.txt").read_bytes() == b"synthetic old file"
    assert (root / "target/empty").is_dir()
    assert not (root / "target/new.txt").exists()
    assert (root / "incoming/new.txt").read_bytes() == b"synthetic new file"
    with store.connection(readonly=True) as db:
        after = dict(db.execute("SELECT path,entity FROM catalog_paths WHERE family='asset_files'"))
    for path, identity in before.items():
        assert after[path] == identity
    assert "target/new.txt" not in after
