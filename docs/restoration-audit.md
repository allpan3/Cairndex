# Portable application behavior restoration

Restoration is incomplete. Owner testing on 2026-10-19 found missing workflows
and interaction defects after the portable application replacement. This record
defines the remaining work and its acceptance checks. A passing replacement
test suite does not establish equivalence to the earlier application.

## Reference and decisions

The comparison starts with `7d5e50b6`, the last main commit before the portable
application merge in PR #45, `cbf1643d`. Later accepted decisions and the owner's
current requests take precedence over that reference. The other-machine audit
identifies published replacements and omissions that explain the reported
differences.

Preserve these accepted changes:

- The portable catalog, private working databases, guarded catalog commits and
  reviewed source operations under ADR-0035 and ADR-0036.
- The ordered media cursor under ADR-0016. The current file and its playback
  timestamp determine resume; cover artwork does not choose the current video.
- Private, recoverable drafts and exact retry receipts. An interrupted save
  remains recoverable while a completed save releases its temporary UI state.
- Settled groupings under ADR-0011 and discovery's identity validation under
  ADR-0032. Restoring review controls must preserve confirmed memberships and
  revalidate accepted changes.
- Reviewed conversion, retained originals and explicit Undo under ADR-0038,
  and the macOS SQLite durability policy under ADR-0039.

## Remaining behavior

The table defines acceptance for this branch. Implemented slices and their
verification follow it; remaining rows stay open until demonstrated.

| Behavior | Timeline and evidence | Required treatment |
| --- | --- | --- |
| Grouping review | PR #45 disconnected `GroupingReview` and introduced separate discovery components. PR #92 restored automatic opening, not the old editing interface. | Restore a coherent suggestion tree, selection, rename, Narrow/Widen, grouping edits, ordering and collection placement over private reviewed discovery. |
| Update progress | The old `JobProgress` supports processed/total; `DiscoveryNotice` only displays observed files and an indeterminate bar. | Show the active phase and completed/total work when that phase has a known total. Enumeration must state that its total is still being discovered. Preserve cancellation. |
| Collection badges | `b79a7b74`, 2026-08-15, made counts follow Show subcontents. PR #90 preserved that rule. The latest owner feedback asks for fold-based badges. | Treat the latest request as a change to the earlier rule: collapsed rows count unique descendant membership, expanded rows count direct membership. Keep the listing's Show subcontents preference independent. |
| Unbundled availability | PR #90's adapter assigns every entry `unknown`, regardless of observation evidence. | Return meaningful local evidence and describe genuinely unobserved files accurately. Never infer missing bytes from catalog presence alone. |
| Bulk inspector retention | PR #90 introduced `bulkRetained`; PR #91 clears successful operation intent without clearing the parent's retained flag. | Release the bulk inspector after successful saves so one selected bundle gets its own inspector. Preserve genuine interrupted work. |
| Bundle opening and resume | PR #45 routes a card open through the album. The private viewer still supports a cursor and generation-bound progress. | Restore the expected viewer opening action and resume the correct current file and timestamp through clicks, keyboard actions and reopen. Keep explicit Open Bundle navigation. |
| Local history and sorts | Restoration left Recently Used, Size, Date Modified and Date Opened unavailable. These were deferred, not implemented upgrades. | Restore current-device behavior with private observations/history, subject to the scope decision below. State unknown values and time semantics explicitly. |
| Manual bundling suggestions | Portable hooks disable ranked target suggestions and draft title/role suggestions. Nearby choices use path order. | Restore useful ranking, title/role defaults and nearby-file choices over the portable catalog with guarded confirmation. |
| Maintenance actions | The portable library menu omits separate Scan, Suggest grouping, Collect metadata and Generate storyboards actions. | Audit each action against later on-demand work. Restore useful explicit controls through bounded private jobs; retain automatic work that already supersedes an old step. |
| Earlier restored interactions | PRs #63 through #92 restored features in separate slices. Their tests did not establish complete interaction equivalence. | Compare navigation, menus, selection, inspectors, grouping, playback, exports and file operations with the reference on the same synthetic data. Record each intentional difference. |

## Further comparison findings

