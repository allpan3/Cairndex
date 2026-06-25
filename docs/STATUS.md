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
  media, and secrets.
- FastAPI backend shell (`apps/server`) with `GET /api/v1/health`, Ruff
  format/lint, mypy, and pytest — see `docs/development.md`.
- React/Vite/TypeScript frontend shell (`apps/web`) with ESLint, Prettier,
  Vitest, and a minimal Playwright check.
- `infra/docker/server.Dockerfile`, `infra/docker/web.Dockerfile`, root
  `docker-compose.yml` for local dev.
- `.github/workflows/ci.yml` running both apps' checks plus a Docker build
  validation.

## Tests run

See the PR-style summary delivered with this branch for exact commands and
output. In short: `ruff format --check`, `ruff check`, `mypy`, `pytest`
(backend); `eslint`, `prettier --check`, `tsc --noEmit`, `vitest run`,
`playwright test` (frontend).

## Known issues / environment gaps

- The development machine's Docker CLI has **no running daemon** and **no
  Compose v2 plugin** installed (`docker compose` is not recognized). Image
  builds and `docker compose up` could not be verified locally in this
  session — they are exercised in CI instead. See the PR-style summary for
  exactly what to install.
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
