# AGENTS.md

This file is the canonical instruction set for every coding agent working in this repository. If another agent-specific file conflicts with this one, `AGENTS.md` wins.

## 1. Project mission

Build a local-first, Eagle-inspired media asset manager for a private video and image library stored on local disks or NAS-mounted storage.

The product is not primarily a Plex/Jellyfin replacement and must not drift into a generic file gallery. Playback matters, but the core value is metadata-first organization:

- asset bundles composed of multiple related files;
- custom covers and generated thumbnails;
- hierarchical tags plus tag groups;
- hierarchical virtual folders with multi-folder membership;
- notes, hyperlinks, ratings, titles, and technical metadata;
- fast filtering, saved Smart Folders, and multiple browsing layouts;
- metadata-only linking to existing files without copying them;
- a polished desktop-class web interface, followed later by TV/mobile clients.

The first product target is the computer-side web application. Android TV support comes after the core library, organization, filtering, and playback experience are stable.

## 2. Product principles

1. **The visible item is an Asset Bundle, not a file.** One card may represent a cover, several videos, subtitle files, screenshots, album images, and attachments.
2. **Preserve the user's disk organization.** Link existing files in place by default. Do not require an Eagle-style managed hash directory.
3. **Metadata-only and non-destructive first.** The MVP must not rename, move, delete, or overwrite original files.
4. **Eagle-inspired, not an exact clone.** Reuse proven interaction patterns while adapting them to bundles, subtitles, NAS use, and the web.
5. **Local-first and self-hosted.** The normal deployment is Docker on a Linux NAS/server, accessed over a LAN. Tailscale access may be added without changing the core architecture.
6. **Scale by design.** Assume multi-terabyte libraries, multi-gigabyte files, and enough items that naïve full scans, full hashing, or non-virtualized rendering are unacceptable.
7. **One source of truth.** The application database is authoritative for app metadata. Eagle migration is one-way initially; do not implement bidirectional synchronization.
8. **Progressive capability.** Direct playback comes first; remux/transcoding, write-mode file operations, native wrappers, and multi-user behavior come later.

## 3. Fixed product decisions

Unless the product owner explicitly changes them, treat these as settled:

- Build from scratch rather than forking SmartGallery DAM.
- Use SmartGallery DAM, Eagle, and open-source Jellyfin clients such as Wholphin as reference material only.
- Start with a Dockerized server and an app-like web UI/PWA.
- A native macOS app is not required for the first release; a Tauri shell may be evaluated later.
- The application links to files already on disk and stores metadata separately.
- Asset bundle metadata is shared across the bundle.
- Individual files may have a display title, note, and source/origin hyperlink in the schema; those file-level editing controls may be deferred.
- Individual files do not need ratings.
- Tags are hierarchical.
- Tag groups also exist and are independent of the hierarchy. A tag may belong to multiple groups.
- Folders are hierarchical virtual collections. A bundle may belong to zero, one, or many folders.
- Selecting a tag or folder parent can include descendants; the UI exposes a toggle.
- The first user is a single owner. Avoid choices that make later multi-user support require a full rewrite.
- Start with metadata-only removal. File rename/move/delete capabilities come later under an explicit write mode.
- Both embedded and external subtitles must be supported.
- Begin with the desktop/computer experience. A TV web UI may reuse the same frontend later.

## 4. Canonical domain model

Names may evolve, but the concepts and relationships must remain clear.

### 4.1 Storage root

A `StorageRoot` represents a server-visible directory mounted into the application, for example `/mnt/media`.

Required concepts:

- stable ID;
- display name;
- canonical server path;
- read-only/write-enabled mode;
- optional path aliases for future platform-specific clients;
- availability/status;
- scan settings and timestamps.

Store file locations as `storage_root_id + relative_path` whenever possible. Never expose arbitrary unrestricted server paths through the API.

### 4.2 Asset bundle

An `AssetBundle` is the primary user-facing object shown in grids, lists, search results, folders, tags, and Smart Folders.