Further source comparison found two distinctions to cover during grouping work.
The private planner currently treats every cataloged bundle as a settled owner,
including staged Unbundled files. ADR-0011 settles confirmed groupings, so the
eligible staged-file path must also be restored with stable file identities.
The card's `review` badge is present even in the pre-portable reference, despite
ADR-0011 retiring it. That is an older implementation deviation, rather than a
feature lost in PR #45. Follow the accepted decision when restoring this area.
Manual bundling already assigns roles during guarded apply; its missing draft
preview and ranked suggestions must use those same established rules.
Portable browse search also excludes filenames, paths, source values, tags and
collection names that the earlier index included. The implementation and topic
document agree on this narrower scope, but the audit has not found owner approval
for removing those fields. Restore their indexed search while keeping file notes
and moment comments searchable. Manual grouping's filename candidates must also
work at the library root and across folders, independently of the first page.

The broader source comparison also finds unlinked media opening disconnected
in File Browser: portable entries require a catalog ID, while the earlier
viewer could open a supported relative path without indexing it. New-library
creation also no longer invokes the earlier indexing callback; desktop index
requests have no active consumer. Verify and restore initial private discovery
without publishing provisional groupings. Smart Collection creation/deletion
currently opens Metadata Review instead of the earlier filter editor and
explicit deletion. These ordinary workflows remain open in the final comparison;
their underlying portable safeguards do not require losing the controls.

The comparison also finds that desktop completion notifications have no caller
in the portable workspace. The earlier workspace fed its active maintenance
snapshots to the shared notification hook. Restore that connection for discovery
and explicit media passes, preserving the existing long-run, away-window and
permission rules. This is a disconnected feature, not a documented replacement.

## Owner scope decisions (2026-10-19)

Restore Recently Used, Size, Date Modified and Date Opened from this device's
observations and history. Keep cross-device playback synchronization separate.
Private playback state remains on each serving instance. This is a scope
decision, not a claim that a deferred feature was replaced by an upgrade.

Conversion intentionally retained old playback positions, cursors, last-opened
times and pending grouping plans in the backup. The owner does not want those
old positions imported. Remembering and resuming the correct file and timestamp
for current-app activity is required and does not depend on importing them.
Stale grouping plans and old trash/import staging must not execute themselves.

## Verification and completion

The first interaction slice fixes bulk retention, fold-based collection badges
and viewer opening/resume. In Cairndex macOS, 40 focused web tests passed,
including the fresh-cursor race, track-switch progress, collection folds and
phase progress. Four full-stack browser scenarios passed: retained bulk edits,
album pagination/draft return, changed/late album responses, and two-video
resume through double-click, Enter and reload. The bulk-release and departing
track tests were observed failing before their fixes. Full VM gates and broader
reference comparison remain outstanding.

Both selection-suite scenarios subsequently passed, including the displayed
Unbundled page distinguishing an existing file from missing synthetic paths
without any unknown rows. Web lint and type checking passed. Backend lint,
type checking and the two focused backend cases passed as well.
The [synthetic selection capture](screenshots/portable-selection.png) comes from
the corrected Linux full gate and has been visually checked for privacy.
The wider discovery, browse, API and local-observation backend slice passed
40 tests on Cairndex macOS. Recovery compatibility and full VM gates remain
part of branch qualification.

Local history/sorts are implemented under
[ADR-0040](adr/0040-local-browsing-history-and-observations.md). Two backend
tests passed for complete SQL ordering before pagination, unknown sizes,
separate opening/edit times, unchanged-value saves and peer isolation. A
full-stack macOS scenario passed for album opening, read-only pagination,
Recent's persisted Date Opened choice, Date Modified after an edit, Size after
Update, inspector size and older-server capability handling. Six backend cases
then passed, including recovery retaining history while clearing file facts,
older private-schema recovery, replacement invalidation and the browse API.
Backend lint/type checks and web lint/type checks passed. No old positions were
imported. Full branch qualification remains pending.

Update now counts phase-local work in a private table committed with each batch.
Totals cover known catalog checks, repair candidates and grouping indexes;
enumeration and the grouping/export algorithms retain indeterminate progress
with explicit phase labels. Counts reset on restart. Two focused backend tests
passed for phase/restart behavior and bounded path observations. Unbundled's
page checks use stat through no-follow directory handles, without probing,
hashing or enumeration. They do not change catalog metadata.

The corrected Linux full gate passed: 1,957 backend tests, 49 browser scenarios,
four frozen checks and 135 Rust tests. The manifest check for unsupported
Linux-arm64 packaging is deselected there. macOS qualification exposed a restart
test that assumed 100 ticks would always finish. Forcing one phase per tick
reproduces the failure on Linux; allowing the scan helper's 1,000 ticks passes
while preserving the cancelled-run, restart and unchanged-catalog assertions.
No production time budget or durability setting changed. The final macOS gate
and renewed qualification remain pending.

