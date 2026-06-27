# Project status

## Current branch / latest commit

Branch: `feat/collections-and-file-view`. Latest commit: see `git log -1`.

This branch is ahead of the merge base for the Collections + File View refactor
and should be updated/rebased against current `main` before merge. In particular,
`AGENTS.md` on current `main` already contains the collection/file-view/default-app
instructions; if the branch is rebased normally, keep the current `main` version
of `AGENTS.md`.

## Current milestone

**Collections + read-only File View refactor** — complete through Phase 8 on this
branch, pending final local/CI validation and rebase/update against current
`main`.

This milestone splits browsing into two surfaces:

- logical, bundle-first **Collection View** — the old virtual folder concept,
  renamed at the DB/model/API/frontend/docs level;
- physical, storage-root-scoped **File View** — a read-only in-app filesystem
  browser for the first milestone.

It also teaches the scanner to repair high-confidence moved files while
preserving `AssetFile.id` and bundle metadata.

## Completed in this milestone

- Phase 0 — orientation and scope captured in the PR description.
- Phase 1 — backend DB/model rename `Folder` → `Collection`, with a
  data-preserving Alembic migration from `folders` /
  `asset_bundle_folders` to `collections` / `asset_bundle_collections`.
- Phase 2 — public API/schema/filter rename to `collections`; Smart Folders →
  Smart Collections; OpenAPI + frontend types regenerated.
- Phase 3 — frontend rename to Collections / Smart Collections, including the
  collection picker, sidebar labels, filter builder, hooks, and e2e tests.
- Phase 4 — read-only File View backend:
  `GET /api/v1/storage-roots/{root_id}/entries`, `services/file_view.py`, and
  backend tests for path scoping, hidden entries, unsupported files, and symlink
  safety.
- Phase 5 — read-only File View UI: sidebar mode toggle, `FileView`,
  `FileInspector`, and Playwright `e2e/file-view.spec.ts`.
- Phase 6 — scanner identity + moved-file repair, documented in ADR-0006;
  same-volume moves preserve `AssetFile.id` and logical bundle metadata.
- Phase 7 — future File View host integration/default-app handoff plan,
  documented in ADR-0007.
- Phase 8 — final docs/consistency audit: current-state docs, changelog, and PR
  description updated.

## Tests and validation

Reported by the implementation phases on this branch:

- backend checks: `ruff`, `ruff format --check`, `mypy`, and `pytest`;
- frontend checks: TypeScript typecheck, lint, Vitest, and Playwright coverage
  for the new File View path.

Not rerun by the ChatGPT connector while adding the Phase 7/8 docs-only cleanup.
Run the full backend/frontend suites again after rebasing/updating this branch
against current `main`.

## Known issues / environment gaps

- The branch currently diverges from current `main`; update/rebase before merge.
- `AGENTS.md` is stale on this branch until it is rebased with current `main` or
  manually synchronized. Current `main` is the desired source for AGENTS.md.
- File View is intentionally read-only in this milestone. Write mode and native
  desktop file handoff require a later host integration (ADR-0007).
- Cross-filesystem moved-file repair and ambiguous repair candidates remain
  future work; same-volume high-confidence repair is implemented (ADR-0006).
- No authentication yet (`AGENTS.md` §12). Compose binds to `127.0.0.1` by
  default; direct public-internet exposure is unsupported — use a private
  network/Tailscale or an authenticating reverse proxy.
- Single uvicorn worker by design (in-process job worker + single SQLite writer,
  ADR-0001); scale by process supervision, not threads.
- Reverse-proxy/TLS termination and Tailscale setup are documented but not
  scripted.

## Next recommended tasks

After merging this refactor, candidate follow-ups include:

- update/rebase branch and resolve any conflicts with current `main`;
- optional single-owner authentication before remote exposure;
- scheduled background scans;
- server-side text search / SQLite FTS5;
- browse-query performance/indexing for larger libraries;
- File View write-mode design and host integration from ADR-0007;
- cross-filesystem repair candidate UI;
- apply Eagle merge suggestions in-app;
- metadata sidecar export.

## Unresolved decisions

- Authentication mechanism (single shared secret vs. per-user) deferred until
  remote access is actually wired up; schema already leaves room.
- First host-integration path for native file handoff: macOS/native app, Tauri
  shell, local companion helper, or another explicit desktop integration
  (ADR-0007).
