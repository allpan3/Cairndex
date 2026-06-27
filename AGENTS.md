# AGENTS.md

This file is the canonical instruction set for every coding agent working in this repository. If another agent-specific file conflicts with this one, `AGENTS.md` wins.

## 1. Project mission

Build a local-first, Eagle-inspired media asset manager for a private video and image library stored on local disks or NAS-mounted storage.

The product is not primarily a Plex/Jellyfin replacement and must not drift into a generic file gallery. Playback matters, but the core value is metadata-first organization:

- asset bundles composed of multiple related files;
- custom covers and generated thumbnails;
- hierarchical tags plus tag groups;
- hierarchical collections with multi-collection membership;
- a separate File View for browsing configured storage-root directories;
- notes, source/origin hyperlinks, ratings, titles, and technical metadata;
- fast filtering, saved Smart Collections, and multiple browsing layouts;
- metadata-only linking to existing files without copying them;
- robust missing-file and moved-file repair so logical organization survives filesystem changes;
- a polished desktop-class web interface, followed later by TV/mobile clients.

The first product target is the computer-side web application. Android TV support comes after the core library, organization, filtering, and playback experience are stable.

## 2. Product principles

1. **Collection View is bundle-first.** In Collection View, the visible item is an Asset Bundle, not a file. One bundle card may represent a cover, several videos, subtitle files, screenshots, album images, and attachments.
2. **File View is file-system-first.** In File View, the visible items are physical directories and files under configured storage roots. File View is not bundle-first; it is an in-app filesystem browser and linking/diagnostic surface.
3. **Collections are logical; directories are physical.** Collection membership never implies a filesystem move. A bundle may belong to many collections without duplicating or moving source files.
4. **Preserve the user's disk organization.** Link existing files in place by default. Do not require an Eagle-style managed hash directory.
5. **Metadata-only and non-destructive first.** The first File View milestone is read-only. In-app physical rename/move/delete comes later under explicit write mode with strong safeguards.
6. **File View is intended to become a true filesystem browser.** Long term, File View should operate on the underlying filesystem for storage-root-scoped browsing, opening, revealing, moving, renaming, and deleting where explicitly enabled. The read-only constraint is a first milestone, not the final product model.
7. **Logical organization must survive filesystem moves.** If a linked path changes externally, Cairndex should preserve bundle, collection, tag, note, rating, cover, primary-file, and subtitle metadata, and repair the existing file row when it can do so confidently.
8. **Eagle-inspired, not an exact clone.** Reuse proven interaction patterns while adapting them to bundles, subtitles, NAS use, File View, and the web.
9. **Local-first and self-hosted.** The normal deployment is Docker on a Linux NAS/server, accessed over a LAN. Tailscale access may be added without changing the core architecture.
10. **Scale by design.** Assume multi-terabyte libraries, multi-gigabyte files, and enough items that naïve full scans, full hashing, or non-virtualized rendering are unacceptable.
11. **One source of truth.** The application database is authoritative for app metadata. Eagle migration is one-way initially; do not implement bidirectional synchronization.
12. **Progressive capability.** Direct playback comes first; remux/transcoding, File View write mode, open-with-default-app integration, native wrappers, and multi-user behavior come later.

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
- File View browses only configured storage roots.
- File View should show all non-hidden files/directories, not only supported media.
- File View should visually distinguish files Cairndex can open natively from unsupported files.
- The first File View milestone is read-only, but the long-term File View milestone is a true filesystem browser over storage roots.
- Future File View should support `open with default app` and `reveal in file manager` where deployment mode permits safe local/native host integration.
- Open-with-default-app must not be implemented as arbitrary command execution from a remote browser. It needs an explicit local desktop/native helper, Tauri shell, or similarly safe host-integration design.
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

An `AssetBundle` is the primary user-facing object shown in Collection View grids, lists, search results, collections, tags, and Smart Collections.

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

Suggested roles: `primary_video`, `video_part`, `alternate_version`, `cover`, `image`, `screenshot`, `album_image`, `subtitle`, `attachment`, `generated_derivative`, and `other`.

One physical path should normally have one owning bundle. Do not add cross-bundle aliases until a real use case requires them.

When a file is moved and repaired, update the existing `AssetFile` row rather than creating a replacement row. Keeping the same `AssetFile.id` preserves bundle membership, cover/primary references, subtitles, collections, tags, notes, ratings, and generated cache identity where applicable.