Bundle-level metadata includes:

- stable ID, preferably UUID or ULID;
- displayed asset title;
- shared note;
- shared rating;
- selected cover file;
- selected primary playable file;
- creation, import, and update timestamps;
- aggregate media properties where useful;
- optional extensible metadata JSON for non-core fields.

### 4.3 Asset file

An `AssetFile` is a physical file linked into one Asset Bundle.

Required concepts:

- bundle ID;
- storage root ID and relative path;
- original filename;
- display title defaulting to the filename;
- optional file-level note and source/origin hyperlink, even if their UI is deferred;
- media kind and MIME type;
- file role;
- order/sequence within the bundle;
- size and modified timestamp;
- availability/missing state;
- quick fingerprint and optional full hash;
- extracted technical metadata;
- import/source metadata.

Suggested roles:

- `primary_video`
- `video_part`
- `alternate_version`
- `cover`
- `image`
- `screenshot`
- `album_image`
- `subtitle`
- `attachment`
- `generated_derivative`
- `other`

One physical file should normally have one owning bundle. Do not add cross-bundle aliases until a real use case requires them.

### 4.4 Covers and thumbnails

Cover precedence:

1. user-selected cover file;
2. user-selected frame from a video;
3. automatically extracted frame from the primary video;
4. generated placeholder.

Original cover files are Asset Files. Generated thumbnails, preview frames, storyboards, and converted derivatives live in application cache storage and must be reproducible.

### 4.5 Tags

Tags are hierarchical and support parent-child relationships.

A bundle can have many tags. Selecting a parent tag should include descendants by default, with a visible toggle to disable descendant inclusion.

The hierarchy and tag groups are separate systems:

- hierarchy expresses semantic parent-child relationships;
- groups organize tags for faster browsing and selection;
- a tag may belong to multiple groups;
- a group does not become the tag's parent and does not change descendant semantics.

The implementation may use an adjacency list with recursive CTEs, a closure table, or another documented strategy. Record the choice in an ADR and test descendant queries carefully.

### 4.6 Tag groups

A `TagGroup` is a navigational category such as Genre, Subject, Status, Source, or Person.

Required behavior:

- many-to-many membership between tags and groups;
- optional ordering of groups and tags within groups;
- counts in the picker;
- tag search independent of group selection;
- the same tag may appear in multiple groups without duplication in the underlying tag table.

### 4.7 Virtual folders

Folders are hierarchical virtual collections, not physical filesystem directories.

Required behavior:

- parent-child nesting;
- many-to-many membership between bundles and folders;
- zero-folder bundles appear under `Uncategorized`;
- folder counts;
- `Show subfolder contents` / `Include descendants` toggle;
- drag-and-drop assignment in a later UI milestone;
- no file movement when folder membership changes.

### 4.8 Smart folders

A Smart Folder is a named, saved filter expression plus optional view preferences.

Store a versioned structured expression, not raw SQL and not an opaque UI string.

Implemented shape:

```json
{
  "version": 1,
  "root": {
    "op": "and",
    "children": [
      {
        "field": "tags",
        "operator": "contains_all",
        "value": ["tag-id-1", "tag-id-2"],
        "include_descendants": true
      },
      {
        "field": "rating",
        "operator": "gte",
        "value": 4
      }
    ]
  }
}
```

The initial editor may support one condition group like Eagle's `any/all of the following are true/false`. The data model permits nested `and`, `or`, and `not` groups later.

### 4.9 Subtitle tracks

Subtitle support is first-class, not an incidental file attachment.

Support:

- external subtitles represented by Asset Files;
- embedded subtitle streams detected by `ffprobe`;
- links from a subtitle track to a specific video file;
- language, label, format, default/forced flags, and ordering;
- auto-linking based on same directory and basename conventions;
- manual correction/attachment;
- conversion to a browser-compatible cached format where necessary.

The implemented model uses `SubtitleTrack` with either an external file reference or an embedded stream index. Embedded stream extraction/serving is deferred to the remux/transcode fallback milestone.

