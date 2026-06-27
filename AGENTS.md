# AGENTS.md

This file is the canonical instruction set for every coding agent working in this repository. If another agent-specific file conflicts with this one, `AGENTS.md` wins.

## 1. Project mission

Build a local-first, Eagle-inspired media asset manager for a private video and image library stored on local disks or NAS-mounted storage.

The product is not primarily a Plex/Jellyfin replacement and must not drift into a generic file gallery. Playback matters, but the core value is metadata-first organization:

- asset bundles composed of multiple related files;
- custom covers and generated thumbnails;
- hierarchical tags plus tag groups;
- hierarchical collections with multi-collection membership;
- a separate read-only file view for browsing configured storage-root directories;
- notes, source/origin hyperlinks, ratings, titles, and technical metadata;
- fast filtering, saved Smart Collections, and multiple browsing layouts;
- metadata-only linking to existing files without copying them;
- robust missing-file and moved-file repair so logical organization survives filesystem changes;
- a polished desktop-class web interface, followed later by TV/mobile clients.

The first product target is the computer-side web application. Android TV support comes after the core library, organization, filtering, and playback experience are stable.

## 2. Product principles

1. **The visible library item is an Asset Bundle, not a file.** One card may represent a cover, several videos, subtitle files, screenshots, album images, and attachments.
2. **Collections are logical; directories are physical.** Collection View is the metadata-first bundle browser. File View is an in-app browser over configured storage roots. Collection membership must never imply a file move.
3. **Preserve the user's disk organization.** Link existing files in place by default. Do not require an Eagle-style managed hash directory.
4. **Metadata-only and non-destructive first.** The MVP must not rename, move, delete, or overwrite original files. In-app physical moves are a later explicit write-mode feature.
5. **Logical organization must survive filesystem moves.** If a linked path changes externally, Cairndex should preserve bundle, collection, tag, note, rating, cover, primary-file, and subtitle metadata, and repair the existing file row when it can do so confidently.
6. **Eagle-inspired, not an exact clone.** Reuse proven interaction patterns while adapting them to bundles, subtitles, NAS use, read-only file browsing, and the web.
7. **Local-first and self-hosted.** The normal deployment is Docker on a Linux NAS/server, accessed over a LAN. Tailscale access may be added without changing the core architecture.
8. **Scale by design.** Assume multi-terabyte libraries, multi-gigabyte files, and enough items that naïve full scans, full hashing, or non-virtualized rendering are unacceptable.
9. **One source of truth.** The application database is authoritative for app metadata. Eagle migration is one-way initially; do not implement bidirectional synchronization.
10. **Progressive capability.** Direct playback comes first; remux/transcoding, write-mode file operations, native wrappers, and multi-user behavior come later.

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
- The old product/API/model concept named `folder` must be renamed at all levels to `collection`.
- Collections are hierarchical logical groupings. A bundle may belong to zero, one, or many collections.
- Collections contain bundles only, not loose files.
- Selecting a tag or collection parent can include descendants; the UI exposes a toggle.
- Smart Folders should be renamed to Smart Collections / saved collection filters, using the same canonical filter-expression model.
- File View browses only configured storage roots. It is read-only for now, hides hidden files/directories, shows all other files/directories, and visually distinguishes files that Cairndex can open natively from unsupported files.
- Start with metadata-only removal. File rename/move/delete capabilities come later under an explicit write mode.
- Move repair is automatic during scan/rescan/reconciliation when confidence is high. Do not require a separate normal user workflow for repair.
- Duplicate detection is deferred. If a still-present file is also found at another path, treat that as an unresolved duplicate/copy candidate later, not as an automatic bundle merge.
- Bundles remain flexible logical objects. A bundle does not require a canonical physical folder and may contain files from different directories or storage roots.
- Both embedded and external subtitles must be supported.
- Begin with the desktop/computer experience. A TV web UI may reuse the same frontend later.
- The first user is a single owner. Avoid choices that make later multi-user support require a full rewrite.

## 4. Canonical domain model

Names may evolve, but the concepts and relationships must remain clear. Current implementation names that still say `folder` are legacy names until the collection refactor replaces them.

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

Store file locations as `storage_root_id + relative_path` whenever possible. Never expose arbitrary unrestricted server paths through the API. File View must browse through this storage-root abstraction, not through unrestricted absolute server paths.

### 4.2 Asset bundle

An `AssetBundle` is the primary user-facing object shown in grids, lists, search results, collections, tags, and Smart Collections.

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

A bundle is logical, not necessarily a physical folder. Do not make bundle identity or collection membership depend on a bundle-root directory. An optional representative directory may be added later only for convenience, not as the source of truth.

### 4.3 Asset file

An `AssetFile` is a physical file linked into one Asset Bundle.

Required concepts:

- stable file ID that survives path repair;
- bundle ID;
- storage root ID and relative path;
- original filename;
- display title defaulting to the filename;
- optional file-level note and source/origin hyperlink, even if their UI is deferred;
- media kind and MIME type;
- file role;
- order/sequence within the bundle;
- size and modified timestamp;
- availability/missing/stale state;
- quick fingerprint and optional full hash;
- optional filesystem identity such as device/inode/file ID when reliable;
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

One physical path should normally have one owning bundle. Do not add cross-bundle aliases until a real use case requires them.

When a file is moved and repaired, update the existing `AssetFile` row rather than creating a replacement row. Keeping the same `AssetFile.id` preserves bundle membership, cover/primary references, subtitles, collections, tags, notes, ratings, and generated cache identity where applicable.

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

### 4.7 Collections

Collections are hierarchical virtual groupings, not physical filesystem directories.

Required behavior:

- parent-child nesting;
- many-to-many membership between bundles and collections;
- zero-collection bundles appear under `Uncategorized` or another clearly named system view;
- collection counts;
- `Show subcollection contents` / `Include descendants` toggle;
- drag-and-drop assignment in a later UI milestone;
- no file movement when collection membership changes.

The product term is `collection`. Do not introduce new user-facing, API, ORM, schema, migration, or documentation concepts named `folder` except when explicitly referring to external products such as Eagle or to ordinary filesystem directories in File View.

### 4.8 Smart Collections

A Smart Collection is a named, saved filter expression plus optional view preferences. It replaces the old Smart Folder terminology.

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

The initial editor may support one condition group like Eagle's `any/all of the following are true/false`. The data model permits nested `and`, `or`, and `not` groups later. Collection conditions must target collection IDs and support descendant inclusion in the same way direct Collection View browsing does.

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

### 4.10 File view

File View is a read-only in-app browser over configured storage roots.

Required behavior:

- browse only configured storage roots;
- display directories and all non-hidden files, not just media files;
- hide hidden dotfiles/dot-directories and platform-hidden files where practical;
- validate every requested path through the storage-root path-safety layer;
- never expose unrestricted absolute server paths;
- visually separate files Cairndex can open natively from unsupported files;
- allow later actions such as fast-add/link-to-bundle/create-bundle from selected files;
- do not move, rename, delete, or rewrite source files in the first File View milestone.

A supported/openable file means a file that the current app can preview or play natively through the web UI. Recognized-but-not-openable files may still be shown, linked, or treated as attachments where the bundle model permits it. PDF preview is optional future support; do not mark PDFs as natively supported until a real viewer path exists.

## 5. File discovery, linking, and identity

### 5.1 Fast add

The primary import workflow links existing files without copying them. Adding an existing file must be fast even over a network-mounted volume.

Do not full-hash multi-gigabyte files during normal add.

Initial identity/fingerprint inputs may include:

- storage root and normalized relative path;
- file size;
- high-resolution modified time;
- sampled/quick hash where cheap;
- filesystem identity such as inode/device/file ID when reliable;
- lazy full hash only for duplicate verification, ambiguous repair, or explicit user-requested integrity work.

### 5.2 Scanning

Network filesystems may not provide reliable file watcher events. The application must support:

- manual incremental rescan;
- scheduled rescan;
- resumable background scan jobs;
- batched database writes;
- progress reporting;
- cancellation;
- missing-file detection without immediately deleting metadata;
- automatic high-confidence moved-file repair during reconciliation.

Do not run full library scans in request handlers.

The scanner is the reconciliation mechanism between the filesystem and the metadata database. It should walk storage roots, observe current files, update known paths, mark absent paths missing/stale, and repair old `AssetFile` rows to new paths before creating replacement bundles for newly discovered files.

### 5.3 Moved-file repair

When a linked path disappears, preserve the Asset File row as missing/stale. On the same scan or a later rescan, try to identify whether a newly observed path is the same physical file.

Repair must:

- update the existing `AssetFile.storage_root_id` and `relative_path` rather than creating a new file row;
- keep the `AssetFile.id` stable;
- preserve the owning bundle, collections, tags, notes, rating, cover/primary selection, subtitle links, and import records;
- run automatically as part of scan/rescan/reconciliation for high-confidence matches;
- avoid destructive changes and avoid merging duplicates.

Confidence signals may include:

- same platform file identity (`st_dev`/`st_ino` or equivalent) when reliable;
- same storage root or clearly equivalent root alias;
- same filename and extension;
- same size and high-resolution mtime;
- same sampled/quick hash;
- optional full hash only when needed for ambiguous candidates and only outside hot request paths.

A same-path content edit is not a move. For example, annotating a PDF may change size, mtime, sampled hash, and full hash while the logical file remains the same because the path and/or filesystem identity are stable. A cross-filesystem move followed by an edit may not be confidently repairable; keep the old file missing and expose a later manual repair/candidate workflow rather than guessing.

If the old path still exists and a similar or identical new path appears, do not auto-merge. Treat that as a future duplicate/copy candidate. Duplicate detection is out of scope for the first collection/file-view refactor.

