# Audit PR, merge and VM test plan

## Start here

This is the handoff for work on another machine. It is a plan for separate PRs
and tests, not permission to merge the cumulative audit branch or use owner data.
Read `AGENTS.md`, this plan, `docs/STATUS.md` and the linked records before work.
Use a normal primary checkout in the guest. Do not resume tests on the owner's
active desktop. The agent performs code review and all tests that available
access permits. Ask the owner only for product decisions, access, or a specific
real-data operation. Do not ask the owner to repeat a scripted test.

The owner authorized pushing the application and required reference for this
handoff. This does not authorize a release, real-library activation, or merge of
the application without its acceptance checkpoint. The prior authorization for
agent PR/merge applies to internal groups with no user-testable function.

## Branches and exact state

On 2026-10-09 the owner approved a history rewrite and a force-push of `main` and
all branches. The rewrite removed private names from `docs/STATUS.md` and
`docs/plans/05-network-library-latency.md`. Every commit from 2026-07-28 onward
has a new ID. No other file changed. The table gives the current IDs.

Do not write pre-rewrite commit IDs into new records. GitHub can serve those
commits until the sensitive-data removal is complete. A private local map relates
old and new IDs; it stays outside Git. The release tags `v0.2.0` and `v0.2.1` were
deleted, and their releases are drafts. Do not create or publish a release.

| Ref | Purpose | State |
| --- | --- | --- |
| `main` | Accepted migration foundation, dependency and privacy-gate repairs | PR #38 merge `a8c536e1709360a84034fc8185dcff55b4e8e812`; then `718f1820` (source-map-js and Mako advisories) and PR #42 merge `7d5e50b68861d2f8936f51ba63d774fdc3f18cfc` (privacy gate fails closed when Git ignores `rev-list -z`) |
| `feature/portable-library-lifecycle` | Application, tests and this handoff | Groups 2–5 combined with owner approval; published at `14dfb6a561df42ce6729167f2dba068def3727ef` on the PR #38 merge; rebased onto current main for its PR; acceptance and merge pending |
| `fix/library-ownership-lifecycle` | Preserved cumulative audit reference | Exact commit `cd38493fcb306198ff4af00e19b5d78ada241ceb`, tree `912a0e657005ade3fb3e3b089df7c2343305fb99`; extraction source only |

The earlier application checks used a local checkpoint that never reached the
remote. That checkpoint is not available after the rewrite. Its application and
deployment source content is equal to `14dfb6a5`. The source inventory SHA-256 is
`12f35cdb150161fc0e6a66a1ee4bbcaf7d651c4dc22b717f8fc648befc5ce655`. Reproduce it with:

```bash
git ls-tree -r HEAD -- apps infra deploy .github docker-compose.yml docker-compose.prod.yml | shasum -a 256
```

The rebase onto current main adds the two main-only commits. Those commits change
`infra/` and lockfiles, so the inventory hash of the rebased branch differs. The
[validation record](portable-lifecycle-extraction.md) gives the new value.

Record the actual checked-out HEAD and executable hashes on the new machine. A rebuilt executable needs its own
native result; the old machine's executable hash is not a build reproducibility
claim. The installed runtime on the original machine is unchanged. It was built
from the commit that is now `395b6206c03311fb7e4c773112bba0756308c93e`; the
binary embeds the pre-rewrite ID of that commit.

Do not merge the reference branch. It includes unaccepted later groups, older
dependencies and superseded intermediate commits. Historical group numbers in its
documents differ from the extraction groups in this plan. The source snapshot is
preserved exactly; current accepted ADRs and extraction records take precedence
over its older implementation summaries.

The unrelated development-tool commit is now
`742461092aa6898b091a1f5b0b39c24d428bb0d1`. It is reachable from the reference.
The former local branch `preserve/local-main-media-tools` is not present in the
current primary checkout. The commit is not part of the application PR. Old local
feature, archive and merge-helper branch names are not required for this handoff.

## Clone and verify

Run these commands in a terminal on the test machine:

```bash
git clone https://github.com/allpan3/Cairndex.git
cd Cairndex
git fetch origin
git switch --track origin/feature/portable-library-lifecycle
git status --short
git rev-parse HEAD origin/main origin/fix/library-ownership-lifecycle
git rev-parse 'origin/fix/library-ownership-lifecycle^{tree}'
just install-privacy-hooks
```

The status must be clean. Compare the reference commit and tree with the table.
Install `just` first if it is missing. Use the HTTPS clone URL above. If authentication is required, use the existing
account's normal sign-in process.
Do not copy credentials into the repository. The local private-pattern file is
not transferred by Git. The installer seeds guest paths; add relevant private
literals locally before any future publication. Never remove a finding to pass.

For a new agent, use this initial instruction:

> Read AGENTS.md and docs/audit-vm-handoff.md. Continue the audit extraction from
> feature/portable-library-lifecycle in this primary checkout. Verify refs first.
> Run the remaining synthetic application tests inside the test guests. Preserve the
> cumulative reference. Do not use owner libraries or production NAS services.
> Record results and stop at the application acceptance checkpoint. Follow the
> PR sequence and privacy gates before publication. Do not assume permission to
> merge, release, change signing, or activate real-library conversion.

## VM setup and qualification boundaries

Use a new guest account and a dedicated test disk. Take a clean guest snapshot
before installation. Keep the repository, private server data, test libraries and
backup output in separate directories. A planning allowance is 4 vCPUs, 8 GiB RAM
and 40 GiB free disk; these are setup estimates, not product performance limits.
Do not mount owner media, the host home directory, the host Docker socket, or
production data volumes into the guest. Use loopback-only service ports.

| Environment | Checks it can establish | What it cannot establish |
| --- | --- | --- |
| Ubuntu VM | Backend, browser, Ubuntu Rust, Linux package and isolated Docker checks | macOS WKWebView rendering, macOS Keychain access or APFS/SMB native behavior |
| macOS guest or dedicated Mac account | Production macOS app, keyboard, playback, restart and local filesystem checks | Physical-host power loss, arbitrary hardware performance or cross-device provider delivery |
| Two configured endpoints | Provider delivery, offline work, hydration and conflict tests on disposable roots | General guarantees for every provider or owner library |

A macOS guest needs supported Apple hardware and usable graphical/video support.
Record OS, architecture, hypervisor and display configuration. A black frame in a
VM must be investigated with a known-good fixture and host/guest comparison; do
not hide it with an unrelated backend pass. Linux browser results cannot close a
macOS native observation. Keep normal production app identity and signing rules.
Use the fresh guest profile instead of the original machine's local profile-hold
helper. No existing Keychain grants or signing identity need to be copied.

Install the tool versions and OS dependencies in `.github/workflows/ci.yml` and
`docs/development.md`: Python 3.12+, uv, Node 22, stable Rust with rustfmt/Clippy,
ffmpeg/ffprobe and platform Tauri dependencies. Linux Docker checks need a working
Docker engine and Compose in the isolated guest. Record exact installed versions.
Do not upgrade project lockfiles merely to set up the guest.

### Current test environment (2026-10-09)

Development occurs in the primary checkout on the host Mac. All tests run in two
VMPal guests (Apple Virtualization framework). Each guest has a normal user account,
a clone at `~/Developer/Cairndex`, fixtures in `~/Cairndex-Test`, server state in
`~/Cairndex-Data` and private receipts in `~/Cairndex-Receipts`.

| Guest | System and resources | Tools |
| --- | --- | --- |
| macOS | macOS 27.0.1 (26A434) arm64; 9 vCPU, 8 GiB; VMPal GPU acceleration setting off; a snapshot exists from before tool installation | uv 0.11.23, Python 3.12.13, Node 22.23.3, Rust 1.99.0 with Clippy and rustfmt, just 1.58.0, Xcode Command Line Tools 27.0, Playwright 1.62.1 Chromium, pinned static ffmpeg/ffprobe 8.1.2 |
| Ubuntu | Ubuntu 24.04.5 LTS arm64, kernel 7.0.0; 6 vCPU, 8 GiB | The same uv, Node, Rust, just and Playwright versions; Python 3.12.3; Git 2.55.0 from the git-core PPA, as on GitHub runners; ffmpeg 6.1.1; Docker 29.9.0 with Compose 5.6.0; Rosetta registered for amd64 images; CI Tauri and Playwright system packages |