## 5. File discovery, linking, and identity

### 5.1 Fast add

The primary import workflow links existing files without copying them. Adding an existing file must be fast even over a network-mounted volume.

Do not full-hash multi-gigabyte files during normal add.

Initial identity/fingerprint inputs may include:

- storage root and normalized relative path;
- file size;
- high-resolution modified time;
- optional sampled/quick hash;
- optional inode/device data when reliable;
- lazy full hash for duplicate verification or repair.

### 5.2 Scanning

Network filesystems may not provide reliable file watcher events. The application must support:

- manual incremental rescan;
- scheduled rescan;
- resumable background scan jobs;
- batched database writes;
- progress reporting;
- cancellation;
- missing-file detection without immediately deleting metadata.

Do not run full library scans in request handlers.

### 5.3 Moved-file repair

When a linked path disappears, preserve the Asset File row as missing. Provide later repair logic using path candidates, filename, size, timestamps, quick hashes, and full hashes when needed.

### 5.4 Optional managed imports

## 6. Media processing and playback

Use `ffprobe` for technical metadata and stream discovery. Use `ffmpeg` for generated derivatives.

The processing pipeline should eventually provide:

- dimensions, duration, codecs, container, bitrate, frame rate, and stream metadata;
- video thumbnail extraction;
- optional storyboard/contact sheet;
- cover frame selection;
- external subtitle conversion;
- remux/transcoding jobs;
- deterministic cache keys and safe cache cleanup.

### 6.1 Direct playback

The server must support HTTP range requests and correct content headers.

Do not claim universal format support merely because a file can be served. Browser support for WMV, AVI, MOV, H.264, and H.265 varies. Detect capability and show a clear fallback state.

### 6.2 Fallback playback

After direct playback is stable, add an FFmpeg-backed fallback:

1. direct stream where client/container/codec permit;
2. remux when codecs are compatible but the container is not;
3. HLS or another adaptive/transcoded format when necessary.

Remote quality/bitrate selection is a later milestone, designed for Tailscale use. Keep transcoding APIs and job models extensible.

## 7. Eagle migration

The goal is one-way migration from Eagle into this application.

Rules:

- prefer official Eagle API/export mechanisms;
- if API coverage is insufficient, inspect Eagle library files in read-only mode;
- never write into Eagle's internal library;
- always support dry run and review before commit;
- preserve Eagle tags, tag groups, folders, titles, notes, links, ratings, and file references where available;
- initially map each Eagle item to one Asset Bundle;
- suggest merges for likely video/cover/subtitle/part relationships;
- never auto-merge destructively without a reviewable report;
- make imports idempotent or record source IDs to avoid accidental duplication.

Grouping heuristics may consider:

- same directory;
- matching or similar basenames;
- numeric part suffixes;
- language subtitle suffixes;
- names such as `cover`, `poster`, `thumbnail`, or `thumb`;
- Eagle folder/tag proximity;
- manual mapping.

## 8. UI and interaction direction

The UI should feel like a desktop media organizer, not an administration dashboard.

Use the supplied Eagle screenshots as interaction references:

- `Main library view (justified layout view)`
- `List layout view`
- `Metadata panel`
- `Folder tree`
- `Tag select view`
- `Top bar inside a folder`
- `Smart folder creation`

Store copies under `docs/reference/eagle/` when available. Do not commit private source media.

### 8.1 App shell

Recommended layout:

- left sidebar: system views, Smart Folders, hierarchical virtual folder tree, tag entry points;
- top toolbar: breadcrumbs, filter categories, search, sort, view controls, zoom/density control;
- center: virtualized bundle browser;
- right inspector: selected bundle metadata and files;
- modal/detail viewer: media preview and playback.

System views should include, where useful:

- All
- Uncategorized
- Untagged
- Recently Added / Recently Used
- Random
- All Tags
- Missing Files
- Trash later

### 8.2 Browsing layouts

