# Project status

## Current branch / latest commit

Branch: `feature/core-domain-model` (Phase 1), stacked on
`chore/project-foundation` (Phase 0, open as PR #1). Latest commit: see
`git log -1`.

## Current milestone

**Phase 1 — Core domain and storage roots** (`feature/core-domain-model`).
Implemented: SQLAlchemy schema + Alembic migration; path-safety module;
domain services + `/api/v1` CRUD for storage roots, bundles (metadata-only
file linking, cover/primary, tag/folder assignment), tags, tag groups, and
folders; keyset pagination; structured errors; recursive-CTE descendant
queries; synthetic seeder; generated frontend API types. Backend: 64 tests
passing, ruff + mypy clean, migration round-trip + `alembic check` clean.
See `docs/pr/phase-1-core-domain.md`. **Phase 0** is complete (PR #1).

## Completed in this milestone

- Repository audit (the GitHub PR description has the full summary — repo
  was empty except `AGENTS.md`/`CLAUDE.md`).
- Monorepo layout: `apps/server`, `apps/web`, `infra/docker`, `docs/`.
- Documentation skeleton: `docs/architecture.md`, `docs/development.md`,
  `docs/deployment.md`, `docs/data-model.md`, `docs/filter-language.md`,
  this file, `docs/adr/` with a template and ADR-0001.
- `CHANGELOG.md` with an `Unreleased` section.
- `.gitignore` covering Python/Node toolchains, databases, caches, thumbnails,
  app-data directories, and secrets (media is excluded by directory, not by
  extension — see the `.gitignore` policy note).
- FastAPI backend shell (`apps/server`) with `GET /api/v1/health`, Ruff
  format/lint, mypy strict, and pytest — see `docs/development.md`.
- React/Vite/TypeScript (strict mode) frontend shell (`apps/web`) that probes
  the health endpoint with loading/online/unreachable states; ESLint flat
  config, Prettier, Vitest component tests, and a Playwright e2e smoke test.
- `infra/docker/server.Dockerfile`, `infra/docker/web.Dockerfile`, root
  `docker-compose.yml` for local dev.
- `.github/workflows/ci.yml` running both apps' checks plus a `docker compose
  build` validation.

## Tests run (this session, on macOS)

All passing:

- Backend (`apps/server`): `uv run ruff format --check .`, `uv run ruff check
  .`, `uv run mypy src`, `uv run pytest` (2 passed).
- Frontend (`apps/web`): `npm run lint`, `npm run format:check`, `npm run
  typecheck`, `npm run test` (3 passed), `npm run build`, `npm run test:e2e`
  (1 passed, Chromium).
- Integration: started both servers and verified the Vite dev proxy forwards
  `:5173/api/v1/health` to the backend (`status: ok`).
- Docker (verified locally after Docker Desktop was installed): `docker
  compose build` (both images), `docker compose up` → backend health on
  `:8000`, frontend on `:5173`, the Vite proxy forwarding `:5173/api` to
  `server:8000` across the compose network, and the server container's
  `HEALTHCHECK` reporting `healthy`; `docker compose down` cleans up.
- Also validated by CI on PR #1 (backend, frontend, and `docker compose
  build` jobs all green).

## Known issues / environment gaps

- `ffmpeg`/`ffprobe` are not installed on the dev machine. Not required
  until Phase 2 (scanner/media metadata), but worth installing now
  (`brew install ffmpeg`) so Phase 2 isn't blocked on environment setup.
- No domain model, scanner, or browsing UI exists yet — Phase 0 is
  intentionally foundation-only.

## Next recommended task

**Phase 2 — Scanner, indexing, and media metadata**
(`feature/library-scanner`): manual incremental storage-root scan as a
resumable background job, quick fingerprint + lazy full hash, ffprobe
metadata extraction, thumbnail extraction/cache, and missing-file state.
Requires `ffmpeg`/`ffprobe` installed (`brew install ffmpeg`). See the
product brief's "Phase 2" section for acceptance criteria.

Smart Folders have a table but no filter compiler yet — that is Phase 5
(`docs/filter-language.md`).

## Unresolved decisions

- None blocking. Open design questions for later phases are tracked inline
  in `docs/data-model.md` ("What Phase 1 must decide") and
  `docs/filter-language.md` ("Open questions for Phase 5").