### 4.4 Covers and thumbnails

Cover precedence:

1. user-selected cover file;
2. user-selected frame from a video;
3. automatically extracted frame from the primary video;
4. generated placeholder.

Original cover files are Asset Files. Generated thumbnails, preview frames, storyboards, and converted derivatives live in application cache storage and must be reproducible.

### 4.5 Tags and tag groups

Tags are hierarchical and support parent-child relationships. A bundle can have many tags. Selecting a parent tag should include descendants by default, with a visible toggle to disable descendant inclusion.

The hierarchy and tag groups are separate systems:

- hierarchy expresses semantic parent-child relationships;
- groups organize tags for faster browsing and selection;
- a tag may belong to multiple groups;
- a group does not become the tag's parent and does not change descendant semantics.

A `TagGroup` is a navigational category such as Genre, Subject, Status, Source, or Person. It supports many-to-many membership between tags and groups, optional ordering, counts in the picker, and tag search independent of group selection.

### 4.6 Collections

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

### 4.7 Smart Collections

A Smart Collection is a named, saved filter expression plus optional view preferences. It replaces the old Smart Folder terminology.

Store a versioned structured expression, not raw SQL and not an opaque UI string. The initial editor may support one condition group like Eagle's `any/all of the following are true/false`. The data model must permit nested `and`, `or`, and `not` groups later. Collection conditions must target collection IDs and support descendant inclusion in the same way direct Collection View browsing does.

### 4.8 Subtitle tracks

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

### 4.9 File View

File View is an in-app browser over configured storage roots. It is separate from Collection View and displays physical directories and files rather than bundle cards.

Initial File View milestone:

- browse only configured storage roots;
- display directories and all non-hidden files, not just media files;
- hide hidden dotfiles/dot-directories and platform-hidden files where practical;
- validate every requested path through the storage-root path-safety layer;
- never expose unrestricted absolute server paths;
- visually separate files Cairndex can open natively from unsupported files;
- allow later actions such as fast-add/link-to-bundle/create-bundle from selected files;
- do not move, rename, delete, or rewrite source files.

Long-term File View milestone:

- behave like a true filesystem browser scoped to storage roots;
- support safe write-mode operations such as rename, move, delete, and directory creation;
- support `open with default app` and `reveal in file manager` where safe local/native host integration exists;
- record or surface enough state that metadata repair, stale paths, and missing linked files are understandable.

A supported/openable file means a file that the current app can preview or play natively through the web UI. Recognized-but-not-openable files may still be shown, linked, or treated as attachments where the bundle model permits it. PDF preview is optional future support; do not mark PDFs as natively supported until a real viewer path exists.

### 4.10 Host file operations and default-app integration

`Open with default app` and `Reveal in file manager` are future host-integration features. They must be designed deliberately because Cairndex may run inside Docker on a NAS while the user interacts through a browser on another machine.

Do not implement these features as arbitrary shell command execution from the web API. Acceptable future approaches include a Tauri/native desktop shell, a local companion helper, or a carefully scoped host integration that can prove the opened path is inside an allowed storage root and that the action is initiated by the authenticated owner.

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

Confidence signals may include same platform file identity (`st_dev`/`st_ino` or equivalent) when reliable, same storage root or clearly equivalent root alias, same filename/extension, same size and high-resolution mtime, same sampled/quick hash, and optional full hash only when needed for ambiguous candidates and only outside hot request paths.

A same-path content edit is not a move. For example, annotating a PDF may change size, mtime, sampled hash, and full hash while the logical file remains the same because the path and/or filesystem identity are stable. A cross-filesystem move followed by an edit may not be confidently repairable; keep the old file missing and expose a later manual repair/candidate workflow rather than guessing.

If the old path still exists and a similar or identical new path appears, do not auto-merge. Treat that as a future duplicate/copy candidate. Duplicate detection is out of scope for the first collection/file-view refactor.

### 5.4 Optional managed imports

Copy/move into an app-managed directory is a future optional mode, not an MVP requirement. Do not couple core IDs or lookup logic to a hash-directory layout.

## 6. Media processing and playback

Use `ffprobe` for technical metadata and stream discovery. Use `ffmpeg` for generated derivatives.

