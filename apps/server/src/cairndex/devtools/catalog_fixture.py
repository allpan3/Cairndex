"""Complete disposable legacy catalogs for executable replica conversion qualification"""

import json
import sqlite3
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from sqlalchemy import JSON, Boolean, Enum, Float, Integer
from sqlalchemy.dialects.sqlite import dialect
from sqlalchemy.schema import CreateIndex, CreateTable

from cairndex.persistence import models as _models  # noqa: F401
from cairndex.persistence.base import Base
from cairndex.replicas.catalog.model import Row
from cairndex.replicas.protocol import canonical


# Construction is restricted to new temporary trees and never adopts an existing library
@dataclass(frozen=True)
class DisposableCatalog:
    directory: Path
    library_uuid: str

    # Source and private recovery live in separate directories under the disposable tree
    @property
    def source(self) -> Path:
        return self.directory / "source"


# Create complete SQLite schemas using the same constraints as real content and private plans
def create_schema(db: sqlite3.Connection) -> None:
    for table in Base.metadata.tables.values():
        db.execute(str(CreateTable(table).compile(dialect=dialect())))
        for index in table.indexes:
            db.execute(str(CreateIndex(index).compile(dialect=dialect())))


# Fill every column, then override relationships with invented stable identities
def synthetic_row(table: str, identity: str, **overrides: Any) -> Row:
    values: Row = {}
    for column in Base.metadata.tables[table].columns:
        kind = column.type
        if column.primary_key:
            value: Any = identity
        elif column.nullable:
            value = None
        elif isinstance(kind, Enum):
            value = kind.enums[0]
        elif isinstance(kind, Boolean):
            value = 0
        elif isinstance(kind, Integer):
            value = 1
        elif isinstance(kind, Float):
            value = 1.25
        elif isinstance(kind, JSON):
            value = "{}"
        elif column.name.endswith("_at"):
            value = "2025-01-02 03:04:05.123456"
        else:
            value = f"Synthetic {column.name}"
        values[column.name] = value
    values.update(overrides)
    return values


# Insert exact SQLite cell values without ORM JSON coercion or default substitution
def insert_row(db: sqlite3.Connection, table: str, row: Row) -> None:
    if table not in Base.metadata.tables or set(row) != set(Base.metadata.tables[table].c.keys()):
        raise ValueError("Fixture row does not match the complete current schema")
    columns = ",".join(f'"{name}"' for name in row)
    placeholders = ",".join("?" for _ in row)
    db.execute(f"INSERT INTO {table} ({columns}) VALUES ({placeholders})", tuple(row.values()))