Plan for:

- justified layout similar to Eagle/Google Photos;
- fixed grid;
- list/table layout;
- masonry/waterfall layout;
- persistent layout, zoom, sort, and filter preferences per view where practical.

All large collections must be virtualized or paginated. Never render an entire large library into the DOM.

### 8.3 Bundle cards

A bundle card should communicate:

- selected cover/thumbnail;
- title;
- media/file count when greater than one;
- primary duration or image dimensions;
- rating and lightweight status indicators where useful;
- missing/offline state;
- selection state.

### 8.4 Inspector

The inspector should expose bundle-level fields first:

- cover;
- title;
- note;
- tags;
- folders;
- rating;
- aggregate properties;
- files in the bundle.

Selecting a file within the bundle reveals file-level technical metadata and, later, display title/note/source-link controls. If the product later adds bundle-level links, expose them with the other bundle-level fields.

### 8.5 Tag selector

The tag selector should combine the useful Eagle group picker with the new hierarchy:

- search field with immediate client-side filtering of already-loaded options;
- group/category list with counts;
- tag tree/list with hierarchy indentation;
- tags can appear under multiple groups but retain one semantic hierarchy location;
- include and exclude states;
- `any` / `all` rule for included tags;
- descendant toggle;
- keyboard and mouse support;
- clear visual distinction between included, excluded, and neutral tags.

Do not make right-click the only way to exclude; provide an accessible alternative.

### 8.6 Folder view

Inside a folder, show:

- breadcrumb/title;
- direct subfolder selector/count;
- `Show subfolder contents` toggle;
- normal filters and views;
- folder counts in the sidebar.

### 8.7 Smart Folder editor

The initial editor should follow the supplied Eagle reference:

- Smart Folder name;
- top-level `all` or `any` selector;
- top-level true/false inversion;
- repeatable condition rows;
- field selector;
- operator selector;
- typed value control with autocomplete where appropriate;
- add/remove buttons;
- live result count;
- server-side validation and preview;
- clear error messages.

Typed field examples:

- title/name, note, URL/source: contains, not contains, equals, starts with, regex later;
- tags/folders: contains any, contains all, contains none, exact set later, descendant toggle;
- rating: equals, greater/less than;
- type/extension/codec: fixed-option multi-select;
- duration/size/dates: range operators;
- file count and missing state;
- subtitle presence.

The simple filter toolbar and Smart Folder editor must compile to the same canonical filter expression model.

## 9. Suggested implementation stack

Use this stack unless an existing repository strongly justifies another choice. Any major deviation requires an ADR.

### Backend

- Python 3.12+
- FastAPI
- SQLAlchemy 2.x
- Alembic
- Pydantic
- SQLite in WAL mode for the initial deployment
- `ffmpeg` and `ffprobe`
- background jobs implemented with a simple database-backed worker or another lightweight documented mechanism

Do not introduce Redis, Celery, Postgres, Elasticsearch, or a separate search service without demonstrated need.

### Frontend

- React
- TypeScript with strict mode
- Vite
- TanStack Query
- TanStack Router or another typed router
- TanStack Virtual or an equivalent virtualizer
- accessible headless primitives such as Radix UI
- a focused state solution only where server/cache state is insufficient
- Playwright for end-to-end tests

### Search and filters

- SQLite FTS5 for title, notes, links/source, and filename search where appropriate;
- relational indexes for tag/folder/rating/date/type filters;
- server-side filtering, sorting, and pagination;
- no client-side loading of the full library.

### Repository layout

A monorepo is recommended:

```text
apps/
  server/
  web/
packages/
  api-client/        # optional generated or shared types
docs/
  adr/
  reference/eagle/
infra/
  docker/
```

Adapt to existing repository conventions rather than reorganizing without reason.

## 10. API design