That macOS run ended with 1,957 backend passes and the restart-limit failure.
It also passed 48 of 49 browser scenarios; the nested-tag check saw only the
first segment when its five-second population poll expired. Creation uses two
guarded segment saves. The focused macOS scenario passes in isolation. Its
completion check now waits for the creation dialog to close before checking the complete tag
population. Packaged sidecar, frozen checks, web checks, 137 Rust tests, desktop
build and distribution verification passed. A complete corrected run is still
required before merge.

The renewed macOS gate passed all 1,958 backend tests, four frozen checks,
155 web test files, 137 Rust tests and packaged-app distribution. It failed two
of 49 browser scenarios: an album was still loading at the five-second assertion,
and a selected video reported a local probe failure. Both scenarios passed on an
isolated two-worker rerun; this does not qualify the full gate. Follow-up tests
reproduce duplicate simultaneous probes of one generation and redundant writes
of unchanged local facts. The fix coalesces per-file inspection across request adapters and writes
observation rows only when their values change. Both reproductions were observed
failing before the fix; all 28 media/history tests then passed on macOS.
Durability settings remain unchanged. A synthetic local-disk microbenchmark on
Cairndex macOS used 150 repeated unchanged observations per mode, alternating
five runs. Median/p95 elapsed time including connection and transaction was
11.458/16.874 ms before and 0.213/0.605 ms after. `synchronous=FULL`, `fullfsync=ON`
and `checkpoint_fullfsync=ON` were confirmed. This measures redundant observation
writes, not rating/edit commit latency or overall UI response. Renewed full
qualification is required.

The next Linux gate passed with 1,959 backend tests and all 49 browser scenarios.
The corresponding macOS gate passed 1,960 backend tests and all build checks,
but its replica-delivery scenario copied synthetic envelopes before publication
finished. Exchange is a bounded, nonblocking attempt; an enabled button is not
a publication receipt. A temporary write-denied synthetic provider reproduces
the old peer-value failure. Waiting for fresh HTTP outbox status before copying
passes that same macOS scenario. Both full gates must pass the corrected test.

Both corrected full gates passed on the browsing/history implementation, with
synthetic temporary libraries only. macOS passed 1,960 backend tests, 155 web
test files, all 49 browser scenarios, four frozen checks, 137 Rust tests and
packaged-app distribution. Linux passed 1,959 backend tests, all 49 browser
scenarios, four frozen checks and 135 Rust tests, with its unsupported-platform
manifest check deselected. Receipts are
`restoration-browsing-history-v6-mac-20261019-060149` and
`restoration-browsing-history-v6-linux-20261019-060218`. Editable grouping and
the remaining restoration rows still require separate qualification.

The browsing/history slice merged through PR #99 after all 16 hosted checks
passed. The trusted privacy gate required its reviewed synthetic image declaration
on main first; prerequisite PR #100 registered the exact image without changing
scanner rules or private patterns. Bringing that main into the feature branch
preserved the qualified file tree exactly, and renewed hosted CI passed.

Staged-file eligibility and identity-preserving acceptance are implemented on
`fix/portable-grouping-identities`. The planner now settles confirmed owners
only, and captures the observed path, lifetime and arrangement bases of eligible
cataloged files. Acceptance reuses one complete provisional source where possible,
keeps file IDs and dependent moments/subtitle choices, and serializes emptied
source memberships. Sources with their own metadata or collection/tag membership
cannot be silently discarded when combining groups. This is a safety constraint
on cleanup; keep those sources as separate groups. Discovery fixtures now mark
their settled examples confirmed explicitly.

Three focused cases pass for preserved metadata/IDs, changed confirmation and
refusal to discard another source's notes. The wider discovery/planner/large-review
slice passed 41 cases, and media plus structural recovery passed 28. Backend lint,
format and type checks passed. Full qualification and the editable review UI remain
outstanding. This implements ADR-0011 through the current private review model;
it does not need a new architecture decision.

The private editable grouping engine is implemented on
`fix/portable-grouping-review`, with paged logical nodes, persistent file selection,
idempotent revision-guarded commands and bounded role recomputation. Rename,
file moves/order, reparenting, reversible additions, existing collection context,
bundle/collection conversion and per-folder Narrow/Widen operate on this private
draft. Regrouping copies only affected members into bounded planner pages before
an atomic splice; unrelated edits and dragged-out files remain in place. Private
schema validation and recovery inventory include the graph and command receipts.

