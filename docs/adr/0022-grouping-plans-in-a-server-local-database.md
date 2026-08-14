# ADR-0022: Grouping plans live in a server-local database, attached to each library

- Status: accepted (owner-directed 2026-08-14)
- Date: 2026-08-14
- Branch/PR: `feat/grouping-suggestion-review`

## Context

ADR-0008 puts a library's metadata inside the library package, so it travels with
the files. That is right for everything the library *is* — bundles, collections,
tags, ratings, notes, the write-mode journal. Grouping plans were put there too,
and they are the one thing it is wrong for.

A plan is a snapshot of a suggestion run (ADR-0009): generated from the library,
reviewed, applied, discarded. Nothing in it is a fact about the library that the
library does not already hold. Regenerating one is a single button.

Meanwhile it is by far the heaviest writer. A plan over the owner's library is
340 proposals and about 1,100 rows, rewritten whenever the input changes, and
touched again on every review keystroke — rename, reparent, convert, Narrow,
Widen. Their library database sits on an SMB share where a page read costs ~36 ms
against 0.021 ms locally. Two fixes had already landed (a 32 MiB page cache and
indexes on the grouping foreign keys, taking the plan write from over ten minutes
to 4.6 s), and 4.6 s was still the wrong number for pressing a button. The owner
asked for the storage to move.

The remaining cost was not a defect left to find. It is the shape of the problem:
about a thousand rows through a filesystem with millisecond latency, in a
transaction that has to be durable. Local disk removes it by construction.

## Decision

**The three grouping tables move out of `library.db` into a SQLite database on the
server's own disk, attached to every library connection as schema `plans`.**

1. `grouping_plans`, `grouping_proposals` and `grouping_proposal_files` are
   declared with `__table_args__ = {"schema": "plans"}`. They are a closed
   foreign-key island — every reference to library data (`asset_file_id`,
   `target_bundle_id`, `target_collection_id`, `base_bundle_id`) was already a
   plain id rather than a foreign key, precisely because a plan is a snapshot —
   so nothing has to be denormalized to move them.
2. `ATTACH` rather than a second engine and session. A plan is read *alongside*
   the library rows it describes; SQLite joins across attached databases natively,
   so `plan_store` keeps taking one `Session` and roughly twenty-five call sites
   stay as they are. A second session would have split every one of those reads
   into two queries and a join in Python.
3. The file is `<data_dir>/plans/<digest>.db`, where the digest is of the library
   database's resolved path. **Keyed by path and deliberately by nothing else.**
   The library id is the better name — plans would then survive a library being
   moved — but it is not known at every place that opens a library engine, and two
   openers disagreeing about which file holds the plans is a plan that silently
   vanishes. That was not hypothetical: it was the first version, and a test that
   reopened a library without the id caught it. One derivation everybody can
   compute beats a nicer one some callers cannot.
4. Where `<data_dir>` is depends on how Cairndex is running, and in every case it
   is the directory that already holds `registry.db` — so a plan is exactly as
   durable as the list of registered libraries, and no more:

   | | plans database |
   | --- | --- |
   | packaged desktop app (macOS) | `~/Library/Application Support/dev.cairndex.app/local-server/plans/` |
   | Docker / NAS | `/data/plans/`, on the `cairndex-data` volume |
   | local development | `apps/server/var/plans/` |

   None of these is a temporary directory, and that is deliberate. A plan is not
   purely derived: the *suggestions* are, but the review on top of them is not —
   renames, destinations, files dragged between suggestions, bundle/collection
   conversions, all recorded as `owner_edited` / `membership_edited`, and the whole
   reason `input_digest` exists is to stop a scan discarding them. A temporary
   directory would lose a review in progress on the next reboot, which is a
   regression against keeping plans in the library.
