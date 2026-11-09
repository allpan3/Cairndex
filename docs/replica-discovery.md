# Manual replica Update

Format-three libraries advertise `discovery_version: 1`. **Update** starts a
private, cancellable job against the serving server's library root. Normal
metadata exchange remains automatic. Earlier formats retain their existing
capabilities; old libraries use the [reviewed conversion workflow](replica-migration.md).

In the bundle browser, **Update** sits at the top of the sidebar. The sidebar says
when discovered files wait for review; that notice and **Review Discoveries…** in
the ⋯ menu open the review as a dialog. As v0.2.1's grouping review did, the
review also opens by itself when an Update this window started finishes and
leaves discovered files to decide; an Update that leaves nothing to decide only
reports its result. Metadata review keeps Update, Review discoveries and the
last run's status above its editors.

Creating a new library also schedules initial private discovery after its
workspace is ready. Its pending files remain available for review, without
opening the grouping dialog automatically. Registration and ordinary reopening
do not schedule a scan. Native creates retain their request across the server
switch, scoped to the intended server and library.

Before the catalog is ready, the workspace says **Preparing this library on the
server** and opens automatically when complete metadata arrives. This also
applies to an existing library on a new server. The working catalog, file
observations and media cache belong to the backend, not a browser. Browsers on
the same server share them; the desktop app's local server has its own copy.
Media probing and preview generation remain separate from Update.

The first Update on that server says **Initial library scan** and explains that
large libraries can take several minutes. Status exposes `initial_scan`, derived
from the absence of an earlier successful private discovery run. Cancellation,
failure and browser refresh retain this label; later runs use ordinary Update
progress. Older servers without this field retain the ordinary display. No
library-format or private-schema migration is needed.

Later Updates still enumerate the complete directory tree. They reuse unchanged
file fingerprints and keep confirmed bundles settled, while new and still
unbundled files remain eligible for grouping. If neither population needs
grouping, Update finishes without rebuilding the grouping index. Replacements
and ambiguous moves retain their separate review candidates. Incremental reuse
does not mean only added directories are visited.

On macOS SMB mounts, reconnecting can change the native device number and
invalidate every cached generation. Update still reads fresh fingerprints in
that case. It retains checked directory descriptors, opens leaves relative to
their held parents and overlaps at most sixteen source inspections per batch.
Unchanged enumeration metadata avoids a leaf open; a metadata miss always reads
content, even if a later SMB file stat returns the old generation. SQLite and
verified-evidence lookup stay on the discovery worker. All readers finish and
release their handles before a batch commits or fails. The 512-entry and 50 ms
scheduling bounds remain; draining pending network reads can exceed the time
target. Review, automatic repair and source operations retain their independent
validation. Local filesystems keep sequential inspection.

The footer names the current phase. Finding files reports the count found so far
with an indeterminate bar. Catalog checks, moved-file checks and grouping indexes
show completed/total with a determinate bar. Grouping and
preparing suggestions show their phase with an indeterminate bar. These are
phase totals, not a whole-Update time estimate. Counts commit with each worker
batch and restart from enumeration after interruption. Cancellation remains
available throughout.

## Review and identity

Update observes existing paths, repairs unambiguous external moves and proposes
new files using the existing grouping rules. Pending files and grouping suggestions
remain private until **Prepare selected grouping** and **Accept reviewed grouping**.
Servers without editable grouping retain the earlier candidate review controls.
Review can change title, destination, selection and order. Additions append to a
confirmed bundle without regrouping its existing members or replacing its cover.
Unambiguous video/subtitle additions create authored subtitle links. Collection
review includes selectable descendant groups and their required ancestors. A chosen
existing collection receives the selected subtree; additions preserve settled
collection membership unless placement is explicit. Accepted source receipts retain
unchecked siblings and remaining album files for later review. Remaining files from
a partially accepted group append to its settled bundle by default.

Candidate files, descendant groups, prepared sources and metadata values have
independent pages. Selection defaults to the complete candidate, with file/group
exceptions and order edits independent of the visible page. Existing explicit-list
drafts remain recoverable. Preparation exposes complete file/group counts, actual
collection placement and exact metadata before acceptance.