The initial engine slice added private API and lifecycle integration, immutable
export and guarded acceptance before advertising a capability. The application
tree follows in the later slice described below.
Ten focused cases passed for paging, exact retries, restart, stem-rule parity,
strict sidecar splitting, collection placement and recovery detecting lost choices.
The broader grouping/planner/recovery slice passed 99 cases on Linux. Backend
lint, format and type checks passed; full feature qualification remains open.

The next slice passed 18 grouping acceptance, paging, API and worker cases.
Checks cover edited membership/order and existing collection placement, stale
source refusal, exact retry, partial acceptance retaining IDs/moments and refusing
later competing confirmation, and the registered worker completing queued edits.
Captured collection bases are checked again before acceptance. The graph freezes
during review and retains unchecked files after acceptance. Remaining staged bases
advance only through that exact accepted event and its ancestry. Backend lint,
format and type checks pass. API artifacts are regenerated; UI and full feature
qualification remain open. These controls extend the existing guarded review
contract, so a new ADR is not needed.

Optional complete-content verification now runs against the immutable edited
grouping snapshot before preparation. Cancellation retains the original draft.
The ordinary and edited review paths share the same verification enqueue logic;
14 verification and grouping-acceptance cases pass on Linux, along with backend
lint, formatting and type checks. The editable interface remains unfinished.

The first application tree is now wired behind `grouping_version: 1`. It retains
private selection and edited names across reopening, supports file moves/order,
Narrow/Widen, kind conversion, persisted collection placement and guarded
preparation/acceptance. Complete-content verification remains available. The
uncertain view queries the complete draft; file-change categories filter before
pagination, and earlier candidate drafts remain accessible.

Linux checks pass for 29 backend workspace/acceptance/verification/recovery cases,
six focused web cases and the 60 legacy reference cases. Two new live scenarios
pass for exact edited membership/order, verification, unchanged source bytes and
201-file partial acceptance. The latter keeps the last file visible after edits
and adds the remaining file to the same settled bundle. The earlier retained
candidate/recovery scenario also passes after preserving its selection across
the compatibility view. Loaded pages remain visible but read-only while their
revisions refresh, using fresh cursors for the complete loaded prefix.

Recovery now pauses unfinished grouping commands at their original phase and
cursor. Only an explicit exact resume continues them. Both queued and partially
executed edits pass actual backup/prepare/activate checks without automatically
changing the recovered draft. Existing safety decisions cover this private edit
lifecycle; a separate ADR would repeat ADR-0035's explicit-retry requirement.

The next slice implements media summaries and repeated-sibling rollups over
loaded node pages. Runs contain at least three matching bundles and at most
fifty, so one revision-guarded checkbox command captures the exact displayed
members. Uncertain groups, additions and different shapes stay visible. Opening
or folding a run never changes selection. Show files applies to later requested
pages with per-row fold overrides; dragging temporarily reveals individual file
targets without changing that preference. Arrow navigation also works from row
controls. Twenty-five focused backend cases, 69 focused web/reference cases and
static checks pass on Linux. An ordering regression failed before the fix:
regrouping one folder could renumber unrelated siblings against positions already
changed by the same SQL update. Materializing the old positions preserves natural
and manually chosen order across Narrow/Widen. The certainty comparison also
failed before its fix at all three stem levels; automatic regeneration now uses
the earlier evidence rules, while explicit type splits inherit parent certainty.

All seven focused Linux browser scenarios pass. The combined interaction case
covers sibling summaries and mixed selection, row keys, Narrow/Widen, file and proposal drags,
type conversion, keyboard placement, retained reopening in the ordinary browser
and unchanged source bytes. Portal options keep their keyboard navigation instead
of bubbling into tree movement. Proposal drags keep file lists folded so their
targets remain in place; only file drags reveal those lists. Filtering an empty uncertain view shows a clear
message and keeps selection unchanged. The other cases cover earlier discovery
drafts, repairs, cancellation, competing identities and 201-file partial acceptance.

The shown-collection expansion controls intentionally preserve paging; they do
not download the whole draft. The [synthetic review capture](screenshots/portable-grouping-review.png)
has been inspected for privacy. Both full VM gates remain required before publication.

The first full Linux grouping gate failed when prior synthetic test directories
left its 4 GiB tmpfs without room for the complete backend suite. It also found
an outdated preview test expecting a provisional badge on the now-confirmed
playback fixture. The assertion now separates confirmed grouping from local
media observations. Its other 51 browser scenarios passed. The obsolete macOS
run was cancelled before qualification because it retained that same assertion.
Neither run qualifies the feature; corrected full gates are required.

