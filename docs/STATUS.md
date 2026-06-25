# Project status

## Current branch / latest commit

Branch: `feature/desktop-library-ui` (Phase 3), based on `main`. Latest
commit: see `git log -1`.

## Current milestone

**Phase 3 — Desktop app shell and browsing views** (`feature/desktop-library-ui`).
Eagle-inspired dark three-pane web UI over the Phase 1/2 APIs, plus the bundle
browse backend it needs. **Phases 0–2** are merged to `main`.

## Completed in this milestone

- Browse backend (`services/browse`): card summaries (file count, size,
  missing/cover state, primary-derived dims/duration/extension); system views
  (all/recent/uncategorized/untagged/missing); folder filter w/ descendants;
  sort with a ULID tie-breaker; offset pagination + total; view/folder counts.
  Endpoints `GET /bundles/browse`, `/bundles/counts`, `/folders/counts`.
- Frontend (`apps/web`): TanStack Query data layer + typed client/hooks;
  resizable three-pane shell; counted system views + folder tree; toolbar
  (search, sort, layout, zoom); grid/list/justified layouts, all virtualized
  (TanStack Virtual); bundle cards; inspector (metadata + files); keyboard
  navigation; layout/zoom/pane-width persisted.

## Tests run (this session, on macOS)

All passing:

- Backend: `ruff`/`mypy`/`pytest` (**100 passed**); Alembic round-trip clean.
- Frontend: `lint`, `format:check`, `typecheck`, `vitest` (2), `build`,
  Playwright e2e (3 — shell+browse, select→inspector, layout persists).
- Verified live in a real browser (Vite + seeded backend, 500 bundles):
  grid/list/justified render, virtualization windows to ~30 DOM nodes,
  selection opens the inspector, sidebar counts populate.

## Known issues / environment gaps

- Search is client-side over loaded items; server-side full-text search +
  Smart Folders are Phase 5. The "Show subfolder contents" toggle defaults on
  for folder views (no explicit UI toggle yet).
- Bundle editing (tags/folders/cover/rating from the UI) is Phase 4; the
  inspector is read-only this phase.

## Next recommended task

**Phase 4 — Bundle editing and organization** (`feature/bundle-editor`):
edit title/note/URL/rating; manage files in a bundle (add/remove/reorder,
choose primary/cover); tag editor (hierarchy, groups, include/exclude);
folder assignment; batch selection + batch tag/folder ops.

## Unresolved decisions

- None blocking. A typed router (TanStack Router) was deferred this phase —
  the app is a single browse view driven by state + localStorage; revisit if
  multi-route/deep-link needs arise.
