# CI and publication checks

This reference describes what the hosted workflows run and which results `main`
requires. The local gates are in [development.md](development.md); the
publication privacy rules are in `AGENTS.md`. [ci-review.md](ci-review.md) records
the measurements and the required-check rollout.

## What CI runs, and when

CI (`.github/workflows/ci.yml`) runs on pushes to `main` and pull requests, with an
always-present `CI result`. Its full scope runs dependency audits; backend lint,
type-check, and tests; frontend lint, type-check, unit tests, and browser e2e;
macOS and Ubuntu desktop checks; a macOS Tauri bundle; and Docker
context/privacy/build/smoke/recovery validation. PRs should be green before merge.

`infra/ci_scope.py` compares the exact event commits and selects conservative scope:

- Documentation-only changes run the scope/result jobs; the heavy matrix is skipped.
- Backend-test and privacy-declaration changes run backend lint/types/the full test
  suite and every dependency audit. Unchanged frontend/native/container builds are skipped.
- Runtime code, dependencies, workflow changes, unknown paths, license texts and
  generated OpenAPI changes run every existing job. Manual dispatch always runs everything.

Mixed changes retain the broadest scope. Rename detection is disabled for the path
inventory so a runtime file moved into tests still triggers the full matrix.
Privacy, CodeQL and dependency review keep their independent triggers.

The backend driver uses an isolated 4 GiB tmpfs when Linux memory headroom permits.
It retains real `fsync` calls and runs the complete suite in two disjoint phases:
bulk synthetic fixtures on memory storage; source-operation and backup/restore
safety tests on ordinary disk. Limited-memory hosts use disk for both phases.
`CAIRNDEX_CI_MEMORY_PARENT` selects an existing executable memory filesystem for
local measurement; the driver creates/removes only its own temporary children.
All phases print slow-test durations. The backend has a 25-minute timeout.

`desktop-macos` carries `timeout-minutes: 30` against an observed ~4.5-minute
cold-cache build, so a hung Tauri bundler cannot occupy a runner for GitHub's
six-hour default.