The macOS guest has no nested virtualization, so it cannot run Docker. Agents have
no administrator access there. Agents can use administrator commands in the Ubuntu
guest. Both guests reach the owner's NAS on the LAN. Do not connect to the NAS or
to its production container without the owner's explicit approval.

Two host helpers outside Git control the guests. `vmx` runs a guest command and
copies its output to a visible console window in the guest. `vmsync` copies the
exact host working tree, including uncommitted and untracked files, into a detached
guest checkout and verifies the tree ID. Record that tree ID as test evidence. A
test does not need a GitHub push. Do not pipe a helper or a gate through `tail`
without `pipefail`: an earlier run hid a failure that way.

These guest limits are not product defects:

- The Ubuntu ext4 disk takes about 5.7 ms for one write plus fsync. The macOS
  guest takes about 0.1 ms. Some timing-sensitive tests fail only on that disk;
  they pass with `--basetemp` or `TMPDIR` on `/dev/shm`.
- Linux arm64 Playwright Chromium has no H.264/AAC decoder: `canPlayType`
  returns `"no"`. macOS Chromium returns `"probably"`. CI on x86_64 uses Chrome
  for Testing.
- `linux-arm64` is not a platform in the pinned ffmpeg manifest.

## PR and merge sequence

| Order | Branch/PR scope | Acceptance gate |
| --- | --- | --- |
| Done | Group 1: offline migration foundation, catalog, private schema and recovery dependencies | PR #38 merged; no real conversion command |
| Next | Current application branch: groups 2–5, normal format-three Create/Open, access/recovery, reviewed Update, browse/edit and playback | Close remaining application/platform checks below; record four functional rounds; obtain application acceptance before merge |
| Then | New branch from refreshed main: group 6, reviewed source operations and identity-preserving Replace/Undo, then mounted SMB | Test its own local source, process, browser/native and exact executable/share behavior; stop for acceptance |
| Then | New branch from refreshed main: group 7, distribution/deployment, private volumes, backups and signing/package preflight | Fresh container/package/deployment checks, isolated restart and recovery; stop for acceptance |
| Conditional | Selected-library conversion adapter and activation procedure | Only if format inventory shows a need; separate dependency-complete implementation, synthetic tests, copy-based qualification and explicit real-data approval |

Groups 2–5 share the catalog workspace. Splitting their application UI would need
a temporary reduced application; the owner approved one branch with separate
functional rounds. Do not reintroduce that split. Group 6 retains recovery and
journal dependencies even when UI work appears small. Keep group 7 independent
except for a minimum compatibility repair required to make the application gates
valid. Record such a repair explicitly rather than importing all later deployment
work into the application PR.

After each accepted merge:

1. Fetch origin and verify the merge commit and checks. Update local main only
   with a fast-forward. Preserve unrelated changes.
2. Create the next feature branch from that main. Review final behavior against
   the reference, not its historical commit order. Extract required hunks, tests,
   schemas, API types, documentation and necessary fixes together.
3. Resolve dependencies and conflicts, then test that branch itself. Old full-audit
   results do not qualify it. Rerun affected checks after every reconstruction.
4. Update `docs/audit-extraction-paths.tsv` and the extraction ledger. Current
   counts are 340 exact, 47 partial and 153 pending reference paths. Review partial
   hunks and record intentional omissions and new fixes. Counts are not proof of
   behavioral coverage.
5. Prepare the PR description and exact privacy gates. Stop for the applicable
   acceptance.