- Version public endpoints, for example `/api/v1/...`.
- Publish and validate OpenAPI.
- Use stable IDs, not paths, as resource identifiers.
- Keep path resolution server-side.
- Paginate all collection endpoints.
- Support deterministic sorting with a stable tie-breaker.
- Return structured errors.
- Validate filter expressions against an allowlist of fields/operators.
- Defend against path traversal, symlink escape, and unauthorized storage-root access.
- Separate metadata removal from physical file deletion.
- Make long-running operations asynchronous jobs with status endpoints.

## 11. Performance and reliability requirements

Design for multi-terabyte storage and large files up to at least 20 GB.

Required practices:

- lazy full hashing;
- incremental scans;
- batched inserts/updates;
- bounded worker concurrency;
- virtualized UI;
- server-side pagination/filtering/sorting;
- thumbnail and metadata caches outside the source directories;
- database indexes justified by real queries;
- cancellation and retry for jobs;
- no unbounded memory collection of scan results;
- graceful handling of unavailable NAS mounts;
- backups of the metadata database and configuration;
- schema migrations with rollback/backup guidance.

Profile before adding complex infrastructure. Record performance baselines for representative libraries.

## 12. Security and privacy

- Treat all source media and metadata as private.
- Never upload media or metadata to external services unless explicitly enabled by the owner.
- Do not add analytics or telemetry by default.
- Do not log notes, URLs, filenames, or paths unnecessarily.
- Never commit secrets, databases, thumbnails, caches, or source media.
- Use a non-root container user where practical.
- Validate all file paths against configured storage roots.
- Consider optional single-owner authentication before remote/Tailscale use.
- Clearly document that direct public internet exposure is unsupported unless hardened separately.

## 13. Future compatibility

Avoid schema choices that block these later features:

- multiple users with per-user watch history, favorites, and view preferences;
- write-mode rename/move/delete with audit logs and recovery;
- remote quality selection and hardware-accelerated transcoding;
- Android TV native client;
- Tauri desktop shell;
- app-managed imports;
- metadata sidecar export;
- plugin/import adapters;
- additional asset types.

Do not implement these prematurely. Add nullable ownership/audit fields only when they have a clear migration path and do not complicate the MVP.

## 14. Code quality standards

- Use clear module boundaries. Avoid god files and god services.
- Separate API routes, schemas, persistence, domain services, scan logic, media processing, and path handling.
- Keep business logic out of UI components and HTTP route functions.
- Use type checking in both backend and frontend.
- Document public interfaces and non-obvious invariants.
- Comments should explain why, edge cases, and safety constraints; do not narrate obvious code.
- Prefer small composable functions and explicit error handling.
- Avoid speculative abstractions.
- Do not add dependencies without documenting the reason and maintenance cost.
- Keep generated files clearly marked and reproducible.

## 15. Testing expectations

Add tests with every non-trivial feature.

Minimum coverage areas:

- storage-root path normalization and traversal rejection;
- asset bundle/file relationships;
- tag hierarchy and descendant behavior;
- tag group many-to-many behavior;
- folder hierarchy and descendant inclusion;
- filter AST validation and SQL compilation;
- Smart Folder preview counts;
- scanner idempotency and missing-file behavior;
- quick fingerprint/full-hash transitions;
- subtitle matching and track selection;
- range requests and playback headers;
- thumbnail job deduplication;
- metadata-only deletion safeguards;
- Eagle import dry run and idempotency;
- critical UI flows with Playwright.

Tests must not depend on private media. Generate small synthetic fixtures or use redistributable test assets.

## 16. Git and branch workflow

Keep `main` stable and reviewable.

### Branches

Use a dedicated branch for each meaningful feature or fix, for example:

- `feat/core-domain-model`
- `feat/storage-scanner`
- `feat/bundle-browser`
- `feat/tag-filtering`
- `feat/smart-folders`
- `feat/subtitle-playback`
- `feat/eagle-import`
- `fix/path-normalization`
- `docs/architecture`

Do not combine unrelated large features in one branch.

### Commits

Commit frequently at meaningful checkpoints. Commits should be small enough to review and should normally leave the branch buildable.

