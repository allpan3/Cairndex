# Cairndex product brief

This document describes the Cairndex product model and long-term direction. Agent operating rules live in [`AGENTS.md`](../AGENTS.md); current implementation status lives in [`docs/STATUS.md`](STATUS.md); consequential architecture decisions live in [`docs/adr/`](adr/).

## Mission

Build a local-first, Eagle-inspired media asset manager for a personal video and image library stored on local disks or NAS-mounted storage.

Cairndex is not primarily a Plex/Jellyfin replacement and must not drift into a generic file gallery. Playback matters, but the core value is metadata-first organization:

- asset bundles composed of multiple related files;
- custom covers and generated thumbnails;
- hierarchical tags plus tag groups;
- hierarchical collections with multi-collection membership;
- a separate File Browser for browsing the active library root;
- notes, source/origin hyperlinks, ratings, titles, and technical metadata;
- fast filtering, saved Smart Collections, and multiple browsing layouts;
- metadata-only linking to existing files without copying them;
- robust missing-file and moved-file repair so logical organization survives filesystem changes;
- a polished desktop-class web interface, followed later by TV/mobile clients.

The first product target is the computer-side web application. Android TV support comes after the core library, organization, filtering, and playback experience are stable.

## Product principles

1. **Bundle Browser is bundle-first.** In Bundle Browser, the visible item is an Asset Bundle, not a file.
2. **File Browser is filesystem-first.** In File Browser, the visible items are physical directories and files under the active library root. File Browser is not bundle-first; it is an in-app filesystem browser and linking/diagnostic surface.
3. **Libraries are the storage scope.** Portable packages exchange immutable metadata and keep their working DB privately outside the library folder (ADR-0035). The server-local registry tracks known libraries and jobs.
4. **Collections are logical; directories are physical.** Collection membership never implies a filesystem move. A bundle may belong to many collections without duplicating or moving source files.
5. **Preserve the user's disk organization.** Link existing files in place by default. Do not require an Eagle-style managed hash directory.
6. **Metadata-only and non-destructive first.** Source files remain unchanged by default. Reviewed portable Copy, Rename, Move, Replace, Trash and Undo require per-library and deployment write permission, supported storage primitives, journals and retained versions (ADR-0036).
7. **Logical organization must survive filesystem moves.** If a linked path changes externally, preserve bundle, collection, tag, note, rating, cover, primary-file, and subtitle metadata by repairing the existing file row when confidence is high.
8. **Eagle-inspired, not an exact clone.** Reuse proven interaction patterns while adapting them to bundles, subtitles, NAS use, File Browser, and the web.
9. **Local-first and self-hosted.** The desktop app can serve local libraries through its bundled server, or connect to an authoritative private server. Docker on a NAS/server is optional; neither NAS nor cloud storage defines a required operating mode.
10. **Scale by design.** Assume multi-terabyte libraries, multi-gigabyte files, and enough items that naive full scans, full hashing, or non-virtualized rendering are unacceptable.
11. **Explicit metadata authority.** Portable libraries use retained causal history with a private DB projection. The registry DB is server-local runtime state. NAS and cloud folders are usage scenarios, not operating modes; real-library conversion remains gated by complete round-trip/conflict support.
12. **Progressive capability.** Direct playback, remux/transcoding, mapped desktop host actions are implemented; reviewed portable file and bounded directory operations require explicit write permission. Broader client support and multi-user behavior remain deferred; implemented capabilities still require their own platform and deployment qualification.

Mac-hosted Cairndex accessing files on mounted SMB storage is a required
deployment scenario. NAS-hosted serving is a separate optional scenario, not a
substitute for mounted-SMB compatibility. Portable metadata publication and
reviewed file/directory operations use authenticated direct SMB on positively
identified macOS mounts (ADR-0037). Missing credentials, changed identity or
unverifiable mapping retain recoverable intent. Current platform and packaged
qualification limits are recorded in [storage qualification](storage-qualification.md).
See [file operations](file-operations.md).

## Fixed product decisions

Unless the product owner explicitly changes them, treat these as settled:

- Build from scratch rather than forking SmartGallery DAM.
- Use SmartGallery DAM, Eagle, Jellyfin clients, and Wholphin as reference material only.
- Start with a Dockerized server and an app-like web UI/PWA.
- The Tauri desktop shell shares the web UI and bundles a local server; macOS packaging is supported. Android TV and broader desktop-platform qualification remain deferred.
- The application links to files already on disk and stores metadata separately.
- Asset bundle metadata is shared across the bundle.
- Individual files display their current actual filename. File notes and verbatim source/origin text round-trip through the API; their editing controls are deferred. Stored legacy titles remain preserved without inferring aliases.
- Individual files do not need ratings.
- Tags are hierarchical.
- Tag groups also exist and are independent of the hierarchy. A tag may belong to multiple groups.
- Product/API/model terminology is `collection`, not user-facing `folder`, except when referring to ordinary filesystem directories in File Browser or historical/external references.
- Collections are hierarchical logical groupings. A bundle may belong to zero, one, or many collections.
- Collections contain bundles only, not loose files.
- New collections remain local name drafts until explicit Create confirmation;
  cancelling a draft does not create, rename or remove a collection.
- Selecting a tag or collection parent can include descendants; the UI exposes a toggle.
- Smart Folders should be renamed to Smart Collections / saved collection filters. The legacy table name `smart_folders` may remain until a migration is worth it.
- File Browser browses only the active library root.
- File Browser should show all non-hidden files/directories, not only supported media.
- File Browser should visually distinguish files Cairndex can open natively from unsupported files.
- File Browser remains scoped to library roots and read-only unless explicit write gates permit a journaled operation.
- The desktop shell supports Open in Default App and Reveal through manifest-validated local mappings; cross-application drag qualification remains incomplete and paused.
- Open-with-default-app must not be implemented as arbitrary command execution from a remote browser. It needs an explicit local desktop/native helper, Tauri shell, or similarly safe host-integration design.
- Metadata-only removal does not modify source files. Collections never move source files.
- Move repair is automatic during scan/rescan/reconciliation when confidence is high. Do not require a separate normal user workflow for repair.
- Duplicate detection is deferred. If a still-present file is also found at another path, treat that as an unresolved duplicate/copy candidate later, not as an automatic bundle merge.
- Bundles remain flexible logical objects. A bundle does not require a canonical physical folder and may contain files from different directories.
- Both embedded and external subtitles must be supported.
- Begin with the desktop/computer experience. A TV web UI may reuse the same frontend later.
- The first user is a single owner. Avoid choices that make later multi-user support require a full rewrite.
- Eagle import/synchronization is removed from the current product path. Eagle remains a UI and interaction reference only.

## Concurrent local replicas

Multiple devices can keep capable synthetic metadata replicas open, edit offline
and reconcile through immutable artifacts. Disjoint fields combine; complete
choices resolve conflicting values, membership, hierarchy or lifetime while
retaining rejected branches and unrelated edits. [ADR-0029](adr/0029-cloud-metadata-replicas.md)
is accepted. The shared app provides bundle-first catalog editing and indexed
File Browser paths for these packages. Cataloged video and images use the shared
viewer, with availability, probes, derivatives and resume private to the serving
device. Missing bytes keep their catalog identity and can be retried locally.
Format-three synthetic packages support [manual Update](replica-discovery.md):
private discovery, conservative external-move repair and explicit grouping or
ambiguous-identity review, complete directory/collection grouping, existing placement
and explicit full-content verification. Confirmed groupings and file IDs remain stable; local
absence never removes shared metadata. Reviewed file and bounded directory operations use explicit write permission and
independent retained content versions. Legacy library admission is unavailable. Real-library conversion and provider qualification
require separate approval and evidence.

Private backups preserve this replica's unexchanged metadata and server-received
drafts. [Explicit recovery](replica-recovery.md) prepares and reviews a separate
generation, checks surviving private work, then activates after serving work has
drained. Each restore has a fresh author identity; source media, old stores and
backups remain intact. Unreceived browser-only work is outside a server snapshot.

