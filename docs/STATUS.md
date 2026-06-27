# Project status

## Current branch / latest commit

Branch: `feat/collections-and-file-view`, based on `main`. Latest commit: see
`git log -1`.

## Current milestone

**Collections + read-only File View refactor** (in progress). Splits browsing
into a logical, bundle-first **Collection View** (the old "folder" concept,
renamed) and a physical, storage-root-scoped read-only **File View**, and
teaches the scanner to repair high-confidence moved files.

Done so far on this branch:

- Phase 1 — backend DB/model rename `Folder` → `Collection` (+ data-preserving
  Alembic migration).
- Phase 2 — public API/schema/filter rename to `collections`; Smart Folders →
  Smart Collections; OpenAPI + frontend types regenerated.
- Phase 3 — frontend rename to Collections / Smart Collections.

Remaining: read-only File View backend (Phase 4) + UI (Phase 5), scanner
moved-file repair (Phase 6), File View host-integration planning (Phase 7),
final audit (Phase 8).

## Previously merged

**In-bundle view** — open a bundle to browse and inspect the files inside it.
Merged to `main`. **Phases 0–8** (original roadmap) are also merged to `main`.

## Completed in this milestone

- Inline **album view** in the center pane: double-click a bundle (grid card or
  list row) to replace the library grid with a thumbnail grid of its files,
  plus a back-to-library breadcrumb (`apps/web/src/app/BundleAlbum.tsx`).
- Fullscreen **file viewer / lightbox** (`apps/web/src/app/FileViewer.tsx`):
  full-resolution image or inline video, prev/next via chevrons and ←/→,
  info-card fallback for non-renderable files, layered Esc (viewer → album →
  library).
- New `GET /api/v1/files/{file_id}/content` (`api/v1/playback.py`) serves a
  file's original bytes — path-safe, HTTP Range-capable, mime guessed from the
  filename. The video-only resolver was generalized into `resolve_file_path`
  in `media/playback.py`.
- `.gitignore` now also excludes `apps/server/var/` (the prior `var/*` patterns
  were anchored to the repo root and missed the server's runtime data dir); a
  stray committed thumbnail under it was removed from the index.

## Previous milestone — Phase 8 (packaging / deployment hardening, ADR-0005)

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

- Backend: `ruff`/`ruff format`/`mypy`/`pytest` (**156 passed**, +1 new
  `test_playback.py::test_file_content_serves_image_with_guessed_mime`:
  `/files/{id}/content` returns the bytes with `image/png`, and 404s for an
  unknown file).
- Frontend: `tsc -b` typecheck, `eslint`, `vitest` (2 passed), and `prettier`
  all clean.
- **Verified in the browser** against a real seeded library (a "Vacation Album"
  bundle of on-disk images): double-click opened the album grid, all per-file
  thumbnails rendered, the lightbox showed full-resolution images via
  `/files/{id}/content`, prev/next worked, and Esc stepped back correctly
  (viewer → album → library).

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

The Phase 0–8 roadmap is complete and the in-bundle view is in. Candidate
follow-ups (each its own branch): per-file metadata editing from the viewer
(title/note/source); transcoded playback for non-browser-playable video (§6.2)
so the viewer can play MKV/HEVC instead of the fallback card; optional
single-owner authentication (gating before remote exposure); scheduled
background scans; apply Eagle merge suggestions in-app; import Eagle smart
folders; metadata sidecar export (`AGENTS.md` §13).

## Unresolved decisions

- Authentication mechanism (single shared secret vs. per-user) deferred until
  remote access is actually wired up; schema already leaves room (§13).