The corrected Linux full gate passed with 1,987 backend tests, all 52 browser
scenarios, four frozen checks, 159 web test files and 135 Rust tests. Its receipt
is `restoration-grouping-v2-linux-20261019-084004`, with `Final result: 0`.
macOS qualification remains pending. PR #101 registered the exact reviewed
synthetic grouping capture on main before any image publication.

The macOS v2 run passed 1,988 backend tests, four frozen checks, 137 Rust tests
and distribution verification. It ended with `Final result: 1` after one of
1,338 web tests and four of 52 browser scenarios failed. The Servers check
assumed workspace mounting also completed the dialog close effect. Album
pagination checked a button name that changes before the response arrives.
Nested tag creation closes its dialog before its two guarded saves finish.
Grouping selection needed to wait for refreshed, enabled rows, because
Playwright skips `check()` when an older disabled row is still checked. The
201-file Update also needed its existing long-job completion signal before
checking automatic review opening. These checks now wait for completed work.
Synthetic fixture setup batches DDL and rows in one transaction; production
durability is unchanged. The focused macOS rerun passes all 78 web/reference
cases and all four affected browser scenarios, including the 201-file partial
acceptance. Receipt `grouping-mac-repair-focused-20261019-100709` records the
results. A corrected full run remains required.

The final-source Linux gate passed after the synchronization repairs: 1,987
backend tests, all 1,338 web tests in 159 files, all 52 browser scenarios, four
frozen checks and 135 Rust tests. Receipt
`restoration-grouping-v4-linux-20261019-102313` ends in `Final result: 0` with
unchanged guest source. macOS qualification remains required.

The renewed macOS run passed 1,987 backend cases but failed the grouping API
test's initialization. The test counted fifteen exchange attempts; the
nonblocking lock allows all of them to skip work while the background worker
imports the catalog seed. A controlled Linux schedule that holds the lock for
those attempts reproduces the same readiness error. Waiting for actual seed
readiness passes that schedule and all ten grouping acceptance cases. Only the
test changes; production locking and durability remain unchanged. This macOS
run does not qualify the feature. Receipt
`restoration-grouping-v3-mac-20261019-101050` ended in `Final result: 1`.
All 1,338 web tests and 51 browser scenarios passed. The remaining Create
assertion expired after five seconds while the UI still said it was opening
library metadata. It now waits up to 30 seconds for the admitted library's
selector. Packaged checks, 137 Rust tests, app build and distribution passed.
Both corrected cases pass on macOS, including the controlled busy-lock schedule
and the real Create flow. The latter receipt is
`grouping-readiness-create-mac.log`. A renewed full gate remains required.

The corrected macOS full gate passed 1,988 backend tests, all 1,338 web tests
in 159 files, all 52 browser scenarios, four frozen checks and 137 Rust tests,
plus the desktop app build and distribution verification. Receipt
`restoration-grouping-v4-mac-20261019-111211` ends in `Final result: 0` with
unchanged guest source. Both VM gates now qualify this grouping slice; the
broader restoration remains open.

Grouping review merged through PR #104 after both VM gates and all 16 hosted
checks passed. This completes that slice's qualification, while the remaining
restoration rows stay open.

Manual-bundling recommendations are implemented separately on
`fix/portable-bundling-recommendations`. Nine backend cases pass for parity with
the earlier scoring, root and distant-folder matches, roles/title defaults,
stale paths, refusal of invalid seeds and older private-schema recognition.
The 57-case recovery suite also passed with the derived filename index. A
full-stack Linux scenario passed with 120 unrelated earlier-path files, then
added a subtitle to a suggested target and created a bundle from the suggested
title, cover and subtitles. Backend and web lint/type checks passed; API
artifacts are regenerated. Full qualification remains outstanding. Direct
manual bundling of unlinked File Browser paths is a separate remaining loss;
this slice restores recommendations for cataloged Unbundled files.

The following local slice also prepares selected unlinked File Browser paths
through the existing catalog preview/commit jobs, without authored provisional
bundles or an Update prerequisite. Bounded source reads pin observations; commit
rechecks them and preserves exact retry receipts. Mixed selections retain
existing file IDs, and the shared bundling rules provide roles and subtitle
links. Fifty focused backend cases and both full-stack browser scenarios pass
on Linux, including unsafe paths, changed sources, append order, metadata
preservation, private receipt validation and the ordinary File Browser workflow.
Backend and web static checks pass. Direct path identities require format three;
format two retains its existing version-12 ID-based controls. The expanded
manual/recovery slice passes 79 cases, including actual backup and activation
with a pending source commit. Reopening retains its private preview without
applying it; an explicit exact retry completes the commit. Both full VM gates
remain pending for this slice.
This extends the existing ADR-0032 boundary; it does not need another ADR.

