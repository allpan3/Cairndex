# Performance baselines (large libraries)

Cairndex targets multi-terabyte libraries with large item counts, so the
browse/query paths must stay fast as a library grows. This document records the
tooling used to measure them and the changes (targeted indexes + one query
rewrite) that the measurements justify. Re-run the tools after schema or query
changes and update the numbers.

## Tooling

Two devtools live under `apps/server` (`cairndex.devtools`):

- **`synthetic_library`** — generates a real `.cairndex/` library on disk and
  bulk-populates it with synthetic bundles/files/collections/tags using batched
  core inserts. No real media is written or read. 100k bundles / ~300k files
  generate in ~6s.

  ```bash
  uv run python -m cairndex.devtools.synthetic_library \
      --library-root /tmp/cairndex-synth \
      --bundles 100000 --files-per-bundle 1-5 \
      --collections 1000 --tags 2000 --seed 1234
  ```

- **`benchmark_queries`** — opens a library read-only and times the hot paths
  (browse first page / deep pagination, collection & tag filters incl.
  descendants, Smart-Collection preview, the sidebar counts, per-bundle reads,
  thumbnail lookup) over `--iterations` runs. `--explain` also dumps SQLite
  `EXPLAIN QUERY PLAN` for the exact SQL each path emits.

  ```bash
  uv run python -m cairndex.devtools.benchmark_queries \
      --library-root /tmp/cairndex-synth --iterations 20 \
      --explain --json /tmp/cairndex-benchmark.json
  ```

## What the baseline showed

`EXPLAIN QUERY PLAN` on the original code showed two problems:

1. **Un-indexed foreign key.** The browse/count/filter paths did a full
   `asset_files` scan *per bundle*: the visible-file predicate
   (`_visible_file_exists`), the per-bundle size/count subqueries, the per-bundle
   summary read, and the Missing-view check all correlate `asset_files` by
   `bundle_id`, which SQLite does not auto-index for a foreign key. The sidebar
   count group-bys also fell back to a temp B-tree because the association
   tables' composite PK leads with `bundle_id`, not the grouped column.

2. **Per-bundle correlated membership EXISTS.** Tag/collection filters (and their
   "include descendants" variants) compiled to a correlated
   `EXISTS(... WHERE bundle_id = B AND member_id IN (…))` evaluated once per
   candidate bundle. With descendant expansion the `IN (…)` set grows to the
   whole subtree, so the cost blew up to seconds at scale.

## Changes made (all measurement-driven)

**Indexes** (defined on the models, so new library DBs get them via
`create_all`; `persistence.engine.ensure_content_indexes` backfills them
idempotently into existing library DBs on open, since library DBs have no
migration chain):

- **`ix_asset_files_bundle_id`** — the dominant fix; turns the per-bundle
  `asset_files` scans into index seeks.
- **`ix_asset_bundle_collections_collection_id`** and
  **`ix_asset_bundle_tags_tag_id`** — reverse indexes (the PK leads with
  `bundle_id`) for the `collection_counts` / `tag_counts` group-bys and for the
  membership semijoin below.

**Query rewrite:** tag/collection membership filters now compile to a
non-correlated semijoin — `AssetBundle.id IN (SELECT bundle_id FROM assoc WHERE
member_id IN (…))` — instead of a per-bundle correlated `EXISTS`. The inner match
set is computed once using the association-table index, independent of the
number of candidate bundles. Applied in both `filters.compiler` (Smart
Collections / toolbar filters) and `services.browse._apply_view` (collection
browsing). Semantically identical to the previous `EXISTS` form.

**Collection-count rollup:** sidebar collection counts use one recursive CTE to
map every collection to its full descendant subtree, then count distinct bundle
memberships per ancestor. This preserves zero-count collections and avoids
double-counting a bundle assigned to multiple nested collections.

## Results

Median ms. **Baseline** = original code, no indexes. **Final** = indexes +
semijoin. Measured on synthetic libraries (`--files-per-bundle 1-5`).

5,000 bundles / 15,050 files (3 iterations):

| path                          | baseline | final | speedup |
| ----------------------------- | -------: | ----: | ------: |
| browse_first_page             |  5399.32 | 11.90 |   ~450× |
| browse_deep_pagination        |  5648.72 | 13.03 |   ~430× |
| view_counts                   | 11960.24 | 13.99 |   ~850× |
| smart_collection_preview      |  1991.81 | 10.70 |   ~185× |
| collection_filter             |  5655.86 |  1.63 | ~3500×  |
| tag_filter                    |  5627.83 |  1.50 | ~3700×  |
| collection_descendant_filter  |  5719.02 |  9.61 |   ~595× |
| tag_descendant_filter         |  6064.60 | 20.86 |   ~290× |
| collection_counts†            |      n/a |  7.80 |     n/a |
| tag_counts                    |     2.64 |  0.87 |    ~3×  |
| bundle_files_read             |     0.94 |  0.15 |    ~6×  |

† Remeasured after descendant rollup on 5,000 bundles / 15,004 files and 1,000
collections. The prior 0.37 ms direct-membership query is not semantically
comparable.

At 100,000 bundles / ~300,000 files (5 iterations) the final code stays
comfortably interactive:

| path                          | final median (ms) |
| ----------------------------- | ----------------: |
| browse_first_page             |            120.36 |
| browse_deep_pagination        |            164.91 |
| view_counts                   |            274.95 |
| smart_collection_preview      |             67.11 |
| collection_filter             |              7.62 |
| collection_descendant_filter  |             72.82 |
| tag_filter                    |              6.34 |
| tag_descendant_filter         |            132.82 |
| collection_counts†            |            267.92 |
| tag_counts                    |              4.88 |
| bundle_detail_read            |              0.06 |
| bundle_files_read             |              0.11 |

† Remeasured after descendant rollup on 100,000 bundles / 300,212 files and
1,000 collections.

## Remaining / future work

- **`view_counts` (~275 ms), descendant-inclusive `collection_counts` (~268 ms),
  and browse (~120–165 ms) at 100k** are now the slowest paths. View/browse are
  dominated by evaluating the visible-file predicate
  (one indexed `asset_files` EXISTS per bundle) and, for browse, the
  `ORDER BY created_at` temp-B-tree sort (no `created_at` index). These are
  acceptable at 100k; collection counts are dominated by distinct membership
  rollup across the recursive collection tree. If a much larger library shows
  these paths dominating, options are an `(created_at, id)` index for the sort,
  denormalizing a "has visible file" flag onto `asset_bundles` to avoid the
  per-bundle EXISTS, or revisiting a closure table through a new ADR if recursive
  collection rollup itself becomes too slow.
- No external infrastructure was introduced; SQLite remains the store.
