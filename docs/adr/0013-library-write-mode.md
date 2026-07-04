# ADR-0013: Library write mode — gate, trash-first deletion, operation journal

- Status: accepted (owner-ratified 2026-07-04)
- Date: 2026-07-04
- Branch/PR: `docs/client-platform-plans`

## Context

Cairndex has been strictly metadata-only: no create/rename/move/delete of
files under a library root. The owner has prioritized write mode as the next
major initiative after the core video player (plan 1), triggered concretely
by: saving generated exports (contact sheets/GIF snippets, plan 1 §10) into
the library and linking them to bundles/covers; maintaining disk organization
from File Browser (rename/move/new-folder/delete, long planned by the product
brief); and the desktop drag-in copy flow (plan 3 §6). Detailed design lives
in `docs/plans/04-library-write-mode.md`. Constraints: AGENTS.md path-safety
and job rules, ADR-0006 (moved-file repair preserves `AssetFile.id`),
ADR-0008 (portable library package), ADR-0010 (passphrase lock), and the
product anti-goal "destructive file management enabled **by default**"
(opt-in is acceptable).

## Decision

1. **Explicit opt-in gate.** Write mode is per-library, default **off**,
   stored server-side in the registry (`registered_libraries.write_mode_enabled`)
   — deliberately *not* in the portable manifest, so a copied library never
   carries write permission to a new server. A deployment master switch
   (`CAIRNDEX_WRITE_MODE=allowed|disabled`) can force read-only globally.
   Enabling re-prompts for the library passphrase when one is set. Write
   endpoints return a structured 403 when gated off.
2. **Trash-first deletion.** Deletes move files (same-filesystem rename) into
   the library package at `.cairndex/trash/{op_id}/…`; `AssetFile` rows gain
   a `trashed` availability state preserving ids, bundle membership, and
   cover/subtitle links so restore is lossless. Permanent deletion happens
   only via explicit Empty Trash / delete-permanently.
3. **Journaled operations.** Every write op records a `file_operations` row
   in `library.db` (pending → done/failed/undone): intent-before-action, a
   reconciler on library open completes or fails interrupted ops, the journal
   provides Undo, and scanner moved-file repair remains the backstop.
4. **In-app move/rename updates `AssetFile.relative_path` in place**,
   preserving `AssetFile.id` and all linked metadata by construction —
   extending the ADR-0006 invariant from repair-after-the-fact to
   app-initiated operations.
5. **No in-place overwrites; collisions get the Eagle/Finder prompt.**
   There is no filesystem truncate/overwrite primitive. Collision policy is
   `fail` (default) | `skip` | `suffix` ("keep both") | `replace`, surfaced
   in the UI as **Replace / Skip / Keep both** (+ Apply-to-all for batches).
   **Replace = journaled trash-then-write**: the existing file moves into
   `.cairndex/trash/` under the same op id before the incoming file takes
   the path, so Replace stays undoable until Empty Trash; a linked
   `AssetFile` at that path keeps its id (updated size/mtime/fingerprint,
   caches invalidated by the fingerprint change). The prompt covers **path
   collisions** only — content-duplicate detection remains deferred.
   Sources and destinations both pass the library-root validator
   (relative-only, traversal/symlink-escape rejection).
6. **Concurrency via the existing queue.** Single-item ops run synchronously;
   bulk ops run as a `file_ops_batch` job on the single-worker registry
   queue, naturally serialized with scans — no new locking infrastructure.
7. **Exports enter the library only through the write-mode `save_new` op**
   (`POST /exports/{id}/save-to-library`), creating a linked `AssetFile`
   (role `generated_derivative`/`cover`, optional `set_as_cover`) — closing
   plan 1 §10's open item. External-file import (upload) is the last slice
   and the only path by which outside bytes enter a library.

## Alternatives considered

- **OS/host trash (send2trash semantics)** — rejected: the server runs in
  Docker on NAS mounts where per-mount trash is unreliable, and an
  in-package trash travels with the library (ADR-0008 portability).
- **Hard delete with confirmation only** — rejected: unrecoverable; trash +
  journal makes every v1 operation reversible except explicit Empty Trash.
- **Write-enable flag in the portable manifest** — rejected: permission would
  leak to any server the library is copied to.
- **Undo without a journal (inverse-op only)** — rejected: no crash safety
  and no history; the journal gives both plus reconciliation.
- **A separate lock/mutex system for scan-vs-write concurrency** — rejected:
  the single-worker queue already serializes bulk work; simple ops are
  self-healing via atomic DB updates + scanner repair.
- **Destructive in-place overwrite for Replace** — rejected: Replace is a
  required UX (owner, matching Eagle's import prompt) but is implemented as
  journaled trash-then-write, never a byte-level overwrite, keeping every
  collision resolution recoverable.
- **Omitting Replace entirely (fail/suffix only)** — rejected by the owner:
  the Replace / Skip / Keep-both prompt is the expected interaction for
  imports and moves.

## Consequences

- AGENTS.md and CLAUDE.md safety wording ("never rename, move, overwrite, or
  delete original media during metadata-only milestones") must be amended in
  the W0 slice to "…except through explicit, journaled write-mode
  operations"; the metadata-only invariant remains the default posture for
  everything else (scans, grouping, playback, exports).
- `library.db` gains `file_operations` and a `trashed` availability state;
  File View gains write affordances and a Trash system view; deployment docs
  gain trash/backup guidance.
- The desktop drag-in (plan 3) and export-to-cover flows get real endings
  instead of dead ends.
- Test surface grows materially (validator, journal recovery, trash
  round-trips, EXDEV/case-only rename edge cases) — priced into plan 4's
  milestones.

## References

- `docs/plans/04-library-write-mode.md` (detailed design and milestones)
- ADR-0006 (scanner identity/repair), ADR-0007 (host integration limits),
  ADR-0008 (library package), ADR-0010 (passphrase lock), ADR-0012 (client
  platform strategy)
- `docs/product-brief.md` — File View long-term milestone; anti-goal is
  destructive file management *enabled by default*, which the opt-in gate
  respects