A successful automatic repair preserves the file ID, bundle membership, notes,
tags, moments, covers and subtitle relationships. It requires the original path to
be absent, unique matching evidence in both directions and an earlier local
observation of that same original catalog path. Receiving a peer's moved path
cannot authorize moving it back to an older local folder. Copies with a surviving
original are new files. Multiple matches, sample-only matches across different
physical files and identities with no prior local observation require explicit
review. Sample-only review states that complete equality is unproven.

Different evidence at a cataloged path requires an explicit replacement choice.
Competing accepted replacements expose **Review content identity** in the file
editor, with both retained evidence alternatives.
Detected replacement bytes cannot inherit that identity's playback state before
review. Local absence, incomplete reads and unavailable roots never delete shared
catalog entries. No discovery operation renames, moves, overwrites or deletes media.

## Editable grouping review

The private store now contains an editable draft graph, separate from immutable
candidate and prepared-review tables. Its API and lifecycle worker are wired;
the application opens its paged tree when `grouping_version` is at least 1.
Current qualification is recorded in [STATUS](STATUS.md). Its `grouping_*` tables
retain logical placement independently of
physical source directories, file selection, folder display choices, per-folder
stem levels and exact edit receipts. The revision counter guards concurrent edits;
it does not version the library format.

Rename and drag commands change private rows only. Narrow/Widen prepares bounded
planner pages for the chosen folder before replacing that folder's suggestions
atomically. Rebuilt bundles inside a retained collection take their titles from
their filenames, even when only one group remains. Widening a standalone bundle
keeps the folder as a collection rather than using its name for the widened
subject. The initial scan still uses the folder name for an ordinary whole-folder
bundle. Bundle-to-collection conversion splits video subjects with strict
sidecar matching within each source folder; repeated filenames in separate
folders remain independent. A one-subject subfolder keeps its folder title.
The inverse keeps file identities and folder display choices.
Cached regrouping now advances copying and planning by up to 32 steps or
50 ms per transaction, rather than committing each page or small subject
separately. Durable commits, the final atomic splice and reviewed acceptance
checks remain unchanged.
Recovery validates the graph and detects missing private decisions. Preparing a
graph exports its selected files, order and logical ancestors into an immutable
candidate, then uses the existing guarded discovery preparation and acceptance.
The graph stays frozen until its review is cancelled or accepted. Partial
acceptance removes only sources covered by that exact accepted receipt and
refreshes remaining staged bases only from its event and ancestry. Newer
competing edits remain stale for explicit review. Read-only collection context
keeps its captured name, lifetime and hierarchy bases.

The strict, paged API lives under `/replica/discovery/grouping`: workspaces,
revision-bound nodes/files/folders/stems, uncertain bundles, searchable move
destinations and idempotent edit commands. Opening a
workspace queues private initialization; request handlers never enumerate media.
The tree fetches only opened branches and requested pages and virtualizes its
visible rows. Loaded pages stay visible during edits, but controls wait until
fresh revision-bound pages arrive. Refresh restarts each loaded prefix with fresh
cursors, retaining later-page context without reusing stale page boundaries.
Expand all acts on loaded collections; its tooltip explains that later pages
remain explicit.
Show files also applies to newly requested pages, with individual folds retained.
Bundle rows summarize media kinds without downloading their file lists. Runs of
three or more matching sibling bundles fold into an expandable summary; uncertain
groups and existing-bundle additions remain individual. A run checkbox changes
only its displayed members, at most fifty per saved command. File drags temporarily
reveal individual targets without changing the Show files preference. Arrows
navigate from row controls as well as row whitespace; text editors retain their
normal keys. Rename keeps the clicked caret position. F2 renames from a row or
its controls; Enter renames only when the row has focus. Right-click or Shift+F10 opens the row
menu for rename, conversion and movement. The kind icon also converts the row.
Narrow/Widen appears only on the row representing a matching source folder.
File and proposal drags, keyboard move choices, file ordering and persisted
collection placement all change private draft rows only.

The need-a-look toggle appears only when suggestions are uncertain and pages them
across the complete draft, including folded branches. Filtering never changes
what Accept selects. The side view keeps identity repair, replacement and saved
prepared reviews reachable. Its category filter runs before server pagination.
Earlier grouping choices opens candidate drafts made before the editable tree.