## Canonical domain model

Names may evolve, but the concepts and relationships must remain clear. Current implementation names that still say `folder` are legacy names until intentionally migrated or retained as historical table names.

Serving is instance-local. An awake server keeps its private store open while
clients idle or disconnect. Release drains active requests, jobs, exchange and
media, then closes the private store. Reopen permits access again. Independent
servers use separate private stores; no shared-folder lease selects one winner.

### Library

A library is a server-visible root with source files and this portable package:

```text
<library-root>/
  media files...
  .cairndex/
    manifest.json
    replica/objects/
```

The descriptor carries its stable library UUID, name, epoch, seed and capabilities.
Immutable history is the authored metadata authority. Each server stores its
working projection, received drafts, jobs, access settings and caches privately.
The registry records root paths, availability and serving intent. Working databases
never reside in provider folders. Private state requires a separate backup.

File locations are library-relative. File Browser cannot browse arbitrary server
paths. Normal Create preserves existing files and publishes the descriptor last.
Open refuses the old `cairndex.library` format. Conversion is external and explicit.

### Asset bundle

An `AssetBundle` is the primary user-facing object shown in Bundle Browser grids, lists, search results, collections, tags, and Smart Collections.

Bundle-level metadata includes:

- stable ID, preferably UUID or ULID;
- displayed asset title;
- shared note;
- shared rating;
- selected cover file;
- one remembered current media file, independent of the cover;
- grouping review state (`provisional` or `confirmed`);
- creation, import, and update timestamps;
- aggregate media properties where useful;
- optional extensible metadata JSON for non-core fields.

A bundle is logical, not necessarily a physical folder. Do not make bundle identity or collection membership depend on a bundle-root directory. An optional representative directory may be added later only for convenience, not as the source of truth.

### Asset file

An `AssetFile` is a physical file linked into one Asset Bundle.

Required concepts:

- stable file ID that survives path repair;
- bundle ID;
- library-relative path;
- original filename;
- displayed name derived from the current filename, with no custom-name editor;
- optional file-level note and verbatim source/origin text, even if their UI is deferred;
- media kind and MIME type;
- file role;
- order/sequence within the bundle;
- size and modified timestamp;
- availability/missing/stale state;
- quick fingerprint and optional full hash;
- optional filesystem identity such as device/inode/file ID when reliable;
- extracted technical metadata;
- import/source metadata.

Suggested roles: `video_part`, `alternate_version`, `cover`, `image`, `screenshot`, `album_image`, `subtitle`, `attachment`, `generated_derivative`, and `other`. Existing `primary_video` rows are legacy grouping metadata only and display as `video`; they do not override sequence order.

One physical path should normally have one owning bundle. Do not add cross-bundle aliases until a real use case requires them.

When a file is moved and repaired, update the existing `AssetFile.relative_path` rather than creating a replacement row. Keeping the same `AssetFile.id` preserves bundle membership, cover/cursor references, subtitles, collections, tags, notes, ratings, and generated cache identity where applicable.

### Covers and thumbnails

Cover/thumbnail source precedence:

1. user-selected cover file, when it is thumbnailable;
2. first image in the bundle;
3. first video in the bundle;
4. generated placeholder / no thumbnail state.

Selecting a cover should update the inspector action immediately, roll back if
the metadata write fails, and let regenerated/cached artwork refresh
asynchronously.

Original cover files are Asset Files. Generated thumbnails, preview frames, storyboards, converted subtitles, and future transcodes live in application cache storage under `.cairndex/cache/` and must be reproducible. Scans must ignore `.cairndex/cache/`.

### Tags and tag groups

Tags are hierarchical and support parent-child relationships. A bundle can have many tags. Selecting a parent tag should include descendants by default, with a visible toggle to disable descendant inclusion.

The hierarchy and tag groups are separate systems:

- hierarchy expresses semantic parent-child relationships;
- groups organize tags for faster browsing and selection;
- a tag may belong to multiple groups;
- a group does not become the tag's parent and does not change descendant semantics.