5. **Orphans are swept on a grace period, not deleted when a library leaves.** The
   file is keyed on a path, so it is orphaned by more than deregistration: moving a
   library gives it a new digest, and so does a symlinked mount that was offline
   when its digest was last computed. And deleting on deregistration made *remove
   and re-add* — which `test_delete_then_re_register_restores_the_same_library`
   documents as reversible — quietly destroy the owner's review.

   So `sweep_orphaned_plans` runs in the existing SQLite maintenance pass: a file
   no *registered* library claims, and that nothing has touched for a fortnight, is
   deleted. Registered, not owned — a library this server is not currently serving
   still has a right to the review left open on it — and a registered library keeps
   its plans however long it sits unopened. The most this can cost is a review
   abandoned for two weeks on a library no longer in the list.
6. It runs in WAL, unconditionally. ADR-0021 forbids WAL only where the
   filesystem cannot host it; this file is always on the server's own disk, and
   reviewing a plan is a long run of small writes.
7. **A library upgrading hands its plans over once.** `ensure_content_indexes`
   copies the rows into the local database and then drops the in-library tables,
   in that order and inside a savepoint, so an interruption leaves them where they
   were. It runs after the additive-column pass, so an old library's tables are
   brought to the current shape before being copied, and before the index pass, so
   no index is built on a table about to be dropped.

## Consequences

**A plan write stops being a network operation.** On the owner's library over SMB:

| | before ADR-0022 | after |
| --- | --- | --- |
| `persist_plan` (340 proposals) | 4,614 ms | **78 ms** |
| prune superseded plans | 1,431 ms | **12 ms** |
| one Narrow/Widen | ~1,000 ms | **66 ms** |

Those "before" figures already include the page-cache and index fixes; against
what shipped, the plan write was over ten minutes.

**A plan no longer travels with its library.** Carry the library to another
machine and the new server has no open plan — pressing Update writes one. This is
the trade, and it is the ADR's premise rather than a regret: a plan is derived
from the library, and a snapshot taken on another machine at another time was
never something to trust. It also means a consistent snapshot of a library
(`persistence/checkpoint.py`) no longer contains plans, which is correct for the
same reason.

**Cross-database atomicity is weaker, and the write order compensates.** SQLite
guarantees a transaction spanning two attached databases is atomic only when
neither is in WAL; a library is in WAL while served (ADR-0021), so this was
already true before the plans file existed. The exposure is a crash *during* a
commit that writes both — applying a plan. Library changes therefore commit
before the plan is marked applied, so the surviving failure is "the plan still
looks open after its changes landed", which the owner can see and discard. The
reverse — a plan marked applied whose changes are gone — would be silent.

**A library keeps its grouping tables' free pages.** The drop frees them inside
`library.db` rather than shrinking the file; SQLite reuses them. Not vacuumed,
because with a 32 MiB page cache a 6 MB database is entirely cacheable and the
free pages are never read — a VACUUM over a network share would be cost without a
measured benefit.

**New grouping columns no longer need an additive-list entry.** The plans database
is always created at the current shape by `create_all`. The existing `grouping_*`
entries in `_ADDITIVE_CONTENT_COLUMNS` stay, because they are what brings a
pre-ADR-0022 library's tables up to shape before the copy; once the copy has
happened they match no table and are skipped.

## Alternatives considered

**Keep the tables in the library and keep optimizing.** The two fixes already
landed had taken over ten minutes down to 4.6 s, and further levers existed
(fewer rows, coarser transactions, a write-behind cache). All of them trade
correctness or complexity for latency against a filesystem that will still be
milliseconds away. Rejected because the data does not belong on the far side of
that link in the first place.

**Plans in the registry database**, which is already local and WAL. Fewer files,
but it makes the registry — the thing that knows which libraries exist — the
hottest table in the system, and mixes per-library content with server state that
ADR-0008 keeps separate. A file per library also makes forgetting a library a
delete.

**A second engine and session instead of ATTACH.** Explicit about the boundary,
and it would preserve cross-database atomicity guarantees SQLite gives up under
WAL anyway. Rejected for the cost at the call sites: every plan read that resolves
a file path or a bundle title would become two queries joined in Python, in about
twenty-five places, for a boundary SQLite can express itself.