Servers advertising `grouping_version: 2` show **New files for existing bundles**
above **New bundles and collections**, as title headings with their rows indented
one level inside them. Both populations are filtered before
pagination. Collection counts and branch checkboxes cover only that tree;
Select all and Select none cover both
sections. Moving an addition into its own display section changes no accepted
collection membership. Headings have no checkbox: each addition is selected on
its own, or with global Select all/none. Older servers
retain their mixed tree. Full-content verification remains optional; its tooltip
explains that it reads every byte.
**Other drafts** appears only when another draft or page is available. The side-view
entry names the available work: File changes, Saved reviews, or both. Ordinary
grouping candidates remain reachable through Earlier grouping choices. The file
change query filters before pagination. Reopening waits for a fresh draft list
and opens the latest completed Update, even when an earlier draft retains
selected files or a prepared review. Earlier drafts keep their choices under
**Other drafts**. They show an earlier-Update notice and **Open latest Update**,
because their original file observations may no longer match after source
changes or an SMB remount. Switching drafts does not refresh their observations
or bypass source validation. Longer explanations are available on demand.

![Synthetic grouping review with additions above new suggestions](screenshots/grouping-review-sections.png)

The synthetic example keeps an addition to an accepted bundle above the new
collection suggestions. Changing their display does not move source files.

### Initial Update timing

In the final full-server browser run, Update took 283.481 seconds and the review
was editable 290.964 seconds after the click. The earlier run took 592.386 and
633.314 seconds respectively. Review initialization therefore fell from 40.928
to 7.483 seconds. The dialog opened automatically, kept Prepare disabled while
building, then enabled it. Both runs used the same 9,000-file synthetic copy and
one-second status polling. These local VM runs do not establish NAS performance
or parity with the older application's different scan/review pipeline.

The November follow-up also measured initial Update on a fresh copy of 9,000
synthetic files, of which 8,707 were supported. The production loop took 76.290
seconds before and 39.586 seconds after the reader and export repairs in Cairndex
macOS. Walking fell from 21.534 to 8.142 seconds; export fell from 27.866 to 7.273
seconds. These runs include profiling overhead and status reads, but exclude
browser polling and exchange scheduling.

Enumeration shares one read snapshot per batch, capped at 512 directory entries
or 50 ms of source work; hidden and unsupported entries also consume that budget.
Catalog checks use the same bounds and existing indexes for stable file paging.
Their progress cursor advances only through processed files, in the same durable
transaction as the observations. Cancellation discards an uncommitted source
batch, and interruption rolls back the complete catalog batch. A slow source
operation or commit can exceed the time target. Ordinary bundle
exports select that bundle directly; collection exports retain all descendants.
Each export page resumes from the last committed group and member instead of
numbering the complete candidate again. Candidate order, complete checksums,
retry boundaries and writer durability are unchanged. The batching regression
checks every exported member against the complete ordered stream.

Update now advances up to 32 bounded steps or 0.25 seconds before the next
exchange pass. Initial review construction batches cached pages within one
transaction, capped at 32 steps or 50 ms. It performs no source I/O and rolls
back the entire batch on failure, retaining the last committed cursor for retry.

### Established-library Update timing

The isolated macOS browser comparison on 2026-11-03 reduced unchanged Update
from **26.453–27.396 seconds to 4.228–4.896 seconds**. The median fell from 26.570
to 4.585 seconds, about 83% less waiting. Ten new generated PNGs took 5.288
seconds, with editable grouping review ready at 6.929 seconds. These results
describe an established library with confirmed groupings. Unreviewed files can
still add substantial grouping work on later Updates.

| Operation | Before (seconds) | After (seconds) |
| --- | ---: | ---: |
| Register on a fresh server until the settled fixture is available | 44.221 | 42.741 |
| First local file scan of that existing library | 34.539 | 7.390 |
| Unchanged Update, run 1 | 27.396 | 4.585 |
| Unchanged Update, run 2 | 26.570 | 4.896 |
| Unchanged Update, run 3 | 26.453 | 4.228 |
| Update after ten new images | 27.696 | 5.288 |
| Same addition run through editable review | 29.322 | 6.929 |

