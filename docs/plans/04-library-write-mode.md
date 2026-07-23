# Plan 4 — Library write mode (guarded file operations)

> Status: planning document (2026-07-04, owner-prioritized: **the next major
> initiative after the core video player**, ahead of the desktop/TV clients).
> Decisions ratified in [ADR-0013](../adr/0013-library-write-mode.md)
> (accepted 2026-07-04). See [README.md](README.md) for the overall build
> order.

## 1. Why now, and what it is

Write mode is the deliberate end of the "metadata-only" era: Cairndex gains
the ability to **create, rename, move, and trash files inside the active
library root** — never outside it — behind an explicit opt-in gate. The
product brief always planned this ("File Browser grows into a true filesystem
browser with guarded write actions"); the immediate triggers are:

- saving generated exports (contact sheets, GIFs — plan 1 §10) into the
  library and linking them to bundles / using them as covers;
- File Browser rename/move/new-folder/delete, so disk organization can be
  maintained *from* Cairndex instead of around it;
- the desktop drag-in flow (plan 3 §6) eventually copying external files in.

The core product advantage worth stating up front: **when Cairndex performs
the move/rename itself, no repair is ever needed.** The filesystem operation
and the `AssetFile.relative_path` update happen together, `AssetFile.id` is
preserved by construction, and every bundle/tag/collection/cover/subtitle/
cache link survives — strictly better than external moves + scanner repair
(ADR-0006), which remains the backstop for changes made outside the app.

Scope boundaries (v1): operations on paths **inside the active library root
only**; no in-place overwrites (Replace is trash-then-write, §3.3) and no
in-place content editing; no arbitrary host
command execution (ADR-0007 unchanged); collection-cascade physical deletion
excluded; scheduled/automated writes excluded — every operation is
user-initiated.

## 2. The write-mode gate

- **Per-library opt-in, stored server-side in the registry**
  (`registered_libraries.write_mode_enabled`, default off) — deliberately
  *not* in the portable manifest, so copying a library to a new server never
  carries write permission with it.
- **Deployment master switch** `CAIRNDEX_WRITE_MODE=allowed|disabled`
  (default `allowed`, meaning per-library toggles work; `disabled` forces
  read-only regardless — for hardened/shared deployments).
- Enabling requires an unlocked session; when the library has a passphrase
  (ADR-0010), enabling **re-prompts for it** (a one-time re-auth, not a new
  session model). The Library Manager UI shows the toggle with a plain
  explanation of what it unlocks.
- Every write endpoint checks the gate and returns a structured
  `403 write_mode_disabled` when off; the UI greys write actions with a
  tooltip instead of hiding them.

## 3. Safety architecture

### 3.1 Operation journal

New table in `library.db` (portable — the history travels with the library):

```sql
file_operations(
  id          TEXT PRIMARY KEY,      -- ULID
  op          TEXT NOT NULL,         -- rename|move|mkdir|trash|restore|save_new|import
  status      TEXT NOT NULL,         -- pending|done|failed|undone
  payload     TEXT NOT NULL,         -- JSON: src/dest relative paths, file_ids, options
  error       TEXT,
  created_at  TEXT NOT NULL,
  finished_at TEXT
)
```

Protocol per operation: **(1)** insert `pending` row and commit → **(2)**
perform the filesystem operation → **(3)** update content rows
(`AssetFile.relative_path`, availability, links) and mark `done` in the same
transaction. Crash between (2) and (3) leaves a `pending` row; on next
library open a reconciler checks the filesystem (src gone + dest present →
complete the metadata side; neither → mark `failed`). The scanner's
moved-file repair remains defense-in-depth: even a lost journal entry looks
like an external move and heals with `AssetFile.id` preserved.

The journal doubles as the **undo** source: each op records its inverse
(rename back, move back, restore from trash), surfaced as an Undo toast;
`status='undone'` keeps history honest.

### 3.2 Trash-first deletion

Deletes never unlink immediately. A delete **moves the file into the library
package's trash**:

```text
.cairndex/trash/{op_id}/files/<original/relative/path>
.cairndex/trash/{op_id}/meta.json    # original paths, file ids, deleted_at
```

- Same-filesystem rename → instant even for huge files; inside `.cairndex/`
  → already scan/grouping-ignored and portable with the library.
- `AssetFile` rows are **kept**, with a new availability state `trashed`
  (filtered from browse/File Browser like `missing`). Restore = rename back +
  flip availability; every id, bundle membership, cover/subtitle link, and
  cache identity survives the round trip.
- Permanent deletion happens only via explicit **Empty Trash** (or per-item
  "Delete permanently"), which unlinks files and finally deletes the rows.
  Optional retention auto-clean (e.g. 30 days) is config, off by default.
- A **Trash system view** (file-first surface, like Unbundled) lists trashed
  files with restore/permanent-delete actions — the brief already reserved
  "Trash later where useful".
- Deleting a directory trashes the whole subtree under one op id, preserving
  structure for restore.
- Ops note: trash can hold bulk data inside `.cairndex/`; `docs/deployment.md`
  gains a line about backup inclusion/exclusion of `trash/`.

### 3.3 Path & filesystem rules

All ops go through one validator (extending `core/paths`): library-relative
input only; reject absolute/`..`/empty/NUL/drive-letter forms; resolve and
re-verify containment after symlink resolution for **both** source and
destination; destination parent must exist (or be created by the same
`mkdir` op); source must be `available` (no ops on `missing` files).

- **No in-place overwrites at the filesystem level** — there is no
  truncate/overwrite primitive anywhere. Collision policy per request:
  `on_conflict: "fail" (default) | "skip" | "suffix" | "replace"`, mapping
  to the Eagle/Finder prompt (owner requirement): **Replace / Skip / Keep
  both** (`suffix` = ` (2)`-style keep-both).
  - **Replace = journaled trash-then-write:** the existing file first moves
    into `.cairndex/trash/` under the same op id, then the incoming file
    takes the path — so even Replace is undoable until Empty Trash.
  - When the replaced path is a linked `AssetFile`, the row **keeps its id**
    (new size/mtime/fingerprint; derived caches invalidate via the
    fingerprint change; the journal records the prior identity for undo) —
    the "swap in the better-quality version" case preserves bundle
    membership, cover/primary selection, and subtitle links.
  - Note: this prompt is about **path collisions**. Content-duplicate
    detection at import (Eagle's other trigger for the same dialog) remains
    deferred per the product brief.
- Cross-device moves inside one root (nested mounts, rare): `rename()` EXDEV
  → copy + size/quick-fingerprint verify + unlink, journaled as two phases.
- Case-only renames on case-insensitive filesystems (SMB from macOS): two-step
  rename via a temporary name.
- Bundle-spanning directory moves update every affected row's
  `relative_path` prefix in Python (no SQL `LIKE` surgery), one journal op.

### 3.4 Concurrency with scans

Single/simple ops (rename, mkdir, one-file trash) run synchronously in the
request — they're milliseconds, and even a mid-scan overlap self-heals (the
DB is updated atomically with the op; a scanner batch that saw the old path
re-reconciles next pass). **Bulk ops** (multi-file move/trash, imports) run
as a `file_ops_batch` job on the existing registry queue — the single worker
naturally serializes them with scans, with progress/cancellation for free
(AGENTS.md: long-running work is async jobs).

## 4. Operations & API

Library-scoped, write-gated, all journaled:

| Endpoint | Op | Notes |
|---|---|---|
| `POST /file-ops/rename` | `{path, new_name, on_conflict?}` | files & dirs; inline UI |
| `POST /file-ops/mkdir` | `{path}` | New Folder |
| `POST /file-ops/move` | `{paths[], dest_dir, on_conflict?}` | ≤ N paths sync, else batch job |
| `POST /file-ops/trash` | `{paths[]}` | to `.cairndex/trash/` |
| `POST /file-ops/restore` | `{op_id or file_ids[]}` | from Trash |
| `POST /file-ops/empty-trash` | `{older_than?}` | permanent; double-confirm in UI |
| `GET  /file-ops` | | journal/history listing (paginated) |
| `POST /exports/{id}/save-to-library` | `save_new` | §5 |

Plus a **plan/preview step for multi-item ops**: `POST /file-ops/plan`
returns what would happen — affected files, linked bundles, collisions —
before the client commits. This mirrors the grouping-plan review pattern
that is already the product's signature interaction for consequential
changes; single-item ops skip it.

**Collision prompt flow:** a single-item op that hits an existing target
returns a structured `409 path_conflict` (with both entries' size/mtime so
the dialog can show them); the UI presents **Replace / Skip / Keep both**
and re-issues with the chosen `on_conflict`. Multi-item ops get the same
choices per collision from the plan/preview step, plus **Apply to all**
(one policy for the whole batch), Eagle/Finder-style.

Bundle-level: "Remove bundle" (metadata-only) stays the default everywhere.
A new explicit **"Delete bundle and trash its N files"** appears only in
write mode, listing the files in the confirm dialog. Collection-cascade
physical deletion is intentionally not offered in v1.

## 5. Saving exports into the library (closes plan 1 §10's open item)

`POST /libraries/{lib}/exports/{export_id}/save-to-library`:

```jsonc
{
  "dest_dir": "Shows/S01",        // default: the source video's directory
  "filename": "…contact.jpg",     // default derived from display title
  "link_bundle_id": "…",          // optional: create AssetFile in this bundle
  "role": "generated_derivative", // or "cover"
  "set_as_cover": true,           // sets bundle.cover_file_id
  "on_conflict": "fail"           // 409 → Replace / Skip / Keep both prompt
}
```

Validated like any `save_new` op; creates the `AssetFile` row (media kind
image/video, probed lazily), links subtitles-style metadata nothing —
it's an ordinary linked file afterward, visible to scan as already-known.
The Export dialog (plan 1 M11) gains "Save into library…" alongside
Download once this lands. Contact-sheet-as-cover is thereby a first-class
flow, not a hack: the cover chain already prefers an explicit
`cover_file_id`.

## 6. Importing external files (enables desktop drag-in copy)

`import` op — multipart upload into a validated destination directory
(+ optional immediate fast-add/link). This is what upgrades plan 3 §6's
drag-in from "explain that files must already be in a library" to an
optional **"Copy into library…"** flow (the desktop shell streams the
local file to the server; the server never reaches out to client paths).
Path collisions here surface the same **Replace / Skip / Keep both**
prompt (§3.3/§4) — the classic Eagle import dialog. Kept as the last
slice: creation-only but the widest new surface (upload size limits,
temp-file staging, partial-upload cleanup).

## 7. File Browser UI (write affordances)

- Context menu + shortcuts: **Rename** (Enter/F2 inline edit), **Move to…**
  (directory-picker dialog), **New Folder**, **Move to Trash** (Del/⌘⌫,
  confirm dialog listing linked-bundle impact), multi-select supported.
- **Drag-move inside File Browser**: dragging entries onto a directory row/card
  moves them (gap-insertion visuals stay reorder-only in Bundle Browser —
  in File Browser a drop *into* a directory is a physical move, clearly cued;
  Esc cancels).
- Trash system view in the sidebar (write-mode libraries only) with restore /
  delete-permanently / Empty Trash.
- **Collision dialog** (shared component): "An item named … already exists
  in …" with both files' size/mtime, actions **Replace / Skip / Keep both**
  (+ "Apply to all" in batches). Replace is visibly labeled as recoverable
  ("the existing file moves to the Library Trash").
- Every completed op → toast with **Undo** (inverse op via journal) where
  safe (rename/move/trash/replace; not empty-trash).
- Read-only libraries look exactly like today; keyboard accessibility per
  AGENTS definition of done.

## 8. Milestones

| # | Slice | Contents |
|---|-------|----------|
| W0 ✅ | Gate | Registry flag + env master switch + structured 403 + Library Manager toggle (re-auth when passphrase set); amend AGENTS.md/CLAUDE.md safety wording per ADR-0013. **Landed 2026-07-23** — one clarification against the design: the passphrase presented to `PUT /write-mode` authorizes that request *by itself*, standing in for an unlocked session, so enabling a locked library costs one prompt rather than two. It authorizes the one request, not the session; the library stays locked for content |
| W1 | Journal + rename/mkdir | `file_operations` table, op service + validator + collision policies (§3.3), reconciler-on-open, File Browser inline rename + New Folder, Undo toast |
| W2 | Save exports to library | §5 (`save_new`), Export-dialog "Save into library…", link/role/set-cover — lands after plan 1 M11 |
| W3 | Move | Single + batch-job move, Move-to… dialog, drag-move in File Browser, collision policy, plan/preview for multi-item |
| W4 | Trash | §3.2 trash/restore/empty, `trashed` availability, Trash view, bundle "delete with files" |
| W5 | Import external | §6 upload op; plan 3 drag-in copy flow lights up |
| W6 | Hardening | EXDEV/case-only edge cases, retention config, journal history UI, deployment/backup docs, perf pass on bulk ops |

Owner re-sequenced 2026-07-10 (milestone ids kept stable, order changed):
build **W0 → W1 → W5** first — the driving use case is dragging media from
Finder into the desktop app (plan 3 §6), which needs only the gate, the
journal, and import-external. W3 (move) and W4 (trash) follow; W2 waits on
plan 1 M11 (media exports), which the owner deferred to the future bucket;
W6 closes the track. W5's dependencies are genuinely just W0+W1 — it shares
the journal/validator machinery but touches neither move nor trash paths.

Testing per slice: unit — validator rejections (traversal/symlink/absolute on
src *and* dest), collision policies, trash round-trip preserving
`AssetFile.id` + cover/subtitle links, journal crash-recovery reconciliation
(simulate FS-done/DB-missing), gate enforcement, bundle metadata survival on
move/rename, directory-subtree moves; e2e Playwright — enable write mode,
inline rename, move dialog, trash→restore, export save + set-cover. All on
generated fixture libraries, never user media (AGENTS).

## 9. Risks & open decisions

- **This plan amends the standing safety rule.** AGENTS.md/CLAUDE.md say
  "never rename/move/delete originals during metadata-only milestones" —
  W0 must reword those rules to "…except through explicit, journaled
  write-mode operations" in the same change (ADR-0013 consequence).
- NFS/SMB rename semantics vary; the EXDEV/case-only fallbacks (§3.3) cover
  the known cases, and the journal + scanner repair bound the damage of any
  surprise.
- Trash disk usage on huge deletes — visible trash size in the UI + Empty
  Trash; retention config later.
- Open: whether `import` (W5) should also offer *move*-into-library for
  files already on the server but outside any root (leaning no — out-of-root
  reads violate the root-scoping model; revisit with a concrete need).
- Open: multi-user attribution columns on the journal (nullable `actor`
  exists implicitly via future `user_id` pattern — add only with multi-user).
