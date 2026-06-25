# Deployment

> Status: skeleton (Phase 0). This document covers the local Docker dev
> stack now and will gain a full NAS production guide in Phase 8
> (`feature/release-hardening`) per `AGENTS.md` §17.

## Local development stack

`docker-compose.yml` (repo root) defines two services:

- `server` — FastAPI app via `uvicorn --reload`, port `8000`, source
  bind-mounted from `apps/server`.
- `web` — Vite dev server, port `5173`, source bind-mounted from `apps/web`.

This is for local iteration only — it is not how the app will run on a NAS
(no storage-root volumes, no production frontend build, reload-on-save
mounts source code into the container).

```bash
docker compose up --build
docker compose down
```

## Target production topology (NAS) — **TBD (Phase 8)**

Planned shape, not yet implemented:

- A single backend container serving the built frontend as static files
  (or a second minimal container for static assets) — final split TBD.
- Storage roots bind-mounted **read-only** by default
  (`/mnt/media:/data/storage/<root-name>:ro`), matching `AGENTS.md` §3
  ("Start with metadata-only removal... file rename/move/delete... come
  later under an explicit write mode").
- A writable app-data volume for the SQLite database (WAL mode — see
  [ADR-0001](adr/0001-stack-and-database-choice.md)) and the derived-media
  cache (thumbnails, converted subtitles), kept outside any storage root.
- A documented backup procedure for the app-data volume (Phase 8).
- Optional single-owner authentication before any Tailscale/remote exposure
  (`AGENTS.md` §12) — not implemented yet; do not expose this app to the
  public internet.
- A non-root container user (`AGENTS.md` §12) — **TBD**, current Phase 0
  Dockerfiles are dev-only and not yet hardened for production.

## Environment variables — **TBD**

Will be documented here as `core/config.py` grows past Phase 0's defaults.
None are required to run the Phase 0 health-check shell.

## Health check

`GET /api/v1/health` returns `{"status": "ok"}` and is suitable for a Docker
`HEALTHCHECK` or NAS container-manager liveness probe. No authentication is
required for this endpoint.