A worker-only profile before the repair spent 8.327 seconds committing SQLite
transactions and 5.028 seconds closing connections, out of 17.385 seconds.
Inspecting all 8,911 eligible sources took 0.536 seconds. Enumeration and catalog
checks used about 600 small transactions. The repair amortizes those durable
writes, uses existing indexes for catalog paging, avoids unchanged baseline
writes and omits grouping-index construction when there is nothing to group.
The profile excludes browser polling and metadata-exchange scheduling; its
timings are not directly comparable to the browser table.

The copied synthetic fixture contained 9,285 visible physical files and 9,018
catalog file entries. Its 120 provisional bundles were confirmed before timing,
leaving 2,389 confirmed bundles and no Unbundled files. The admission snapshot
reported one missing-file indicator before and zero after. Each unchanged scan
in both measurements observed 8,911 eligible files,
produced no pending candidates and repaired no links; additions raised the
observed count to 8,921. Every click was matched to its newly returned operation
ID, with one-second status polling. Copying, fixture confirmation and server
startup are excluded. Registration, first scanning and later Updates are timed
separately on one persistent private server store.

Receipts `repeat-update-isolated-1793707474675` and
`repeat-update-isolated-1793709317712` retain the before/after per-phase timings,
fixture counts and synthetic review captures. The latter exercised the source
subsequently committed and checked byte-for-byte as `558f63ad`.
Other qualification work was idle during these measurements.
An earlier run during concurrent qualification measured 84.118 seconds for an
unchanged Update and 30.386 seconds for ten additions; the isolated repetitions
avoid treating that timing variation as steady everyday cost. These few local
VM runs do not predict NAS or representative-media performance. The earlier
9,000-file initial measurement above used an unorganized library and built its
grouping suggestions; it is a different workload.

### SMB reconnect Update timing

On a disposable macOS-to-Samba share, three cold-remount production-worker
runs took **2.431–2.638 seconds**, compared with **19.545–20.436 seconds**
before this change. Each run scanned the same 256 synthetic 512 KiB files in
eight directories, using a settled private catalog. The share was remounted
before every run and the implementation order alternated.

| Run | Previous worker (seconds) | Bounded parallel worker (seconds) |
| --- | ---: | ---: |
| 1 | 19.545 | 2.638 |
| 2 | 20.436 | 2.587 |
| 3 | 20.098 | 2.431 |

All six runs read the same 48 MiB of samples through 256 file opens and 768
reads, retained equal evidence and produced no candidates or repairs. Directory
opens fell from 529 to 9; observed concurrency reached sixteen. The production
512-entry/50 ms bounds were unchanged. These calls exercised the complete
discovery state machine, including catalog checks, durable commits and status
reads. They exclude background scheduling, history exchange, browser polling
and media probing. They are not owner-NAS or end-to-end browser timings.

A further server-side edit while the client share was unmounted changed one
sampled byte without changing file size or mtime. Both workers detected exactly
one replacement candidate; the updated worker took 2.637 seconds. This does
not extend sampling's ability to detect edits outside its sampled regions.
The `smb-update-mac-20261104` receipt retains the harness, observations and raw
results; its earlier failed metadata-cache prototypes and traversal-only probe
are separate evidence. Neither native ctime nor Samba FileId/ChangeTime is
accepted as cross-remount content proof on its own; a copied file's recorded
samples are (see *Evidence and limits*).

### Conversion timing

Synthetic local-disk measurements in Cairndex macOS compare one fresh run per
size before and after batching. They include private worker transactions and
status reads, but exclude UI polling, the worker's scheduling pause and shared
metadata transport. Every subject has one generated video-shaped file and one
subtitle-shaped file; no decoder or owner data is involved.

| Selected files | Bundle to collection, before / after | Durable worker steps, before / after |
| --- | ---: | ---: |
| 4 | 0.244 / 0.082 s | 13 / 3 |
| 200 | 5.190 / 0.211 s | 221 / 9 |
| 420 | 9.891 / 0.724 s | 454 / 17 |

The reverse conversion takes about 0.06 / 0.13 / 0.32 seconds for those sizes.
These timings establish the cached-planner improvement. A separate real-server
browser run on the same VM measured 1.549 seconds for collection to bundle and
3.691 seconds for the 200-file reverse conversion, from clicking until the saved
summary and controls returned. Assertions polled every 50 ms. Before Update
batching, its 203-file Update took 44.323 seconds, followed by 6.362 seconds to
reopen and initialize review.

