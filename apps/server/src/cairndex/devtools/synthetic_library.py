"""Generate a large synthetic Cairndex library on disk for benchmarking.

Creates a real ``.cairndex/`` package (manifest + ``library.db``) at a chosen
root and bulk-populates it with synthetic bundles, files, collections, and tags
— **no real media is ever written or read** (AGENTS.md §15). Unlike the small
service-layer ``synthetic.seed_synthetic_library`` used by tests, this uses
batched SQLAlchemy *core* inserts so 100k+ bundles generate in seconds, which is
what the query benchmark (``benchmark_queries``) needs.

Usage (from apps/server):

    uv run python -m cairndex.devtools.synthetic_library \\
        --library-root /tmp/cairndex-synth \\
        --bundles 100000 --files-per-bundle 1-5 \\
        --collections 1000 --tags 2000 --seed 1234
"""

import argparse
import random
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from sqlalchemy import Engine, Table, bindparam, insert, update
from sqlalchemy.orm import Session

from cairndex.core.ids import new_id
from cairndex.core.time import utcnow
from cairndex.domain.enums import (
    FileAvailability,
    FileRole,
    GroupingSource,
    GroupingState,
    MediaKind,
)
from cairndex.persistence.models import (
    AssetBundle,
    AssetFile,
    Collection,
    Tag,
    TagGroup,
    asset_bundle_collections,
    asset_bundle_tags,
    tag_group_memberships,
)
from cairndex.registry import library_package as pkg
from cairndex.search import drop_maintenance_triggers, ensure_search_schema, rebuild

# A small fraction of files are marked missing so the Missing system view and
# its query path have realistic (non-empty, non-dominant) selectivity.
_MISSING_FRACTION = 0.02
# How many bundles to flush per batch — bounds peak memory on huge generations.
_BATCH = 5000
_TAG_GROUPS = ["Genre", "Mood", "Status", "Source", "Person"]


@dataclass(frozen=True)
class GenerateSummary:
    bundles: int
    files: int
    collections: int
    tags: int
    tag_groups: int
    collection_memberships: int
    tag_memberships: int


def parse_range(spec: str) -> tuple[int, int]:
    """Parse ``"1-5"`` or ``"3"`` into an inclusive ``(lo, hi)`` file-count range."""
    if "-" in spec:
        lo_s, hi_s = spec.split("-", 1)
        lo, hi = int(lo_s), int(hi_s)
    else:
        lo = hi = int(spec)
    if lo < 1 or hi < lo:
        raise ValueError(f"invalid files-per-bundle range: {spec!r}")
    return lo, hi


def _tag_rows(n_tags: int, rng: random.Random, now: object) -> list[dict[str, object]]:
    """Build ``n_tags`` tag rows: ~12% roots, the rest children of earlier tags
    (a realistic adjacency-list hierarchy for descendant-filter benchmarks)."""
    ids = [new_id() for _ in range(n_tags)]
    rows: list[dict[str, object]] = []
    for i, tag_id in enumerate(ids):
        parent_id = None
        if i > 0 and rng.random() > 0.12:
            parent_id = ids[rng.randint(0, i - 1)]
        rows.append(
            {
                "id": tag_id,
                "parent_id": parent_id,
                "name": f"tag-{i:05d}",
                "sort_order": 0,
                "created_at": now,
                "updated_at": now,
                "version": 1,
            }
        )
    return rows


def _collection_rows(n: int, rng: random.Random, now: object) -> list[dict[str, object]]:
    ids = [new_id() for _ in range(n)]
    rows: list[dict[str, object]] = []
    for i, cid in enumerate(ids):
        parent_id = None
        if i > 0 and rng.random() > 0.3:  # ~70% nested → deep descendant trees
            parent_id = ids[rng.randint(0, i - 1)]
        rows.append(
            {
                "id": cid,
                "parent_id": parent_id,
                "name": f"collection-{i:05d}",
                "sort_order": 0,
                "created_at": now,
                "updated_at": now,
                "version": 1,
            }
        )
    return rows


