# Performance baselines (large libraries)

Cairndex targets multi-terabyte libraries with large item counts, so the
browse/query paths must stay fast as a library grows, and the media jobs that
walk every file must not scale with how expensive each one is to decode. This
document records the tooling used to measure both and the changes the
measurements justify — targeted indexes and one query rewrite for the query
paths, keyframe sampling for storyboard generation. Re-run the tools after
schema, query, or media-pipeline changes and update the numbers.

## Portable catalog synthetic checkpoint

On local macOS APFS, a complete synthetic catalog contains 10,000 bundles.
These measurements use current private catalog queries, 20 repetitions per query,
and warm/uncontrolled OS caches. They are in-process query timings, not HTTP or
end-user latency guarantees. The generated catalog has no playable-media claim.

| Check | Median | Maximum |
| --- | ---: | ---: |
| First browse page | 22.19 ms | 29.49 ms |
| Full-catalog text search, one match | 1.68 ms | 1.87 ms |
| Collection filter, one match | 12.14 ms | 20.79 ms |
| Last browse page | 33.45 ms | 37.19 ms |

Synthetic seed preparation takes 12.39 seconds; private store reopen takes 8.25 ms.
One hundred sequential authored edits take 0.42 seconds. Controlled reverse-order
in-process delivery of their retained artifacts settles the final causal edit in
7.33 seconds. The private database is about 195 MiB. This measures bounded metadata
cardinality, not provider transport, network backlog, cold startup or large media.
The [storage matrix](storage-qualification.md) records independent generated-media
and source-operation evidence and the remaining scale limits.

## NAS playback checkpoint

The [2026-09-16 NAS checkpoint](nas-verification.md) uses a non-root Linux
production container with a four-core CPU quota and 3 GiB memory, accessed from
a Mac over the existing LAN. Synthetic clips are 180 seconds at 1280×720/30 fps:
H.264/AAC MP4 at about 3.5 Mbps, the same streams remuxed into MKV, and MPEG4/MP3
AVI at about 7 Mbps. Direct playback is enabled for the directly playable clip.

Each Chromium run uses a fresh browser context and app session, observes decoded
pixels, performs forward/backward seeks and samples progression 13 times over
approximately 60 seconds. All 13 image hashes differ for every path. Sources
were generated/read earlier; OS/NAS caches were not flushed or proven cold.
These are individual observations, not latency percentiles or service budgets.

| Path | First picture | Forward seek | Backward seek | Media / wall progression |
| --- | ---: | ---: | ---: | ---: |
| Direct | 478 ms | 874 ms | 872 ms | 60.097 / 60.098 s |
| Remux | 387 ms | 871 ms | 869 ms | 60.380 / 60.093 s |
| Transcode | 1,512 ms | 2,879 ms | 2,876 ms | 60.094 / 60.096 s |

The isolated production native app shows decoded synthetic pictures on all
three paths, forward/backward seeks and hands-off progression. Direct advances
about 74 seconds over 74.4 seconds; remux advances about 113 seconds over 113.7
seconds and reaches normal EOF. Transcode advances about 83 seconds over 85.5
seconds including seek recovery. Partial native diagnostic exports are truncated
and do not establish complete stall histories. The final rebuilt app also passes
a direct-play picture/resume and connected metadata-refresh smoke check.

Two read-only representative sources decode and seek in the browser. The heavier
HEVC transcode does not maintain uninterrupted real-time progression during the
sampled minute. No conclusion attributes that solely to CPU quota. Exact owner
media characteristics and measurements remain in private receipts. Representative
owner media is not qualified in the native app.

Two browser clients complete retained-draft conflict resolution and refresh on
plain LAN HTTP; browser/native edits also propagate visibly. Peer-search checks
show responsiveness but their timing did not await search completion, so no
search-latency claim is made. This checkpoint does not qualify multi-terabyte
scale, every quality/device, broad concurrency or fully cold storage.

## Installed desktop playback checkpoint

The 2026-09-23 check uses the installed production client at `15a227dc`, the
matching source backend on the same Mac, and fresh synthetic media in a temporary
library. It does not use an alternate desktop shell. Source files are generated
from ten-second `testsrc2`/sine seeds, encoded with VideoToolbox and stream-copied
into 300-second MP4s. Both tested HEVC sources use Main 10, `hvc1`, 4:2:0 and AAC.
External EN/FR SRT fixtures contain an eight-second numbered cue every ten seconds.
The 1080p/30 source is about 230 MB at 6.1 Mbps; the 4K/60 source is about 908 MB
at 24.2 Mbps. These are synthetic stress inputs, not representative scene-quality
or multi-terabyte-library benchmarks. No operating-system cache is flushed.

| Check | Observed result |
| --- | --- |
| 4K direct startup | First presented-frame event at 372 ms; decoded dimensions 3840×2160 |
| 4K direct progression | 86.533 s at 87.510 s of journal time; no error or wait after startup; 53 dropped frames reported |
| Restart resume | Persisted position 125.001 s; loaded metadata and completed seek report 125.001 s; first presented frame at 125.127 s |
| Rapid paused seeks | Commands to approximately 240, 30 and 120 s settle at 120.001 s in 529 ms after the final seek event; pause remains set |
| Subtitle timing | Visible cue matches the final 120–128 s interval; off/on and forward/backward seeks preserve one active default track |
| 1080p HEVC native remux | 82.522 s at 83.385 s of journal time; no error, post-start wait or reported dropped frames |
| Remux to 720p transcode | Replacement remains paused at 60.004 s and decodes at 1280×720; subtitles remain active |
| Transcode completion | UI reaches 5:00/5:00; stored position and duration both 300.019271 s with completed=true |

