# Audit extraction ledger

Continuation on another machine uses the [VM handoff plan](audit-vm-handoff.md).
The owner authorizes transfer of the application branch and preserved reference
after privacy inspection. This does not approve their merge or real-data use.

## Preserved reference and base

IDs below are current after the owner-approved history rewrite of 2026-10-09.
The [history rewrite record](#history-rewrite-and-vm-qualification) explains it.

- Reference branch: `fix/library-ownership-lifecycle`.
- Reference commit: `cd38493fcb306198ff4af00e19b5d78ada241ceb`.
- Reference tree: `912a0e657005ade3fb3e3b089df7c2343305fb99`.
- Original extraction base: local main, now `742461092aa6898b091a1f5b0b39c24d428bb0d1`.
- Fetched origin/main: `cda8998b532d6d38f4ad401cc129654e375ab4bc`.
- Local main included one unpublished development-tool fix. The reference keeps it.
- Publication base: origin/main `cda8998b532d6d38f4ad401cc129654e375ab4bc`.
  The unrelated development-tool fix is excluded from the PR.
- Installed runtime: built from the commit that is now
  `395b6206c03311fb7e4c773112bba0756308c93e`.
  Desktop and sidecar hashes match the reference's storage qualification record.
- The primary checkout was clean before extraction. The reference is unchanged.

The final main-to-reference difference has 540 paths. Historical commits are not
extraction units. [The path inventory](audit-extraction-paths.tsv) assigns every
path to a group. Shared files require a hunk review; a path assignment does not
mean its full reference contents belong to one group.

## Dependency order

| Group | Final behavior and dependencies | Tests and contract scope | State |
| --- | --- | --- | --- |
| 1 | Offline migration foundation: complete catalog, causal constraints, retained branches, private schema compatibility, format-three preparation and rollback | All-family catalog, schema/refusal, WAL, process-exit/retry and rollback tests; private schema only; no HTTP API change | Merged through PR #38; automated review accepted |
| 2 | Portable application: normal Create/Open, old-format refusal, lifecycle drain, private access and backup/recovery controls; requires 1 | Creation/admission/access/recovery API and registry schema, OpenAPI/types, browser/native, packaging and backup checks | Implemented and locally tested; application round 1 acceptance pending |
| 3 | Reviewed Update, discovery/grouping, stable-ID repair, full verification and interrupted reviews; requires 1–2 | Private discovery schemas and library-scoped API, process tests, browser/native, source-generation checks | Implemented and locally tested; application round 2 acceptance pending |
| 4 | Browse/edit: complete search/filter populations, exact saved filters, navigation, inspectors, albums, bulk selection and retained drafts; requires 1–3 for complete workflow | Catalog query/API types, component and real-server browser suites, synthetic native checks | Implemented and locally tested; application round 3 acceptance pending |
| 5 | Playback/connection continuity, scoped requests, server navigation, keyboard/layout and loading/error fixes; requires 2–4 | Media/API and native host contracts; playback, connection, component/browser/native and package checks | Implemented and locally tested; application round 4 acceptance pending |
| 6 | Reviewed source operations, identity-preserving Replace/Undo and retained recovery; then mounted SMB; requires 1–5 | Private journals and source-event protocol, API/types, process/browser/native tests; SMB and Keychain only for exact executable/share | Planned |
| 7 | Distribution/deployment: signing preflight, packaged dependencies, private volumes and backup scripts; requires applicable runtime groups | Docker contexts/images, source/license inventory, package smoke, isolated deployment restart and recovery | Planned |

Each group carries its necessary documentation, changelog, tests and fixes.
API artifacts are regenerated from that extracted branch. Later branches are
created only after the preceding review checkpoint, then based on refreshed main.
The owner permits agent review, PR creation and merge for groups with no
user-testable function, subject to all gates. Group 1 has no user interface or
owner conversion command. Other groups still require functional acceptance.
Release publication and remote-history changes remain outside this task.

## Group 1 design and changes

Branch: `feature/library-migration-foundation`.
The original implementation and review checkpoints remain on the local archive
branch `archive/migration-foundation-pre-publication`. The unpublished feature
branch is reconstructed on published main and consolidated before its first push.
Its catalog and migration code is unchanged by this reconstruction.

Catalog projection, linked seed import, relationship validation and retained-branch
recovery are inseparable from a reversible converter. Extracting only the manifest
and capability flag would lose those guarantees. Private schema definitions are
separated into `private_layout.py`; the derived search index is in `catalog/index.py`.
This preserves current layouts without importing discovery/source workers, media
execution, HTTP routes or application controls. Catalog command dependencies for
structural recovery remain internal. Shared hidden-path constants retain the same
scanner behavior.

New work relative to the reference: durable conversion intent, format-three seed
preparation, source checkpoint receipts, actual schema-definition refusal, process
interruption points and exact retry tests. Interrupted attempts remain intact.
The procedure and real-data prerequisites are in [migration](replica-migration.md).

The application remains at main's behavior. This is an offline prerequisite, not
a deployable portable-app replacement. It does not restore legacy support removed
on the reference. ADR-0035 remains the accepted target for group 2.

## Validation and limits

The final full extracted backend suite passed 1,400 tests with one existing
ffmpeg skip. Backend Ruff, formatting and mypy passed. The 27 migration tests
include eight actual subprocess exits, WAL capture, strict schema refusal,
exact retry, record preservation and rollback.
All 10 library browser regressions pass with one worker and no retries. These
check the unchanged main application; they do not run a migration interface.
Generated OpenAPI matches the tracked artifact. The built Python wheel passed
an isolated preparation, exact retry and rollback smoke test.

Normal installed-app compatibility uses fresh synthetic state and an output
created by this branch. The app was brought to the foreground before interaction.
It independently reconstructed the seed, displayed three bundles, preserved tag
and collection membership and folder members, saved a note, and retained it after
Quit/restart. The branch's rollback exporter retained that native edit with valid
relationships. The original fixture remained unchanged. Playback clock reached
the three-second end and file details matched the generated video, but the player
capture was black; decoded-pixel playback is unverified in this check.

The installed app, profile, cache, WebKit, preferences and saved state were protected.
The owner state was held while stopped, then restored with exact inventory,
hashes, modes and links. The installed app and signing configuration are unchanged.
No Keychain grant changed. Test state remains separately in private temporary
storage. No owner library or production NAS service was changed.

The native consumer is the installed reference runtime, not a rebuild of group 1.
Desktop/Rust, full frontend, full frozen-app and Docker/NAS gates are not applicable
to this offline Python extraction: their sources and application routes are unchanged.
Fresh gates remain mandatory when their corresponding groups are extracted.

## Publication review

The original scanner reported 156 findings in published main and one more in the
unpublished local-main commit. All were one owner-approved machine name in
historical STATUS blobs. They were not different private values. On 2026-10-03,
the owner explicitly authorized removal of only that exact local pattern. The
approval receipt remains in untracked Git-local state. Hooks, both home-path
patterns and all built-in checks remain active. Published history is unchanged.
The current STATUS text uses generic operational wording.

The owner authorizes agent review, PR creation and merge for this internal group.
No manual owner test is required. The preparation boundary, schema refusal,
retained attempts, receipts and rollback were reviewed. All 121 migration and
catalog tests passed again before the publication-base change. The exact final
range, complete reachable history and PR text require passing gates before push.
The final publication result and merge are recorded in the next group ledger.

## Publication-base validation

After excluding the unrelated development-tool commit, the fresh full backend
gate passes: Ruff, formatting, mypy, 1,398 tests passed and one existing skip.
The two development-tool tests excluded with that commit explain the count
difference from the previous 1,400-test run. Browser, wheel and native compatibility results above apply to identical
migration code. Deployment and desktop sources match the publication base.

## Coverage tracking

The path inventory compares each final source blob with the extracted file and
marks exact, partial, or pending coverage. New files outside the reference are `catalog/migration.py`,
`catalog/index.py`, `replicas/private_layout.py`, `test_library_migration.py`
and the two extraction tracking files. The split schema modules preserve the
reference layouts; migration preparation and its tests are new implementation.
The inventory records 340 exact, 47 partial and 153 pending reference paths.
No pending path is an intentional omission by default. Before each later merge,
compare the combined main result against the preserved reference tree, review
shared-file hunks and record intentional omissions. Superseded legacy workspace
fixes remain pending for review; they must not reintroduce the removed application.
Deferred features in [audit status](audit-status.md) are not silently extracted.

## Independent dependency repair

The first PR CI run exposed advisories in dependencies inherited from main. A
separate commit updates AnyIO 4.14.1 to 4.14.2, brace-expansion 5.0.9 to 5.0.12
and undici 7.29.0 to 7.29.1. Python and npm audits pass. Backend lint, formatting,
mypy and 1,398 tests pass with one skip. Frontend lint, formatting, types,
1,152 unit tests, production build and 144 browser tests pass. This repair does
not add audit features or change the migration boundary. CI must verify the new
head before merge.

The subsequent Rust audit identifies RUSTSEC-2026-0285 in inherited rustls
0.23.42. A separate patch commit updates rustls to 0.23.45 and rustls-webpki
to 0.103.15. Local Rust formatting, locked Clippy and all 122 tests pass. The
local cargo-audit command is unavailable; CI runs the authoritative Rust audit
and the packaged macOS build. The installed app is unchanged.

## Group 1 merge and Group 2 start

PR #38 is merged as `a8c536e1709360a84034fc8185dcff55b4e8e812`. All checks
passed on `2cfd171b`, including dependency audit, backend, frontend/browser,
full-stack browser, packaged server, Docker, Ubuntu Rust, macOS app and privacy.
The merge retains the migration commit and separate dependency repairs.

Group 2 starts on `feature/portable-library-lifecycle` from that merged main.
The unrelated prior local-main commit was retained on
`preserve/local-main-media-tools`; the reference also keeps it. The original
audit branch and exact tree were unchanged. No force-push or published-history
rewrite occurred before the owner-approved rewrite of 2026-10-09.

## Approved application regrouping and qualification

The owner approved one application branch for groups 2–5, with separate functional
test rounds before merge. The normal portable application shares its catalog
workspace across lifecycle, Update, browsing/editing and playback. A temporary
reduced application is not required. Source operations/SMB (group 6) and
distribution/deployment (group 7) remain separate.

The application is implemented and locally tested. See the [validation record](portable-lifecycle-extraction.md)
for exact test counts, native results, contract changes, intentional omissions,
new fixes and limitations. Path coverage records source equality only; partial
files need hunk review when later groups are extracted. New application fixes are
portable thumbnail routing and safe empty-library Refresh. Internal legacy fixture
adaptations do not restore legacy application support.

The owner delegates all available functional checks to the agent. Additional
native checks cover metadata, retained drafts, moved-file repair, restart and
playback on disposable data. No scripted owner test is required now. Product
acceptance and publication permission are not implied by testing delegation.
Before merge, complete the missing platform/deployment checks and the exact
publication privacy gates.
The preserved reference and installed app remain unchanged.

## History rewrite and VM qualification

The public repository contained private NAS names in `docs/STATUS.md` and
`docs/plans/05-network-library-latency.md`. On 2026-10-09 the owner approved a
text replacement over all history and a force-push of `main` and all branches.
Every commit from 2026-07-28 onward has a new ID. A tree comparison of the old and
new `main`, application branch and reference shows changes in only those two files.
The application source inventory is unchanged:
`12f35cdb150161fc0e6a66a1ee4bbcaf7d651c4dc22b717f8fc648befc5ce655`.

- The reference is now `cd38493fcb306198ff4af00e19b5d78ada241ceb`, tree
  `912a0e657005ade3fb3e3b089df7c2343305fb99`. The tree change is the two
  document replacements; no other reference content changed.
- The published application branch is now `14dfb6a561df42ce6729167f2dba068def3727ef`.
- The application checkpoint used for the earlier native checks never reached the
  remote. It is not available after the rewrite. Its source inventory is equal.
- A private local map relates old and new IDs. It stays outside Git. New records
  use only current IDs.
- The release tags `v0.2.0` and `v0.2.1` were deleted. Their releases are drafts.
  This extraction does not create or publish a release.

After the rewrite, `main` received two commits that the application branch lacked:
`718f1820` updates source-map-js and Mako for security advisories, and PR #42
(`7d5e50b6`) makes the privacy gate stop when Git ignores `rev-list --objects -z`.
Git 2.43 printed newline-delimited output there, so a range scan passed with no
blobs. The application branch is rebased onto that main before its PR.

All tests now run in two VMPal guests: macOS 27.0.1 arm64 and Ubuntu 24.04.5
arm64. The [handoff](audit-vm-handoff.md#current-test-environment-2026-10-09)
records their tools and limits. The [validation record](portable-lifecycle-extraction.md#vm-results-on-2026-10-09)
records the results. After the rebase, the macOS and Ubuntu gates, Docker
section E, a 60-minute native session and the four functional rounds passed on
synthetic data, after two test repairs and the Docker smoke repair. Three open
observations in reference code need an owner decision: Update throughput,
same-device recovery after an Update, and the recovery CLI `prepare` without
Release. No owner library or production NAS service was used.
