# Deployment

> Status: Phase 8 — production packaging is implemented
> ([ADR-0005](adr/0005-packaging-and-deployment.md)). This covers both the
> local dev stack and the hardened single-container NAS/self-host deployment.

## Local development stack

`docker-compose.yml` (repo root) defines two services for local iteration:

- `server` — FastAPI app via `uvicorn --reload`, port `8000`, source
  bind-mounted from `apps/server`.
- `web` — Vite dev server, port `5173`, source bind-mounted from `apps/web`.

```bash
docker compose up --build
docker compose down
```

This is for local iteration only (source bind-mounts, hot reload, no media
volumes). It is **not** how the app runs in production.

## Production deployment (NAS / self-host)

One hardened container serves the API and the built frontend on port `8000`.
See [ADR-0005](adr/0005-packaging-and-deployment.md) for the rationale.

```bash
cp .env.example .env          # then edit MEDIA_HOST_PATH (and bind addr/port)
docker compose -f docker-compose.prod.yml up --build -d
```

Then open the bound address (default `http://127.0.0.1:8000`), register a
storage root whose canonical path is the in-container mount (`/storage/media`),
and scan it.

### Topology

- **Single image** (`infra/docker/production.Dockerfile`): a multi-stage build
  compiles the SPA, installs the locked backend, and produces a slim
  `python:3.12-slim` runtime that serves the built frontend from FastAPI
  (`CAIRNDEX_STATIC_DIR=/app/web`) behind `/api`. `ffmpeg`/`ffprobe` are
  installed for scanning, thumbnails, and subtitle conversion.
- **Non-root**: runs as a fixed UID/GID `10001:10001` (`AGENTS.md` §12). Give
  the app-data volume to that id if you manage permissions on the host.
- **Read-only media**: your library is mounted **read-only** at
  `/storage/media` (`AGENTS.md` §3 — metadata-only, originals are never
  modified). Set the host path via `MEDIA_HOST_PATH` in `.env`.
- **Writable app-data**: the `cairndex-data` named volume holds the SQLite
  database (WAL — [ADR-0001](adr/0001-stack-and-database-choice.md)) and the
  derived-media cache (thumbnails, converted subtitles), at `/data`, entirely
  outside any storage root.
- **Hardening**: read-only container root filesystem, `tmpfs` `/tmp`,
  `no-new-privileges`. The app only ever writes under `/data`.

### Environment variables

Configuration is read from the environment (prefix `CAIRNDEX_`); see
`.env.example` and `apps/server/src/cairndex/core/config.py`.

| Variable | Default (image) | Purpose |
| --- | --- | --- |
| `CAIRNDEX_ENVIRONMENT` | `production` | Free-form environment label. |
| `CAIRNDEX_DATA_DIR` | `/data` | Writable app-data dir (DB + cache). |
| `CAIRNDEX_STATIC_DIR` | `/app/web` | Built SPA dir the backend serves. Unset → backend serves API only (dev). |
| `CAIRNDEX_DATABASE_URL` | _(unset)_ | Override DB URL; defaults to `sqlite:///{DATA_DIR}/cairndex.db`. |
| `CAIRNDEX_WORKER_ENABLED` | `true` | Run the in-process scan/probe/thumbnail worker. |

Compose-only host knobs (`.env`): `CAIRNDEX_BIND_ADDR` (default `127.0.0.1`),
`CAIRNDEX_PORT` (default `8000`), `MEDIA_HOST_PATH` (host media library).

### Backups

The SQLite database is the only state worth backing up (the cache is
regenerable). `infra/backup.sh` makes a consistent hot copy using SQLite's
online backup API — safe to run while the app is writing — and integrity-checks
it:

```bash
# Against the running container (recommended):
docker exec <container> /app/infra/backup.sh /data/cairndex.db /data/backups
docker cp <container>:/data/backups ./backups     # pull the copies off the box
```

Restore is a file copy while the app is **stopped**: `down`, replace the
database in the `cairndex-data` volume with a backup, `up -d`.

### Remote access and security

There is **no authentication yet** (`AGENTS.md` §12). The compose file binds to
`127.0.0.1` by default. Do **not** expose this directly to the public internet.
For remote access, reach it over a private network or Tailscale, or front it
with a reverse proxy that adds authentication. Optional single-owner auth is a
documented follow-up, not yet implemented.

## Health check

`GET /api/v1/health` returns `{"status": "ok", ...}` and backs the image's
Docker `HEALTHCHECK` (and any NAS container-manager liveness probe). No
authentication is required for this endpoint.