These are individual observations, not latency percentiles. Picture inspection
is separate from frame counters. The final long diagnostic export is truncated
by accessibility capture, so full-interval stall/frame counts are unavailable.
No general smoothness, cold-cache, NAS bandwidth, provider, background-presentation
or owner-media qualification follows. External subtitle language selection has
no user-facing chooser; this check covers the default/first track and visibility.
Embedded/advanced subtitle formats and output-audio quality are not tested.

The temporary server, registry, library and generated media are removed. The
saved test connection is removed and the previous remote address is restored.
No production service, source media or authored owner metadata is changed.

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

- **`benchmark_queries`** — opens a library ownership-checked maintenance and times the hot paths
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

## Browser and thumbnail-concurrency audit (2026-09-14)

This audit used disposable synthetic libraries on an Apple Silicon laptop with
local SSD storage. Query timings are repeated in-process service calls after the
library is open; the browser checks used the Vite client over loopback against
one uvicorn worker. They do not measure NAS latency or native desktop startup.

### Current metadata scale

The current query benchmark used one to five files per bundle. Values are
medians in milliseconds; each column names its sample count.

| bundles / files | samples | browse first | deep page | view counts | collection counts | Smart preview |
| --------------- | ------: | -----------: | --------: | ----------: | ----------------: | ------------: |
| 1,000 / 2,981 | 100 | 6.73 | 7.09 | 5.78 | 1.04 | 5.41 |
| 10,000 / 30,060 | 200 | 23.97 | 28.42 | 46.34 | 15.13 | 12.87 |
| 100,000 / 300,066 | 20 | 235.08 | 290.57 | 535.81 | 585.44 | 118.84 |

At 100,000 bundles, direct collection and tag filters remained at 5.49 and
3.74 ms. Including descendants raised those medians to 116.04 and 307.06 ms.
These results qualify metadata queries only: the 100,000-bundle fixture has no
source media and was not rendered as a 100,000-item browser UI.

With a warm server and 24 real synthetic 1080p H.264 videos, five browser
reloads reached a visible catalog card in 194, 201, 249, 308 and 325 ms
(median 249 ms). The browser visibly opened the 24-item collection, narrowed a
search to one item, decoded changing video frames and received an edit made by a
second client while the viewer remained open. Automation elapsed time is not
used as application latency; only the locator-ready reload samples above are
timed.

### Large thumbnail job memory

A 100,000-bundle library contained 235,204 eligible thumbnail files. With media
generation stubbed so the measurement isolates enumeration, retaining every ORM
row raised peak RSS by 496.2 MiB and took 3.738 s. Enumerating IDs in 256-row
keyset pages raised peak RSS by 48.4 MiB and took 1.806 s. Progress still reports
every 20 files. Both measurements ran in fresh processes and used macOS peak-RSS
accounting.

### Concurrent cold thumbnails

The contention workload issues 48 simultaneous requests: two clients each ask
for the same 24 cold video covers while another thread continuously probes the
browse endpoint. Cache artifacts are absent at the start of each compared run;
ffmpeg generation is real. All thumbnail responses were 200.

| measure | before | bounded and deduplicated |
| ------- | -----: | -----------------------: |
| thumbnail wall time | 2.824 s | 1.432 s |
| thumbnail p50 / p95 / max, 48 requests | 2304.5 / 2813.0 / 2817.8 ms | 1325.8 / 1424.9 / 1429.1 ms |
| browse p50 / p95 / max | 82.7 / 111.5 / 2372.2 ms (5 probes) | 10.5 / 18.7 / 62.1 ms (37 probes) |

Identical cold requests now share one OS-locked generation and recheck the cache
after acquiring the lock. ffmpeg writes a temporary artifact that atomically
replaces the destination. At most two thumbnails encode simultaneously, and at
most four lazy media requests enter the shared worker pool, leaving request and
database-session capacity for browsing, edits, playback and job control.

As a separate warm-cache control, ten consecutive rounds produced 480 successful
thumbnail responses in 1.046 s. Thumbnail p50/p95/max was
82.3/106.6/127.9 ms; 17 concurrent browse probes measured 40.8/70.5/93.4 ms.
This sustained ten-round workload records warm behavior and is not the paired
comparison for the single cold batch above.

### Same-library worker recovery

Two browser clients also shared a 2,026-file synthetic library during Update.
The scan durably staged 2,002 new provisional bundles and one grouping proposal;
the metadata worker remained searchable and visibly cancellable. Cancellation
completed at 1,750/2,026, no job remained active, and reload restored the 24
confirmed bundles plus 2,002 unbundled provisional files. The concurrent title
edit, all source bytes, SQLite integrity and foreign keys remained intact.

That local audit does not qualify a production desktop build, remote browsers, network
mounts, multi-terabyte source media, provider replicas or NAS deployment. Folder
pagination and the slowest 100,000-bundle aggregate/descendant queries remain
future measurement-driven work rather than changes in this fix.

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

### Maintenance ownership

The query benchmark acquires an independent lease before opening SQLite and
refuses a live holder without changing database, journal, sidecar, lease or local
plan files. It never confirms stale takeover. Release the library on its server
before benchmarking. Successful runs can change journal and local-plan state;
this is maintenance, not mutation-free inspection. Cleanup closes SQLite while
still owning the library, then releases. Failed cleanup leaves recovery state
and does not advertise a clean handoff.
