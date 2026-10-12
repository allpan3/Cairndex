# CI runtime and completion review

Branch `maintenance/ci-runtime-review` starts from main `01a8d6d3`. The application,
package source and dependency locks are unchanged. This review separates CI test
execution time from the missed completion notifications after PR #47 and PR #49.
[PR #50](https://github.com/allpan3/Cairndex/pull/50) merged as `eaa0674d` from
fully qualified head `f26cf9df` on 2026-10-12 UTC.

## Completed hosted baselines

| Run | Backend job | Pytest step | Dependency sync |
| --- | ---: | ---: | ---: |
| [PR #48](https://github.com/allpan3/Cairndex/actions/runs/38128193844) | 546 s | 501 s | 1 s |
| [PR #47](https://github.com/allpan3/Cairndex/actions/runs/38132115753) | 975 s | 915 s | <1 s |
| [PR #49](https://github.com/allpan3/Cairndex/actions/runs/38139344576) | 724 s | 661 s | <1 s |
| [PR #49 merge](https://github.com/allpan3/Cairndex/actions/runs/38182949749) | 660 s | 609 s | <1 s |

Pytest consumed over 90% of backend time. The latest PR run's other longest jobs
were full-stack browser tests (339 s) and macOS (309 s). More dependency caching
would not address the dominant cost. Existing audit, package, browser, native and
container checks remain in the full scope.

The local Ubuntu ext4 probe measured a median 7.9735 ms for 100 real `fsync` calls
after writes, versus 0.001 ms on tmpfs. A disk-only full-suite diagnostic was
interrupted after its slowness was established; its raw log remains private and
does not count as a completed gate. No production implementation or assertion
was changed to make that diagnostic faster.

## Changes

`CI scope` calculates the exact PR merge-base or push range with NUL-delimited
paths and no rename collapsing. Known documentation changes skip heavy jobs.
Backend-test/privacy-declaration changes retain the complete backend suite and
all dependency audits. Runtime, lockfile, workflow, unknown, license and OpenAPI
changes retain every existing job; manual dispatch forces full scope. Privacy,
CodeQL and dependency review remain independent.

`CI result` always runs after every matrix job. It validates the exact job set,
successful scope output and each selected result. Failed, cancelled, missing or
unexpectedly skipped selected jobs fail the completion check. Regression coverage
also couples the helper's job list and scope conditions to the actual workflow,
so adding an unaccounted job cannot silently bypass the completion result.

`infra/ci_backend.sh` partitions the complete suite without dropping tests.
Bulk fixtures use a fresh, executable 4 GiB tmpfs on normal hosted Ubuntu memory
headroom. Low-memory hosts retain the complete disk fallback. The backup/restore
and portable source-operation suites always run on ordinary disk. `fsync`, SQLite
settings, failure injection and recovery assertions are unchanged. Local callers
can select an existing executable memory filesystem with
`CAIRNDEX_CI_MEMORY_PARENT`; only fresh owned children are removed. A busy mount
cleanup fails CI without recursively deleting the mounted tree.

Memory storage accelerates synthetic fixtures; it does not qualify physical
power-loss durability. The retained disk tests, packaged process tests and Docker
recovery checks preserve their separate scopes. Slow-test durations remain visible
in both test phases, and the backend is bounded to 25 minutes.

## Local validation

- Ubuntu 24.04.5 arm64, Python 3.12.3: complete optimized driver passed **1,855**
  tests in two disjoint phases: 1,800 in **243.36 s** on memory and 55 in
  **153.20 s** on disk. One existing unpinned Linux-arm64 platform test is excluded;
  hosted x64 keeps it. All original tests plus the new CI regressions are retained.
- Ruff, formatting and mypy including the CI helper passed in both guests.
- **89** focused CI/privacy regressions passed on Ubuntu and macOS. They cover
  job failure/cancellation/skips, malformed scope, real Git rename handling,
  workflow dependency wiring, both test partitions, exit codes, quoted temporary
  parents, cleanup and preservation of pre-existing entries.
- `actionlint` **1.7.12** (official release checksum verified) and Bash syntax
  validation passed. No validator binary or new dependency enters the repository.
- A tiny isolated Ubuntu admin probe exercised the actual disposable tmpfs mount,
  disk partition, unmount and cleanup using synthetic command stubs. The full
  model suite runs as the normal guest user; the probe is not a root-run model gate.
- Docker build/context/privacy/license checks passed for the separate local
  candidate image; the largest context transfer was 7.33 MB. No image was published.

The optimized test phases total about **6 minutes 37 seconds on this guest**.
Hardware, Python and architecture differ from hosted runners, so this is not a
claim of a measured hosted speedup. The completed hosted run below provides a
separate measurement. Frontend/browser/native runtime gates were not repeated
locally because their source is unchanged; they passed remotely in full scope.
Raw guest receipts stay outside Git.

## Hosted validation

[Run 38192022665](https://github.com/allpan3/Cairndex/actions/runs/38192022665)
passed full scope on `f26cf9df`. All eight matrix jobs, scope and final result
passed, including dependency audit, package smoke, both browser suites, Ubuntu
Rust, macOS Keychain/package/build checks and Docker build/media/backup recovery.
Independent privacy, both CodeQL analyses, CodeQL security and dependency review
also passed. All six required checks were successful and exact-head merge
readiness was clean before the merge.

| Measurement | Result |
| --- | ---: |
| Full run, creation through completion | 577 s (9m37s) |
| Backend job | 528 s (8m48s) |
| Pytest driver step | 486 s (8m06s) |
| Isolated-memory phase | 1,801 passed in 449.22 s |
| Ordinary-disk safety phase | 55 passed in 27.56 s |
| Full-stack browser job | 360 s |
| macOS job | 280 s |

The hosted driver reported a real isolated memory mount and ran all **1,856**
tests without the guest's Linux-arm64 platform exclusion. Neither partition lost
tests. The pytest step is below the prior 501–915 s range; these are uncontrolled
runs, so a consistent speedup requires repeated comparable measurements. Backend
remains the longest job. Raw logs and timing receipts stay outside Git.

## Completion-monitoring rollout

At review start, main's rule was strict/up-to-date and required only
`publication-privacy/trusted`. T3 Code reports required-check completion, so it
can wake after privacy and miss the later non-required job completion. The final
CI job fixes the repository's completion signal; the required-check configuration
must also be updated for that signal to drive monitoring.

With owner approval, [PR #50](https://github.com/allpan3/Cairndex/pull/50) was
opened and the following required checks were activated. The completion result
becomes reported after its dependencies finish; requiring it blocks merging
until every selected job passes.

| Context | Required source app |
| --- | --- |
| `publication-privacy/trusted` | GitHub Actions, 15368; existing requirement retained |
| `CI result` | GitHub Actions, 15368 |
| `Analyze (python)` | GitHub Actions, 15368 |
| `Analyze (javascript-typescript)` | GitHub Actions, 15368 |
| `CodeQL` | GitHub Advanced Security, 57789 |
| `Review dependency changes` | GitHub Actions, 15368 |

The API readback verified these checks, preserved strict/up-to-date behavior and
confirmed every other protection field unchanged. Full hosted validation passed,
the exact head was verified and merged, and the resulting main requirements were
confirmed again. Other open PRs will need the refreshed base/new workflow before
their completion check can satisfy the rule. Native PR watching remains the
monitor; no separate polling loop or scheduled watcher is introduced.

Monitoring also exposed a limit: T3 Code first announced five successful reported
requirements while `CI result` did not exist yet. GitHub still reported the PR
blocked. After the final job succeeded, T3 Code delivered a six-check completion
notification and the approved PR was merged. A notification is a prompt to read
readiness, including missing required contexts, rather than merge authorization.

A workflow-level path filter would leave a required check missing on docs-only
PRs, which is why scope is selected inside the always-triggered workflow. See
[GitHub's skipped-check guidance](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
and [hosted runner resources](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
No live branch protection was changed during local preparation; activation
followed the owner's explicit publication and rollout approval.
