# PR: Phase 0 — Repository audit and foundation

- Branch: `chore/project-foundation` → `main`
- Status: ready for review (Phase 0 only; Phase 1 not started)

## Problem and scope

The repository was empty apart from `AGENTS.md` and `CLAUDE.md`. Per the
delivery plan, Phase 0 establishes the monorepo structure, documentation,
ADR process, backend/frontend app shells, a Docker dev stack, and CI —
**before** any domain code — so later milestones build on a reviewable,
checked foundation. No domain model, scanner, or browsing UI is in scope here.

## Repository audit (starting state)

- Git repo with no commits; only `AGENTS.md` + `CLAUDE.md` present.
- Tooling on the dev machine: `uv` 0.11, Node 25 / npm 11, Docker CLI present
  but **no running daemon and no Compose v2 plugin**, `ffmpeg`/`ffprobe`
  **not installed**, system Python 3.9 (so `uv` provisions 3.12).

## Design summary

- **Monorepo**: `apps/server` (FastAPI), `apps/web` (React/Vite),
  `infra/docker`, `docs/` — matching `AGENTS.md` §9.
- **Stack decision** recorded in `docs/adr/0001-stack-and-database-choice.md`:
  the recommended stack as-is, SQLite+WAL over Postgres, a DB-backed job table
  over Celery/Redis, `uv`+`npm`. SQLite/jobs are documented now but not built
  until Phases 1–2.
- **Backend shell**: app factory + `GET /api/v1/health` returning
  `{status, app_name, environment}`; Ruff (format+lint), mypy strict, pytest.
  `get_settings()` is `lru_cache`d.
- **Frontend shell**: strict-mode React/TS app that probes the health endpoint
  and renders loading / online / unreachable states (AGENTS.md §8 wants those
  states handled even in a shell). Plain typed `fetch` — TanStack Query/Router
  are deliberately deferred to Phase 3 to avoid speculative abstraction
  (AGENTS.md §14). Vite dev server proxies `/api` → backend (no CORS in dev).
- **Docs**: architecture/development/deployment/data-model/filter-language
  skeletons with explicit TBD markers and AGENTS cross-references; the filter
  AST shape and field/operator allowlist are fixed now so earlier phases don't
  paint themselves into a corner.
- **Docker + CI**: dev-oriented Dockerfiles + compose with source mounts;
  GitHub Actions runs backend checks, frontend checks (incl. Playwright), and
  `docker compose build`.

## Tests run (macOS, this session)

| Area | Commands | Result |
| --- | --- | --- |
| Backend | `ruff format --check`, `ruff check`, `mypy src`, `pytest` | ✅ 2 passed |
| Frontend | `lint`, `format:check`, `typecheck`, `test`, `build` | ✅ 3 unit passed, build ok |
| Frontend e2e | `playwright test` (Chromium) | ✅ 1 passed |
| Integration | both servers up; `curl :5173/api/v1/health` via Vite proxy | ✅ `status: ok` |
| Docker | `docker compose build` + `up` | ✅ both images build; health on `:8000`, proxy `:5173/api` → `server:8000` across the compose net, server container `HEALTHCHECK` `healthy`, clean `down` |

## Acceptance criteria (Phase 0)

- ✅ One documented command starts each side locally (`uv run uvicorn …`,
  `npm run dev`); proxy wiring verified end-to-end.
- ✅ Docker Compose defined (`docker compose up --build`); build validated in
  CI, not locally.
- ✅ Static checks pass (backend + frontend).
- ✅ No source media required.
- ✅ `docs/STATUS.md` names the next milestone.
- ✅ This PR-style summary exists.

## Notable fixes during review (self-review pass on Opus)

- **`.gitignore` shadowing TypeScript**: the media-extension block included
  `*.ts`, which silently excluded all TypeScript source (would have committed
  a broken frontend). Removed the blanket extension globs — source media is
  excluded by directory (`data/`, `storage/`, `var/`) instead.
- **Missing TS strict mode**: the Vite scaffold shipped no `"strict": true`;
  added it (plus `noUncheckedIndexedAccess`) to both tsconfigs per AGENTS §9.
- **Toolchain alignment**: replaced the scaffold's `oxlint` with the
  documented ESLint + Prettier and added the promised scripts.
- **Eagle reference screenshots** were initially committed; history was
  rewritten so they were never committed, and they are now git-ignored
  (`docs/reference/eagle/*`, README tracked) per "do not commit private
  source media."

## Safety / product-model adherence

- Metadata-only by design; nothing reads or writes source files yet.
- No path handling exists yet (Phase 1) — storage-root path safety is the
  first Phase 1 deliverable and is called out in `docs/architecture.md` §4.

## Migration notes

None — no database or migrations in Phase 0.

## Follow-ups (explicitly out of scope)

- **Action for the owner**: install `ffmpeg`/`ffprobe` before Phase 2
  (Docker Desktop is now installed and the stack is verified locally). Drop
  the remaining Eagle screenshots into `docs/reference/eagle/` (git-ignored).
- **Next milestone**: Phase 1 — Core domain and storage roots
  (`feature/core-domain-model`).

## Commits

```
chore: scaffold monorepo docs and ADR process
feat: add FastAPI backend shell with versioned health endpoint
fix: stop .gitignore shadowing TypeScript and test-fixture media
feat: add React/TypeScript frontend shell
perf: cache the Settings instance
chore: add Docker dev stack and CI pipeline
```
