# Performance baselines (large libraries)

Cairndex targets multi-terabyte libraries with large item counts, so the
browse/query paths must stay fast as a library grows, and the media jobs that
walk every file must not scale with how expensive each one is to decode. This
document records the tooling used to measure both and the changes the
measurements justify — targeted indexes and one query rewrite for the query
paths, keyframe sampling for storyboard generation. Re-run the tools after
schema, query, or media-pipeline changes and update the numbers.

## Tooling

Two devtools for the query paths live under `apps/server` (`cairndex.devtools`);
a third, for storyboard generation, is described in its own section below:

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

## Storyboard generation (2026-07-30)

Trickplay sheets are the most expensive derived artifact Cairndex produces, and
the owner asked why a run over a library on an SMB share took so long. The
answer was the sampling filter: `fps=1/n` gives ffmpeg no reason to seek, so it
**decodes every frame from start to finish**. The cost per video was therefore a
full decode, and the cost per library a full decode — and, on a network mount, a
full read — of every eligible video.

Generation now samples **keyframes only** (`-skip_frame nokey` plus a `select`
that keeps the first keyframe and then the next one at least an interval later).

### Tooling

- **`benchmark_storyboards`** — encodes fixtures of stated GOP length with
  ffmpeg (never user media), then times each sampling mode end to end, reporting
  wall clock, tiles, cues, and sheet bytes.

  ```bash
  uv run python -m cairndex.devtools.benchmark_storyboards \
      --fixtures-dir /tmp/cairndex-storyboard-fixtures --json /tmp/sb.json
  ```

### Results

Five-minute 1280x720 fixtures, 30 fps, on an Apple Silicon laptop with local
SSD storage — so this measures **decode only**; the network read a real library
adds is on top, and is what makes the saving matter more there than here.

| Fixture (300 s) | Sampling | Wall clock | Tiles | Sheet bytes |
| --------------- | -------- | ---------: | ----: | ----------: |
| H.264, GOP 2 s  | keyframe |   **0.38 s** |   150 |     804 KiB |
| H.264, GOP 2 s  | exact    |     1.11 s |   150 |     804 KiB |
| H.264, GOP 10 s | keyframe |   **0.17 s** |    30 |     172 KiB |
| H.264, GOP 10 s | exact    |     1.06 s |   150 |     803 KiB |
| HEVC, GOP 5 s   | keyframe |   **0.27 s** |    35 |     197 KiB |
| HEVC, GOP 5 s   | exact    |     3.63 s |   150 |     804 KiB |

2.9× to 13.4× faster, and the harder the codec is to decode the more it saves —
the HEVC row is the shape a real library has. Where the GOP matches the sampling
interval the two modes produce the *same* 150 tiles; where it is coarser, the
storyboard is coarser, which is the trade below.

### The trade, and what was rejected

Tiles land on the keyframe at or before each sample point, so scrubbing is only
as fine as the source's GOP. Rather than let a cue claim a time it did not
sample, each cue carries the timestamp of the frame it actually holds and runs
to the next sampled frame — cues are as uneven as the keyframes are. The hover
path already seeks to a cue's own timestamp, so it now lands exactly on the
frame it displayed. A video whose keyframes cannot describe it at all (a
single-keyframe encode) still gets one full decode. `exact` sampling remains
available per deployment for a local library where decode is cheap.

**Seeking to each cue with `-ss`, the way contact sheets do, was measured and
rejected.** On a 10-minute 1080p fixture: 4.1 s for the full decode it would
replace, 12.0 s seeking accurately to each cue, 15.1 s seeking to the nearest
keyframe, and 0.7 s for the keyframe pass. Seeking wins only when samples are
spaced much further apart than keyframes — which is exactly the contact-sheet
case (16–60 frames across a whole film) and exactly not the storyboard case: a
storyboard samples every 2–30 s, so consecutive cues keep landing in the same
group and re-reading it. The keyframe pass reads each file once, sequentially,
which is also the friendlier pattern for a network mount.

## macOS SQLite durability (2026-10-18)

The 2026-10-18 qualification measured the macOS policy in
[ADR-0039](adr/0039-macos-sqlite-durability.md): FULL synchronous and both
fullfsync flags for every SQLite writer. Linux/Docker policy is unchanged.

Synthetic storage timings on the approved macOS VM, Python 3.12.13 and SQLite
3.53.1. The columns compare median / p95 milliseconds before and after. Three fresh
databases per policy, with alternating policy order, supply 150 samples per
rating mode, 60 batches of each size and 30 checkpoints. Automatic checkpoints
are disabled for the pooled WAL timings; each explicit checkpoint has 1 MiB of
new payload.
These are SQLite transaction timings, excluding API, catalog replay and media
work. The first row includes opening, committing and closing the last
connection, which also checkpoints its WAL.

| Storage and operation | Before, median / p95 ms | After, median / p95 ms |
| --- | ---: | ---: |
| Local WAL, rating including open/close, previous FULL | 0.62 / 2.02 | 18.45 / 28.69 |
| Local WAL, pooled rating, previous FULL | 0.10 / 0.32 | 5.24 / 9.38 |
| Local WAL, pooled rating, previous ORM NORMAL | 0.007 / 0.013 | 5.24 / 9.38 |
| Local WAL, 32-row batch, previous FULL | 0.26 / 0.49 | 7.19 / 18.77 |
| Local WAL, 200-row batch, previous ORM NORMAL | 0.41 / 0.44 | 8.20 / 15.20 |
| Local WAL, 1 MiB checkpoint, previous FULL | 1.03 / 1.52 | 5.25 / 15.93 |
| Local rollback, rating, previous ORM NORMAL | 0.44 / 0.89 | 17.46 / 24.73 |
| Local rollback, 200-row batch, previous ORM NORMAL | 1.10 / 1.23 | 21.33 / 34.54 |

