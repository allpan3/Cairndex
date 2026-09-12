"""Complete filename search and stable global ordering over synthetic staged files"""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, event
from sqlalchemy.orm import Session

from cairndex.domain.enums import FileRole, GroupingSource, GroupingState, MediaKind
from cairndex.services import bundles
from cairndex.services.file_browser import list_unbundled_files


# Seed more than one page; the last filename also owns the largest and newest values
@pytest.fixture
def staged(session: Session) -> list[str]:
    bundle = bundles.create_bundle(session, title="Staged")
    bundle.grouping_state = GroupingState.PROVISIONAL
    bundle.grouping_source = GroupingSource.SCAN_SUGGESTION
    paths = [f"dir-{i % 3}/clip-{i:03d}.mp4" for i in range(230)]
    paths += [
        "later/zz-needle.MKV",
        "dir/Case.mp4",
        "dir/case.mp4",
        "other/Case.mp4",
        "dir/literal%_.mp4",
    ]
    for path in paths:
        file = bundles.add_file(
            session,
            bundle.id,
            relative_path=path,
            role=FileRole.PRIMARY_VIDEO,
            media_kind=MediaKind.VIDEO,
        )
        file.original_filename = "Stale alias"
        file.size_bytes = 1_000_000 if "needle" in path else 100
        file.mtime = datetime(2026, 1, 1, tzinfo=UTC) + timedelta(days=1 if "needle" in path else 0)
        file.created_at = file.mtime
    for path in [
        ".dot.mp4",
        "dir/.hidden/clip.mp4",
        "node_modules/clip.mp4",
        "dir/__pycache__/clip.mp4",
        "dir/Thumbs.db",
    ]:
        bundles.add_file(
            session,
            bundle.id,
            relative_path=path,
            role=FileRole.PRIMARY_VIDEO,
            media_kind=MediaKind.VIDEO,
        )
    confirmed = bundles.create_bundle(session, title="Confirmed")
    bundles.add_file(
        session,
        confirmed.id,
        relative_path="confirmed/needle.mp4",
        role=FileRole.PRIMARY_VIDEO,
        media_kind=MediaKind.VIDEO,
    )
    session.commit()
    return paths


# Search applies to current basename, including literal wildcard characters, before paging
def test_search_before_paging_and_filename_scope(
    client: TestClient, library_id: str, staged: list[str]
) -> None:
    url = f"/api/v1/libraries/{library_id}/manual-bundling/unbundled-files"
    first = client.get(url, params={"limit": 200}).json()
    assert first["total"] == len(staged)
    assert "later/zz-needle.MKV" not in {row["relative_path"] for row in first["items"]}
    for query, expected in [
        (" NEEdLe ", ["later/zz-needle.MKV"]),
        ("later", []),
        ("Stale alias", []),
        ("%_", ["dir/literal%_.mp4"]),
        ("absent", []),
    ]:
        result = client.get(url, params={"q": query, "limit": 200})
        assert result.status_code == 200
        assert result.json()["total"] == len(expected)
        assert [row["relative_path"] for row in result.json()["items"]] == expected
    for params in [
        {"sort": "bogus"},
        {"order": "bogus"},
        {"limit": 201},
        {"offset": -1},
        {"q": "a" * 1025},
    ]:
        assert client.get(url, params=params).status_code == 422


# All sort directions produce a complete stable traversal with small pages
@pytest.mark.parametrize("sort", ["name", "type", "size", "added", "modified"])
@pytest.mark.parametrize("descending", [False, True])
def test_global_order_and_stable_pages(
    session: Session, staged: list[str], sort: str, descending: bool
) -> None:
    pages = [
        list_unbundled_files(session, offset=offset, limit=37, sort=sort, descending=descending)
        for offset in range(0, len(staged), 37)
    ]
    paths = [entry.relative_path for page in pages for entry in page.items]
    assert len(paths) == len(set(paths)) == len(staged)
    assert set(paths) == set(staged)
    assert all(page.total == len(staged) for page in pages)
    if sort in {"size", "added", "modified"} and descending:
        assert paths[0] == "later/zz-needle.MKV"
    if sort == "type" and not descending:
        assert paths[0] == "later/zz-needle.MKV"
    entries = [entry for page in pages for entry in page.items]
    values = [
        {
            "name": entry.name.lower(),
            "type": entry.extension or "",
            "size": entry.size_bytes,
            "added": entry.created_at,
            "modified": entry.modified_at,
        }[sort]
        for entry in entries
    ]
    assert values == sorted(values, reverse=descending)
    assert list_unbundled_files(session, offset=len(staged), limit=37).items == []


# Only the requested page is fetched; count and ordering remain inside SQLite
def test_query_materialization_is_bounded(
    engine: Engine, session: Session, staged: list[str]
) -> None:
    statements = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        page = list_unbundled_files(session, limit=17, offset=200, search="clip", sort="size")
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert page.total == 230 and len(page.items) == 17
    assert len(statements) == 2
    assert "count(*)" in statements[0]
    assert "ORDER BY" in statements[1] and "LIMIT" in statements[1] and "OFFSET" in statements[1]
