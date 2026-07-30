# ADR-0008: Per-library metadata and a server-side registry

- Status: accepted (incremental implementation)
- Date: 2026-06-28
- Branch/PR: `feat/per-library-metadata`

## Context

Cairndex currently keeps **all** content metadata — bundles, files,
collections, tags, tag groups, smart collections, subtitles, import records,
scan state — in a single global application database (`{CAIRNDEX_DATA_DIR}/
cairndex.db`), and scopes browsing to a `StorageRoot` row inside that one DB.

The product direction (ADR-0007, and the owner's design discussion that led to
this ADR) is an **Eagle-like portable library**: a library is a directory
that carries its own metadata, so it can be moved, copied, or backed up as a
self-contained unit. At the same time Cairndex keeps a **Jellyfin-like
server/client** shape — browser/TV/mobile/native clients talk to one server,
and the server is normally the only process that writes metadata.

These two goals do not conflict, but only if we are precise about three distinct
kinds of "write" that the old single-DB model conflated:

1. **Metadata writes** — editing a title, adding a tag, moving a bundle into a
   collection. These go through the server API into a library's `library.db`.
2. **Physical file writes** — renaming/moving/deleting media on disk. Still
   out of scope (metadata-only milestones; AGENTS.md §2/§3).
3. **Native file opening** — a desktop client launching a file in a macOS app.
   This is a *client-local* action on a *local mount path*; it is neither a
   metadata write nor a server capability.

`AGENTS.md` constraints that apply: one source of truth for app metadata (§2.7);
never trust client-supplied absolute paths and validate against a configured
root (§12 / safety rules); do not run full scans or full hashes on the request
path; scale by design for multi-terabyte libraries.

## Decision

Adopt a per-library metadata store plus a separate server-side registry, rolled
out incrementally (see the phase plan). Concretely:

1. **A library is a directory** containing a `.cairndex/` marker:

   ```text
   <library-root>/
     .cairndex/
       manifest.json     # format, library_uuid, display_name, db, content_root
       library.db        # ALL content metadata for this library
       cache/            # portable derived cache (thumbnails/subtitles/…)
       locks/            # future: active-owner.json for direct-open mode
   ```

2. **All content metadata is per-library.** Bundles, files, collections, tags,
   tag groups, smart collections, subtitles, import records, and durable scan
   metadata live in that library's `library.db`. There are no global
   collections or tags.

3. **The server keeps a separate registry DB** at
   `{CAIRNDEX_DATA_DIR}/registry.db`. It tracks *registered libraries* (path,
   availability, schema state) and the server-runtime *job queue*. The registry
   is server-local infrastructure — it is **not** portable library metadata and
   never travels with a library folder.

4. **One library = one root directory** for now. Library-relative paths are
   sufficient inside `library.db`. Multi-root libraries are out of scope.

5. **Library context is routed by path:** `/api/v1/libraries/{library_id}/…`.
   There is no server-global "active library"; the active selection is a client
   concern. (Registry and job-status endpoints stay global.)

6. **Server-managed writes are the default mode.** Clients do not open
   `library.db` directly; they call the server, which opens the target library
   DB and performs the read/write.

7. **The registry owns the job queue.** Job rows carry `library_id`; the worker
   opens that library's DB to execute, writes durable results into `library.db`,
   and writes transient progress into `registry.db`.

8. **Native desktop is server-managed first (Mode C).** The desktop app gets
   metadata from the server API and opens files by mapping a server-relative
   path to a local mount path (path aliases). It does not own the DB.

9. **Direct-open standalone mode is future** and requires an active-owner lease
   (`.cairndex/locks/active-owner.json`). Documented here; not implemented.

10. **Clean break from current dev data.** No global-DB → per-library migration
    is written; pre-release dev data is discarded and rescanned.

This ADR **supersedes the single-global-DB assumption** behind ADR-0001/0002 for
content metadata. The schema and identity decisions in ADR-0002 still hold; they
now apply *inside each `library.db`* rather than to one global DB.

## Why per-library DB and server/client do not conflict

The library DB travels with the library folder, but at any moment a single
**active owner** (normally the server) is the metadata writer. Clients never
write the DB file directly; they send API requests, and the server serializes
writes through one engine per library. Portability (the file can move) and
single-writer safety (one process writes at a time) are orthogonal. Direct-open
desktop mode is the only case where a *non-server* process would write the DB,
and that case is explicitly gated on an owner lease (decision 9).

## Alternatives considered

- **Keep one global DB, scope by `storage_root_id`** (today's model) — rejected:
  metadata cannot travel with a library, backup/restore is all-or-nothing, and
  cross-library isolation depends on every query remembering to scope. The
  current sidebar already needs a scoping workaround that this removes.
- **Per-library DB with no registry; discover libraries by scanning paths** —
  rejected: the server still needs durable runtime state (job queue, last-opened,
  availability) that must not live in any one portable library file.
- **Let clients open `library.db` directly over a share** — rejected for the
  default mode: concurrent multi-writer SQLite over SMB/NFS is unsafe. Reserved
  for future direct-open mode behind an owner lease.

## Consequences

Easier: moving/backing up a library as one folder; natural per-library
isolation; a clean separation of portable metadata vs. server runtime state;
a clear path to the native desktop app without DB-ownership conflicts.

Harder / follow-up: a per-library engine cache and `library_id`-scoped routing
(replacing the single `get_engine()`); a registry DB with its own lifecycle;
migrating every content router under `/libraries/{id}`; collapsing the library
schema to drop `storage_roots`/`storage_root_id` (paths become library-relative);
relocating derived cache under `.cairndex/cache`; optimistic-concurrency
versions for server-mediated multi-client edits. These are sequenced across PRs
so no single change is unreviewable.

## Amendment (2026-07-30): the journal mode is part of portability

Decision 1 says a library is a directory you can move, copy, sync or mount, and
decision 6 says the server opens `library.db` on the user's behalf. Neither was
enough on its own: the server was setting `PRAGMA journal_mode=WAL` on every
connection, and WAL is recorded in the *file header*, not on the connection — so
serving a library from a machine with local access left the file in a state that
**no** machine reaching the same folder over SMB or NFS can open at all. A
library that only opens from one machine is not portable, whatever the folder
contains.

ADR-0021 restores the invariant: a library uses WAL while a server holds it open
and a rollback journal at rest. Read it alongside decision 1 — "everything a
user would miss lives in `.cairndex/`" now carries the corollary that the
package must stay *openable* wherever it lands.

## References

- ADR-0001 (stack and database choice), ADR-0002 (core schema/identity),
  ADR-0007 (File Browser host integration), ADR-0021 (journal-mode lifecycle —
  see the amendment above).
- AGENTS.md §2 (product principles), §3 (fixed decisions), §12 (safety rules).