The Docker job runs `infra/docker/build-and-check.sh`, the production smoke and
the recovery smoke against one explicit candidate image;
[deployment.md](deployment.md#verifying-an-image-actually-works) describes what
they prove. `infra/docker/backup-restore-smoke.sh <candidate>` creates synthetic
state, takes a hot registry backup and a private snapshot, removes the registry,
damages the private store, and recovers both. With a second argument naming an
older source image, it creates the state with that image and recovers it with the
candidate; use that form before a release when a previous image that creates
portable libraries exists. `infra/docker/portable_smoke.py` adds the joined
catalog/conflict/source/recovery workflow and verifies received drafts, saved
source receipts and bytes after clean and forced restarts. Run these locally
against a fresh disposable root, separate private data/snapshot directories, a
unique container and a loopback endpoint.

## Required result

`CI result` uses `always()` and depends on every matrix job. A failed, cancelled,
missing or unexpectedly skipped selected job fails the result; documentation skips
are accepted only after a successful scope decision. `main` requires this
completion result alongside trusted privacy, dependency review and CodeQL. A
privacy-only required-check notification does not establish completion.

## Dependency audits and code scanning

The audit job checks both npm lockfiles at high severity, the complete Python
lock, and the Rust lock. The Rust audit carries one narrow exception:
`RUSTSEC-2024-0429` applies to `glib::VariantStrIter` in `glib` 0.18.5. Cairndex
does not call that API, the crate enters only through Tauri/wry's Linux GTK 0.18
dependency graph, and it is not part of the Apple Silicon release artifact. The
first patched glib line is 0.20, which GTK 0.18 cannot accept. Keep the exception
until Tauri's Linux GTK line moves, then remove it rather than broadening it;
every other Rust advisory still fails CI.

CodeQL analyzes Python and JavaScript/TypeScript on pushes, pull requests, and a
weekly schedule. Dependency review rejects a pull request that introduces a
known high-or-critical vulnerability. Dependabot checks GitHub Actions, Python,
npm, Cargo, and Docker dependencies weekly; grouped minor/patch updates keep its
pull-request volume bounded. Vulnerability reports belong in GitHub's private
reporting flow described by [`SECURITY.md`](../SECURITY.md), never in a public
issue containing real owner data.

The "CodeQL" check on a pull request fails when the PR has a new alert of high
or critical security severity. An alert is new when main has no alert with the
same fingerprint. The fingerprint comes from the text of the flagged line, so a
PR that edits a line with an open or dismissed alert makes that alert new again.
Test code is not analyzed (`.github/codeql/codeql-config.yml`). For each new
alert, read its data flow from the source to the sink. When a request value
reaches a file path, a command or SQL, take the value from the database or from a
server constant, or pass it as a bound parameter: such a fix stays fixed when the
line changes later. Dismiss an alert only when the behavior is intended, for
example the absolute folder that the owner gives to Create/Open, and write the
reason and the code that limits the value in the dismissal.

Every third-party workflow action outside GitHub's own `actions/*` and
`github/*` namespaces is pinned to an immutable commit SHA. Keep the human
version comment beside each pin, and let Dependabot propose reviewed updates;
do not replace a pin with a moving major, tag, or branch.

## Publication privacy

`.github/workflows/privacy.yml` runs independently for every push to `main` and
for PR open, synchronization, reopen, edit, and ready-for-review events. Its
`pull_request_target` path executes the base branch's trusted workflow and
scanner, fetches but never checks out PR objects, grants no contents write, and
posts `publication-privacy/trusted` to the exact PR head. Changing the scanner
in a PR therefore cannot make that PR pass. GitHub has no access to the owner's
local literal profile, so a green remote check complements rather than replaces
the pre-publication local gate.

A PR that deliberately changes the binary/root allowlist must land before a
separate PR uses the new allowance. Keep that prerequisite PR limited to the
reviewed declaration and documentation; include the binary itself only in the
consuming PR. The inventory test verifies assets already present; an absent asset
may have a declaration waiting for the consuming PR. Its digest and path remain
mandatory when its bytes are staged or become reachable.

The range scanner reads newly reachable Git objects, including blobs introduced
and deleted by an intermediate commit. It scans commit metadata, paths, text,
credential shapes, configured private literals, and binary bytes. Standard Git
author/committer email headers are intentional public identity metadata; email
addresses in messages, paths, PR text, tracked files, and artifacts remain
content findings. The reviewed binary allowlist records an immutable SHA-256,
expected path, purpose, and provenance; a new or moved binary fails until it
receives deliberate review. Do not use `--no-verify` or weaken the profile to
make a finding disappear.

With explicit owner approval, the scanner excludes a proper-substring literal
match inside the exact public codesign field name `TeamIdentifier`. It still
checks the field value, later occurrences, longer identifiers and a private
pattern equal to the entire field name. Secret and home-path rules are unchanged.
A generic temporary-directory prefix is not owner identity; the owner-approved
local profile correction removes that prefix while retaining actual private
names and paths, including those used beneath temporary directories.

`infra/docker/build-and-check.sh` places synthetic private-data canaries in
runtime database, environment, virtualenv, cache, test, dependency, and sidecar
packaging paths; builds both development images and the production image;
verifies the canaries are absent from every image; rejects residual Python caches
independently of canary names; verifies the production license payload; and
rejects a build context larger than 50 MiB by default. Override the ceiling only
for a reviewed, intentional context growth with
`CAIRNDEX_DOCKER_CONTEXT_LIMIT_BYTES`.

## Runner cost

The repository is **public** (since 2026-07-23), so standard GitHub-hosted
runners — `ubuntu-latest` and `macos-latest` among them — are free and
unmetered. This matters if that ever changes: while the repo was private, macOS
billed at **10× Linux**, and `Desktop shell (macOS)` alone was 1,570 of 2,691
billable minutes over 30 days — 58% of everything. Larger runners (`-large`,
`-xlarge`) are billed even on public repositories, so reaching for one is a cost
decision rather than a capacity one.

To measure spend, note that the per-run billing endpoint reports zeroes for
recent runs; job start/finish timestamps are reliable, so compute it from
`/repos/{owner}/{repo}/actions/runs/{id}/jobs` — round each job up to the minute
and apply the OS multiplier.