Use descriptive conventional-style messages when practical:

- `feat: add asset bundle and file schema`
- `fix: reject storage-root path traversal`
- `test: cover descendant tag filters`
- `docs: record scanner architecture decision`
- `refactor: split ffprobe adapter from job service`

Do not create meaningless `update` or `changes` commits.

### Pull requests

Merge large features through pull requests. A large feature is one that changes architecture, data models, user-visible workflows, or multiple subsystems.

Every PR should include:

- problem and scope;
- design summary;
- screenshots/video for UI changes;
- migration notes;
- tests run and results;
- performance/safety considerations;
- changelog entry;
- follow-up work explicitly out of scope.

When no hosted PR system is available, create a PR-style markdown summary under `docs/pr/` or in the final handoff message before merging.

### Rebase and force push

- Never force-push `main`.
- Before rebasing into main, check whether the local `main` is up to date.
- Rebase feature branches as needed.
- Force-push only non-main branches and use `--force-with-lease`.
- Avoid rewriting a shared branch without communicating the intent.
- Prefer preserving meaningful commits; squash noisy fixup commits before merge.

### Merging

- Run required tests, linters, type checks, and migrations before merge.
- Rebase or update the branch against current `main`.
- Resolve conflicts intentionally; do not blindly choose one side.
- Update documentation and changelog in the same branch.

## 17. Changelog and documentation

Maintain `CHANGELOG.md` using an `Unreleased` section with:

- Added
- Changed
- Fixed
- Removed
- Security
- Internal

Update the changelog for every meaningful user-visible or operational change.

Maintain at least:

- `README.md`
- `docs/architecture.md`
- `docs/development.md`
- `docs/deployment.md`
- `docs/data-model.md`
- `docs/filter-language.md`
- `docs/eagle-migration.md` when migration begins
- `docs/adr/` for consequential decisions
- `docs/STATUS.md` for current milestone, known issues, and next steps
- `CHANGELOG.md`

When behavior changes, update documentation in the same branch.

## 18. Agent execution loop

Before changing code:

1. Read `AGENTS.md`, `README.md`, `docs/STATUS.md`, relevant ADRs, and the current changelog.
2. Inspect the repository and existing conventions.
3. State the intended scope and branch.
4. Identify migrations, safety risks, and tests.

For each meaningful step:

1. implement a coherent slice;
2. run focused tests and static checks;
3. update docs/changelog when applicable;
4. commit the slice;
5. record remaining work.

At the end of a branch:

1. run the full relevant test suite;
2. verify the feature manually where practical;
3. add screenshots for UI work;
4. update `docs/STATUS.md`;
5. prepare a PR-style summary;
6. do not claim completion unless it was actually run or verified.

Ask the product owner only when a decision is genuinely blocking or destructive. For non-blocking ambiguity, choose the safest metadata-only default, document the assumption, and proceed incrementally.

## 19. Definition of done

A feature is done only when:

- the code is implemented with clear boundaries;
- migrations are included and tested when needed;
- focused tests pass;
- type checks and linters pass;
- security/path/file-safety concerns are addressed;
- UI behavior is keyboard-accessible where applicable;
- loading, empty, error, and large-data states are handled;
- documentation and changelog are updated;
- the branch has a reviewable history;
- a PR-style summary exists for major changes;
- the feature has been run or otherwise verified.

## 20. Explicit anti-goals for the first release

Do not spend MVP time on:

- internet metadata scraping;
- AI auto-tagging, OCR, or face recognition;
- social or collaboration features;
- public cloud hosting;
- full multi-user RBAC;
- bidirectional Eagle synchronization;
- destructive file management enabled by default;
- native macOS or Android TV applications;
- a general plugin marketplace;
- a complex distributed job system;
- premature replacement of SQLite.

The first release succeeds when the owner can link an existing NAS library, group related files into bundles, assign covers/tags/folders/metadata, filter and browse quickly in an Eagle-like interface, and play supported media with correctly linked subtitles without modifying the source files.