The first complete Linux manual-bundling gate passed 2,009 backend tests,
packaging, frontend checks and 135 Rust tests. It passed 53 of 54 browser
scenarios. The existing empty-bundle workflow exposed a real loss: ranked
recommendations offered no files for an unrelated title. Add Files now also
pages and searches the complete Unbundled population, opening that picker
automatically when there are no recommendations. Exact checked IDs survive
paging and search changes. All three focused browser scenarios and web static
checks pass, including a later-page choice and selection retained through search.
The [synthetic picker capture](screenshots/portable-manual-file-picker.png) was
reviewed edge to edge. Renewed full qualification remains pending; that failed
gate does not qualify the feature.
PR #102 merged the capture's declaration after every applicable hosted check
passed. The functional branch still awaits qualification before publishing it.

The corrected Linux manual-bundling gate passed 2,009 backend tests, all
54 browser scenarios, 159 web test files, four frozen checks and 135 Rust tests.
Receipt `restoration-manual-bundling-v2-linux-20261019-094245` ends in
`Final result: 0`. The renewed run including the parent's test synchronization
repairs passed every stage, including all 54 browser scenarios. Receipt
`restoration-manual-bundling-v3-linux-20261019-104050` ends in
`Final result: 0` on unchanged guest source. Initial macOS qualification remains
required.

The first full macOS manual run passed 2,010 backend tests, web/static checks,
four frozen checks, 137 Rust tests and app build/distribution, but failed one
of 54 browser scenarios. The album's pagination check treated an absent loading
label as completion before the pending state had rendered. Its failure context
still showed 100 of 125 items with a running request. A controlled six-second
page delay reproduces the original failure; waiting for the complete item count
passes on the same schedule. This changes test synchronization only. Both
corrected full gates remain required.

The next Linux manual gate failed its packaged online-backup scenario after
passing 2,009 backend tests and all 54 browser scenarios. A deterministic test
reproduces SQLite removing each temporary sidecar between enumeration and its
type check. Backup now accepts only those expected disappearances. All eight
focused cases pass on both guests, and the Linux recovery suite and rebuilt
packaged scenario pass. Missing primary files, unknown entries, links and
unsupported types remain refused.

The second macOS manual gate passed 2,010 backend tests, all packaged/web/native
checks and distribution, but failed four of 54 browser scenarios. Three failures
used premature completion signals. The repaired checks await actual album data,
the second peer's committed title and enabled grouping controls. A separate
test reproduces virtual keyboard focus loss before its target mounts. The fix
retains the target by row identity until its render, unless focus moved elsewhere.
Both focus cases and all four affected browser scenarios pass on macOS with web
lint/type checks. The large Update passed unchanged in isolation and with another
scenario running. These focused passes do not qualify either full gate.

Both renewed manual-bundling gates now pass on unchanged source. Linux passes
2,017 backend tests, all 54 browser scenarios, four frozen checks, frontend
checks/build and 135 Rust tests. macOS passes 2,018 backend tests, all 54 browser
scenarios, four frozen checks, frontend checks/build, 137 Rust tests and app
distribution verification. Receipts
`restoration-manual-bundling-v6-linux-20261019-141556` and
`restoration-manual-bundling-v3-mac-20261019-141556` both end in
`Final result: 0`. This qualifies the manual-bundling slice; the later restoration
branches and final owner build remain pending.

The local search slice restores filename, path, source, tag and collection
matches over the complete indexed catalog, keeping file notes and moment
comments. Filename classification also supplies searchable media kinds without
probing. File transfers, field edits, edge changes and tag/collection renames
refresh affected bundle rowids in the same transaction. Startup replaces the
known narrower derived layout atomically and repopulates it in bounded batches.
One index module now supplies both startup and private-schema recognition.
The focused Linux slice passes 84 backend cases for later-page matches,
changes, historical upgrades, rollback and recovery. Backend/web static checks
and the new whole-population browser scenario also pass. Full gates remain
required before publication. This restores the earlier search contract and
changes a private derived index only, so another ADR is unnecessary.