A `TagGroup` is a navigational category such as Genre, Subject, Status, Source, or Person. It supports many-to-many membership between tags and groups, optional ordering, counts in the picker, and tag search independent of group selection.

### Collections

Collections are hierarchical virtual groupings, not physical filesystem directories.

Required behavior:

- parent-child nesting;
- many-to-many membership between bundles and collections;
- zero-collection bundles appear under `Uncategorized` or another clearly named system view;
- collection counts that roll up distinct bundles across the full descendant subtree;
- `Show subcollection contents` / `Include descendants` toggle;
- drag-and-drop assignment in a later UI milestone;
- no file movement when collection membership changes.

The product term is `collection`. Do not introduce new user-facing, API, ORM, schema, migration, or documentation concepts named `folder` except when explicitly referring to external products such as Eagle, to ordinary filesystem directories in File Browser, or to legacy table names being intentionally retained.

### Bundle search

Free text searches bundle names, all bundle/member-file notes and moment comments.
File names/paths and tag names are excluded; filename search belongs in Files.
Tag and collection filters remain independent. Collection names are excluded from
free text under the current working assumption. Unbundled files are intentionally
absent from Bundle Browser; their filename query covers the complete active-library
queue and sorts globally before pagination.

### Smart Collections

A Smart Collection is a named, saved filter expression plus optional view preferences. It replaces the old Smart Folder terminology.

Store a versioned structured expression, not raw SQL and not an opaque UI string. The initial editor may support one condition group like Eagle's `any/all of the following are true/false`. The data model must permit nested `and`, `or`, and `not` groups later. Collection conditions must target collection IDs and support descendant inclusion in the same way direct Bundle Browser browsing does.

### Subtitle tracks

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

### File Browser

File Browser is an in-app browser over the active library root. It is separate from Bundle Browser and displays physical directories and files rather than bundle cards.

Current File Browser milestone:

- browse only the active library root;
- display directories and all non-hidden files, not just media files;
- hide hidden dotfiles/dot-directories and platform-hidden files where practical;
- validate every requested path through the library-root path-safety layer;
- never expose unrestricted absolute server paths;
- visually separate files Cairndex can open natively from unsupported files;
- fast-add/link-to-bundle/create-bundle from selected files without copying them;
- leave source files unchanged by default; physical operations require the
  deployment-and-library write-mode gates and journal described in ADR-0013;
- offer Open in Default App and Reveal in Finder in the desktop shell when the
  active library has a validated local mapping.

Long-term File Browser milestone:

- behave like a true filesystem browser scoped to library roots;
- record or surface enough state that metadata repair, stale paths, and missing linked files are understandable.

A supported/openable file means a file that the current app can preview or play natively through the web UI. Recognized-but-not-openable files may still be shown, linked, or treated as attachments where the bundle model permits it. PDF preview is optional future support; do not mark PDFs as natively supported until a real viewer path exists.

### Host file operations and default-app integration

The Tauri desktop shell implements **Open in Default App** and **Reveal in
Finder** through the local operating system. A server-scoped mapping connects
the active library's registry ID to a local root and its portable manifest UUID.
Each handoff rechecks identity, availability and path containment. Missing files,
unavailable mounts and changed identities produce errors; an unmapped library
does not offer these context-menu actions.

A remote server path is not a desktop path. Remote libraries require explicit
local location selection; only the shell's own local server can supply an
automatically adopted root, which still passes manifest validation. The browser
does not offer native handoff, and the web API never executes host commands.

