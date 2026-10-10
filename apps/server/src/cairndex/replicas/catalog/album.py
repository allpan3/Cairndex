"""Snapshot-consistent album pages over catalog membership; no source reads."""

import hashlib
import json
import sqlite3
from typing import Literal

from cairndex.api.schemas.bundles import DirectoryMemberRead, FileRead
from cairndex.core.errors import ConflictError, NotFoundError
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.media import ReplicaMedia
from cairndex.replicas.protocol import StrictModel
from cairndex.scanning.media_types import HIDDEN_NAMES, is_hidden_relative_path


class CatalogAlbumItem(StrictModel):
    id: str
    kind: Literal["file", "directory"]
    file: FileRead | None = None
    directory: DirectoryMemberRead | None = None


class CatalogAlbumPage(StrictModel):
    title: str
    directory_path: str | None
    revision: str
    items: list[CatalogAlbumItem]
    total: int
    next_offset: int | None


def visible(path: str) -> str:
    """Apply scanner exclusions before counting and paging catalog paths."""
    return f"{path} NOT LIKE '.%' AND {path} NOT LIKE '%/.%'" + "".join(
        f" AND instr('/'||{path}||'/','/{name}/')=0" for name in sorted(HIDDEN_NAMES)
    )


def revision(db: sqlite3.Connection) -> str:
    """Bind continuation pages to the committed causal frontier, not wall time."""
    digest = hashlib.sha256()
    for row in db.execute("SELECT event FROM catalog_frontier ORDER BY event"):
        digest.update(row[0].encode())
    return digest.hexdigest()


def album(
    media: ReplicaMedia,
    bundle_id: str,
    directory_id: str | None,
    offset: int,
    limit: int,
    expected_revision: str | None,
) -> CatalogAlbumPage:
    with media.store.connection(readonly=True) as db:
        bundle = read_row(db, "asset_bundles", bundle_id)
        if bundle is None:
            raise NotFoundError("Bundle is unavailable; return to the library")
        current = revision(db)
        if expected_revision is not None and current != expected_revision:
            raise ConflictError("Album changed. Reload the album before loading more items.")
        directory = None
        if directory_id:
            directory = read_row(db, "bundle_directory_members", directory_id)
            if (
                directory is None
                or directory["bundle_id"] != bundle_id
                or is_hidden_relative_path(directory["directory_path"])
            ):
                raise NotFoundError("Directory member is unavailable; return to the bundle")
        path = "json_extract(c.body,'$.relative_path')"
        folder_path = "json_extract(d.body,'$.directory_path')"
        owner = f"asset_bundles/{bundle_id}/$members"
        params: list[str | int] = [owner]
        files = (
            "SELECT c.entity AS entity,c.body,'file' AS kind,"
            "CAST(json_extract(p.body,'$.sequence') AS INTEGER) AS sequence "
            "FROM catalog_placements p JOIN catalog_rows c "
            "ON c.family=p.family AND c.entity=p.entity "
            "WHERE p.owner=? AND c.family='asset_files' AND " + visible(path)
        )
        if directory:
            files += f" AND {path}>=? AND {path}<?"
            params.extend([directory["directory_path"] + "/", directory["directory_path"] + "0"])
            relation = files
        else:
            files += (
                " AND NOT EXISTS (SELECT 1 FROM catalog_placements dp JOIN catalog_rows d "
                "ON d.family=dp.family AND d.entity=dp.entity WHERE dp.owner=p.owner "
                "AND d.family='bundle_directory_members' AND "
                f"{path}>={folder_path}||'/' AND {path}<{folder_path}||'0')"
            )
            relation = files + (
                " UNION ALL SELECT c.entity AS entity,c.body,'directory' AS kind,"
                "CAST(json_extract(p.body,'$.sequence') AS INTEGER) AS sequence "
                "FROM catalog_placements p JOIN catalog_rows c "
                "ON c.family=p.family AND c.entity=p.entity "
                "WHERE p.owner=? AND c.family='bundle_directory_members' AND "
                + visible("json_extract(c.body,'$.directory_path')")
            )
            params.append(owner)
        total = db.execute(f"SELECT count(*) FROM ({relation})", params).fetchone()[0]
        rows = db.execute(
            relation + " ORDER BY sequence,entity LIMIT ? OFFSET ?", [*params, limit, offset]
        ).fetchall()
        items = [
            CatalogAlbumItem(
                id=row["entity"],
                kind=row["kind"],
                file=FileRead.model_validate(media.catalog_file(db, row["entity"]))
                if row["kind"] == "file"
                else None,
                directory=DirectoryMemberRead.model_validate(json.loads(row["body"]))
                if row["kind"] == "directory"
                else None,
            )
            for row in rows
        ]
        return CatalogAlbumPage(
            title=bundle["title"] or "Untitled",
            directory_path=directory["directory_path"] if directory else None,
            revision=current,
            items=items,
            total=total,
            next_offset=offset + len(items) if offset + len(items) < total else None,
        )