### 5.4 Optional managed imports

Copy/move into an app-managed directory is a future optional mode, not an MVP requirement. Do not couple core IDs or lookup logic to a hash-directory layout.

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

When opening/streaming/thumbnailing a file, re-check that the resolved path still exists. If it no longer exists, mark the file stale/missing and rely on the scanner to repair it on the next reconciliation when possible.

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
- map Eagle folders to Cairndex collections;
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

- left sidebar: system views, Smart Collections, hierarchical collection tree, file-view entry points, tag entry points;
- top toolbar: breadcrumbs, filter categories, search, sort, view controls, zoom/density control;
- center: virtualized bundle browser in Collection View; storage-root directory browser in File View;
- right inspector: selected bundle metadata and files, or selected file/directory details in File View;
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

Plan for Collection View:

- justified layout similar to Eagle/Google Photos;
- fixed grid;
- list/table layout;
- masonry/waterfall layout;
- persistent layout, zoom, sort, and filter preferences per view where practical.

All large collections must be virtualized or paginated. Never render an entire large library into the DOM.

Plan for File View:

- directory list/tree navigation scoped to storage roots;
- file table/list layout with name, type, size, modified time, support/openable state, and linked/missing state where known;
- no hidden files by default;
- no write actions in the first milestone.

### 8.3 Bundle cards

A bundle card should communicate:

- selected cover/thumbnail;
- title;
- media/file count when greater than one;
- primary duration or image dimensions;
- rating and lightweight status indicators where useful;
- missing/offline/stale state;
- selection state.

### 8.4 Inspector

The inspector should expose bundle-level fields first:

- cover;
- title;
- note;
- tags;
- collections;
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

### 8.6 Collection view

Inside a collection, show:

- breadcrumb/title;
- direct subcollection selector/count;
- `Show subcollection contents` toggle;
- normal filters and views;
- collection counts in the sidebar.

### 8.7 File view

Inside File View, show:

- storage-root selector;
- filesystem breadcrumbs;
- directories first, then files;
- all non-hidden files/directories;
- support/openable state;
- linked-to-bundle state when known;
- missing/stale indicators when a previously linked path is gone;
- read-only affordances until explicit write mode exists.

File View is not a replacement for Collection View. It is a filesystem browser and linking/diagnostic surface. Collection View remains the primary organization and browsing surface.

### 8.8 Smart Collection editor

The initial editor should follow the supplied Eagle reference:

- Smart Collection name;
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
- tags/collections: contains any, contains all, contains none, exact set later, descendant toggle;
- rating: equals, greater/less than;
- type/extension/codec: fixed-option multi-select;
- duration/size/dates: range operators;
- file count and missing state;
- subtitle presence.

The simple filter toolbar and Smart Collection editor must compile to the same canonical filter expression model.

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
- relational indexes for tag/collection/rating/date/type filters;
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
- Use collection terminology in public APIs and schemas. Do not add new `/folders` APIs after the collection refactor.
- Keep path resolution server-side.
- Paginate all list endpoints.
- Support deterministic sorting with a stable tie-breaker.
- Return structured errors.
- Validate filter expressions against an allowlist of fields/operators.
- Defend against path traversal, symlink escape, and unauthorized storage-root access.
- Separate metadata removal from physical file deletion.
- Make long-running operations asynchronous jobs with status endpoints.
- File View endpoints must accept only `storage_root_id + relative_path` and must reject absolute paths, traversal, and symlink escapes.

## 11. Performance and reliability requirements

Design for multi-terabyte storage and large files up to at least 20 GB.

Required practices:

- lazy full hashing;
- incremental scans;
- moved-file repair before creating duplicate replacement bundles;
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
- File View must not become an unrestricted server filesystem browser.
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
- duplicate detection and manual duplicate/copy resolution;
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
- File View path scoping, hidden-file exclusion, and symlink escape rejection;
- asset bundle/file relationships;
- tag hierarchy and descendant behavior;
- tag group many-to-many behavior;
- collection hierarchy and descendant behavior;
- collection membership preserving bundle metadata;
- filter AST validation and SQL compilation;
- Smart Collection preview counts;
- scanner idempotency and missing-file behavior;
- automatic high-confidence moved-file repair preserving `AssetFile.id`;
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
- `feat/smart-collections`
- `feat/file-view`
- `feat/moved-file-repair`
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
- duplicate detection or automatic duplicate merging;
- native macOS or Android TV applications;
- a general plugin marketplace;
- a complex distributed job system;
- premature replacement of SQLite.

The first release succeeds when the owner can link an existing NAS library, group related files into bundles, assign covers/tags/collections/metadata, browse both logical collections and read-only filesystem directories, filter quickly in an Eagle-like interface, survive external filesystem moves through scan-based repair where possible, and play supported media with correctly linked subtitles without modifying the source files.
