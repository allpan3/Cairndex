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
The wider discovery, browse, API and local-observation backend slice passed
40 tests on Cairndex macOS. Recovery compatibility and full VM gates remain
part of branch qualification.

Update now counts phase-local work in a private table committed with each batch.
Totals cover known catalog checks, repair candidates and grouping indexes;
enumeration and the grouping/export algorithms retain indeterminate progress
with explicit phase labels. Counts reset on restart. Two focused backend tests
passed for phase/restart behavior and bounded path observations. Unbundled's
page checks use stat through no-follow directory handles, without probing,
hashing or enumeration. They do not change catalog metadata.

Use synthetic libraries only. Compare the earlier and restored applications on
equivalent fixtures, then add outcome-based tests for the identified losses.
Include large paginated reviews, interrupted/retried saves, missing or changed
media, library/server switching and ordinary Quit/reopen.

Restoration is complete only when every row has an implemented or explicitly
accepted disposition and its behavior has been demonstrated. Run the complete
macOS and Linux VM gates, applicable deployment checks, publication privacy and
all PR CI checks before merge. Build merged main for the next owner test and
report any remaining differences before offering installation.