The processing pipeline should eventually provide dimensions, duration, codecs, container, bitrate, frame rate, stream metadata, video thumbnails, optional storyboard/contact sheet, cover frame selection, external subtitle conversion, remux/transcoding jobs, deterministic cache keys, and safe cache cleanup.

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

Grouping heuristics may consider same directory, matching or similar basenames, numeric part suffixes, language subtitle suffixes, names such as `cover`/`poster`/`thumbnail`/`thumb`, Eagle folder/tag proximity, and manual mapping.

## 8. UI and interaction direction

The UI should feel like a desktop media organizer, not an administration dashboard.

Use the supplied Eagle screenshots as interaction references and store copies under `docs/reference/eagle/` when available. Do not commit private source media.

### 8.1 App shell

Recommended layout:

- left sidebar: system views, Smart Collections, hierarchical collection tree, File View entry points, tag entry points;
- top toolbar: breadcrumbs, filter categories, search, sort, view controls, zoom/density control;
- center: virtualized bundle browser in Collection View; storage-root directory browser in File View;
- right inspector: selected bundle metadata and files, or selected file/directory details in File View;
- modal/detail viewer: media preview and playback.

System views should include All, Uncategorized, Untagged, Recently Added / Recently Used, Random, All Tags, Missing Files, and Trash later where useful.

### 8.2 Collection View layouts

Plan for justified layout similar to Eagle/Google Photos, fixed grid, list/table layout, masonry/waterfall layout, and persistent layout/zoom/sort/filter preferences per view where practical.

All large collections must be virtualized or paginated. Never render an entire large library into the DOM.

### 8.3 File View layouts

Plan for directory list/tree navigation scoped to storage roots, file table/list layout with name/type/size/modified time/support state/linked state, hidden-file exclusion, and no write actions in the first milestone. Later File View should grow into a true filesystem browser with guarded write actions and default-app handoff.

### 8.4 Bundle cards and inspector

A bundle card should communicate selected cover/thumbnail, title, media/file count when greater than one, primary duration or image dimensions, rating, lightweight status indicators, missing/offline/stale state, and selection state.

The inspector should expose bundle-level fields first: cover, title, note, tags, collections, rating, aggregate properties, and files in the bundle. Selecting a file within the bundle reveals file-level technical metadata and, later, display title/note/source-link controls.

### 8.5 Tag selector

The tag selector should combine the useful Eagle group picker with the new hierarchy: search, group/category list with counts, tag tree/list with hierarchy indentation, tags appearing under multiple groups, include/exclude states, any/all rule, descendant toggle, keyboard/mouse support, and accessible alternatives to right-click exclusion.

### 8.6 Collection View

Inside a collection, show breadcrumb/title, direct subcollection selector/count, `Show subcollection contents` toggle, normal filters and views, and collection counts in the sidebar.

### 8.7 File View

Inside File View, show storage-root selector, filesystem breadcrumbs, directories first, all non-hidden files/directories, support/openable state, linked-to-bundle state when known, missing/stale indicators when a previously linked path is gone, and read-only affordances until explicit write mode exists.

File View is not a replacement for Collection View. It is a filesystem browser and linking/diagnostic surface. Collection View remains the primary organization and browsing surface.

### 8.8 Smart Collection editor

The initial editor should follow the supplied Eagle reference: Smart Collection name, all/any selector, true/false inversion, repeatable condition rows, field/operator selectors, typed values with autocomplete where appropriate, add/remove buttons, live result count, server-side validation, and clear error messages.

Typed field examples: title/name, note, URL/source, tags/collections, rating, type/extension/codec, duration/size/dates, file count, missing state, and subtitle presence.

The simple filter toolbar and Smart Collection editor must compile to the same canonical filter expression model.

## 9. Suggested implementation stack

Use this stack unless an existing repository strongly justifies another choice. Any major deviation requires an ADR.

Backend: Python 3.12+, FastAPI, SQLAlchemy 2.x, Alembic, Pydantic, SQLite in WAL mode, ffmpeg/ffprobe, and a simple database-backed worker or other lightweight documented mechanism. Do not introduce Redis, Celery, Postgres, Elasticsearch, or a separate search service without demonstrated need.

Frontend: React, TypeScript strict mode, Vite, TanStack Query, TanStack Router or another typed router, TanStack Virtual or equivalent, accessible headless primitives such as Radix UI, a focused state solution only where server/cache state is insufficient, and Playwright for e2e tests.

