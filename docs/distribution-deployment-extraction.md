# Distribution/deployment extraction

Group 7 uses `feature/distribution-deployment`, based on the fully green PR #47
merge `a7d149db1f34d0e0bba3d544b8253626dc521b8a`. The preserved reference is
`cd38493fcb306198ff4af00e19b5d78ada241ceb`, tree
`912a0e657005ade3fb3e3b089df7c2343305fb99`. It is an extraction source, not a
branch to merge.

## Scope

- Optional local macOS certificate identity, strict configured-signer checks and
  signing of the frozen sidecar with its fixed identifier. Explicit release
  identities take precedence. Builds never create or rotate identities.
- Development sidecars in a separate staging directory with verified media-cache
  links; distribution bundles retain independent copies and pinned bytes. The
  launcher also tracks `uv.lock`, so dependency-only updates rebuild frozen code.
- Separate writable private data and backup volumes in the image and both
  deployment compose files; retain the deployment write-mode master switch.
- Registry backup/restore safeguards, format-three deployment guidance and a
  joined portable integration smoke alongside the existing acceptance scripts.

The reference's obsolete shared-package ownership smoke is intentionally omitted.
The existing media smoke and damaged-store recovery smoke retain their stronger
protected-access, metadata identity and clean/forced restart checks. Current CI
security pins, CodeQL repairs and privacy gates are preserved.

The two existing acceptance scripts mount the new `/backups` volume explicitly
and remove only their test resources. The arbitrary-uid path supplies a writable
backup bind mount as well as data. Registry backup/restore uses that separate
volume; the damaged original store and retained access assertions are unchanged.