# Every family, private category, ordered duplicate and precise opaque value is exercised
def create_disposable(*, parent: Path | None = None, bundles: int = 125) -> DisposableCatalog:
    from cairndex.auth.passwords import hash_passphrase

    if bundles < 3:
        raise ValueError("Complete fixture needs at least three bundles")
    directory = Path(tempfile.mkdtemp(prefix="cairndex-catalog-synthetic-", dir=parent)).resolve()
    fixture = DisposableCatalog(directory, uuid4().hex)
    metadata = fixture.source / ".cairndex"
    metadata.mkdir(parents=True)
    private = directory / "private"
    private.mkdir()
    with sqlite3.connect(metadata / "library.db") as db:
        db.execute("ATTACH DATABASE ? AS plans", (str(private / "plans.db"),))
        create_schema(db)
        for index in range(bundles):
            insert_row(
                db,
                "asset_bundles",
                synthetic_row(
                    "asset_bundles",
                    f"bundle-{index:06}",
                    title=None if index == 0 else f"Synthetic bundle {index} 雪",
                    notes=None
                    if index == 0
                    else "[]"
                    if index == 1
                    else '["  note  ","雪","雪",""]',
                    rating=2.25 if index == 0 else 3.5,
                    extra_metadata='{"precise":1.2345678901234567890123456789,"big":9007199254740993}',
                    manual_order=9007199254740993 + index,
                    cover_file_id="file-video" if index == 0 else None,
                    primary_file_id="file-video" if index == 0 else None,
                    last_opened_at="2025-02-03 04:05:06.000001",
                ),
            )
        for identity, path, role in (
            ("file-video", "Synthetic/雪.mp4", "PRIMARY_VIDEO"),
            ("file-subtitle", "Synthetic/雪.srt", "SUBTITLE"),
        ):
            insert_row(
                db,
                "asset_files",
                synthetic_row(
                    "asset_files",
                    identity,
                    bundle_id="bundle-000000",
                    relative_path=path,
                    directory_path="Synthetic",
                    original_filename=path.split("/")[-1],
                    display_title=path.split("/")[-1],
                    role=role,
                    sequence=7,
                    note="  exact note\n",
                    source="magnet:?xt=urn:synthetic:test",
                    size_bytes=9007199254740993,
                    filesystem_inode=-(2**63),
                    tech_metadata='{"duration":0.1234567890123456789}',
                    cover_time=0.125,
                ),
            )
        insert_row(
            db,
            "bundle_directory_members",
            synthetic_row(
                "bundle_directory_members",
                "directory-one",
                bundle_id="bundle-000000",
                directory_path="Synthetic",
                sequence=7,
            ),
        )
        for family in ("tags", "collections"):
            for suffix, parent_id in (("root", None), ("child", f"{family}-root")):
                insert_row(
                    db,
                    family,
                    synthetic_row(
                        family,
                        f"{family}-{suffix}",
                        parent_id=parent_id,
                        name=f"Synthetic {suffix}",
                    ),
                )
        insert_row(db, "tag_groups", synthetic_row("tag_groups", "group-one"))
        insert_row(db, "asset_bundle_tags", {"bundle_id": "bundle-000000", "tag_id": "tags-child"})
        insert_row(
            db,
            "asset_bundle_collections",
            {
                "bundle_id": "bundle-000000",
                "collection_id": "collections-child",
                "sort_order": 7,
            },
        )
        insert_row(
            db,
            "tag_group_memberships",
            {
                "group_id": "group-one",
                "tag_id": "tags-child",
                "sort_order": 7,
            },
        )
        insert_row(
            db,
            "moments",
            synthetic_row(
                "moments",
                "moment-one",
                bundle_id="bundle-000000",
                file_id="file-video",
                start_s=0.1234567890123456,
                end_s=1.2345678901234567,
                comment="Frame 雪\n",
            ),
        )
        insert_row(db, "moment_tags", {"moment_id": "moment-one", "tag_id": "tags-child"})
        insert_row(
            db,
            "subtitle_tracks",
            synthetic_row(
                "subtitle_tracks",
                "track-one",
                bundle_id="bundle-000000",
                video_file_id="file-video",
                source_file_id="file-subtitle",
                label="字幕",
                language="zh-Hans",
                is_default=1,
            ),
        )
        insert_row(
            db,
            "smart_folders",
            synthetic_row(
                "smart_folders",
                "filter-one",
                filter_json=canonical(
                    {
                        "version": 1,
                        "root": {
                            "field": "tags",
                            "operator": "contains_any",
                            "value": ["tags-root"],
                            "include_descendants": True,
                        },
                    }
                ).decode(),
            ),
        )
        insert_row(
            db,
            "playback_progress",
            synthetic_row(
                "playback_progress",
                "file-video",
                bundle_id="bundle-000000",
                position_s=0.625,
            ),
        )
        insert_row(
            db,
            "bundle_cursors",
            synthetic_row(
                "bundle_cursors",
                "bundle-000000",
                file_id="file-video",
            ),
        )
        insert_row(
            db,
            "file_operations",
            synthetic_row(
                "file_operations",
                "operation-one",
                status="UNDONE",
                op="RENAME",
                payload='{"synthetic_recovery":true}',
            ),
        )
        insert_row(
            db,
            "plans.grouping_plans",
            synthetic_row(
                "plans.grouping_plans",
                "plan-one",
                stem_modes='{"Synthetic":2}',
            ),
        )
        insert_row(
            db,
            "plans.grouping_proposals",
            synthetic_row(
                "plans.grouping_proposals",
                "proposal-one",
                plan_id="plan-one",
            ),
        )
        insert_row(
            db,
            "plans.grouping_proposal_files",
            synthetic_row(
                "plans.grouping_proposal_files",
                "proposal-file",
                proposal_id="proposal-one",
                asset_file_id="file-video",
                relative_path="Synthetic/雪.mp4",
            ),
        )
        insert_row(
            db,
            "plans.grouping_proposal_directories",
            synthetic_row(
                "plans.grouping_proposal_directories",
                "proposal-directory",
                proposal_id="proposal-one",
                directory_path="Synthetic",
            ),
        )
        if db.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("Invalid synthetic relationships")
    manifest = {
        "format": "cairndex.library",
        "format_version": 1,
        "library_uuid": fixture.library_uuid,
        "display_name": "Synthetic complete catalog",
        "db": "library.db",
        "content_root": ".",
        "created_at": "2025-01-02T03:04:05Z",
    }
    manifest["auth"] = hash_passphrase("synthetic-test-phrase", iterations=1)
    (metadata / "manifest.json").write_bytes(canonical(manifest))
    (private / "synthetic-auth.json").write_text(json.dumps({"synthetic": "private-auth-record"}))
    media = fixture.source / "Synthetic"
    media.mkdir()
    (media / "雪.mp4").write_bytes(b"Synthetic source specimen for metadata-only tests\n")
    (media / "雪.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\nSynthetic subtitle 雪\n")
    return fixture
