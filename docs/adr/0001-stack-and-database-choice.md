# ADR-0001: Stack and database choice

- Status: accepted
- Date: 2026-06-25
- Branch/PR: `chore/project-foundation`

## Context

`AGENTS.md` (§9) recommends a specific stack and explicitly forbids
introducing Postgres, Redis, Celery, or Elasticsearch "without demonstrated
need." The repository started empty (no prior code, no prior stack
commitments), so there is no existing-codebase reason to deviate.

Deployment target: a single-owner Docker container on a Linux NAS/server,
multi-terabyte library, multi-gigabyte files, accessed by one browser client
at a time (LAN, later Tailscale). This is not a multi-tenant SaaS workload.

## Decision

Adopt the recommended stack as-is for the MVP:

**Backend** — Python 3.12+, FastAPI, SQLAlchemy 2.x, Alembic, Pydantic v2,
SQLite in WAL mode, `ffmpeg`/`ffprobe` for media processing, a lightweight
database-backed job table for background work (no Celery/Redis).

**Frontend** — React + TypeScript (strict mode), Vite, TanStack Query,
a typed router, TanStack Virtual for large lists, Radix UI primitives,
Playwright for e2e.

**Package/dependency management** — `uv` for the backend (fast, lockfile-based,
installs pinned Python versions without requiring the host to have 3.12
pre-installed — relevant since the dev machine ships Python 3.9). `npm` for
the frontend (already present via Node; avoids adding a second Node package
manager like `pnpm`/`yarn` without a concrete reason).

**Database**: SQLite with WAL mode, not Postgres.

- Single-writer, single-owner workload; SQLite's concurrency model (WAL
  allows concurrent readers with one writer) is sufficient.
- Zero extra service to run/back up/monitor on a NAS — the entire metadata
  store is one file plus WAL/SHM siblings, which matches the "self-hosted,
  low-ops" goal in `AGENTS.md` §2.5.
- SQLite FTS5 (also recommended in §9) covers title/note/filename search
  without standing up a separate search service.
- Revisit only if profiling shows a concrete bottleneck (e.g. write
  contention from concurrent background jobs + UI traffic) — see §11
  "Profile before adding complex infrastructure."

**Background jobs**: a `jobs` table polled by an in-process worker (asyncio
task or thread), not Celery/RQ. Scan/ffprobe/thumbnail/transcode work is
bursty and single-node; a DB-backed queue avoids running Redis and gives us
durable, resumable job state for free (job rows are already required for
progress/cancellation per `AGENTS.md` §4.10/§5.2).

## Alternatives considered

- **Postgres** — rejected for MVP. Better concurrency and JSON features, but
  adds a service to deploy/back up on a NAS with no demonstrated write
  contention yet. SQLAlchemy's dialect abstraction keeps a future migration
  possible if profiling justifies it.
- **Celery + Redis** — rejected. Adds two services for a single-user,
  single-node job load that a polled DB table handles fine at this scale.
- **pnpm for the frontend** — rejected for now; `npm` ships with Node and is
  sufficient at this repo size. Revisit if workspace tooling needs improve.
- **Tauri/Electron desktop shell instead of a web app** — rejected for MVP
  per `AGENTS.md` §3 ("native macOS app is not required for the first
  release").

## Consequences

- Migrations (Alembic) must be SQLite-aware (e.g. limited `ALTER TABLE`
  support) — batch migrations using `op.batch_alter_table` where needed.
- WAL mode requires the database file to live on a filesystem with working
  `fsync`/locking semantics; document this caveat for exotic NAS filesystems
  in `docs/deployment.md`.
- A future multi-user or heavier-write-concurrency requirement would need a
  follow-up ADR before introducing Postgres — not a blocker for the MVP per
  `AGENTS.md` §13 (avoid schema choices that block this, but don't build it
  now).

## References

- `AGENTS.md` §2.6, §9, §11, §13
