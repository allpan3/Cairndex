# ADR-0016: Ordered bundle media cursor

- Status: accepted
- Date: 2026-07-14
- Branch/PR: `main` (direct owner-requested change)
- Supersedes: ADR-0009's selected-primary-file provisions

## Context

Bundle playback previously mixed three independent ideas: static cover artwork,
an optional `primary_file_id`, and per-video watch progress. Bundle cards could
scrub only when the effective cover was itself a video, while the viewer chose a
primary video before consulting file order. This broke the expected album model:
an image cover hid the resumable video preview, image positions could not be
remembered, and the order shown in Files in bundle was not the authoritative
playback order.

## Decision

1. Each bundle has one current media file stored in `bundle_cursors`. The row is
   keyed by `bundle_id`, points to a stable member `AssetFile.id`, and updates
   independently of bundle metadata/versioning.
2. The effective current file is the valid cursor, otherwise the most recently
   updated unfinished legacy video progress, otherwise the first ordered
   available media supported by the viewer. A supported missing cursor remains
   current so opening it can show the correct missing-file state.
3. `AssetFile.sequence` plus stable id tie-break is the media playlist order.
   Navigation and end-of-video advance follow that order and ignore sidecars or
   other file types without a viewer stage.
4. Video timestamps remain in `playback_progress`, keyed by file id. Images need
   only the bundle cursor. Continue Watching includes a bundle only when its
   current cursor is an unfinished video.
5. Cover artwork is independent. Cover precedence is explicit cover, first
   image, first video, then placeholder. Card hover overlays the current cursor
   media: an image stays still; a video uses direct/storyboard preview beginning
   at its saved position.
6. `primary_file_id` remains as an unused nullable legacy database column so
   existing library databases need no destructive migration. It is removed from
   public API/UI behavior and new code does not read or write it. The legacy
   `primary_video` grouping role may remain on existing rows, but is displayed
   simply as `video` and carries no playback priority.

## Alternatives considered

- Reuse `primary_file_id` as the cursor — rejected because viewer navigation is
  transient owner state and must not bump or conflict with shared bundle edits.
- Derive the cursor only from video progress — rejected because images and
  future non-video media have no timestamp row.
- Make the cover the current media — rejected because artwork and playback
  position are independent user choices.

## Consequences

- Existing libraries gain one additive table on open; no source file or library
  path is modified.
- The viewer performs one small idempotent cursor write when its selected media
  changes. Browse invalidation refreshes card preview/stats and Continue Watching.
- Adding a future openable type requires one viewer stage and one update to the
  central supported-media predicate; ordering and cursor persistence remain the
  same.

## References

- ADR-0008 (per-library metadata)
- `docs/product-brief.md` — bundles, covers, and playback
- `apps/server/src/cairndex/services/bundle_cursor.py`
