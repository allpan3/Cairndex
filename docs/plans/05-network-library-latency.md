# Plan 5 — Network-library latency: Theater Mode and where the database lives

> Status: planning document (2026-07-28, owner-raised). **Deferred to
> post-v0.1.0** by the owner in the same session — recorded now because the
> diagnosis is expensive to re-derive, not because the work is queued. Nothing
> here is decided; §5 is the fork that needs an owner call and an ADR before any
> of it is built. See [README.md](README.md) for the overall build order.

## 1. The symptom, and why it is not a bug

Selecting a bundle on a NAS-mounted library leaves the inspector on `Loading…`
for ~500 ms, degrading to well over a second as the owner clicks through
bundles in quick succession. The owner's comparison: Eagle is instant on the
same network disk, so "is this a design philosophy / architecture issue?"

It is. Measured on the owner's library (`//nadir@nas-4800-nadir/tundra`, smbfs,
2026-07-28), a control probe against the same server on the same loopback
connection at the same moment:

    GET /api/v1/health                  5 ms     ← touches no library
    GET /…/bundles/{id}               387 ms     ← same server, same transport
    GET /…/bundles/{id}              1331 ms     ← after several rapid clicks

Both are sync endpoints sharing one AnyIO threadpool, so this is neither
queueing nor transport. The distinguishing factor is which database the request
opens — and the two databases live in different places:

    library.db   →  //nadir@nas-4800-nadir/tundra   (smbfs)
    registry.db  →  /System/Volumes/Data            (local SSD)

The same file, same schema, same connection pragmas, benchmarked in both
locations (a copy of the real `library.db`, never the original):

| | read p50 | **write p50** |
| --- | --- | --- |
| Local SSD | 0.00 ms | **0.01 ms** |
| SMB | 5.53 ms | **37.96 ms** |

Writes are ~3800× slower over SMB. Two things then follow:

- **Browsing writes.** `LibrarySession` is a transactional `yield` dependency
  that commits on *every* request, read or not; `GET /bundles/{id}/files` calls
  `reconcile_missing_files`, and selecting a bundle updates its cursor. The
  lease gate's own docstring already says it plainly: "Browsing already writes —
  bundle cursors, missing-file reconciliation."
- **It degrades rather than plateauing.** SQLite's WAL mode needs a `-shm`
  shared-memory file that network filesystems do not properly support. Each
  write leaves a longer WAL for the next reader to walk, and the background
  `SqliteMaintenance` thread checkpoints it across the same slow link.

## 2. Why Eagle is instant

Eagle keeps its **index local** and puts only **media** on the NAS. Clicking an
item reads a local database; the network is touched only when bytes are needed.

Cairndex does the opposite, on purpose. [ADR-0008](../adr/0008-per-library-metadata-and-registry.md)
puts metadata *inside* the library package so a library is portable: move the
folder and its bundles, tags, and collections travel with it; open it on another
machine and everything is there. [ADR-0018](../adr/0018-library-ownership-lease-and-local-server.md)'s
lease exists to protect exactly that property.

**That portability is what costs the 500 ms.** The trade was made deliberately;
what does not appear to have been weighed is that it makes every UI interaction
a SQLite transaction over SMB.

## 3. Theater Mode vs Management Mode (owner's framing, 2026-07-28)

The owner's names for the two ways a library can be used, and they are better
than "read-only":

- **Theater Mode** — watching and browsing. Nothing is written: no cursor
  updates, no reconciliation, no metadata edits, read-only sessions that never
  commit.
- **Management Mode** — organizing. What exists today: tags, ratings,
  collections, cursors, reconciliation, and (behind its own gate) file
  operations.

**This is not [ADR-0013](../adr/0013-library-write-mode.md) write mode.** That
gate protects *media* — create/rename/move/trash under the library root — and
every route carrying `WriteModeRequired` is in `file_ops.py` plus the two
destructive bundle routes. The writes costing 38 ms each are *metadata* writes
into `library.db`, which write mode neither gates nor could gate: they are the
app doing its job. Turning write mode off changes none of it. Theater Mode is
a second, orthogonal axis, and the two should not be conflated in the UI.

### The tension worth resolving first

The name says *watching* — and watching is the one activity with a legitimate
reason to write: **playback progress / resume position**. A Theater Mode that
forgets where you were in a film is worse than one that is 40 ms slower.
Options: buffer progress in memory and flush once on close/pause; keep progress
as the single sanctioned write; or write progress to a local sidecar and
reconcile later. Needs deciding before the mode is designed, since it decides
whether "nothing is written" is literal.

## 4. What Theater Mode alone buys

It removes the 38 ms writes. It does **not** remove the 5.53 ms reads, and a
bundle selection makes several. Expected landing zone: **~30–50 ms**, versus
~500 ms today.

That is a large improvement and still not "instant". Only moving the database
off the network reaches Eagle's feel. Theater Mode is worth having on its own
merits — a watching mode that provably touches nothing is a good product idea
independent of latency — but it should not be sold as the fix for this.

## 5. The fork (needs an owner decision + ADR)

1. **Local database, keyed by library UUID.** Eagle's model. Instant. Largest
   departure: a library folder alone would no longer carry its metadata, which
   is the ADR-0008 property the lease was built to protect.
2. **Local cache, NAS authoritative.** Read/write a local mirror; sync back on a
   timer and at close. Keeps portability *and* speed. The hard part is
   reconciliation after a crash — made tractable, but not trivial, by the lease
   already guaranteeing a single writer.
3. **Theater Mode + read-path cleanup.** §3 plus read-only sessions, deferred
   reconciliation, no cursor write on select. Cheapest, no storage-model change,
   ceiling ~30–50 ms.

Assessment at the time of writing: **2 with a slice of 3** matches the stated
goals — portability preserved, latency actually solved. Not chosen; the owner
deferred the decision past v0.1.0.

## 6. Before building anything

- Count the reads and writes a single bundle selection actually issues, against
  a NAS library. §4's ~30–50 ms estimate is arithmetic from the per-operation
  numbers, not a measurement of the real path, and it decides how much option 3
  buys on its own.
- Confirm whether `-shm` on smbfs degrades with WAL size or with elapsed time.
  The rapid-click degradation is consistent with both, and they imply different
  mitigations.
- Re-measure on a local library as the control. This is invisible on SSD
  (`registry.db` writes at 0.01 ms), which is why no earlier profiling caught it.
