# ADR-0003: Subtitle track model and direct playback

- Status: accepted
- Date: 2026-06-26
- Branch/PR: `feature/subtitle-playback`

## Context

Phase 6 makes subtitles first-class (`AGENTS.md` §4.9) and adds direct
playback (§6.1). §4.9 explicitly requires the track model to be documented
before implementation. A subtitle can be either an **external** file (a
`.srt`/`.ass`/`.vtt`/… sitting next to the video, represented as its own
`AssetFile`) or an **embedded** stream inside a video container (discovered by
`ffprobe`). Both must link to a specific video file and carry language, label,
format, and default/forced flags.

## Decisions

### 1. A dedicated `subtitle_tracks` table (not a generalized MediaTrack yet)

We add one table, `subtitle_tracks`, rather than a generalized `media_tracks`
table. §13 warns against speculative abstraction; audio/video track rows have
no consumer in the MVP. The column shape (a link to a video file plus an
*either external-file or embedded-index* source) generalizes cleanly to a
future `media_tracks` table if needed, so this is not a one-way door.

### 2. Each track is exactly one of external or embedded

Columns:

- `id` ULID PK.
- `bundle_id` → `asset_bundles` (CASCADE). Denormalized so a bundle's tracks
  list in one query; it always equals the video file's bundle.
- `video_file_id` → `asset_files` (CASCADE), **nullable**. The video the track
  belongs to. Required for embedded streams; for an external file it may be
  null until auto-link/manual attachment resolves a target.
- `source_file_id` → `asset_files` (SET NULL), **nullable**. The external
  subtitle `AssetFile`. Mutually exclusive with `embedded_index`.
- `embedded_index` int, **nullable**. The `ffprobe` stream index of an
  embedded subtitle stream within `video_file_id`'s container.
- `language` (BCP-47/ISO-639 string, nullable), `label` (nullable),
  `format` (`srt`, `ass`, `vtt`, `mov_text`, … nullable),
  `is_default` bool, `is_forced` bool, `sort_order` int.
- `created_at` / `updated_at`.

Two CHECK constraints encode the invariant:

- **exactly one source**: `(source_file_id IS NOT NULL) <> (embedded_index IS
  NOT NULL)`.
- **embedded needs a host**: `embedded_index IS NULL OR video_file_id IS NOT
  NULL`.

Uniqueness: an embedded stream is linked once —
`UNIQUE(video_file_id, embedded_index)`; an external subtitle file backs one
track — `UNIQUE(source_file_id)`.

### 3. Auto-linking heuristic

External subtitles auto-link to a video in the **same directory** whose
basename matches the subtitle's basename minus a trailing language/flag suffix
(`movie.en.srt` → `movie.mkv`; `movie.forced.srt`, `movie.en.forced.srt`).
The language token (when present and a known 2/3-letter code) populates
`language`; a `forced` token sets `is_forced`. Ambiguous or unmatched
subtitles are kept as unlinked tracks for manual attachment — never guessed
destructively (§4.9 "manual correction/attachment").

### 4. Browser-compatible serving (decided here, built in slice 3)

Browsers play WebVTT, not SubRip/ASS. The playback layer converts external
`.srt` to `.vtt` on demand into a deterministic cache (mirroring the thumbnail
cache), serves `.vtt` directly, and reports per-video **playability** from the
container/codec so the UI can show a fallback state instead of a silent
failure (§6.1 — do not claim support merely because a file can be served).
Embedded-stream extraction/transcoding is deferred to the §6.2 fallback
milestone; embedded tracks are surfaced in metadata now but not yet served as
standalone `.vtt`.

## Consequences

- `MediaKind.SUBTITLE` / `FileRole.SUBTITLE` already exist; the scanner gains
  subtitle extension recognition so external subtitles become `AssetFile`s.
- Deleting a video cascades its tracks; deleting an external subtitle file
  nulls the track's `source_file_id` (the track row can then be cleaned up by
  the service) rather than orphaning a dangling FK.
- The `subtitle_tracks` migration follows the established SQLite batch +
  app-independent `render_item` conventions, and is `ruff-format`ed.

## References

- `AGENTS.md` §4.9 (subtitles), §6.1 (direct playback), §13 (avoid speculative
  abstraction), §15 (subtitle matching + range-request tests)
- ADR-0002 (core schema conventions reused here)