On 2026-10-09 the owner set these merge rules. Rebase the branch onto current
main before its merge. Fold fix-up commits into the commits that they fix. Merge
with a merge commit (`gh pr merge N --merge`); never squash. Write commit messages
and PR descriptions that state the problem, the change and the evidence. The owner
gave standing permission to force-push feature branches with `--force-with-lease`
after a new privacy gate. A force-push to `main` still needs an instruction that
names `main`. Small maintenance fixes can go directly to `main` after guest tests
and `just privacy-range origin/main HEAD`. The application branch still needs
explicit owner acceptance before its PR is opened and merged. Keep the original
audit reference and its exact tree unchanged.

## Existing evidence and remaining application checks

The [application record](portable-lifecycle-extraction.md) contains the exact
scope and evidence. On its source checkpoint: backend 1,612 passed/one existing
skip; frontend 1,253 unit and 31 browser tests; Rust 135 tests; static checks,
sidecar smoke, three frozen process tests and macOS production app/DMG passed.
Native Create/Open refusal, access, recovery, drafts, metadata, stable-ID repair,
local resume, image and video rendering passed on synthetic data.

Two observations remain to investigate: the first long session retained stale
Update status and showed black video captures. Switching libraries refreshed
status; a clean restart showed progress and decoded direct/remux/fallback frames.
No cause or code repair was established. Do not mark these fixed from the restart.

