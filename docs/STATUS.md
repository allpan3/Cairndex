# Project status

## Current branch / latest commit

Branch: `feature/library-scanner` (Phase 2), based on `main`. Latest commit:
see `git log -1`.

## Current milestone

**Phase 2 — Scanner, indexing, and media metadata** (`feature/library-scanner`).
Implemented: DB-backed background job framework + worker; incremental,
idempotent, non-destructive storage-root scanner (quick fingerprint, missing-
file state); ffprobe technical-metadata extraction; thumbnail generation +
cache + cover fallback + serving; async scan/probe/thumbnail endpoints; manual
fast-add with grouping. Backend: 94 tests passing, ruff + mypy clean,
migration round-trip + `alembic check` clean. **Phases 0 and 1** are merged to
`main` (PRs #3, #2).

## Completed in this milestone

- Background jobs: `jobs` table + migration; an in-process polled `Worker`
  (app-lifespan managed) with cooperative cancellation and progress
  checkpoints; `GET /jobs`, `/jobs/{id}`, `POST /jobs/{id}/cancel`.
- Scanner (`scanning/`): batched, idempotent upsert keyed on
  `(root, relative_path)`; quick fingerprint (size+mtime) only — full hash is
  lazy and never on the scan path; unseen files marked `missing` (not
  deleted); unreachable root marks its files missing; nothing on disk touched.
- ffprobe adapter + probe service (`media/ffprobe`, `media/probe_service`):
  normalized `tech_metadata` (dimensions/duration/codecs/streams), exposed on
  the file API; runs as a cancellable PROBE job.
- Thumbnails (`media/thumbnails`): ffmpeg frame/downscale to a deterministic
  cache path outside source dirs, cover fallback, dedup; THUMBNAIL job; served
  via `GET /bundles/{id}/thumbnail` (lazy, 404/503 fallbacks).
- Endpoints: `POST /storage-roots/{id}/scan|probe|thumbnails` (async jobs) and
  `/fast-add` (per-file / single-bundle grouping; directories expanded).
- `demo/phase2_walkthrough.py` (real ffprobe metadata + thumbnails).

## Tests run (this session, on macOS)

All passing:

- Backend (`apps/server`): `ruff format --check`, `ruff check`, `mypy src`,
  `pytest` (**94 passed**); Alembic round-trip + `alembic check` clean. ffmpeg
  8.1.2 present, so scanner/probe/thumbnail tests run (they skip where ffmpeg
  is absent; CI installs it).
- The Phase 2 demo runs end-to-end (scan → probe → thumbnails) on generated
  media, originals untouched.

## Known issues / environment gaps

- No browsing UI yet (Phase 3). Smart Folders have a table but no filter
  compiler yet (Phase 5).
- Subtitle/media-track table and jobs-driven transcoding are later phases
  (6/later); `asset_files` already carries `role=subtitle`.

## Next recommended task

**Phase 3 — Desktop app shell and browsing views** (`feature/desktop-library-ui`):
the Eagle-inspired three-pane shell (sidebar / virtualized browser /
inspector), system views, counted folder tree, justified + grid + list
layouts, search/sort/zoom, and bundle cards backed by the Phase 1/2 APIs
(including `/bundles/{id}/thumbnail`). See the product brief's "Phase 3".

## Unresolved decisions

- None blocking. Open design questions for later phases are tracked inline in
  `docs/data-model.md` and `docs/filter-language.md`.
