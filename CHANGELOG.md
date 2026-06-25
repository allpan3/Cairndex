# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project does not yet follow semantic versioning releases; entries are
grouped under `Unreleased` until the first tagged release.

## [Unreleased]

### Added

- **Phase 1 — core domain and storage roots.** SQLAlchemy 2.0 schema +
  first Alembic migration for storage roots, asset bundles, asset files,
  tags, tag groups (+ membership), folders, and smart folders, plus the
  bundle↔tag / bundle↔folder joins (ADR-0002: ULID PKs, tz-aware UTC
  timestamps, adjacency-list hierarchy, SQLite WAL/foreign-keys pragmas).
- Path-safety module (`core/paths`) — normalizes client relative paths and
  rejects absolute/traversal/symlink-escape; the single choke point for all
  storage-root path resolution.
- Domain services + `/api/v1` CRUD for storage roots, bundles (with
  metadata-only file linking/unlinking, cover/primary selection, and
  tag/folder assignment), tags, tag groups, and folders — with keyset
  pagination, structured errors, and recursive-CTE descendant queries.
- Synthetic library generator (`devtools/synthetic`) and seed CLI
  (`python -m cairndex.devtools.seed`) for tests and scaled UI dev.
- Generated frontend API types from the backend OpenAPI schema
  (`apps/web/src/api/schema.d.ts`, `npm run gen:api`).
- Repository foundation: monorepo layout (`apps/server`, `apps/web`,
  `infra/docker`, `docs/`), `.gitignore`, ADR process, and documentation
  skeleton (`docs/architecture.md`, `docs/development.md`,
  `docs/deployment.md`, `docs/data-model.md`, `docs/filter-language.md`,
  `docs/STATUS.md`).
- `docs/adr/0001-stack-and-database-choice.md` recording the backend/frontend
  stack and SQLite-with-WAL decision.
- FastAPI backend shell (`apps/server`) with a versioned health endpoint
  (`GET /api/v1/health`), uv-managed Python 3.12+ project, Ruff formatting
  and linting, mypy strict type checking, and a pytest smoke test.
- React + TypeScript (strict mode) frontend shell (`apps/web`) built with
  Vite, ESLint (flat config) + Prettier, a Vitest component test suite, and a
  Playwright end-to-end smoke test. The shell probes `GET /api/v1/health` and
  renders loading/online/unreachable states; the Vite dev server proxies
  `/api` to the backend so development needs no CORS.
- Docker development environment: `infra/docker/server.Dockerfile`,
  `infra/docker/web.Dockerfile`, and root `docker-compose.yml`.
- GitHub Actions CI workflow running backend and frontend checks plus a
  `docker compose build` validation on every push/PR.

### Changed

- N/A

### Fixed

- `.gitignore` no longer blanket-ignores media extensions at the repo root.
  The `*.ts` glob silently shadowed all TypeScript source; source media is
  kept out via directory ignores (`data/`, `storage/`, `var/`) instead.

### Removed

- N/A

### Security

- N/A

### Internal

- Enforced TypeScript strict mode (`strict`, `noUncheckedIndexedAccess`) in
  both frontend tsconfigs, which the Vite scaffold omitted (AGENTS.md §9).
- `get_settings()` memoizes the `Settings` instance (`lru_cache`) so config
  is read from the environment once per process.
