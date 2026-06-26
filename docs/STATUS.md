# Project status

## Current branch / latest commit

Branch: `feature/smart-filters` (Phase 5), based on `main`. Latest commit:
see `git log -1`.

## Current milestone

**Phase 5 — Filtering and Smart Folders** (`feature/smart-filters`). A
canonical filter AST powers both ad-hoc filtering and persisted Smart Folders.
**Phases 0–4** are merged to `main`.

## Completed in this milestone

- Canonical, versioned filter AST (`filters/ast.py`) + validator/compiler
  (`filters/compiler.py`): allowlisted fields/operators compiled to
  **parameterized** SQLAlchemy; invalid/hostile expressions → HTTP 422, never
  SQL. Logical (and/or/not) + predicate nodes; `include_descendants` on
  tags/folders resolves the hierarchy.
- `POST /filters/preview` (AST → count) and `POST /bundles/browse` (filtered
  browse) so toolbar filters and Smart Folders share one code path;
  `smart_folders` service + `/api/v1/smart-folders` CRUD (AST validated on
  write).
- Desktop UI: Eagle-style FilterBuilder (match all/any; text/number/bool/date
  inputs + tag/folder pickers with an include-descendants toggle), a Smart
  Folder editor with a live match count, and a "Smart Folders" sidebar section
  that browses saved filters (inline edit/delete).
- Earlier in the branch: dropped the bundle-level hyperlink; renamed the
  file-level `source_url` → `source`.

## Tests run (this session, on macOS)

All passing:

- Backend: `ruff`/`mypy`/`pytest` (**129 passed**) — incl. `test_filters.py`,
  `test_smart_folders.py`, `test_filters_api.py` (AST disambiguation,
  invalid-cannot-reach-SQL, simple-vs-smart equivalence, saved-survive-reload,
  preview/browse/CRUD API).
- Frontend: `lint`, `typecheck`, `vitest` (2), `build`, Playwright e2e (7 —
  adds the build/preview/save/browse Smart Folder flow).
- Verified live in a real browser against a seeded DB: built a `rating ≥ 4`
  filter (live count 108 = backend preview), saved it, the sidebar Smart
  Folder browsed exactly 108, reload persisted it, and editing re-opened the
  builder prefilled.

## Known issues / environment gaps

- The FilterBuilder exposes one condition group (Eagle-style all/any); the AST
  supports arbitrary nesting but the UI does not yet build nested groups.
- `duration`/`container`/`codec`/`availability`/`has_subtitles`/`file_role`
  are in the documented allowlist but not yet in the compiler (see
  `docs/filter-language.md` → "Implemented fields").
- Adding *new* files to a bundle from the UI is still unwired (fast-add covers
  bulk linking).

## Next recommended task

**Phase 6 — Subtitles and playback** (per `AGENTS.md`): subtitle association
and a first-class player. Smaller Phase 5 follow-ups if desired: extend the
compiler to the rest of the documented allowlist (`duration`, `codec`,
`availability`, `has_subtitles`, …) and add nested condition groups to the
FilterBuilder.

## Unresolved decisions

- None blocking. A typed router remains deferred (single browse view).