Desktop file drag-out uses the same mapped-path validation. Current drag-in uses
HTML file uploads into write-enabled libraries. App-origin self-return remains
an unresolved integration gap. Desktop file integration is incomplete and paused;
QSpace and multi-file OS delivery remain unqualified, while native adapters and
volume-based Move remain on hold. See the current
[desktop drag contract](plans/03-macos-desktop-app.md#6-drag-out--drag-in).

## File discovery, linking, and identity

### Fast add

The primary import workflow links existing files without copying them. Adding an existing file must be fast even over a network-mounted volume.

Do not full-hash multi-gigabyte files during normal add.

Initial identity/fingerprint inputs may include:

- library-relative path;
- file size;
- high-resolution modified time;
- sampled/quick hash where cheap;
- filesystem identity such as inode/device/file ID when reliable;
- lazy full hash only for duplicate verification, ambiguous repair, or explicit user-requested integrity work.

### Scanning

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

The scanner is the reconciliation mechanism between the filesystem and the metadata database. It should walk the active library root, observe current files, update known paths, mark absent paths missing/stale, repair old `AssetFile` rows to new paths before creating replacement bundles for newly discovered files, and ignore hidden/cache paths such as `.cairndex`.

### Moved-file repair

When a linked path disappears, preserve the Asset File row as missing/stale. On the same scan or a later rescan, try to identify whether a newly observed path is the same physical file.

Repair must:

- update the existing `AssetFile.relative_path` rather than creating a new file row;
- keep the `AssetFile.id` stable;
- preserve the owning bundle, collections, tags, notes, rating, cover/cursor selection, and subtitle links;
- run automatically as part of scan/rescan/reconciliation for high-confidence matches;
- avoid destructive changes and avoid merging duplicates.

Confidence signals may include same platform file identity, same filename/extension, same size and high-resolution mtime, same sampled/quick hash, and optional full hash only when needed for ambiguous candidates and only outside hot request paths.

A same-path content edit is not a move. When a conservative scan misses a rename
and has already linked its replacement, Missing Files may offer an explicit
stable-ID relink for a unique, revalidated candidate. A cross-filesystem move
followed by an edit may not be confidently repairable; keep the old file missing
rather than guessing when no candidate remains.

If the old path still exists and a similar or identical new path appears, do not auto-merge. Treat that as a future duplicate/copy candidate. Duplicate detection is out of scope for the first release.

### Optional managed imports

Copy/move into an app-managed directory is a future optional mode, not an MVP requirement. Do not couple core IDs or lookup logic to a hash-directory layout.

## Media processing and playback

Use `ffprobe` for technical metadata and stream discovery. Use `ffmpeg` for generated derivatives.

The processing pipeline should eventually provide dimensions, duration, codecs, container, bitrate, frame rate, stream metadata, video thumbnails, optional storyboard/contact sheet, cover frame selection, external subtitle conversion, remux/transcoding jobs, deterministic cache keys, and safe cache cleanup.

### Direct playback

The server must support HTTP range requests and correct content headers.

Do not claim universal format support merely because a file can be served. Browser support for WMV, AVI, MOV, H.264, and H.265 varies. Detect capability and show a clear fallback state.

When opening/streaming/thumbnailing a file, re-check that the resolved path still exists. If it no longer exists, mark the file stale/missing and rely on the scanner to repair it on the next reconciliation when possible.

Bundle open/playback order is the Files in bundle order (`AssetFile.sequence`,
stable id tie-break). One bundle cursor remembers the current supported media
file independently of the cover; video time remains per-file watch progress.
Opening the bundle starts at that cursor, end-of-video advances through ordered
supported media, and card hover represents the same cursor. An image cursor is
a still preview; a video cursor uses storyboard/direct preview from its saved
time. The inspector's per-file play action opens the selected supported media
directly and lets the same cursor mechanism remember it. See ADR-0016.

### Fallback playback

After direct playback is stable, add an FFmpeg-backed fallback:

1. direct stream where client/container/codec permit;
2. remux when codecs are compatible but the container is not;
3. HLS or another adaptive/transcoded format when necessary.

Remote quality/bitrate selection is a later milestone, designed for Tailscale use. Keep transcoding APIs and job models extensible.

## Bundle grouping

Importing from an external Eagle library is out of scope. With the per-library architecture (ADR-0008), a Cairndex library is its own portable directory populated by scanning the library root, not by migrating from another app. The former one-way Eagle importer and its `import_records` table have been removed; ADR-0004 is retained as superseded history.

Bundles are formed by scanning the library and grouping related files. Grouping heuristics may consider same directory, matching or similar basenames, normalized subject prefixes, numeric part suffixes, language subtitle suffixes, names such as `cover`/`poster`/`thumbnail`/`thumb`, and manual mapping.

Grouping is a **suggestion, not an automatic decision** (ADR-0009, Option A+). A scan stays discovery/repair-first and stages newly found files in _provisional_ bundles; a read-only suggester turns the library into a durable **grouping plan** of BUNDLE / CONTAINER proposals (with roles, confidence, and a reason); the user reviews it and **applies** it. Apply is the only step that creates _confirmed_ groupings — it merges/splits provisional bundles (preserving `AssetFile.id`), assigns roles, selects a cover, links external subtitles, and creates or reuses the logical collections a CONTAINER suggests, never touching the filesystem. Relevant existing collection branches remain visible in review so a new bundle can inherit or change its proposed collection placement even though confirmed bundles themselves stay outside regrouping.

A scan stages each newly discovered file as a _provisional_ one-file bundle.
Until the owner confirms it, that file is treated as **unbundled**
(`grouping_state = provisional`, `grouping_source = scan_suggestion`): it lives
only in a dedicated **Unbundled** system view and is hidden from All, Recently
Added, Uncategorized, Untagged, Missing, and every collection, so unaccepted scan
suggestions never masquerade as real bundles. Collections still contain confirmed
bundles only, never loose files.

Unbundled files are surfaced in the **Files** browsing surface, not as bundle
cards: the sidebar's **Unbundled** view opens a flat, library-wide list of the
not-yet-bundled files with the file inspector, and the Files directory tree badges
each file `unlinked` / `unbundled` / (openable). The two primary browsing surfaces
are **Bundles** (bundle-first: system views, Smart Collections, the collection
tree, tags) and **Files** (the library-root filesystem browser).

Confirming unbundled files is either bulk (grouping review, above) or by hand via
the **manual bundling assistant**, reachable by right-clicking files in either
Files surface. The assistant can add selected files to an existing confirmed
bundle, create a confirmed bundle from selected files, create an empty confirmed
bundle, or add suggested unbundled files from inside a bundle. A file that is not
yet linked is auto-linked (staged as provisional) when an action is applied. It offers automatic ranked suggestions (target bundles for
selected files; unbundled files for a bundle; a bundle draft from a seed) computed
only from the library DB and search index — never a filesystem scan — each with a
confidence and a human-readable reason. Suggestions are automatic on open but
**applying is always explicit**, and every action is metadata-only: files are
re-parented and emptied provisional bundles removed, but nothing on disk is moved,
copied, renamed, or deleted. Assigning an unbundled file to a collection first
confirms or creates a bundle, then adds that bundle to the collection.

Current workflow details:

- scan jobs persist an open grouping plan without applying it;
- the primary **Update** flow runs scan/grouping-plan generation, refreshes
  affected queries, and opens grouping review immediately when suggestions
  exist; metadata probe continues in the background, followed by storyboard
  generation after probe supplies duration metadata;
- manual **Suggest grouping** and Update use the same candidate boundary:
  confirmed bundles stay settled regardless of collection membership, while
  still-unbundled files and new additions remain eligible;
- the grouping review UI accepts file-backed bundle proposals only. Collection
  checkboxes are checked, empty, or indeterminate bulk controls for their
  descendant bundles; selecting one nested bundle automatically carries its
  complete collection ancestor path into apply without selecting siblings;
- selection and placement are separate: file rows can move within or across
  bundle suggestions, while bundle and new-collection proposals can be moved
  among speculative collection proposals by drag-and-drop or placed into the
  library's current persisted collection hierarchy with a keyboard-accessible,
  searchable picker. Suggested collections are not picker destinations because
  they are still unconfirmed. The picker shows one persisted collection name per
  indented row, supports folding its branches, and uses full paths only for
  disambiguation and accessibility instead of repeating every ancestor visibly.
  New suggestions remain renameable/reclassifiable, with each row's
  lower-frequency edits collected behind one named actions menu at a fixed right
  edge; an existing collection context is labeled and read-only, and offers no
  actions at all;
- grouping review leads with what needs deciding. The suggester's own certainty
  is surfaced: uncertain rows are counted, filterable, marked, and never folded
  away. A bundle row states what it contains and keeps its file list closed
  until asked, with a Show files default and a per-row override; a file drag
  reveals every list. Runs of three or more identically shaped siblings collapse
  to one summary row that can be expanded and folded back. Collection rows fold
  their descendants, and Collapse all / Expand all govern collections only.
  Nothing here changes selection, placement, drag-and-drop, or which proposal
  ids apply — narrowing the view never changes what Accept would do;
- the review is keyboard-drivable: arrows move between rows, left and right
  fold, space accepts or skips the focused row, and Cmd/Ctrl+Enter applies under
  the same conditions that enable the Accept button;
- a re-scan addition recommends its existing confirmed bundle by default, and a
  named item in the row's actions menu converts that same proposal in place to a
  new bundle; the owner can switch back without losing selection, file order,
  collection parent, or an edited new-bundle title. An addition has no placement
  of its own, because its target bundle already sits wherever it sits;
- suggested file order is video first, then audio, then image, then every other
  file, preserving natural path order within each group; review can override the
  sequence, which becomes the bundle playlist order on apply;
- a drag that empties a bundle suggestion auto-deselects it; a collection with
  no file-backed descendants has a disabled bulk-selection checkbox because the
  collection row itself is structural rather than accepted work;
- in a flat multi-video directory, sidecars first match a unique normalized full
  video stem (including suffix variants such as subtitles/posters); trailing
  rendition labels such as `720p` are folded by default, and fresh stem groups
  are matched independently against confirmed bundles instead of assigning a
  whole directory to one owner;
- grouping review offers one pair of named folder actions per represented
  filesystem directory, in the actions menu of whichever row speaks for it:
  "Split <folder> into more bundles" retains rendition labels in each complete
  normalized stem, and "Merge <folder> into fewer bundles" uses a broader
  subject/source prefix. Balanced is the rendition-folded default and the
  resting state between them; a read-only existing-collection row offers
  neither, because it names no directory. The per-directory choices are
  persisted on the regenerated plan snapshot;
- suggestions reflect the latest reconciled scan state: rows marked missing are
  retained for repair and metadata continuity but excluded from grouping; run
  Update or Scan new files after filesystem changes before regenerating;
- explicit cross-bundle review edits revise provisional suggestions while
  preserving stable file identities and cleaning up an emptied source bundle;
- applying selected bundle proposals retires accepted rows while unchecked
  bundles retain their IDs and edits in the same open plan. Apply resolves only
  the required collection paths, reuses existing context by stable collection
  id, and reports a localized conflict if that target was removed or reparented
  after the plan was generated instead of creating a same-name lookalike;
- confirmed groupings are durable and win over heuristics on re-scan: a confirmed bundle is never silently re-split or merged, and a newly discovered matching stem in its directory is suggested as an addition, not auto-applied;
- a CONTAINER is a logical-collection suggestion, not an ongoing path-to-collection sync;
- fast-add and manual creation confirm immediately because the user already chose the grouping.

Bundle/container reclassification is available for new suggestions. Existing
collection context cannot be renamed, moved, or reclassified, and an addition
proposal is not renameable while it targets its existing confirmed bundle.
Switching the addition to new-bundle mode enables the same title editor as other
new bundles and applies without changing the suggested existing bundle.

## UI and interaction direction

The UI should feel like a desktop media organizer, not an administration dashboard.

Use the supplied Eagle screenshots as interaction references and store copies under `docs/reference/eagle/` when available. Do not commit user source media.

### App shell

Recommended layout:

- left sidebar: library selector, primary Update action, system views, Smart Collections, hierarchical collection tree, File Browser entry points, tag entry points;
- top toolbar: breadcrumbs/title, filter categories, search, sort, view controls, zoom/density control;
- center: virtualized bundle browser in Bundle Browser; library-root directory browser in File Browser;
- right inspector: selected bundle metadata and files, or selected file/directory details in File Browser;
- modal/detail viewer: media preview, playback, and grouping review.

System views should include All, Uncategorized, Untagged, Recently Added / Recently Used, Unbundled (scan-staged files awaiting bundling/confirmation), Random, All Tags, Missing Files, and Trash later where useful.

### Bundle Browser layouts

Plan for justified layout similar to Eagle/Google Photos, fixed grid, list/table layout, masonry/waterfall layout, and persistent layout/zoom/sort/filter preferences per view where practical.

All large collections must be virtualized or paginated. Never render an entire large library into the DOM.

### File Browser layouts

Plan for directory list/tree navigation scoped to the active library root, file table/list layout with name/type/size/modified time/support state/linked state, hidden-file exclusion, and no write actions in the first milestone. Later File Browser should grow into a true filesystem browser with guarded write actions and default-app handoff.

### Bundle cards and inspector

A bundle card should communicate selected cover/thumbnail, title, media/file count when greater than one, current-media duration or image dimensions, rating, lightweight status indicators, missing/offline/stale state, grouping review state, and selection state.

The inspector should expose bundle-level fields first: cover, title, note, tags, collections, rating (0–5 stars in half-star steps), aggregate properties, and files in the bundle. Selecting a file within the bundle reveals file-level technical metadata. File note/source controls are deferred; filenames remain the displayed names.

### Tag selector

The tag selector should combine the useful Eagle group picker with the new hierarchy: search, group/category list with counts, tag tree/list with hierarchy indentation, tags appearing under multiple groups, include/exclude states, any/all rule, descendant toggle, keyboard/mouse support, and accessible alternatives to right-click exclusion.

### Bundle Browser

Inside a collection, show breadcrumb/title, direct subcollection selector/count, `Show subcollection contents` toggle, normal filters and views, and descendant-inclusive collection counts in the sidebar.

### File Browser

Inside File Browser, show library breadcrumbs, directories first, all non-hidden files/directories, support/openable state, linked-to-bundle state when known, missing/stale indicators when a previously linked path is gone, and read-only controls. Source operations require a separate portable operation contract. Entering a directory may reconcile only the linked direct children expected there; it must not trigger a whole-library scan or guess moved-file identity from an unlinked path.

File Browser is not a replacement for Bundle Browser. It is a filesystem browser and linking/diagnostic surface. Bundle Browser remains the primary organization and browsing surface.

### Smart Collection editor

The initial editor should follow the supplied Eagle reference: Smart Collection name, all/any selector, true/false inversion, repeatable condition rows, field/operator selectors, typed values with autocomplete where appropriate, add/remove buttons, live result count, server-side validation, and clear error messages.

Typed field examples: title/name, note, URL/source, tags/collections, rating, type/extension/codec, duration/size/dates, file count, missing state, and subtitle presence.

The simple filter toolbar and Smart Collection editor must compile to the same canonical filter expression model.

## Future compatibility

Avoid schema choices that block these later features:

- multiple users with per-user watch history, favorites, and view preferences;
- remote quality selection and hardware-accelerated transcoding;
- Android TV native client;
- metadata sidecar export;
- duplicate detection and manual duplicate/copy resolution;
- plugin/import adapters;
- additional asset types.

Do not implement these prematurely. Add nullable ownership/audit fields only when they have a clear migration path and do not complicate the MVP.

## Explicit anti-goals for the first release

Do not spend MVP time on:

- internet metadata scraping;
- AI auto-tagging, OCR, or face recognition;
- social or collaboration features;
- public cloud hosting;
- full multi-user RBAC;
- Eagle import or synchronization;
- destructive file management enabled by default;
- open-with-default-app before a safe local/native host-integration design exists;
- duplicate detection or automatic duplicate merging;
- Android TV implementation beyond the existing pairing groundwork;
- a general plugin marketplace;
- a complex distributed job system;
- premature replacement of SQLite.

The first release succeeds when the owner can register or create a Cairndex library, scan it, review grouping suggestions into bundles/collections, assign covers/tags/collections/metadata, browse both logical collections and filesystem directories, filter quickly in an Eagle-like interface, survive external filesystem moves through scan-based repair where possible, and play supported media with correctly linked subtitles without modifying source files.
