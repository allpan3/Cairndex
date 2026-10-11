# Source-operation extraction

Branch: `feature/portable-source-operations`, from main `9ba347c8`.
Reference: `cd38493fcb306198ff4af00e19b5d78ada241ceb`, tree
`912a0e657005ade3fb3e3b089df7c2343305fb99`. The reference remains unchanged.

## Scope

Group 6 adds portable reviewed Copy, Rename, Move, Replace, Trash, conditional
Undo and separate recovery copies. Private intent and exact review receipts
precede source mutations. Recovery versions are independent copies. Copy Replace
retains destination identity; Rename/Move retain source identity; Move Replace
retains displaced bytes and metadata for recovery. Permission remains off by
default for each library and serving instance, with the deployment gate, access
checks and Release admission preserved.

Two bounded workers perform byte reads outside HTTP exchange handlers. Directory
reviews retain the reference's 128-entry/identity bounds, metadata limits and
operation byte budget. Interrupted work requires exact Retry. Received immutable
receipts never execute a physical operation on another device.

The mounted-SMB adapter uses the exact saved server/account/share login,
signed/encrypted SMB3, parent mapping proofs and no-replace publication. Its
qualification requires fresh tests of the extracted source and exact frozen
executable; earlier reference receipts do not qualify this branch.

The library-scoped API and File Browser review/recovery interface land together.
OpenAPI and frontend types are regenerated from this branch. The existing private
source tables were already included in the migration foundation, so this change
does not alter their schema. It enables the format-three source capability.
Strict older readers refuse `catalog_source_edit` events.

`smbprotocol` is pinned to 1.16.0. It supplies authenticated SMB3 requests where
the macOS mount lacks native exclusive primitives. Its transitive authentication
and cryptography dependencies add packaging and advisory maintenance; the lock
and third-party notice record them. No separate service is introduced.

## Extraction decisions

- Preserve main's dependency/security repairs, empty-library Refresh guard,
  portable thumbnails, browser proxy handling and recovery test ordering.
- Preserve the tested migration foundation and private schema definitions.
- Preserve main's single-entry validation in the immutable publication primitive;
  the reference SMB extension omitted that guard. A regression rejects traversal
  and nested-name publication before any filesystem call.
- Refresh the former mounted name through a safe open after direct SMB rename.
  Fresh HTTP qualification exposed cached positive stat results after completed
  directory capture. The bounded wait now checks refreshed namespace evidence;
  file/directory regressions retain the existing arriving-name refusal.
  HTTP absence assertions likewise use non-following, non-blocking opens rather
  than cached stat. No timeout, overwrite permission or recovery check is relaxed.
- Commit write-permission changes before sending their successful response.
  Frozen HTTP acceptance exposed a request that reached the server before the
  previous request's dependency cleanup committed the opt-in. Independent-session
  regressions cover both enabling and revocation before that cleanup.
- Browser acceptance waits for the actual library-creation response before
  asserting the selected library. The selected mount exposed a test that spent
  its five-second assertion budget while creation was still in flight. The
  request and HTTP 201 remain checked; no product timeout is changed.
  Opt-in mounted browser runs use the HTTP acceptance's bounded 90-second
  asynchronous waits. Concurrent guest/share load left valid work queued or
  applying beyond the local assertion budget. Local test budgets are unchanged;
  the mounted run still requires every review, success state and byte result.
- Omit the reference's removed legacy workspace/import/relocation repairs and
  their tests. They are not dependencies of portable source operations and do not
  restore old-format admission. The removed legacy relocation/replacement modules
  and import/move replacement tests remain intentionally absent; ADR-0033 stays
  deferred with OS drag. SMB transport tests retain their portable
  coverage; legacy import-journal cases are omitted, and direct leaf absence is
  asserted as the transport's specific exception. The existing write-mode test
  now verifies that enabling portable permission still refuses legacy handlers.
- Keep distribution/signing, compose, private volumes and backup helpers in
  group 7. The package smoke is a necessary compatibility change here: it now
  exercises the source worker instead of asserting that its routes are absent.
- Keep OS drag, real-library conversion, provider delivery, large-scale and
  power-loss qualification outside this extraction.

## Validation