The full Linux search gate passes 2,012 backend tests, all 55 browser scenarios,
159 web test files, four frozen checks and 135 Rust tests. Receipt
`restoration-search-v1-linux-20261019-110423` ends in `Final result: 0` with
unchanged guest source. Later parent changes affect test synchronization only;
the search implementation is unchanged. Both complete combined restoration
receipts, `restoration-combined-v4-mac-20261019-165332` and
`restoration-combined-v4-linux-20261019-165332`, also end in `Final result: 0`.
They exercise the same index module and search regression scenarios, alongside
the remaining restoration work. This search branch contains only its own slice;
the other branches and final merged-main owner build remain separate.

The local initial-discovery slice reconnects Create and native destination
requests to the admitted portable workspace. Each server/library request is
consumed once; unrelated libraries leave it queued. Discovery uses existing
bounded jobs, while registration and reopening enqueue nothing. Initial work
keeps pending suggestions private and does not open grouping review. The
Linux checks pass 86 focused web cases, lint/type checks and the normal-Create
browser scenario. They cover native destination isolation, pending admission,
private candidates without authored file rows, unchanged source bytes and
reopening without a second scan. A delayed initial-result test failed before
its originating-run guard was added; it now passes and preserves the later
manual Update. Receipt `initial-discovery-focused-20261019-101927` records the
passing run. An additional browser check holds catalog admission, verifies
that discovery remains idle, then admits the workspace and confirms one private
scan. It passes in `initial-discovery-admission-v2-20261019.log`. Full
Linux qualification passed 2,012 backend tests, all 55 browser scenarios,
159 web test files, four frozen checks and 135 Rust tests. Receipt
`restoration-initial-discovery-v1-linux-20261019-113016` ends in
`Final result: 0` with unchanged guest source. Both complete combined receipts,
`restoration-combined-v4-mac-20261019-165332` and
`restoration-combined-v4-linux-20261019-165332`, also end in `Final result: 0`,
with the same initial-discovery hooks and browser scenarios. Other restoration
branches and the final merged-main owner build remain separate.
This restores the earlier initial indexing outcome within ADR-0032,
so another ADR is unnecessary.

The local Smart Collection slice reconnects ordinary sidebar creation, editing
and explicit deletion at `browse_version: 14`. It shares the existing condition
builder and preview query while retaining private drafts, opening causal bases,
creation identities and exact pending requests. Guarded previews refuse stale
openings. Name-only changes leave advanced filter text untouched; deletion
keeps all bundles and media. Linux passes 25 backend cases, 15 web cases,
backend/web static checks and the real browser workflow. The browser verifies
draft reopening, matching results, exact advanced-rule preservation, refusal
of a stale save and deletion without bundle loss. Its focused receipt is
`smart-collections-focused-20261019.log`. The full Linux gate passed 2,017
backend tests, all 1,347 web tests in 160 files, all 56 browser scenarios, four
frozen checks and 135 Rust tests. Receipt
`restoration-smart-collections-v1-linux-20261019-115727` ends in
`Final result: 0` with unchanged guest source. Both complete combined
restoration receipts, `restoration-combined-v4-mac-20261019-165332` and
`restoration-combined-v4-linux-20261019-165332`, also end in `Final result: 0`.
They exercise the same editor, guarded command and regression scenarios,
including the capability check accepting supported later browse versions.
Other restoration slices and the final merged-main owner build remain separate.
The [synthetic editor capture](screenshots/portable-smart-collection.png) was
reviewed edge to edge; PR #103 registered its declaration before publication.
This restores an existing workflow over the accepted catalog/draft contracts;
it does not need another ADR.

The local maintenance slice restores separate Scan, Suggest grouping, Collect
metadata and Generate storyboards controls. On-demand probes/storyboards are
useful additions, but did not replace explicit library preparation. Scan runs
the existing private discovery pipeline without opening review; its prepared
suggestions remain private. Suggest grouping opens the retained editable tree.
Explicit media passes use private catalog jobs on the bounded source worker,
then the existing storyboard queue. They retain progress across restart, support
cancellation and pause on private recovery. No media bytes or authored catalog
values change. Eight Linux backend/worker cases and backend/web static checks
pass. The real maintenance and grouping-menu browser scenarios pass in
`maintenance-browser-20261019.log`, with source hashes and authored values
unchanged. The full Linux gate passed 2,023 backend tests, all 57 browser
scenarios, four frozen checks and 135 Rust tests. Receipt
`restoration-maintenance-v1-linux-20261019-121536` ends in `Final result: 0`
with unchanged guest source. Both complete combined restoration receipts,
`restoration-combined-v4-mac-20261019-165332` and
`restoration-combined-v4-linux-20261019-165332`, also end in `Final result: 0`
with the same maintenance implementation. Publication review found the browser
test passed its server wrapper to the child-process stop helper. Correct cleanup
also closes the page before stopping its server, preventing polling requests
from reaching a stopped backend. The intermediate Linux cleanup run exposed that
ordering mistake. The corrected scenario, lint and formatting pass on both guests
in `maintenance-cleanup-20261020-015257`; application code is unchanged.
Publication and the final merged-main owner build remain separate. This reuses
the accepted private job and derivative boundaries, so no additional ADR is needed.

