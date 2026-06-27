# Project status

## Current baseline

`main` contains the Phase 0–8 MVP foundation. Cairndex is no longer only a
project skeleton: it has the core schema, storage-root CRUD, scanner/probe/
thumbnail jobs, an Eagle-inspired desktop browser, filtering and Smart Folders,
direct playback with subtitle tracks, one-way Eagle import, and a hardened
single-container production deployment.

The app is still pre-1.0. The next work should focus on making the existing
foundation usable at real-library scale rather than adding broad new product
surfaces.

## Implemented capabilities

- **Core domain model**: storage roots, asset bundles, asset files, hierarchical
  tags, independent tag groups, hierarchical virtual folders, Smart Folders,
  subtitle tracks, jobs, and import records.
- **Path safety and metadata-only behavior**: file locations are stored as
  `storage_root_id + relative_path`, path resolution rejects traversal/symlink
  escape, and normal unlink/delete flows never mutate source media.
- **Scanning and media processing**: incremental storage-root scan, fast-add,
  quick fingerprints, missing-file state, ffprobe metadata extraction, and
  cached ffmpeg thumbnails.
- **Background jobs**: DB-backed queued/running/terminal jobs with progress and
  cooperative cancellation, driven by a lightweight in-process worker.
- **Desktop web UI**: Eagle-like sidebar/browser/inspector shell, virtualized
  grid/list/justified layouts, editable bundle metadata, tag/folder assignment,
  multi-select batch tagging/foldering, Smart Folder editor, and playback modal.
- **Filtering and Smart Folders**: versioned JSON filter AST validated on input
  and compiled to parameterized SQLAlchemy; live preview counts and filtered
  browse use the same compiler path.
- **Playback and subtitles**: per-bundle playback manifest, conservative browser
  playability assessment, range-served video files, external SRT/VTT → cached
  WebVTT, embedded subtitle-track detection, and manual subtitle attachment
  support in the service layer.
- **Eagle migration**: read-only `.library` parser, dry-run plan with advisory
  merge suggestions, idempotent import via `import_records`, and frontend import
  dialog.
- **Packaging/deployment**: production Dockerfile builds SPA + backend into one
  non-root image with ffmpeg/ffprobe; production compose mounts media read-only,
  keeps app data under `/data`, uses read-only rootfs + tmpfs, and includes a
  WAL-safe backup script.

## Last recorded validation

The Phase 8 handoff recorded the following checks as passing on macOS:

- Backend: `ruff`, `ruff format`, `mypy`, and `pytest` (**155 passed**).
- Production image built and ran end-to-end: healthy container, non-root UID
  10001, `/api/v1/health` served, SPA/deep-link fallback served, read-only
  rootfs rejected writes, `ffprobe`/`ffmpeg` present, and WAL DB written to the
  `/data` volume.
- `docker compose -f docker-compose.prod.yml config` validated.
- `infra/backup.sh` verified against a real WAL database with integrity `ok`.

This status document does not mean those checks have been rerun after every
future docs-only edit; use CI or rerun the relevant commands before merging code
changes.

## Known issues / environment gaps

- **No authentication yet** (`AGENTS.md` §12). Compose binds to `127.0.0.1` by
  default; direct public-internet exposure is unsupported. Use a private network
  such as Tailscale or an authenticating reverse proxy until single-owner auth
  lands.
- **Toolbar text search is client-side only** over the already-loaded browse
  items. Server-side text search / SQLite FTS5 is not implemented yet.
- **Browse summaries need a performance pass** before very large libraries:
  current browse behavior is correct for the MVP, but aggregate summary queries
  and indexes need profiling and optimization.
- **Bundle merge/split/move-file workflows are still incomplete**. Scanner
  defaults to one bundle per file; fast-add can group selected files, but
  in-app merge review and Eagle merge-suggestion application are follow-ups.
- **Moved-file repair is not implemented yet**. Missing-file rows are preserved,
  but candidate matching and repair confirmation are future work.
- **Scheduled scans are not scripted yet**. Manual/invoked jobs exist; recurring
  scan orchestration is a follow-up.
- **Media fallback is direct-play only**. Unsupported browser containers/codecs
  report clear fallback states, but remux/transcode/HLS and embedded subtitle
  extraction are deferred.
- **Single uvicorn worker by design** (in-process job worker + single SQLite
  writer, ADR-0001); scale by process supervision and measured query/job
  improvements, not by adding distributed infrastructure prematurely.
- Reverse-proxy/TLS termination and Tailscale setup are documented but not
  scripted.

## Next recommended tasks

1. **Server-side text search / SQLite FTS5**: move toolbar search out of
   client-side filtering, index bundle title/note plus file names/source fields,
   and keep pagination/filtering server-side.
2. **Browse-query performance pass**: eliminate N+1 summary loading, add
   query-pattern indexes, and benchmark against synthetic 10k/100k-item
   libraries.
3. **Bundle workflow hardening**: merge/split bundles, move files between
   bundles, apply Eagle merge suggestions in-app, and expose safer cover/primary
   and subtitle correction flows.
4. **Single-owner authentication** before any remote exposure beyond a trusted
   LAN/private overlay.
5. **Moved-file repair and scheduled scans** so external filesystem changes do
   not strand logical bundles.
6. **Media fallback v1**: remux/transcode job model, embedded subtitle
   extraction, and cached browser-compatible derivatives.

## Unresolved decisions

- Authentication mechanism: single shared secret vs. per-user login/session.
- Whether to add a first-class bundle-level source/link column or keep
  source/origin metadata file-level until a concrete bundle-level workflow needs
  it.
- How aggressive moved-file repair should be before requiring manual
  confirmation, especially when quick fingerprints collide or NAS mtimes are
  unreliable.
