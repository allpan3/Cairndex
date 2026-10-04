# Audit extraction ledger

## Preserved reference and base

- Reference branch: `fix/library-ownership-lifecycle`.
- Reference commit: `8c814e311726ff178b3ab0efca75cb42d4c63c9a`.
- Reference tree: `f78c202018b94501af4fa796163b9c584303ae0f`.
- Original extraction base: local main `7e2e345967150441407cdb823721e78aaaebd206`.
- Fetched origin/main: `a0ac750cb6b462648daa78eba58f79c08951776e`.
- Local main includes one unpublished development-tool fix. It is preserved.
- Publication base: origin/main `a0ac750cb6b462648daa78eba58f79c08951776e`.
  The unrelated development-tool fix is excluded from the PR.
- Installed runtime: `e44bc574abb18f6ed93dcd50c73dcba2f6b4982d`.
  Desktop and sidecar hashes match the reference's storage qualification record.
- The primary checkout was clean before extraction. The reference is unchanged.

The final main-to-reference difference has 540 paths. Historical commits are not
extraction units. [The path inventory](audit-extraction-paths.tsv) assigns every
path to a group. Shared files require a hunk review; a path assignment does not
mean its full reference contents belong to one group.

## Dependency order

| Group | Final behavior and dependencies | Tests and contract scope | State |
| --- | --- | --- | --- |
| 1 | Offline migration foundation: complete catalog, causal constraints, retained branches, private schema compatibility, format-three preparation and rollback | All-family catalog, schema/refusal, WAL, process-exit/retry and rollback tests; private schema only; no HTTP API change | Extracted; validation in this ledger; acceptance and merge pending |
| 2 | Portable application: normal Create/Open, old-format refusal, lifecycle drain, private access and backup/recovery controls; requires 1 | Creation/admission/access/recovery API and registry schema, OpenAPI/types, browser/native, packaging and backup checks | Planned |
| 3 | Reviewed Update, discovery/grouping, stable-ID repair, full verification and interrupted reviews; requires 1–2 | Private discovery schemas and library-scoped API, process tests, browser/native, source-generation checks | Planned |
| 4 | Browse/edit: complete search/filter populations, exact saved filters, navigation, inspectors, albums, bulk selection and retained drafts; requires 1–3 for complete workflow | Catalog query/API types, component and real-server browser suites, synthetic native checks | Planned |
| 5 | Playback/connection continuity, scoped requests, server navigation, keyboard/layout and loading/error fixes; requires 2–4 | Media/API and native host contracts; playback, connection, component/browser/native and package checks | Planned |
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
The inventory records 26 exact, 13 partial and 501 pending reference paths.
No pending path is an intentional omission by default. Before each later merge,
compare the combined main result against the preserved reference tree, review
shared-file hunks and record intentional omissions. Superseded legacy workspace
fixes remain pending for review; they must not reintroduce the removed application.
Deferred features in [audit status](audit-status.md) are not silently extracted.