The local unindexed-playback slice restores the shared folder viewer for
physical video/audio/image paths without fabricating catalog rows. A selected-path
observation and bounded probe cache feed the existing playback decision and
HLS manager. Raw ranges, image previews, pinned decoder inputs and session
artifacts retain source-generation checks and portable admission. Mixed folder
playlists preserve linked-file progress/cursors, moments and local usage.
Unindexed files retain the earlier limits that require a catalog identity.
Linux passes 106 backend cases, 77 focused viewer/File Browser web cases,
backend/web static checks and the mixed-folder and linked-resume browser cases.
The mixed folder exercises video, TIFF previews and audio, linked resume and
progress on file switch, plus unchanged source hashes and authored rows. It
exposed an additional directory-adapter restriction on unindexed files; both
that restriction and the obsolete inspector message are corrected. This restores the existing scoped path contract over private media storage;
no persistent migration or additional ADR is needed. The full Linux gate
passed 2,034 backend tests, all 1,349 web tests in 161 files, all 58 browser
scenarios, four frozen checks and 135 Rust tests. Receipt
`restoration-path-media-v1-linux-20261019-124114` ends in `Final result: 0`
with unchanged guest source. Both subsequent complete combined restoration
receipts, `restoration-combined-v4-mac-20261019-165332` and
`restoration-combined-v4-linux-20261019-165332`, end in `Final result: 0` with
the same path-media implementation. Publication review corrected browser cleanup
to close its page before stopping its child server. The scenario, lint and
formatting pass again on both guests in `path-cleanup-20261020-020812`;
application code is unchanged. Publication and the final merged-main owner
build remain separate.
The [synthetic folder viewer](screenshots/portable-path-viewer.png) was reviewed
edge to edge. PR #105 registered its exact declaration before publication.

The next local slice unifies retained provisional files and fresh private
observations in the ordinary Unbundled queue and manual dialogs. It selects
only the latest completed discovery, excludes current catalog paths and keeps
unaccepted files private. A derived filename index feeds bounded ranked
candidates; paged choices retain paths and catalog IDs separately. Explicit
confirmation uses the existing source preparation/revalidation jobs. Older
private schemas remain recognizable and gain the derived index on open. Linux
passes 93 backend cases, four focused web cases, backend/web static checks and
the fresh-discovery plus both existing manual-bundling browser scenarios. The
fresh-discovery scenario creates with a suggested subtitle and adds paths across
pages/searches while source hashes remain unchanged. It also verifies immediate
sidebar count refresh after confirmation. This restores the earlier workflow under the
accepted private discovery contract, so another ADR is unnecessary.
Both complete combined restoration receipts,
`restoration-combined-v4-mac-20261019-165332` and
`restoration-combined-v4-linux-20261019-165332`, end in `Final result: 0`
with the same Unbundled implementation. Publication review corrected browser
cleanup to close its page before stopping its child server. The scenario, lint
and formatting pass again on both guests in
`private-unbundled-cleanup-20261020-022328`; application code is unchanged.
Publication and the final merged-main owner build remain separate.
The [synthetic paged file choices](screenshots/portable-private-unbundled.png)
were reviewed edge to edge. PR #105 registered the exact image before publication.

Use synthetic libraries only. Compare the earlier and restored applications on
equivalent fixtures, then add outcome-based tests for the identified losses.
Include large paginated reviews, interrupted/retried saves, missing or changed
media, library/server switching and ordinary Quit/reopen.

Restoration is complete only when every row has an implemented or explicitly
accepted disposition and its behavior has been demonstrated. Run the complete
macOS and Linux VM gates, applicable deployment checks, publication privacy and
all PR CI checks before merge. Build merged main for the next owner test and
report any remaining differences before offering installation.
