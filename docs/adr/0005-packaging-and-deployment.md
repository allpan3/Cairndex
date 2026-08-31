# ADR-0005: Packaging and deployment (single hardened container)

- Status: accepted
- Date: 2026-06-26
- Branch/PR: `feature/release-hardening`

## Context

Phase 8 turns the dev stack into something runnable on a NAS or home server
(`AGENTS.md` §12 security/privacy, §17 deployment). The dev `docker-compose.yml`
bind-mounts source and hot-reloads two services — unsuitable for production. We
need a reproducible image, a non-root runtime, read-only access to media, a
clear app-data boundary, and a backup story, **without** standing up
infrastructure the single-owner MVP doesn't need.

## Decisions

### 1. One container serves the API and the built SPA

The backend serves the compiled frontend (`apps/web/dist`) when
`CAIRNDEX_STATIC_DIR` is set: FastAPI keeps owning `/api/v1`, hashed assets are
served directly, and any other path falls back to `index.html` so client routes
survive a hard refresh. Same-origin means no CORS and no separate static host.
A reverse proxy can still sit in front, but isn't required. The setting is unset
in dev, so Vite continues to serve the frontend separately with its `/api`
proxy.

Rejected: a second nginx container for static assets — more moving parts for no
benefit at single-owner scale; the API already runs and can serve files.

### 2. Multi-stage build, slim non-root runtime

`infra/docker/production.Dockerfile` builds the SPA (node) and installs the
locked backend (uv), then copies only the venv, the server source, and the built
SPA into a `python:3.12-slim` runtime. The runtime adds `ffmpeg`/`ffprobe`
(required by scan, thumbnail, and subtitle conversion — they shell out via PATH)
and `curl` (healthcheck). It runs as a fixed non-root UID/GID `10001:10001`
(`AGENTS.md` §12); a fixed high id is predictable for NAS volume ownership. The
build context is the repo root (both `apps/*` are needed); a root `.dockerignore`
keeps data, secrets, and build artifacts out of the context.

### 3. Storage is read-only; app-data is a separate writable volume

`docker-compose.prod.yml` mounts the media library **read-only** at
`/storage/media` (`AGENTS.md` §3 — metadata-only, never mutate originals) and
the writable app-data (SQLite DB + derived-media cache) as a named volume at
`/data`, kept entirely outside any storage root. The container root filesystem
is itself `read_only` with a `tmpfs` `/tmp` and `no-new-privileges`, since the
app only ever writes under `/data`. Media and app-data are mounted at distinct
top-level paths (`/storage` vs `/data`) so the read-only and writable trees never
overlap.

### 4. Backup = SQLite online backup of app-data only

**Amended by ADR-0008:** persistent content metadata moved from the one app-data
database into each library's `.cairndex/library.db`. The online-backup decision
still applies, but a complete backup set is now the registry plus every library
database (and `.cairndex/trash/` when write mode is used). `restore.sh` replaces
the original unguarded file-copy procedure with a stopped-only atomic restore.

`infra/backup.sh` uses SQLite's online backup API (via `python3`, always present
in image and host) to make a consistent hot copy of `cairndex.db` while the app
writes (WAL mode) — a plain `cp` of a WAL database can capture a torn state. The
copy is integrity-checked. Only the database is backed up; the derived-media
cache is regenerable.

### 5. No authentication yet; not for public exposure

The MVP ships no auth (`AGENTS.md` §12 — "consider optional single-owner
authentication before remote/Tailscale use"). The compose file binds to
`127.0.0.1` by default and the docs state plainly that direct public-internet
exposure is unsupported; reach it over a private network or Tailscale. Optional
single-owner auth is left as a documented, non-blocking follow-up.

## Consequences

- A single `docker build`/`docker compose -f docker-compose.prod.yml up`
  produces a runnable, hardened deployment — verified by building and running the
  image (healthy, non-root, SPA + API served, read-only rootfs enforced, ffprobe
  on PATH, WAL DB in the `/data` volume).
- Scaling is by process supervision, not threads: one uvicorn worker keeps the
  in-process job worker and the single SQLite writer simple (ADR-0001).
- Adding auth later is additive (a dependency on the API routes + a login view);
  nothing here blocks the §13 multi-user path.

## References

- `AGENTS.md` §3 (metadata-only), §12 (security/privacy), §13 (future
  compatibility), §17 (deployment)
- ADR-0001 (stack and database choice — SQLite/WAL, in-process worker)
- `docs/deployment.md` (operator guide)