On the mounted test SMB share, rollback journaling remained in use. No WAL was
attempted there. The synthetic file rejected `F_FULLFSYNC` with errno 45,
`ENOTSUP`, and accepted `fsync`. SQLite commits and integrity checks passed
with both flags on, consistent with its documented fallback.

| SMB rollback operation | Before ORM NORMAL, median / p95 ms | After, median / p95 ms |
| --- | ---: | ---: |
| Rating | 76.81 / 118.36 | 120.79 / 142.70 |
| 32-row batch | 86.83 / 100.21 | 132.75 / 154.69 |
| 200-row batch | 106.74 / 152.78 | 151.08 / 181.91 |

With FULL already set and both flags off, the SMB rating median was 118.52 ms
and the 200-row batch 150.66 ms. Most of the increase therefore comes from
NORMAL to FULL, rather than the rejected fullfsync call. This cost is acceptable
for the retained network-library engine and conversion paths. Current portable
libraries keep their working databases local. The benchmark created only its
own uniquely named scratch tree, removed it and unmounted its test mount.

The local synthetic file accepted `F_FULLFSYNC`. All benchmark databases passed
integrity checks and exact scan-row counts. The absolute local costs are
acceptable for edits and existing scan batches, so scans retain the same
durability policy. This does not qualify large-library throughput or physical
power-loss safety. SQLite's fallback and a successful flush request cannot
establish that the hypervisor, host or NAS persists bytes on stable storage.
Run `uv run python -m cairndex.devtools.benchmark_sqlite_durability` from
`apps/server` to reproduce. Gates and benchmarks use isolated synthetic temp
state; the owner's library, registry and private store are outside the tests.

Both full VM gates ended with `Final result: 0`. macOS passed 1,954 backend
tests and 137 Rust tests; Linux passed 1,788 + 165 backend tests and 135 Rust
tests. Both passed 4 frozen binary tests, 154 web test files, all 47 browser
tests, static checks, sidecar smoke and the web build. The macOS app build and
distribution check passed too. The documented ARM manifest assertion is
excluded in the Linux guest and remains covered by hosted x86 CI.
Docker context/image privacy, API/restart/arbitrary-UID smoke, registry
backup/restore and private recovery smoke also ended with `Final result: 0`
against the local test VM daemon. Receipts:
`fullfsync-ack-final-mac-20261018-230329`,
`fullfsync-ack-final-linux-20261018-230705` and
`fullfsync-docker-20261018-230350`.

## SMB responsiveness and grouping accept (2026-11-21)

Synthetic benchmark against a format-three portable library whose root is
instrumented with a `1.5 ms` per-syscall SMB round-trip plus `280 MB/s`
sequential read bandwidth across `open`, `stat`, `lstat`, `scandir`, `fsync`,
`read`, `pread`, and `write`, with private SQLite stores (`fullfsync=ON`,
`synchronous=FULL`) and derived-media caches on local SSD:

| Workload | Before | After (Server / SMB) | Visible UI Latency |
| --- | ---: | ---: | ---: |
| Idle 4 s background window | 1,667 SMB syscalls (1,590 `open`s) | **77 SMB syscalls** (11 `open`s, **−95.4%**) | — |
| 24 cached thumbnails (8-way burst) | 669.4 ms wall / 1,344 SMB ops | **315.0 ms** cold (**105.4 ms** p50) / 409 SMB ops | **0 ms** on warm scroll / view switch (`coverMemoryCache`) |
| Single-bundle rename (`save` job) | 2,637.4 ms median | **126.9 ms** (**20.8× faster**) | **0 ms** (optimistic draft + browse patch) |
| Tag / collection toggle (`preview` + `commit`) | 5,654.0 ms median | **258.4 ms** (**21.9× faster**) | **0 ms** (optimistic chip + tree patch) |
| Grouping **Accept selected** (12 bundles / 36 files) | 75,416.9 ms cold / 37,842 SMB syscalls (~3.0 s warm SMB) | **1,431.0 ms** / **646 SMB syscalls** (**52.7× faster**, **−98.3% ops**) | Adaptive 25–40 ms status poll (`<250 ms` on LAN SMB) |

Why SMB felt sluggish despite `280 MB/s` sequential bandwidth: SMB throughput
governs bulk streaming, whereas small metadata operations (`open`, `stat`,
`scandir`, `fsync`) pay per-round-trip latency (`~0.8–2.5 ms` each). Probing
256 shard paths per worker tick under the per-library lock, re-reading 192 KiB
file samples during Grouping **Accept selected** instead of passing cached
candidate rows, serializing `LIMIT 1` group steps across `F_FULLFSYNC`
commits, evicting `no-store` thumbnails on virtualized scroll, and waiting for
job polling before updating React Query caches multiplied per-syscall RTT into
multi-second stalls.

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