def generate_synthetic_library(
    session: Session,
    *,
    n_bundles: int,
    files_per_bundle: tuple[int, int] = (1, 5),
    n_collections: int = 100,
    n_tags: int = 200,
    seed: int = 1234,
) -> GenerateSummary:
    """Bulk-populate a library content session with synthetic metadata.

    Deterministic for a given ``seed``. Inserts taxonomy, then bundles+files in
    batches, then random membership rows; finally points each bundle's
    cover at its files via set-based UPDATEs (avoids the FK-cycle dance
    per row)."""
    rng = random.Random(seed)
    now = utcnow()

    # Suspend FTS5 search-index maintenance triggers for the bulk load. Those
    # triggers recompute one bundle's search row per write, which is the right
    # behavior for normal interactive/scan writes but pathological here: SQLite
    # fires a trigger per row even inside an executemany-style batch, and many
    # small individual FTS5 DELETE+INSERT operations fragment the index and get
    # progressively slower as it grows (100k+ bundles turns a few seconds into
    # hours). Triggers are restored and the index rebuilt in one efficient pass
    # at the end instead.
    drop_maintenance_triggers(session)
    session.commit()

    # --- Taxonomy ---------------------------------------------------------
    tag_rows = _tag_rows(n_tags, rng, now)
    if tag_rows:
        session.execute(insert(Tag), tag_rows)
    coll_rows = _collection_rows(n_collections, rng, now)
    if coll_rows:
        session.execute(insert(Collection), coll_rows)

    group_ids = [new_id() for _ in _TAG_GROUPS]
    session.execute(
        insert(TagGroup),
        [
            {"id": gid, "name": name, "sort_order": i, "created_at": now, "updated_at": now}
            for i, (gid, name) in enumerate(zip(group_ids, _TAG_GROUPS, strict=True))
        ],
    )
    # Spread tags across groups (many-to-many; a tag may land in several groups).
    if tag_rows:
        memberships = [
            {"group_id": rng.choice(group_ids), "tag_id": t["id"], "sort_order": 0}
            for t in tag_rows
            if rng.random() < 0.8
        ]
        if memberships:
            session.execute(insert(tag_group_memberships), memberships)
    session.commit()

    tag_ids = [t["id"] for t in tag_rows]
    coll_ids = [c["id"] for c in coll_rows]
    lo, hi = files_per_bundle

    total_files = 0
    coll_memberships = 0
    tag_memberships = 0

    bundle_batch: list[dict[str, object]] = []
    file_batch: list[dict[str, object]] = []
    bc_batch: list[dict[str, object]] = []
    bt_batch: list[dict[str, object]] = []
    # Bundle cover selections, tracked in Python and applied by primary
    # key — never via a correlated subquery over asset_files (which would depend
    # on the very bundle_id index this milestone measures).
    # Core table UPDATE (not ORM) keyed by primary key: executemany-friendly and
    # avoids the ORM "bulk update by PK" path that wants an ``id`` in each row.
    bundles_table = cast(Table, AssetBundle.__table__)
    cover_update = (
        update(bundles_table)
        .where(bundles_table.c.id == bindparam("b_pk"))
        .values(cover_file_id=bindparam("cover"))
    )
    update_batch: list[dict[str, object]] = []

    def flush() -> None:
        if bundle_batch:
            session.execute(insert(AssetBundle), bundle_batch)
        if file_batch:
            session.execute(insert(AssetFile), file_batch)
        if bc_batch:
            session.execute(insert(asset_bundle_collections), bc_batch)
        if bt_batch:
            session.execute(insert(asset_bundle_tags), bt_batch)
        if update_batch:
            session.execute(cover_update, update_batch)
        session.commit()
        bundle_batch.clear()
        file_batch.clear()
        bc_batch.clear()
        bt_batch.clear()
        update_batch.clear()

    for i in range(n_bundles):
        bundle_id = new_id()
        # Spread created_at backwards in time so date sort + deep pagination are
        # realistic (each bundle one minute older than the next).
        created = now.timestamp() - i * 60
        created_at = datetime.fromtimestamp(created, UTC)
        bundle_batch.append(
            {
                "id": bundle_id,
                "title": f"Synthetic Bundle {i:06d}",
                "rating": rng.choice([None, 1, 2, 3, 4, 5]),
                "grouping_state": GroupingState.CONFIRMED.name,
                "grouping_source": GroupingSource.MANUAL.name,
                "created_at": created_at,
                "imported_at": created_at,
                "updated_at": created_at,
                "version": 1,
            }
        )

        n_files = rng.randint(lo, hi)
        shard = i % 256
        cover_id: str | None = None
        for j in range(n_files):
            if j == 0:
                role, kind, ext = FileRole.PRIMARY_VIDEO, MediaKind.VIDEO, "mp4"
            elif j == 1:
                role, kind, ext = FileRole.COVER, MediaKind.IMAGE, "jpg"
            elif j == 2:
                role, kind, ext = FileRole.SUBTITLE, MediaKind.SUBTITLE, "srt"
            else:
                role, kind, ext = FileRole.IMAGE, MediaKind.IMAGE, "jpg"
            file_id = new_id()
            if cover_id is None and kind is MediaKind.IMAGE:
                cover_id = file_id
            missing = rng.random() < _MISSING_FRACTION
            file_batch.append(
                {
                    "id": file_id,
                    "bundle_id": bundle_id,
                    "relative_path": f"dir{shard:03d}/clip{i:06d}_{j}.{ext}",
                    "original_filename": f"clip{i:06d}_{j}.{ext}",
                    "display_title": f"clip{i:06d}_{j}.{ext}",
                    "role": role.name,
                    "media_kind": kind.name,
                    "sequence": j,
                    "size_bytes": rng.randint(1_000, 5_000_000_000),
                    "availability": (
                        FileAvailability.MISSING.name
                        if missing
                        else FileAvailability.AVAILABLE.name
                    ),
                    "identity_available": False,
                    "created_at": created_at,
                    "updated_at": created_at,
                    "version": 1,
                }
            )
            total_files += 1

        update_batch.append({"b_pk": bundle_id, "cover": cover_id})

        for cid in rng.sample(coll_ids, k=min(len(coll_ids), rng.randint(0, 2))):
            bc_batch.append({"bundle_id": bundle_id, "collection_id": cid})
            coll_memberships += 1
        for tid in rng.sample(tag_ids, k=min(len(tag_ids), rng.randint(0, 3))):
            bt_batch.append({"bundle_id": bundle_id, "tag_id": tid})
            tag_memberships += 1

        if (i + 1) % _BATCH == 0:
            flush()
    flush()

    # Restore normal maintenance for future writes, then populate the search
    # index in one set-based pass (a single INSERT...SELECT from the view).
    engine = cast(Engine, session.get_bind())
    ensure_search_schema(engine)
    rebuild(session)
    session.commit()

    return GenerateSummary(
        bundles=n_bundles,
        files=total_files,
        collections=n_collections,
        tags=n_tags,
        tag_groups=len(_TAG_GROUPS),
        collection_memberships=coll_memberships,
        tag_memberships=tag_memberships,
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate a large synthetic Cairndex library for benchmarking."
    )
    parser.add_argument("--library-root", required=True, help="root dir for the new library")
    parser.add_argument("--name", default="Synthetic Library", help="library display name")
    parser.add_argument("--bundles", type=int, default=100_000)
    parser.add_argument("--files-per-bundle", default="1-5", help="e.g. 1-5 or 3")
    parser.add_argument("--collections", type=int, default=1000)
    parser.add_argument("--tags", type=int, default=2000)
    parser.add_argument("--seed", type=int, default=1234)
    args = parser.parse_args()

    root = Path(args.library_root)
    root.mkdir(parents=True, exist_ok=True)
    if pkg.detect(root) is None:
        pkg.create_package(root, args.name)

    from cairndex.persistence.engine import create_app_engine

    engine = create_app_engine(database_url=f"sqlite:///{pkg.db_path(root).as_posix()}")
    try:
        with Session(engine) as session:
            summary = generate_synthetic_library(
                session,
                n_bundles=args.bundles,
                files_per_bundle=parse_range(args.files_per_bundle),
                n_collections=args.collections,
                n_tags=args.tags,
                seed=args.seed,
            )
    finally:
        engine.dispose()

    print(
        f"Generated {summary.bundles} bundles / {summary.files} files, "
        f"{summary.collections} collections, {summary.tags} tags "
        f"({summary.collection_memberships} collection + {summary.tag_memberships} tag "
        f"memberships) at {root}."
    )


if __name__ == "__main__":
    main()
