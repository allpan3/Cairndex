# Project status

## Current branch / latest commit

Branch: `feature/subtitle-playback` (Phase 6), based on `main`. Latest commit:
see `git log -1`.

## Current milestone

**Phase 6 — Subtitles and direct playback** (`feature/subtitle-playback`).
First-class subtitle tracks (ADR-0003) and HTTP-Range direct playback with a
browser player. **Phases 0–5** are merged to `main`.

## Completed in this milestone

- `subtitle_tracks` table + ADR-0003: each track is exactly one of an external
  subtitle `AssetFile` or an embedded `ffprobe` stream (two CHECK constraints),
  linked to a video. `services/subtitles.py` covers CRUD, embedded-stream sync
  on probe, and `auto_link_external_subtitles` (same-dir basename match parsing
  a trailing language/forced suffix; ambiguous subtitles stay unlinked).
- Direct playback (`media/playback.py` + `api/v1/playback.py`):
  `GET /bundles/{id}/playback` manifest, `GET /files/{id}/stream` (HTTP Range /
  206 via Starlette `FileResponse`), `GET /subtitles/{id}/vtt` (SRT→cached
  WebVTT). Per-video `playable` flag/reason so MKV/HEVC show a fallback.
- Desktop player modal: range-streamed `<video>` + WebVTT `<track>`s, a
  multi-video playlist, and a fallback panel; opened from a ▶ on the inspector
  cover.

## Tests run (this session, on macOS)

All passing:

- Backend: `ruff`/`mypy`/`pytest` (**142 passed**) — incl. `test_subtitles.py`
  (parsing, model invariants, auto-link, embedded sync) and `test_playback.py`
  (capability detection, srt→vtt, **range request 206 + Content-Range**,
  manifest, VTT endpoint).
- Frontend: `lint`, `typecheck`, `vitest` (2), `build`, Playwright e2e (8 —
  adds the player flow: video src, subtitle `<track>` src, fallback).
- Verified live in a real browser: a real ffmpeg-generated H.264 `.mp4` + an
  external `.srt`, scanned/probed/auto-linked, **played end-to-end** through
  range streaming (seekable, 0:03) with the SRT served as WebVTT and shown in
  the player — no console errors.

## Known issues / environment gaps

- Embedded subtitle streams are detected and listed, but not yet *served* as
  standalone VTT (needs ffmpeg extraction — the §6.2 fallback milestone). The
  player attaches external `.srt`/`.vtt` tracks only.
- Direct playback only (§6.1). Remux/transcode for MKV/HEVC etc. is the §6.2
  fallback milestone; those videos currently show a fallback state.
- ASS/SSA subtitles are recognized but not converted to VTT yet (styling port).

## Next recommended task

**Phase 7 — Eagle migration** (per `AGENTS.md` §7): one-way, read-only import
from an Eagle library into Asset Bundles, with dry-run + reviewable report and
idempotent re-imports. Smaller Phase 6 follow-ups if desired: ffmpeg extraction
of embedded subtitle streams to VTT, and ASS/SSA → VTT conversion.

## Unresolved decisions

- None blocking. A typed router remains deferred (single browse view).
