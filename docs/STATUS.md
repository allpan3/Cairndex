# Project status

## Current branch / latest commit

Branch: `feature/bundle-editor` (Phase 4), based on `main`. Latest commit:
see `git log -1`.

## Current milestone

**Phase 4 — Bundle editing and organization** (`feature/bundle-editor`).
The inspector becomes interactive and the browser gains multi-select + batch
operations. **Phases 0–3** are merged to `main`.

## Completed in this milestone

- Backend editing endpoints: file PATCH (display title/note/link/role/seq),
  file reorder, `POST /bundles/batch` (add/remove tags+folders across many
  bundles), `GET /bundles/{id}/tags`+`/folders`, `GET /tags/counts`. Most
  editing primitives already existed from Phase 1.
- Editable inspector (TanStack Query mutations + invalidation): title, note,
  source URL, star rating.
- Tag editor (chips + popover: group tabs, search, hierarchy, counts) and
  hierarchical folder assignment.
- File management in the inspector: reorder, set primary/cover, remove from
  bundle (metadata only — never deletes the file on disk).
- Multi-select (cmd/ctrl/shift-click) + batch bar for tag/folder assignment.

## Tests run (this session, on macOS)

All passing:

- Backend: `ruff`/`mypy`/`pytest` (**106 passed**).
- Frontend: `lint`, `typecheck`, `vitest` (2), `build`, Playwright e2e (6 —
  browse, inspector, layout-persist, rating edit, tag assignment, multi-select
  batch bar).
- Verified live in a real browser: editing a rating persisted across refetch;
  the tag picker opened with group tabs/search/hierarchy and toggled
  assignment; file actions and the editable fields render.

## Known issues / environment gaps

- Adding *new* files to a bundle from the UI is not wired yet (fast-add covers
  bulk linking; the inspector currently reorders/removes/repurposes existing
  files). Choosing a video *frame* as a cover (vs. an existing file) is
  deferred — the thumbnail already auto-extracts a frame as a fallback.
- Search is still client-side over loaded items; server-side search + Smart
  Folders are Phase 5.

## Next recommended task

**Phase 5 — Filtering and Smart Folders** (`feature/smart-filters`): the
canonical filter AST + server validator/compiler, the tag/folder filter
pickers (include/exclude, any/all, descendants), the Smart Folder editor
(field/operator/value rows with live counts), and saved Smart Folders in the
sidebar. See `docs/filter-language.md`.

## Unresolved decisions

- None blocking. A typed router remains deferred (single browse view).