A separate in-process 200-file Update measurement fell from 10.986 to 1.264
seconds after cached indexing, grouping and export shared a bounded transaction.
Write transactions fell from 355 to 29; filesystem enumeration, known-file
validation and repair retained their existing boundaries. Both runs use 100
synthetic video/subtitle pairs, include status reads and exclude worker pauses,
UI polling and metadata transport. These single local runs do not establish
network-share or media-probing cost.
The real-server 203-file browser journey passes after this change: Update takes
8.713 seconds and review initialization 7.558 seconds. The same run measures
1.882 seconds to merge and 3.125 seconds to split its 200-file grouping. Selection,
accepted identities, collection placement and unchanged source bytes are checked.

Optional complete-content verification operates on the immutable exported graph
before review preparation. Its byte progress and cancellation remain available
after reopening the dialog. Cancelling verification or returning from a prepared
review retains the editable draft. A newer Update does not discard earlier
retained grouping choices; the owner can choose that run explicitly.
Recovery pauses queued and running grouping edits with their original phase,
cursor and intent intact. Resume retained grouping edit retries that exact
operation. Merely reopening a recovered library never submits the edit.

## Evidence and limits

An ordinary scan touches at most three 64 KiB regions per file. Files up to 192 KiB
receive a complete SHA-256; larger files initially receive `sample-sha256-v1`.
Samples cannot detect changes outside those regions or prove equality of independent large copies.
Automatic sampled repair also requires the earlier local device/inode identity.
Generation-bound local resume follows a verified repair; a manual sample-only
identity assignment does not transfer old progress to a different physical file.

A file change's action in Update's review (**Check and Restore**, **Check and
Link**, **Use New Content**) explicitly queues full SHA-256 reads for its immutable
candidate when samples alone cannot prove it, then prepares and accepts the
reviewed change; the server revalidates the file at each step. The worker reads 1 MiB blocks, yielding after at most 8 MiB or roughly
50 ms of reads. Byte progress and cancellation remain private. Complete receipts
survive cancellation; an interrupted file restarts from byte zero. A pinned
source descriptor and a final path/generation check reject files changed during
hashing. Reading a full file is never part of a request handler or ordinary scan.

Complete identities derive from library/epoch, path and evidence, so independently
verified identical large copies can share a file ID after reviewed acceptance.
Unverified large-file IDs are random and persist in a private path/evidence mapping.
A full-evidence identity observed through local samples requires verification;
matching samples alone cannot establish equality. One same-path exception, accepted
by the owner on 2026-11-08: a file copied in by Cairndex keeps, beside its complete
hash, the samples read just after publication (and a completed verification keeps
the samples it compared). When the samples, inode and mtime are unchanged, the
complete hash still covers the file. The device number is not compared, because
macOS numbers a network share anew on every mount, which changes every generation.
This is at least the assurance a sampled file already has; an edit outside the sampled
regions that keeps size, mtime and inode goes unnoticed until verification.
Copies made before this change have no recorded samples and need one verification.
Retained samples find possible
moves of previously verified files, with complete evidence checked before repair.
Independent large discoveries and same-path different contents retain explicit causal identity conflicts with a
valid local display. Group IDs derive from selected file IDs. Initial group/file
timestamps use the earliest selected source modification time: preserved copied
mtimes converge, while different mtimes can produce ordinary timestamp conflicts.
Timestamps never establish ancestry or authorize a move.

Enumeration yields every 32 entries, including ignored hidden/symlink entries.
The worker starts its next pass after 25 ms while a run, review, verification,
grouping edit, catalog job or unpublished event is queued, and after 1 second when every open
library is idle. Each pass keeps the bounded steps, so Release drains promptly.
Private disk-backed planning indexes every fresh source and settled catalog owner
before classifying complete directories. Assignment and role work advances in
32-file batches; worker batches never split bundles or omit later-page owners.
Cached indexing, grouping and candidate export share one transaction for at most
32 steps or 50 ms. Phase and cursor updates commit with those rows. Failure rolls
back that batch; cancellation takes effect between batches. This reduces durable
flushes without changing SQLite settings or moving filesystem work into the batch.
Preparation stages selected files, relationships and original causal bases in
private tables and emits complete linked catalog payloads. Final catalog validation
and activation are atomic operations; complete membership/forest units and the
final source-generation check may take longer than a batch. No measured
multi-terabyte readiness claim is implied. Continuous watchers, provider hydration
and directory-browser pagination remain outside this workflow.