The read-only backup mount exposed an inherited restore bug: opening a WAL-format
snapshot through SQLite could require writable companions
([SQLite WAL documentation](https://www.sqlite.org/wal.html#read_only_databases)).
The helper now validates a private file copy, preserving literal `?`/`#` paths and
the source bytes without weakening the read-only mount. It rejects source WAL,
SHM and journal companions before making changes, then keeps its integrity check,
atomic install, stopped-server and rollback requirements.

Documentation is adapted to current main rather than copied wholesale. The image
also defaults private backups to `/backups` and declares both writable volumes,
so standalone containers do not depend on Compose to get separate snapshots.

## Qualification

Focused gates passed on source snapshot `f5d852a3dc`, tree
`786078937a`: Ruff, format and mypy in both guests; 62 packaging/signing/backup
tests on macOS, 61 on Ubuntu with the explicit unpinned Linux-arm64 media-platform
exclusion, and the launcher test on both. The macOS disposable Keychain smoke
proved changed readers retain access without a prompt and rejected wrong
identifiers, certificates and ad-hoc readers; original search-list cleanup passed.
The initial compose configurations and shell syntax checks passed on Ubuntu.

Full qualification used checkpoint `5d934efe`, tree `b07e106e875a2dee4b9102f8dd7478e719be47ad`.
The compiled runtime-input inventory SHA-256 is `d2b07f153c2530311bfdf2965490becd982a1e0f94d97112af3e84ef63b83492`;
these inputs remain unchanged after the separately tested launcher and restore
repairs. This identifies the tested source, rather than promising reproducible
binaries or qualifying a release built from a later metadata commit.

| Check | Result |
| --- | --- |
| macOS backend | 1,776 passed; the four new restore regressions passed afterward in the 11-test helper suite |
| Ubuntu backend | 1,514 initial passes and 261 affected tests passed after space cleanup; one unpinned Linux-arm64 platform exclusion; four new restore regressions passed afterward |
| Backend static checks | Ruff, formatting and mypy passed in both guests; restore regression formatting/lint rechecked after the repair |
| Development launcher | Passed on both guests, including dependency-only lock changes, missing signing identity and media-cache invalidation |
| Real development shutdown | Ctrl-C closed the private binding lock and left no shared database in both guests |
| Frozen HTTP acceptance | Five local source/creation/discovery/recovery tests passed on each rebuilt platform package |
| Rust | Formatting, locked Clippy and 135 macOS/133 Ubuntu tests passed; macOS included the actual frozen sidecar lifecycle |
| macOS production build | App and DMG built; license inventory and strict app signature passed; the embedded sidecar retained the exact configured signature and standalone bytes |
| Docker contexts and images | All contexts passed canary/residue, size and license checks, including a rebuild after the restore repair |
| Docker media/restarts | Thumbnail, range/HLS, catalog identity, clean/forced restart and arbitrary-uid checks passed |
| Docker recovery | Read-only registry restore, damaged-private-store recovery, unchanged damaged original and retained protection passed |
| Joined portable deployment | Reviewed Update, conflicting titles/resolution, source identities/Replace/Undo/Trash, occupied arrival refusal, protected backup/recovery, drafts and source bytes passed initially and after clean/forced restarts |
| Compose/shell configuration | Both production examples and affected shell scripts passed validation |

Ubuntu initially exhausted its 4 GiB test tmpfs because a completed group 6 run
still occupied 2.1 GiB. The failure log and all 261 failed/error node IDs were
preserved before removing only those completed synthetic test directories. All
261 passed on retry; no code or test expectation changed for that environment
failure. Backend coverage totals 1,780 macOS and 1,779 Ubuntu unique tests after
the four additional restore regressions. This combines a full initial run with
focused reruns; it is not a claim of a second full-suite invocation.

Both macOS package modes use a disposable local signer. The development bundle
links verified media tools; distribution and app resources hold regular copies.
All copies retain the pinned media hashes and valid signatures, with no forbidden
native encoder. SHA-256:

- Development sidecar: `4abdf9d882f9d95017d6c09467a3d7eb50a3edf53ea94238383213ef66283407`.
- Distribution and embedded sidecar: `cf7660e00481028a1eca1f711ab24a95b8b9ffd9fbd83a052e87fa6206aade9a`.
- Final isolated arm64 image: `sha256:e21edece478fc4d3ff7d8b3ccad99ffd2a7a6803c220e1de55c1a3a3a2993bda`.

The embedded executable received its exact selected-share saved-login grant in
the guest. Mounted source HTTP acceptance then passed on both different frozen
builds, with background credential prompts disabled, in 76.66 and 69.19 seconds.
The same certificate covered the changed reader; neither qualification reused an
old ad-hoc executable's result. The independent disposable-Keychain smoke also
rejected other certificates, identifiers and ad-hoc copies without interaction.

Native acceptance created a new synthetic mounted library through the production
app and showed its source files. Normal Quit closed the app and sidecar. Restart
retained the same registry/library identity, manifest and exact source bytes;
opening Files showed the same entries. The guest's network-volume permission
prompt was handled. No mutable database entered the library. The original guest
profile was restored with matching hashes, modes and symlinks. The disposable
signing Keychain was removed and the original Keychain search list retained.
Private raw receipts remain outside Git.

### PR #49 headless runner follow-up

The first GitHub macOS 26.6.2 job failed in `codesign` while signing the
disposable test reader, before the package build. The macOS 27 guest's earlier
smoke passed. The test now explicitly unlocks its freshly created Keychain and
sets Apple signing partitions on only that Keychain's private signing keys,
following [GitHub's runner setup](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications).
Passwords stay on stdin; this does not change local enrollment, system trust or
saved-login ACLs. All changed-reader and rejected-identity assertions remain.

Ruff, formatting, mypy and 21 signing regressions passed in both guests. The
real macOS Keychain smoke also passed all access/refusal assertions and removed
the temporary Keychain with the original search list retained. GitHub runner
verification and the full CI merge review remain pending.

The web source, API and user interactions are unchanged. The production SPA build
ran; the group 6 frontend unit/browser suite was not repeated locally for group 7.
Linux package checks use system ffmpeg because Linux-arm64 has no pinned media
bundle. Developer ID signing, notarization, quarantine/download behavior, provider
delivery, representative scale and power-loss safety remain unqualified.

## Publication checkpoint

The reference ledger has 364 exact, 129 partial and 47 absent paths. These compare
bytes rather than behavioral acceptance. The obsolete shared-package ownership
smoke is intentionally omitted; paused OS drag, former prototypes, superseded
legacy API/tests and separate application proposals are not imported by group 7.
The pre-publication local gates passed with all 10 owner-specific patterns and
hooks intact: one commit and 40 newly reachable text/JSON blobs; full reachable
history of 884 commits and 6,192 blobs; and the prepared PR title/body. New blob
contents, detected types/sizes, paths, commit metadata and text were inspected.
There is no new binary, build output or vendored tree. Docker context/image checks
also passed. These gates run again against the final amended ref before pushing.

No owner host signing configuration, installed app, real library, production NAS,
release tag or published image is changed by this work. Developer ID signing and
notarization remain unqualified without a configured release identity.
