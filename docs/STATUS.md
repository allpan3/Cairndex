# Project status

## Current branch / latest commit

Branch: `feature/release-hardening` (Phase 8), based on `main`. Latest commit:
see `git log -1`.

## Current milestone

**Phase 8 — packaging / deployment hardening** (`feature/release-hardening`,
ADR-0005). A single hardened container that serves the API and the built SPA,
ready for NAS/self-host. **Phases 0–7** are merged to `main`.

## Completed in this milestone

- Backend serves the built frontend when `CAIRNDEX_STATIC_DIR` is set
  (`api/static_site.py`): `/api/v1` still wins, hashed assets are served
  directly, other paths fall back to `index.html` (deep links survive a
  refresh). Unset in dev.
- `infra/docker/production.Dockerfile`: multi-stage (build SPA + install locked
  backend) → slim `python:3.12-slim` runtime, non-root UID 10001, with
  `ffmpeg`/`ffprobe`. Root `.dockerignore` keeps the context free of
  data/secrets.
- `docker-compose.prod.yml`: read-only rootfs + `tmpfs`, media mounted
  read-only at `/storage/media`, writable app-data volume at `/data`,
  `no-new-privileges`; `.env.example` for the host knobs.
- `infra/backup.sh`: WAL-safe online SQLite backup + integrity check.
- ADR-0005 + rewritten `docs/deployment.md` (topology, env-var table,
  backup/restore, remote-access security). CI builds the production image.

## Tests run (this session, on macOS)

All passing:

- Backend: `ruff`/`ruff format`/`mypy`/`pytest` (**155 passed**, +6 new
  `test_static_site.py`: SPA shell, deep-link fallback, hashed asset, root
  file, `/api` still wins, unknown `/api` stays JSON 404).
- **Built and ran the production image end-to-end**: container reports
  `healthy`, runs as non-root (uid 10001), serves `/api/v1/health`
  (`environment=production`) and the SPA + deep-link fallback, read-only rootfs
  rejects writes, `ffprobe`/`ffmpeg` on PATH, WAL DB written to the `/data`
  volume. `docker compose -f docker-compose.prod.yml config` validates.
- `infra/backup.sh` verified against a real WAL database (100 rows copied,
  integrity `ok`).

## Known issues / environment gaps

- **No authentication yet** (`AGENTS.md` §12). Compose binds to `127.0.0.1` by
  default; direct public-internet exposure is unsupported — use a private
  network/Tailscale or an authenticating reverse proxy. Optional single-owner
  auth is a documented follow-up.
- Single uvicorn worker by design (in-process job worker + single SQLite
  writer, ADR-0001); scale by process supervision, not threads.
- Reverse-proxy/TLS termination and Tailscale setup are documented but not
  scripted.

## Next recommended task

The Phase 0–8 roadmap is complete. Candidate follow-ups (each its own branch):
optional single-owner authentication (gating before remote exposure);
scheduled background scans; apply Eagle merge suggestions in-app; import Eagle
smart folders; metadata sidecar export (`AGENTS.md` §13).

## Unresolved decisions

- Authentication mechanism (single shared secret vs. per-user) deferred until
  remote access is actually wired up; schema already leaves room (§13).