Search and filters: SQLite FTS5 where appropriate, relational indexes for tag/collection/rating/date/type filters, server-side filtering/sorting/pagination, and no client-side loading of the full library.

Repository layout should remain the existing monorepo shape under `apps/server`, `apps/web`, `docs`, and `infra`. Adapt to existing conventions rather than reorganizing without reason.

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
- Do not expose arbitrary host command execution for open-with-default-app or reveal-in-file-manager features.
- Consider optional single-owner authentication before remote/Tailscale use.
- Clearly document that direct public internet exposure is unsupported unless hardened separately.

## 13. Future compatibility

Avoid schema choices that block these later features:

- multiple users with per-user watch history, favorites, and view preferences;
- File View write mode with audit logs and recovery;
- open-with-default-app and reveal-in-file-manager via safe local/native host integration;
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

Use a dedicated branch for each meaningful feature or fix, for example `feat/core-domain-model`, `feat/storage-scanner`, `feat/bundle-browser`, `feat/tag-filtering`, `feat/smart-collections`, `feat/file-view`, `feat/moved-file-repair`, `feat/subtitle-playback`, `feat/eagle-import`, `fix/path-normalization`, or `docs/architecture`.

Do not combine unrelated large features in one branch.

Commit frequently at meaningful checkpoints. Commits should be small enough to review and should normally leave the branch buildable. Use descriptive conventional-style messages when practical. Do not create meaningless `update` or `changes` commits.

Every PR should include problem and scope, design summary, screenshots/video for UI changes, migration notes, tests run and results, performance/safety considerations, changelog entry, and follow-up work explicitly out of scope.

Never force-push `main`. Before rebasing into main, check whether local `main` is up to date. Force-push only non-main branches and use `--force-with-lease`.

## 17. Changelog and documentation discipline

Documentation is part of implementation, not an optional cleanup step. Agents must update docs continuously as phases land, not only in a final pass.

For every meaningful phase or commit, ask which docs are affected before moving on. If behavior, schema, API, routes, filters, UI, deployment, or operations change, update the relevant docs in the same branch and preferably the same commit slice.

Required documentation targets include, as applicable:

- `README.md`
- `docs/architecture.md`
- `docs/development.md`
- `docs/deployment.md`
- `docs/data-model.md`
- `docs/filter-language.md`
- `docs/eagle-migration.md` when migration behavior changes
- `docs/adr/` for consequential decisions
- `docs/STATUS.md`
- `CHANGELOG.md`
- generated OpenAPI/frontend API artifacts when backend contracts change

Maintain `CHANGELOG.md` using an `Unreleased` section with Added, Changed, Fixed, Removed, Security, and Internal. Update it for every meaningful user-visible, API-visible, migration-visible, operational, or architectural change.

Do not say “docs later” unless the PR explicitly records a narrow docs-debt item and the owner accepts it. PR summaries must include a `Documentation updated` section listing changed docs, or explain why no docs were affected. Definition of done requires documentation and changelog updates.

When implementation reveals inconsistencies between AGENTS.md, current code, and other docs, correct the docs in the same phase. If the code is intentionally different from AGENTS.md, either change the code or record an ADR/STATUS note explaining the accepted deviation.

## 18. Agent execution loop

Before changing code:

1. Read `AGENTS.md`, `README.md`, `docs/STATUS.md`, relevant ADRs, and the current changelog.
2. Inspect the repository and existing conventions.
3. State the intended scope and branch.
4. Identify migrations, safety risks, tests, and docs that must change.

For each meaningful step:

1. implement a coherent slice;
2. run focused tests and static checks;
3. update docs/changelog/generated API artifacts when applicable;
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
- documentation, changelog, and generated API artifacts are updated where applicable;
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
- open-with-default-app before a safe local/native host-integration design exists;
- duplicate detection or automatic duplicate merging;
- native macOS or Android TV applications;
- a general plugin marketplace;
- a complex distributed job system;
- premature replacement of SQLite.

The first release succeeds when the owner can link an existing NAS library, group related files into bundles, assign covers/tags/collections/metadata, browse both logical collections and filesystem directories, filter quickly in an Eagle-like interface, survive external filesystem moves through scan-based repair where possible, and play supported media with correctly linked subtitles without modifying the source files.
