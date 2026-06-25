# Cairndex demos

A small, runnable demo per milestone so you can *see* what each phase built
without wiring up real media. Demos use throwaway databases and temp folders
and never touch real state.

## Phase 1 — core domain & storage roots (backend only)

Phase 1 is the API + data model; the browsing UI arrives in Phase 3. Two ways
to see it:

### A. Narrated walkthrough (no server, ~2 seconds)

Runs the real API in-process against a temp DB and a fake on-disk library,
printing each step — create a storage root, build one bundle from a cover +
two video parts + a subtitle, set shared metadata, assign hierarchical tags
(across tag groups) and multiple folders, then delete the bundle and prove the
files on disk are untouched.

```bash
cd apps/server
uv run python ../../demo/phase1_walkthrough.py
```

### B. Interactive Swagger UI (seeded library)

Seeds a synthetic library and serves the API so you can click through the
auto-generated docs.

```bash
./demo/run_phase1.sh           # or: ./demo/run_phase1.sh 2000
# then open http://localhost:8000/docs
```

Good things to try in the docs: `GET /api/v1/bundles` (paginated — note
`next_cursor`), `GET /api/v1/tags`, `GET /api/v1/folders`, and
`GET /api/v1/bundles/{id}/files`.

## Phase 2 — scanner, ffprobe metadata, thumbnails (backend)

Generates a tiny real library with ffmpeg, then runs the scanner, ffprobe
metadata extraction, and thumbnail generation in-process — printing the
discovered files with their **real dimensions/duration/codecs** and where the
cached thumbnails landed (outside the source tree). Originals are never
touched. Requires ffmpeg (`brew install ffmpeg`).

```bash
cd apps/server
uv run python ../../demo/phase2_walkthrough.py
```

Interactive: `./demo/run_phase1.sh` serves the API; the Phase 2 endpoints
`POST /api/v1/storage-roots/{id}/scan|probe|thumbnails` run these as background
jobs (poll `GET /api/v1/jobs/{id}`), and `GET /api/v1/bundles/{id}/thumbnail`
serves a generated cover.

## Convention for later phases

Each phase adds a `demo/phaseN_*.py` (or `.sh`) plus a section here:

- **Phase 3** (desktop UI): the web app itself becomes the demo — seed a
  library and browse it.
- Later phases: filtering/Smart Folders, playback/subtitles, etc.
