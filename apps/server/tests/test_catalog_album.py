"""Album paging preserves identity, scope, hidden exclusions and private state."""

import pytest

from cairndex.core.errors import ConflictError, NotFoundError
from cairndex.devtools.album_fixture import prepare_album
from cairndex.replicas.catalog.album import album
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.replicas.media import ReplicaMedia
from tests.test_replica_catalog import edit, save


@pytest.fixture
def media(tmp_path):
    converted = prepare_disposable(prepare_album(parent=tmp_path))
    return ReplicaMedia(converted.store, converted.package, "synthetic")


def test_album_pages_order_folder_boundaries_and_no_source_reads(media, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Album browsing must not read source bytes")

    monkeypatch.setattr("cairndex.replicas.media.open_source", forbidden)
    before = media.store.frontier()
    first = album(media, "bundle-000001", None, 0, 50, None)
    second = album(media, "bundle-000001", None, 50, 50, first.revision)
    assert first.total == 65
    assert len(first.items) == 50 and len(second.items) == 15
    ids = [item.id for item in first.items + second.items]
    assert len(set(ids)) == 65
    assert ids[:5] == ["gallery2-000", "loose-000", "album-folder", "loose-001", "empty-folder"]
    assert "gallery-000" not in ids
    pages = [
        album(media, "bundle-000001", "album-folder", offset, 50, first.revision)
        for offset in (0, 50, 100)
    ]
    assert [len(page.items) for page in pages] == [50, 50, 25]
    assert pages[-1].items[-1].id == "gallery-124"
    assert pages[-1].next_offset is None
    assert all(item.file and not item.file.tech_metadata for page in pages for item in page.items)
    assert album(media, "bundle-000001", "empty-folder", 0, 50, None).total == 0
    with media.store.connection(readonly=True) as db:
        assert db.execute("SELECT count(*) FROM local_media").fetchone()[0] == 0
    assert media.store.frontier() == before


def test_changed_projection_requires_new_page_basis(media):
    first = album(media, "bundle-000001", None, 0, 50, None)
    save(
        media.store,
        edit(media.store, "asset_bundles", "bundle-000001", "title", "Revised album"),
        "album-title",
    )
    with pytest.raises(ConflictError, match="Album changed"):
        album(media, "bundle-000001", None, 50, 50, first.revision)
    assert album(media, "bundle-000001", None, 0, 50, None).title == "Revised album"


@pytest.mark.parametrize(
    "bundle,directory",
    [
        ("absent", None),
        ("bundle-000002", "album-folder"),
        ("bundle-000001", "../Gallery"),
        ("bundle-000001", "/Gallery"),
    ],
)
def test_album_requires_current_scoped_id(media, bundle, directory):
    with pytest.raises(NotFoundError):
        album(media, bundle, directory, 0, 50, None)