Qualification passed in the macOS and Ubuntu guests described in
[the handoff](audit-vm-handoff.md#current-test-environment-2026-10-09).
Tests use generated data and separate private state. Raw logs, credentials,
mount details and executable receipts stay outside Git.

The final macOS backend suite passed 1,749 tests; Ubuntu passed 1,748 with one
explicit platform deselection. Ruff, formatting and mypy pass in both guests. Frontend lint,
formatting, types, all 1,257 unit tests, production build and all 33 browser tests
pass. The Linux and macOS frozen sidecar builds, package smoke and private
recovery process test pass. The new source HTTP acceptance passes against source
and the frozen macOS sidecar; it checks exact review/retry, Move Replace identity,
independent retained versions, conditional Undo, nested directories, picker Copy,
external arrivals, recovery Copy, process restart, permission revocation and Release.
Rust formatting, locked Clippy and tests pass: 135 macOS and 133 Ubuntu tests.

The first adapted transport assertions were corrected to expect definite leaf
absence as an exception. A stale write-mode test now preserves legacy refusal
while accepting portable permission. Linux's initial full run exhausted tmpfs.
Deleting passed temporary directories then reused a path with retained private
creation intent, correctly triggering a changed-directory refusal. The final
Linux run retains directories with a larger tmpfs. Its only excluded case is the
known `linux-arm64` media-manifest key assertion; that platform has no bundled
media pin. No product safety check was relaxed.

The final focused SMB checks passed 67 tests in each guest. Linux's rebuilt
frozen source HTTP acceptance passed; its arm64 bundle uses system media tools
because that platform has no pin. Isolated Docker build/context checks and the
production smoke pass, including clean/forced restart and arbitrary-uid operation.
The macOS production app and DMG also build
successfully. Native local Copy, occupied-target refusal, explicit Copy Replace,
conditional Undo refusal and successful replacement Undo passed. The exact
prepared Undo survived normal Quit/restart before acceptance. The guest's original native profile
was restored with matching hashes, modes and symlinks after the local checks.
The synthetic browser screenshot was reviewed edge to edge and recorded with
explicit provenance in the binary inventory.

Source mounted-SMB HTTP acceptance passed after the namespace-refresh repair.
It uses fresh synthetic directories and local private SQLite, including exact
reviews, identity-preserving Replace/Undo, nested directories across process
restart, picker Copy, external arrivals and separate recovery copies. The focused
SMB suite passed 67 tests in both guests. All twelve mounted process-exit cases
passed, covering six Move Replace boundaries for files and directories, exact
Retry, retained versions and Undo. Both source-operation browser flows passed
on the same selected mount. The final rebuilt frozen mounted HTTP acceptance
also passes. Its executable matches the production app's embedded sidecar and
the app passes strict signature verification. Native mounted Copy and directory
Rename pass; the exact saved rename review survived normal Quit/restart before
acceptance. The final mounted browser rerun passed both flows with explicit
asynchronous waits. Native cleanup stopped only the test app, allowed its sidecar
to drain, verified original/copy/nested bytes and the database-free package, and
restored the original guest profile with matching hashes, modes and symlinks.

Later qualification changes only adjust acceptance tests and documentation;
the runtime source remains identical to the tested build. Its source inventory
SHA-256 is `2afc1de27bcbd865a36b5d1f8d2d5213d05375ad56d41613ebbef455d49029f0`.
Reproduce it with:

```bash
git ls-tree -r HEAD -- apps/server/src apps/server/packaging apps/server/pyproject.toml apps/server/uv.lock apps/desktop/src-tauri apps/web/src | shasum -a 256
```

The exact standalone and embedded sidecar SHA-256 is
`3a7a4b1279b7d6637c130dbc9e252d5f9379cd7b241841d2646afb52e6a8d9b1`.
The final isolated arm64 Docker image digest is
`sha256:5f6e8db0e71eea7670a5169b70b53906ede0abbb9fabcd1493592ba6f4333a23`.
These hashes identify tested artifacts; they are not reproducibility claims.

See [file operations](file-operations.md), [ADR-0036](adr/0036-portable-source-operations.md)
and [ADR-0037](adr/0037-portable-mounted-smb.md) for the contract and limits.
