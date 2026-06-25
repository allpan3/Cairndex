# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project does not yet follow semantic versioning releases; entries are
grouped under `Unreleased` until the first tagged release.

## [Unreleased]

### Added

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
