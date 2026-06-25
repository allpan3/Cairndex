# Project status

## Current branch / latest commit

Branch: `chore/project-foundation` (not yet merged to `main`).
Latest commit: see `git log -1` — this file is updated at each meaningful
checkpoint, not retroactively reconciled against git after the fact.

## Current milestone

**Phase 0 — Repository audit and foundation** (`chore/project-foundation`).

## Completed in this milestone

- Repository audit (see PR-style summary in the branch handoff message —
  repo was empty except `AGENTS.md`/`CLAUDE.md`).
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

**Phase 1 — Core domain and storage roots** (`feature/core-domain-model`):
storage-root/bundle/file/tag/tag-group/folder/smart-folder migrations,
domain/service layer, CRUD APIs, path-safety tests. See `AGENTS.md` and the
product brief's "Phase 1" section for full acceptance criteria.

## Unresolved decisions

- None blocking. Open design questions for later phases are tracked inline
  in `docs/data-model.md` ("What Phase 1 must decide") and
  `docs/filter-language.md` ("Open questions for Phase 5").