The validation record also gives the guest results on source inventory `12f35cdb`.
In the macOS guest, all section A checks passed. In the Ubuntu guest, the Rust-only
job, frontend unit tests, sidecar smoke and frozen recovery test passed. Some
Ubuntu backend and browser failures come from the guest limits above. One frozen
discovery test has a thin timeout margin; it is an open observation. The
[results after the rebase](portable-lifecycle-extraction.md#results-after-the-rebase-onto-current-main)
cover sections A, C, D and E, the test repairs and the open observations.

### A. Environment and automated checks

Run from the repository root after dependency installation:

```bash
(cd apps/server && uv sync --frozen)
(cd apps/web && npm ci && npx playwright install --with-deps chromium)
(cd apps/desktop && npm ci)
(cd apps/server && uv run ruff check && uv run ruff format --check)
(cd apps/server && uv run mypy src packaging && uv run pytest)
(cd apps/web && npm run lint && npm run format:check && npm run typecheck)
(cd apps/web && npm run test && npm run build && npm run test:e2e)
(cd apps/desktop/src-tauri && cargo fmt --check)
(cd apps/desktop/src-tauri && cargo clippy --locked --all-targets -- -D warnings)
(cd apps/desktop/src-tauri && cargo test --locked)
```

For Ubuntu Rust-only compile context, follow the CI job's empty sidecar-resource
placeholder after building the web app. That placeholder is not a runnable app.
For actual package tests, build the sidecar instead. On Linux use
`uv run python packaging/build_sidecar.py --skip-ffmpeg` from `apps/server` and
run `uv run python packaging/smoke_test.py`. On macOS fetch the pinned ffmpeg,
build without `--skip-ffmpeg`, and run the same smoke test. Run the frozen checks
with `CAIRNDEX_RECOVERY_TEST_BINARY` set to the absolute built sidecar path:
`uv run pytest tests/test_replica_recovery_binary.py` from `apps/server`.

On macOS build the normal app from `apps/desktop` with
`npm run tauri build -- --bundles app`. Verify it with
`infra/verify_macos_distribution.sh` from the repository root, passing
`apps/desktop/src-tauri/target/release/bundle/macos/Cairndex.app`.
Launch that `.app` in the fresh guest and bring it to the foreground before UI
actions. Do not install it over an existing app. DMG packaging remains a separate
macOS build check. Do not publish build output or private test logs.

### B. Fresh, reproducible test libraries

No old machine paths, local receipts, binaries or test libraries are required.
The committed fixture generators create new synthetic data. From `apps/server`,
run this in a terminal; it prints the paths to select in Manage libraries:

```bash
mkdir -p "$HOME/Cairndex-Test"
export CAIRNDEX_TEST_ROOT="$(mktemp -d "$HOME/Cairndex-Test/run.XXXXXX")"
uv run python - <<'PY'
import os
import shutil
from pathlib import Path
from cairndex.devtools.catalog_fixture import create_disposable
from cairndex.devtools.discovery_fixture import create_discovery
root = Path(os.environ['CAIRNDEX_TEST_ROOT'])
playable = create_discovery(parent=root, playable=True)
old = create_disposable(parent=root)
first = root / 'Create One'
second = root / 'Create Two'
first.mkdir()
second.mkdir()
shutil.copy2(playable / 'Playback/movie.mp4', first / 'Pattern.mp4')
shutil.copy2(playable / 'Playback/picture.png', first / 'Shapes.png')
for label, path in [('Create One', first), ('Create Two', second),
                    ('Open portable', playable), ('Refuse old format', old.source)]:
    print(f'{label}: {path}')
PY
```

Keep this output privately. The generated old package is for refusal and migration
unit tests only. It is not authorization to convert an owner library. Choose
**This Computer** in the production app. Open **Manage libraries** to Create or
Open the printed roots. If these controls are absent, check the running binary,
server and profile before testing. Do not improvise against an owner registration.
For web tests use the fixture's dedicated server state and a separate browser
profile; `CAIRNDEX_DATA_DIR` must point outside the library root.

### C. Functional rounds and expected results

| Round | Actions on synthetic data | Required result |
| --- | --- | --- |
| 1: lifecycle | Create in Create One; Open portable; refuse old format; create empty Create Two; test access, Release/Reopen, snapshot/verify, preparation/review/activation | Source bytes unchanged; format-three creation; old refusal without edits; wrong unlock refused; destination access retained; explicit recovery review and Reopen; independent libraries |
| 2: Update | Update and review grouping; repeat Update; rename one generated video externally after baseline; Update; restore name and Update; exercise interruption, cancellation and exact retry in process tests | Stable file ID and bundle relationships; no duplicate replacement bundle; only intended relative path change; metadata/source hashes preserved; interrupted work retained and retry explicit |
| 3: browse/edit | Search and rating/tag/collection filters; layouts and selection; scoped File Browser; edit notes/rating/cover; prepare/apply memberships while a draft exists; switch libraries and restart | Correct full query population and empty state; no path escape; no draft leakage; saved metadata and draft recovery persist; collections do not move media |
| 4: media/continuity | Open generated direct MP4, MKV remux, AVI fallback and image; pause/seek/captions; Escape; switch libraries and servers; restart | Decoded frames, correct caption association, responsive controls, scoped requests and local resume; no claim of cross-device resume |

The new machine does not need to repeat every prior manual action before the
specific remaining investigation. First establish a small startup/playback check,
then run the missing platform gates and the sustained test below. Repeat affected
rounds if the runtime, code or environment changes, or a result fails.

### D. Sustained native session

Use the same production binary for a planned 60-minute session. This duration is
a bounded test, not a reliability guarantee. At startup, 15, 30 and 60 minutes:
run Update; inspect progress until completion without switching libraries;
repeat direct/remux/fallback playback, pause and seek; edit/save a synthetic note;
switch between two synthetic libraries and return. Include background/foreground,
idle time, and a normal guest lock/unlock if supported. Keep backend operation
state and UI observations separately. Record whether only capture is black or
the visible viewer is also black. Check pixels, not just the playback clock.

If either symptom appears, preserve private logs and timings before restart.
Identify the request, job state, visibility/focus state and exact media delivery
path. Reproduce with the same fixture. Add a focused regression and repair before
claiming resolution. A restart is a diagnostic step, not the fix. If the VM cannot
provide usable graphical/video access, report that exact limit and request access
to a suitable test endpoint; do not move the test onto the owner's active desktop.

### E. Docker and deployment compatibility

These checks were deferred on the original machine because its daemon was absent.
They remain required before the application merge. Run in the isolated Linux guest:

```bash
./infra/docker/build-and-check.sh cairndex:application-test
./infra/docker/smoke.sh cairndex:application-test
./infra/docker/backup-restore-smoke.sh cairndex:application-test
```

The two smoke scripts formerly expected shared `.cairndex/library.db`, the old
scan route and shared ownership leases. On 2026-10-09 this branch replaced those
assertions with the format-three contract: reviewed Update, the media adapter, a
database-free package, clean and forced restarts, a separate snapshot volume,
damaged-store recovery and retained access. Image, compose and `backup.sh` changes
stay in group 7. The reference's joined smoke helper was not used, because it
needs source operations.

Require a non-root runtime, read-only container root, separate private data and
snapshot storage, media ranges, clean shutdown/restart, forced test-process exit,
explicit recovery and retained access. Inspect contexts and image contents for
private data, databases, caches and host build output. Use unique test container,
volume and image names. Stop/remove only this test's resources. Do not run a
production compose project or change NAS services.

## Later external tests and owner setup

These are separate qualifications. They do not automatically block a scoped local
application acceptance if their unsupported status is explicit. They must pass
before claiming the corresponding storage or real-data behavior.

| Test | Owner setup or approval needed | Agent work and pass condition |
| --- | --- | --- |
| Two-endpoint iCloud | Two already-configured, accessible endpoints and an explicitly disposable synchronized folder; consent to disconnect/reconnect test networking | Independent private stores; compatible/conflicting edits, offline work, delayed/partial/duplicate/out-of-order delivery, restart, hydration/eviction and retained versions; compare byte and metadata receipts at both ends |
| Mounted SMB, group 6 | A disposable share/root, test account and exact permitted endpoint; access to macOS if Keychain is involved | Source, frozen sidecar and normal native app checks for the exact executable/share; prompts disabled during normal retries/restarts; no grant reuse claim for a different binary |
| Real-library qualification | Select one library; supply format/app/writer information and a consistent private backup or copy; specify permitted read access | Classify format first, inspect exact schema and external recovery records, build only the necessary adapter, and validate a separate candidate with rollback before asking for activation |
| Representative playback/scale | Explicitly selected private test copy, adequate disk and agreed workload | Measure relevant limits; no upload or publication of names, media, metadata, paths, screenshots or raw receipts |

For source operations, begin with synthetic local roots. Test reviewed
Copy/Rename/Move/Replace/Trash/Undo, occupied-target refusal, changed-generation
refusal, exact retry, interruption/recovery, stable IDs, replacement history and
directory Undo. Consult the reference's `docs/storage-qualification.md` with
`git show origin/fix/library-ownership-lifecycle:docs/storage-qualification.md`.
Its prior Docker/NAS and SMB receipts qualify only their recorded images,
executables and shares. The installed runtime has no new SMB/Keychain
qualification. Repeat relevant checks on the extracted branch.

## Real-library migration and rollback boundary

Read [replica-migration.md](replica-migration.md). `CONVERSION_AVAILABLE = False`.
There is no supported real-library conversion command or activation operation.
Do not enable the flag, relabel a manifest, construct a fake disposable fixture
around an owner path, or restore legacy application support.

Classify each selected library separately:

- Format-three portable: no legacy format conversion. A known additive private
  database upgrade is a separate operation; it must retain package identity.
- Old `cairndex.library`: refused by the new app. Needs a qualified historical
  schema adapter and deliberate format conversion before use.
- Replica formats one/two, unknown layouts or incomplete packages: inspect and
  design the required migration separately. No descriptor-only promotion.

Before requesting real activation, prepare this concrete private record:

1. Selected roots, exact formats/schemas, all known writers and offline work.
   Explain why this library needs conversion. Do not require all libraries to move.
2. Quiescent consistent DB/WAL backups, descriptor/shared history, registry,
   credentials/settings and source/recovery media backups. Verify checksums,
   counts, integrity and available space outside provider trees. A VM snapshot
   does not back up an external mount. Preserve unreceived browser text separately.
3. A bounded preparation procedure using a separate candidate. Preserve stable
   IDs, exact metadata, relationships, source paths, private plans, recovery
   records, pending/interrupted work and retained conflicts. Never replay pending
   source operations automatically. Unknown artifacts stop preparation.
4. Disposable tests of interruption at each durable boundary, exact retry,
   unchanged-source checks and independent candidate reconstruction. On an
   explicitly approved private copy, repeat the relevant validations. Synthetic
   fixture defaults are not a real historical-schema adapter.
5. A tested rollback target and procedure before and after new edits. Before
   edits retain the original authority intact. After edits retain all new history
   and reconcile/export a separate copy; replacing a database is not sufficient.
   Identify how old offline writers stay isolated.
6. Exact proposed registration/activation steps, validation results and a separate
   owner approval for those paths and operations. Stop before activation until
   that approval exists. Preserve the original backups after activation.

No real library was inventoried or converted during this audit extraction.
Private logs, credentials, backups and receipts must stay outside Git.

## Publication, records and stopping rules

Before a push, run the repository's exact privacy gates on the proposed refs and
all newly reachable content. New remote refs require complete reachable-history
inspection. Before PR creation/update, also scan the exact title/body files with
`just privacy-pr`. Enumerate blob types/sizes, review binary provenance, commit
messages/identity metadata, Docker contexts and publishable artifacts. Never
weaken hooks, rewrite published history or treat a clean working tree as proof.

The reference was formerly blocked by private-text and volume findings. The only
local private literal removed was the explicitly owner-approved machine name.
Both home-path patterns and built-in rules remain active. The current complete
history audit must pass before the exact reference is transferred. Its cumulative
range is large and is not an acceptable feature PR; the whole-history gate has
its documented volume exemption for a new reference. Extracted PR ranges must
pass normal volume limits. Do not use that exemption to merge the whole audit.

A branch push alone does not run the full CI matrix: current CI runs for main,
pull requests and manual dispatch. Do not report checks merely because a push
succeeded. No release tag or published container is part of this handoff.

For each run record: branch/commit/tree, guest OS/architecture, dependency versions,
build and executable/image hashes, fixture recipe, checks and exact result,
failures/skips, private receipt location, cleanup/profile result and scope limits.
Commit a sanitized summary in the extraction ledger and STATUS. Keep raw private
receipts local. For a failed test, preserve evidence before changing the fixture.
For a passing group, prepare a short PR summary and stop at its acceptance point.

Use this remaining checklist; add evidence before changing any box:

- [x] New VM clone, exact refs, hooks, dependencies and isolated state verified.
  On 2026-10-09 both guests were clean at `14dfb6a5`, tree
  `fc2ea3299811825fd1bc6351dc495aca7f43fc49`, with hooks and a local
  private-pattern file. The Ubuntu Docker engine had no containers, images or volumes.
- [x] Ubuntu Rust and relevant Linux package/browser gates pass on proposed HEAD.
  On 2026-10-09, after the rebase: Rust formatting, Clippy and 133 tests; frontend
  1,253 unit tests and build; sidecar build, smoke and three frozen process tests;
  backend 1,613 passed on tmpfs. The remaining failures are guest limits (see
  the validation record).
- [x] Portable Docker compatibility assertions repaired and extracted checks pass.
  The two smoke scripts were repaired; build-and-check, smoke and
  backup-restore-smoke passed on arm64 in the Ubuntu guest.
- [x] Sustained macOS native observations resolved or explicitly dispositioned.
  A 60-minute session in the macOS guest did not show stale Update status or black
  video. The original observations are dispositioned as not reproduced; their
  cause is not established.
- [ ] Application functional rounds and scope accepted; exact PR/privacy gates pass.
- [ ] Application PR merged; main refreshed and result recorded.
- [ ] Group 6 extracted, tested, accepted and merged.
- [ ] Group 7 extracted, tested, accepted and merged.
- [ ] Combined behavior compared with preserved reference; omissions explained.
- [ ] Optional external/real-data qualification recorded separately when authorized.

Keep these deferred items separate: OS drag (incomplete and paused), folder
pagination, Recently Used, file note/source UI, cross-device resume, owner-media
playback diagnosis and production registration repair. Large-scale and power-loss
guarantees remain unestablished. Keep one ordinary library concept.