## Private work and recovery

Still-unconfirmed catalog files remain eligible for grouping. Their fresh local
observations carry the existing file ID and opening path, lifetime and membership
bases. Preparation refuses a later confirmed boundary or changed arrangement.
Acceptance moves these existing identities through disk-backed arrangements,
including dependent moments and subtitle selections, rather than creating new
file rows. A complete provisional source can supply the resulting bundle's ID,
notes, rating and other metadata. Empty sources with independent notes, ratings,
extra metadata or collection/tag membership cannot be silently removed; keep them
as separate groupings. Existing selected covers and subtitle choices survive.
Only newly discovered files receive new identities. The same reviewed catalog
validator and exact retry receipt cover the complete change.

Progress, errors, observations, missing-file candidates, grouping drafts, identity
mappings and exact prepared reviews live in the private DB. Completed scans
supersede obsolete suggestions while retaining their bodies and saved drafts.
Cancelled or failed work retains already committed repairs. A failed or cancelled
walk cannot publish a repair; a restarted walk discards its partial observations.

Preparation captures source generations and causal bases. Acceptance revalidates
sources in pages, checks their generations again immediately before committing,
and commits authored changes and the private receipt atomically. An exact
retry retains its original preview and never silently takes newer bases. Competing
offline choices become catalog conflicts; a competing grouping received before
acceptance can instead fail safely while retaining the full private preview.
Closing/reopening review, switching libraries or refreshing the catalog preserves
private drafts. Invalid browser draft bytes are retained with a visible error.

[Private recovery](replica-recovery.md) includes every discovery table and validates
candidate shapes, identities, causal references and acceptance receipts. Restored
observations require local revalidation. **Saved discovery reviews** retains the
original selection and preview. **Revalidate saved review** checks that exact intent
without submitting it. Changed source generations require Update and a fresh
review; unchanged sources can be explicitly accepted after revalidation. Nothing
recovered applies itself. Normalized candidate members, group context, staged
values, linked preview parts and accepted-source receipts are included in recovery.
Recovered full-verification jobs require explicit retry; complete cached receipts
become trusted only after local generation checks. Incomplete hash accumulators
are rebuilt. Older backups missing whole additive discovery families remain
supported; partial or unknown schemas require an upgrade.

## API

All routes are under `/api/v1/libraries/{id}/replica/discovery`:

| Route | Behavior |
| --- | --- |
| `GET /status` | Latest private job state, phase, observed/repaired counts and error |
| `POST /runs` | Enqueue with a stable operation ID; repeated active requests reuse the run |
| `DELETE /runs/{id}` | Cancel future worker steps |
| `GET /candidates` | Paginated pending suggestions |
| `GET /candidates/{id}/files`, `GET /candidates/{id}/groups` | Page through complete sources and descendant/ancestor context |
| `GET /candidates/{id}/choices` | Page through every missing-identity choice; retain the selected label independently |
| `POST /reviews` | Queue complete selection preparation or exact-intent revalidation |
| `GET /reviews`, `GET /reviews/{id}` | Saved reviews, durable progress and exact compact preview/receipt |
| `GET /reviews/{id}/pages/{kind}` | Page through prepared `files`, `groups` or metadata `changes` |
| `POST /reviews/{id}/accept` | Queue acceptance of the exact receipt |
| `DELETE /reviews/{id}` | Cancel an uncommitted review while retaining its bytes |
| `POST /verifications` | Explicitly queue full-content verification of a candidate |
| `GET /verifications/{id}` | Read file/byte progress and retained errors |
| `DELETE /verifications/{id}` | Cancel future reads while retaining completed evidence |

HTTP handlers never enumerate media or apply grouping. Discovery shares the
existing replica worker and Release drain; its private state never enters metadata
transport. [ADR-0032](adr/0032-replica-discovery.md) defines the capability boundary.
