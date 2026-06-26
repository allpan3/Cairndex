# Project status

## Current branch / latest commit

Branch: `feature/eagle-import` (Phase 7), based on `main`. Latest commit:
see `git log -1`.

## Current milestone

**Phase 7 — Eagle migration** (`feature/eagle-import`). One-way, read-only,
idempotent import from an Eagle `.library` into Asset Bundles (ADR-0004).
**Phases 0–6** are merged to `main`.

## Completed in this milestone

- `eagle/reader.py`: read-only parser of an Eagle `.library` (nested folders →
  flat, tag groups, per-item metadata) into frozen dataclasses; malformed
  items are skipped + reported, never fatal. The library is never written to.
- `eagle/planner.py`: `plan_import()` produces a dry-run `ImportPlan` (counts +
  advisory merge suggestions) with no DB writes.
- `services/eagle.py`: `import_library()` ensures a storage root at the
  library's `images/` dir, creates/reuses folders/tags/groups by name, maps
  each non-deleted item → one bundle + one linked file, and records
  `import_records` (`UNIQUE(provider, external_id)`) so re-imports are no-ops.
- API: `POST /eagle/preview` (dry run) + `POST /eagle/import` (commit).
- Desktop "Import from Eagle" dialog (⇪ in the sidebar): path → Preview report
  → Import, then the browse-facing queries refresh.

## Tests run (this session, on macOS)

All passing:

- Backend: `ruff`/`mypy`/`pytest` (**149 passed**) — incl. `test_eagle_reader.py`,
  `test_eagle_planner.py`, `test_eagle_import.py` (mapping, **idempotent
  re-import creates no new rows**, preview→import→preview API, 422 on bad path).
- Frontend: `lint`, `typecheck`, `vitest` (2), `build`, Playwright e2e (9 —
  adds the Eagle preview→import flow).
- Verified live in a real browser against a synthetic Eagle library: previewed
  4 new bundles (1 deleted skipped, a part1/part2 merge hint), imported, and
  the grid + folder tree updated — no console errors.

## Known issues / environment gaps

- Merge suggestions are advisory only — the MVP maps one Eagle item → one
  bundle; combining suggested groups into a single bundle is a later manual
  step (no destructive auto-merge, per §7).
- Imported tags are flat (Eagle tags are flat strings); hierarchy isn't
  inferred. Eagle smart folders are not imported (filter dialects differ).
- Tested against a synthetic library matching the documented on-disk format;
  real Eagle libraries may carry version-specific fields not yet handled.

## Next recommended task

**Phase 8 — packaging / deployment hardening** (per `AGENTS.md` §12/§13): the
remaining roadmap items (e.g. remote access, background-scan scheduling, and
release packaging). Smaller follow-ups: import Eagle smart folders, infer tag
hierarchy, and apply merge suggestions in-app.

## Unresolved decisions

- None blocking. A typed router remains deferred (single browse view).
