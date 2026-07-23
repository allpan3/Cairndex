# Project status

## Done: CI cost reduction (2026-07-23)

Merged to `main` directly at the owner's request. Prompted by the Actions budget
being ~90% consumed for the month, and driven by measurement rather than
instinct — the intuitive suspect (the release workflow) turned out to be 10% of
the bill.

**Where the minutes actually went**, 30 days to 2026-07-23, computed from job
timestamps because the per-run billing endpoint reports zeroes:

| | billable min | share |
| --- | ---: | ---: |
| `CI / Desktop shell (macOS)` | 1,570 | 58% |
| all other CI jobs combined | 860 | 32% |
| `Release` (one-off, both arches) | 261 | 10% |
| **total** | **2,691** | |

One job was 58% of everything, because the repository is private and macOS bills
at **10×**. Two facts made it worse: roughly **half of this repository's commits
touch only documentation** (12 of the last 25), and CI ran on both
`pull_request` *and* the `push` that merged it — so a green PR's macOS build was
immediately re-run against identical code.

**Two changes went in, and one came straight back out.** `paths-ignore` for
docs-only changes stays — it is worth having for feedback latency regardless of
money, and it alone accounts for roughly half the runs. Restricting the desktop
jobs to pull requests was reverted within the hour: **the owner made the
repository public**, standard GitHub-hosted runners (including `macos-latest`)
became free and unmetered, and that restriction had been a pure cost trade that
bought nothing while costing desktop coverage on every direct-to-main commit.

The lesson worth keeping is about sequencing, not CI: a measured, correct
optimisation was obsoleted by a one-click change to the constraint it optimised
against. The measurement was not wasted — it is what found the flake and the
missing timeout below, both of which stand on their own — but the cost analysis
had a shorter shelf life than the work it justified.

`desktop-macos` keeps `timeout-minutes: 30` against an observed ~4.5-minute
build: free runner time is still finite runner time, and a hung Tauri bundler
should not hold one for six hours.

**Going public also closes the ADR-0019 gap** flagged during D7: a release can
now actually reach people who are not the author, which was the premise of
publishing prebuilt binaries in the first place.

**A pre-existing flake surfaced along the way**, and it belongs in this entry
because a flake costs a whole re-run. The packaged sidecar smoke test asserted
on `bundles?limit=1` — whichever of three differently-formatted fixtures sorted
first — and failed with `thumbnail is not a JPEG (296 bytes)` on 2026-07-22 and
again on 2026-07-23, having passed 37 minutes earlier on identical code. Not a
D7 regression. It now pins the assertion to the JPEG fixture, removing the
uncontrolled variable.

**What produced those 296 bytes is still unexplained**, and that is recorded in
the code as an open question rather than papered over: a 200 response whose body
is not JPEG, from a path that only ever writes `.jpg`. The bundled ffmpeg
thumbnails all three fixtures correctly when driven by hand, including the HEIC,
so a missing decoder is not the answer. If it recurs on a pinned fixture, the
remaining suspect is the generate-then-serve path.

## In progress: plan 3 D7 — first public release (2026-07-22 → 2026-07-23)

Branch `feat/d7-first-public-release`, based on `main` at `e588ae1`. Pushed and
merged through a PR at the owner's request (2026-07-23), after two review
rounds on the branch — the last engineering commit is `aeafed6` (workflow
hardening), and this handoff commit is the branch tip. The engineering half of
D7 is complete; everything that remains is owner-gated and listed under
**Next** below. The one unresolved decision is item 3 there (`pillow-heif` /
libheif LGPL notices).

**The blocker is resolved: ffmpeg is pinned.** Both macOS architectures now pin
FFmpeg 8.1.2 from the Martin Riedl build server. The choice was made by
verification rather than by reputation, and the check that decided it was
licensing, not staticness: the obvious candidate — `eugeneware/ffmpeg-static`,
static, current, widely used — carries `--enable-nonfree` and therefore **may
not be redistributed at all**, which is fatal for a milestone whose entire point
is publishing binaries. The same builder's *Linux* artifacts fail the same way
(`--enable-decklink` forces nonfree), so `linux-x86_64` stays deliberately
unpinned and documented; it is not a release target, and the container path uses
the image's own ffmpeg. What was verified on the pinned builds, none of it taken
from a label: a clean `otool -L` closure, `--enable-gpl --enable-version3` with
no nonfree, `--enable-libx264` (the HLS ladder needs it), and — a bonus — a
notarized Developer ID signature.

**A latent bug fell out of the manifest work.** Checksums were a flat
`{tool: sha256}` map, which cannot express two architectures. The moment a
release shipped both, one arch's digest would have "verified" the other's
binary. Pins are per-platform now, and `build_sidecar.py` refuses an unpinned
binary rather than bundling it with a warning — that code runs at the point
where a binary becomes part of something published.

**The quarantined-build check found a real defect, which is why that item
existed.** `Cairndex.app` shipped with no `Contents/_CodeSignature/CodeResources`:
Tauri only runs `codesign` when a `signingIdentity` is configured and none was,
so the app had a linker-ad-hoc-signed executable and no resource seal. macOS
rejects that as *malformed* — "code has no resources but signature indicates
they must be present" — which is worse than being unsigned, and is precisely the
failure ADR-0019 §4 warned about while asserting the invariant already held. It
was invisible because Gatekeeper only assesses **quarantined** apps and every
build ever observed was local. Setting `com.apple.quarantine` by hand on a local
build reproduced the download path in seconds. Fixed with
`signingIdentity: "-"`; Tauri signs without `--deep`, so the nested notarized
ffmpeg keeps its Developer ID signature, and the quarantined verdict is now the
ordinary `rejected` that Open Anyway clears.

**Also landed:** `THIRD-PARTY-NOTICES.md` with the GPL written source offer,
configure options and exact binary digests; a README install section for the
Open Anyway first launch; and a correction to the README's license line, which
said "All rights reserved" while `LICENSE` has been MIT since 2026-07-21.

**Four review findings fixed on the same branch.**

1. *The README promised updates would skip the Gatekeeper walk.* They will not.
   There is no updater, so an update is a fresh quarantined download, and an
   ad-hoc signature has no stable identity for macOS to carry the approval
   across — the CDHash changes every build. The section now says the step
   repeats per version, and ADR-0019 §4 carries the same amendment, since
   "cost paid on every release" is a materially different trade from "cost paid
   once" for the Developer ID decision.
2. *The smoke test could pass while proving the opposite.* It set
   `CAIRNDEX_FFMPEG_PATH` and trusted the sidecar to honour it, but
   `media/tool_paths.py` falls back to PATH discovery when a configured binary
   is not executable — correct for the app, wrong for the one run that exists to
   prove the bundled binary works. On this machine (Homebrew ffmpeg on PATH) a
   lost execute bit would have passed. It now refuses a non-executable bundled
   binary, and a bundle staging one media tool without the other.
3. *The GPL offer leaned on a third-party server and covered one architecture.*
   Both `versions.txt` files are committed under `packaging/ffmpeg-build-info/`
   and referenced from the manifest; the notices file no longer presents the
   arm64 configure line as if it were both.
4. *`packaging/` was outside every typing gate*, because the gate named `src` —
   leaving the checksum gate that decides what may be published unchecked. It is
   now in scope (`mypy src packaging`, also set as `files` in pyproject), the
   five pre-existing `smoke_test.py` errors are fixed too, and
   `ffmpeg_manifest.py` validates field types as it reads them rather than
   trusting the JSON's shape.

**Gates.** Backend ruff / ruff format / **strict mypy over `src` + `packaging`**
(146 files) / **625 pytest** (+30, all in the new `test_ffmpeg_manifest.py`,
covering the ways the checksum gate can fail open — malformed pins, vendor
scoping, and Mach-O architecture reading).
Desktop `cargo fmt --check`, Clippy `-D warnings`, **86 tests** against the real
packaged sidecar, and `tauri build`. Web build run to produce the Tauri
frontend; no web source changed, so the web unit/e2e suites were not re-run.

**Verified by hand, end to end:** fetched the pinned binaries, confirmed the
Developer ID signatures survive download → extract → stage → bundle, built the
213 MB app, installed it, and launched it with the sidecar spawning from inside
the bundle. The packaged smoke test passes against the *bundled* ffmpeg — and
that was proven rather than assumed by sabotaging the bundled binary and
confirming the smoke test fails (it did, though only with a raw traceback; it
now reports the failure in its own words).

**The release pipeline exists, and both architectures are built and verified.**
`.github/workflows/release.yml` triggers on a `v*` tag or manual dispatch,
builds each architecture on its own native runner, smoke-tests each packaged
sidecar against its bundled ffmpeg, and drafts a release carrying both DMGs, a
`.sha256` beside each, and `THIRD-PARTY-NOTICES.md`. Publishing stays a human
decision.

*Native jobs rather than cross-compilation, and this is not a preference.* The
Rust half cross-compiles fine with `--target`; the sidecar does not, because
PyInstaller freezes the interpreter that runs it and has no cross-compile mode.
So the matrix pins `uv sync --python cpython-3.12-macos-<arch>-none` — that line
is what decides the sidecar's architecture. `--platform` selects which checksum
pin to verify against and *cannot* change what was frozen, which is a trap worth
naming: staging a correctly-pinned Intel ffmpeg beside an arm64 sidecar passes
every digest check and produces an app that dies on launch. `build_sidecar.py`
now reads the frozen executable's Mach-O header and refuses the mismatch
(verified: exit 1 with a message naming the fix).

Two things the two-architecture work surfaced. Fetched binaries all landed in
one `vendor/ffmpeg/` directory with identical filenames, so building both arches
meant each fetch silently clobbered the other — the vendor path is
platform-scoped now. And the Intel runner label is `macos-15-intel`; the old
free `macos-13` image is retired, so if Intel runners go away the fallback is
dropping the artifact, not cross-compiling.

**CI cannot be run from here, so the pipeline's logic was verified on this
machine instead**, which is stronger than it sounds: the whole Intel path was
executed end to end. An x86_64 CPython and the `x86_64-apple-darwin` Rust target
produced an Intel sidecar (arch-checked), its smoke test passed under Rosetta
against the Intel ffmpeg, and `tauri build --target x86_64-apple-darwin` yielded
a 294 MB app whose every Mach-O — shell, sidecar, ffmpeg, ffprobe — is x86_64,
with a valid bundle signature, the expected `rejected` quarantine verdict, and a
clean launch with the sidecar spawning. The arm64 DMG was built (97 MB from a
213 MB app), mounted, and the app inside it verified. The workflow's two
non-obvious shell steps — the `file`/`sed` architecture assertion and the
staging/checksum step — were run verbatim against those real artifacts.

**A second review round hardened the workflow** (2026-07-23). The release jobs
held a write-capable `GITHUB_TOKEN` they never use — `permissions: contents:
write` was declared at workflow level, so it reached the build jobs and every
third-party action they run. The workflow is now `contents: read` with the
write grant scoped to the `publish` job alone, and the non-GitHub-owned actions
(`softprops/action-gh-release`, `Swatinem/rust-cache`, `astral-sh/setup-uv`)
are pinned by commit SHA rather than by movable tag — this workflow produces
the binaries strangers download, so a repointed tag must not be able to change
what runs in it. Notably, `Swatinem/rust-cache`'s moving `v2` already pointed
past its latest release (an unreleased commit); the pin is the released v2.9.1.
`dtolnay/rust-toolchain` stays on `@stable` because that branch name is its
toolchain selector, not a code version. Smaller items from the same round: the
arch-verify step's comment claimed "every Mach-O" while checking the four
executables (the ~50 Python `.so` files follow the pinned interpreter, which
the sidecar check covers — the comment now says so), a dead step output was
removed, `macho_arch` reads 8 bytes instead of the whole 10 MB executable, and
the re-pin checklist in `development.md` gained its missing fifth property:
GPL-compatible components, i.e. OpenSSL must be ≥ 3.0 (Apache-2.0) for
`--enable-openssl` to be redistributable alongside GPL — the pinned builds
link 3.6.1.

**`v0.1.0` was tagged and the release workflow run at the owner's request
(2026-07-23), and it passed on both architectures.** The tag is annotated,
points at `34ab2e0` (the D7 merge), and matches the `0.1.0` in
`tauri.conf.json` — which matters because artifact names come from the config,
not the tag, and nothing enforces that they agree.

Every gate the workflow adds fired for real: the packaged smoke test against the
bundled ffmpeg, the bundle-signature assertion, and the per-binary architecture
check. `macos-15-intel` accepted its job, settling the open question about that
runner label.

**Intel was then dropped from the pipeline** (owner, 2026-07-23), and the run's
own numbers are why it was worth measuring before deciding: arm64 finished in
**7m02s**, while Intel was still in its app+DMG step at **10m+**, having already
taken 98s to freeze the sidecar against arm64's 24s. Roughly 4× slower at every
compile-bound step, on minutes billed at 10×, for an artifact that is not
needed. The matrix keeps its single entry and carries the removed one as a
comment; `macos-x86_64` stays pinned, the architecture checks still cover it,
and the documented local Intel build still works — so the artifact is one
uncommented block away, not a rebuild.

The Intel DMG built successfully before the decision landed, so it was **removed
from the draft** rather than shipped: offering an Intel build once and never
again would strand those users at v0.1.0 with no upgrade path, and it would make
the arm64-only wording in the README and notices false on its first outing. It
is recoverable until 2026-10-21 from the run's `cairndex-x64` artifact if that
call should be reversed.

**The published artifact was verified as a downloader gets it.** Downloaded from
the draft with `gh release download`, checksum matched what CI computed, DMG
mounted, the app inside carried a valid signature and a working bundled
FFmpeg 8.1.2. Applying `com.apple.quarantine` to it produced Gatekeeper
`rejected` and the app **did not launch** — which is the README's install
section being necessary, demonstrated rather than assumed. A genuine
browser-download pass is still the owner's to do.

Two workflow gaps this run exposed, both fixed:
- **No `timeout-minutes`**, so a wedged Tauri DMG bundler (it drives Finder over
  AppleScript, the documented reason CI skips DMG) could have burned hours of
  10×-billed minutes against GitHub's 6-hour default. Now 45.
- **Cancelling one matrix leg would have skipped `publish` entirely** (`needs:
  build`), losing the draft release along with the successful arm64 artifact.
  That is why the Intel leg was left to finish rather than cancelled when the
  decision to drop it came mid-run.

The procedure is now a runbook in `docs/deployment.md` (*Cutting a release*):
pre-tag version bumps, tagging, watching, reviewing the draft, publishing, and
backing out. `AGENTS.md` gains the matching rule — releasing is owner-triggered
like opening a PR, and a tag with a published release must never be moved.

**Next**, in order:
1. **The HEIC dependency's licensing — investigated 2026-07-23, now an owner
   decision with a recommended answer.** It is worse and simpler than first
   flagged. `pillow-heif`'s wheel bundles libheif (LGPL-3.0+), libde265
   (LGPL-3.0+) **and libx265 (GPL-2.0+)**, and libheif names x265 in a load
   command rather than a lazy `dlopen`, so importing it pulls GPL code into the
   sidecar process. All three ship inside `Cairndex.app`; x265 alone is 8.6 MB.
   Its declared `BSD-3-Clause` alongside a **GPLv2** classifier is not a
   metadata error — the maintainer is describing the wheel accurately.

   **Cairndex never encodes HEIC**: `media/previews.py` calls
   `register_heif_opener()` and nothing else, and the only HEIF write in the
   repository is a smoke-test fixture generated in the test process, outside the
   bundle. The GPL component is an encoder the product does not use.

   **Recommended: swap the runtime dependency to `pi-heif` 1.4.0** — same
   maintainer, same codebase, decode-only, and its wheel carries libheif +
   libde265 with **no x265** (verified by inspecting it). Verified as a drop-in:
   `from pi_heif import register_heif_opener` is the identical symbol, it
   decoded the HEIC fixture and re-encoded to WebP exactly as `previews.py`
   does, and `save(..., "HEIF")` correctly fails. That removes the GPL
   obligation entirely, drops the notices question from copyleft to LGPL notice
   text, and takes 8.6 MB off the app.

   One consequence, not a blocker: the smoke test generates its HEIC fixture
   with an encoder, so `pillow-heif` would move to a **dev-only** dependency
   (dev deps are not distributed, and the fixture is written by the test
   process, not the frozen sidecar). The alternative is committing a small
   synthetic HEIC as a test asset.
2. **An owner pass on a genuinely downloaded build**, which needs a release to
   exist. The `xattr` reproduction is faithful to the quarantine bit and the
   published artifact was verified after a real `gh release download`, but a
   browser round trip is the last unobserved step.

After those, D7 closes and the build order moves to **phase H — plan 4 library
write mode**, W0 → W1 → W5.

Unchanged and still open from D6: the lease redirect landing on the target
server's first library, and `localStorage` being undefined in jsdom.

## Implemented: unified library add/remove flow (2026-07-22)

Branch `feat/unified-library-manager`, based on `main` at `2efddeb`. PR opened at
the owner's request; not merged. Commits run server endpoints → shell → web
modal → docs, then a review follow-up and four rounds from an owner pass on the
packaged app.

**What changed.** Adding a library no longer starts with a question the owner
should not have to answer. The Create/Register tabs are gone; there is one path
field and one action, and the server classifies the path
(`GET /libraries/probe-path`): already registered → select it, an existing
library → register it under the name it carries, anything else → one
confirmation prefilled with the folder's basename. A path that does not exist
yet says so in that same confirmation, which is what replaced the
create-if-missing checkbox. Libraries can now be **removed**
(`DELETE /libraries/{id}`), metadata-only in the strict sense: registry row,
lease release, engine dispose, and nothing on disk.

**The desktop half is a pick/confirm pair.** `pick_library_folder` no longer
refuses a folder without a manifest; a non-library pick parks the `PathBuf` in a
single-slot `PendingPick` and returns `{ needs_confirmation, token, folder_name
}`, and `confirm_picked_library(token, name)` redeems it. This keeps the
`PickedFolder` invariant intact for a flow that now needs a user round trip
mid-way: the path waits inside the shell, the web layer holds only an opaque
token. A superseded token is refused **and leaves the newer pick intact** —
otherwise a name typed for one folder could create a library at another.

**The menu item became the same surface.** File → Open Library Folder… is now
**Manage Libraries…** (still ⌘O) and opens the dialog instead of jumping to the
picker, so one surface covers adding, opening, and removing — and it is now
rendered in the states that replace the workspace (a lease refusal, a locked
library), which are exactly where switching libraries is what a user wants and
where the dialog previously did not exist. First-run setup keeps the direct
picker on purpose: the dialog lists a *server's* libraries and first run has no
server, which is the situation the picker resolves (ADR-0018's "local libraries
just work"). That removed App's whole duplicated folder-opening path — naming
dialog, state, toast, error handling — since the dialog owns all of it. The
sidebar's `+` became a books glyph for the same reason: the dialog no longer
only adds.

**Three things worth keeping from the build:**

1. **Layout is where this feature kept breaking, and jsdom cannot see layout.**
   Twice: the suggestion menu stays open after a selection (to drill down) and
   sat over the primary button, so the click that looked like "Add library"
   would have selected a suggestion — caught by Playwright, fixed by moving the
   action beside the field. Then the owner reported the menu showing only two
   rows in the real app: `.modal` is a scroll container, so an absolutely
   positioned menu is clipped at the dialog's edge, and the add row sits at the
   dialog's bottom so "below the field" is usually the direction with no room.
   Fixed with an `overflow: visible` opt-out plus a measured flip above the
   field. Its first regression test **passed against the bug** — `boundingBox()`
   reports an element's layout box whether or not an ancestor clips it, so the
   assertion had to become an `elementFromPoint` hit test at the menu's edges.
   Then a third, from the same owner pass: the menu could not be dismissed by
   clicking away, because its outside-click listener was on the bubble phase and
   the dialog stops mousedown propagating (deliberately — that is what keeps a
   click inside it from reaching the backdrop). Every dismissing click is inside
   the dialog, so the listener never fired; it runs in the capture phase now.
   A fourth, on the same pass, was design rather than defect: the name step
   replaced the whole add section, so the button that asked for the
   confirmation moved out from under the pointer. It now swaps the row's
   contents in place — and holding the row still needed two non-obvious
   things, since the dialog is vertically centred: buttons that never wrap, and
   a hint paragraph that reserves two lines whether or not it uses them.
   **The pattern across all four: this dialog's behavior lives in the browser,
   not in the component.** A component test can prove which handler ran; it
   cannot prove the handler ever gets the event, that the element is where it
   claims to be, or that it stayed there.
2. **Content query keys are not library-scoped.** The cache is cleared on every
   library switch instead, so removing the *active* library had to clear it
   explicitly; without that the next library inherits the removed one's bundles
   and counts. This is a standing trap for anything that changes the active
   library outside `changeLibrary`.
3. **Deregistration releases the lease** (ADR-0018 §3 lists unregistration
   alongside clean shutdown). Skipping it would leave a folder nobody serves
   showing a takeover prompt on the next machine to open it. Pinned by mutation.

**Gates.** Backend ruff / ruff format / strict mypy / **595 pytest** (+17).
Frontend ESLint / Prettier / tsc / **329 Vitest** (+29) / Vite build / **90
Playwright** (+7, the whole suite including its `@fullstack` partition against a
real backend). Desktop `cargo fmt --check`, Clippy
`-D warnings`, **86 tests** (+13) against the real packaged sidecar, and
`tauri build`. Mutations applied and killed: the lease release in
`deregister_library`, the pending-pick token comparison, the dialog's
`overflow` opt-out, the menu's upward flip, the capture-phase dismissal, and the
hint paragraph's reserved height — the last four all layout or event-propagation
properties that only a browser test can observe.

**Verified by hand**: the modal was driven in a real browser and captured in
three states (suggestions with a library badge, the name confirmation, the
removal confirmation). The first capture found the removal reassurance —
the sentence saying no files are touched — being ellipsized by the path row's
`nowrap`; it has its own class now. The owner then found the clipped menu in
the running app, which is item 1 above.

**Owner acceptance passed (2026-07-22)** on the packaged app, which is what
closes the one gap the automated suites structurally cannot reach: driving a
macOS folder dialog needs assistive access this environment does not have, so
the pick→confirm round trip was proven only at its seams (Rust tests against a
real sidecar; web tests against the command boundary). The owner drove the
native picker on a library folder, a plain folder, and a folder the current
server already serves, plus the typed-path and removal flows, and reported all
of them working. The four defects that pass surfaced are items 1 above; each was
fixed with a browser test that fails without the fix.

**Next**: unchanged — plan 3 **D7 (first public release)**, whose only true
blocker is pinning a static ffmpeg (ADR-0019 §3).

## Implemented: startup flash root-cause fix via macos-private-api (2026-07-22)

Branch `fix/desktop-startup-flash-root-cause`, based on `main`.

- Reverted the off-screen priming workaround (`e2ef4c4`): it raced WebKit's
  compositor using undocumented off-screen rAF behavior that macOS occlusion
  throttling could legitimately break. The workaround is preserved on branch
  `archive/startup-offscreen-priming` and in `main` history.
- Root cause addressed instead: the window `backgroundColor` never affected
  WKWebView's opaque white backing surface because wry's `drawsBackground`
  disabling is compiled behind Tauri's `macos-private-api` feature, which was
  not enabled. Enabling the Cargo feature plus `app.macOSPrivateApi` in
  `tauri.conf.json` makes the first composited frame dark by construction
  (ADR-0020). This supersedes the 2026-07-21 note that no private API was
  enabled.
- The renderer-acknowledged hidden-until-mounted reveal (below) is retained as
  content polish with its two-second fail-safe; it is no longer a flash
  defense.
- Desktop formatting, Clippy, and all 73 Rust tests pass. Frontend lint,
  formatting, type checking, all 300 component tests, and the production build
  pass. Playwright was skipped: no browser-visible behavior changed and the
  reverted web code returns to its previously gated state.
- `tauri build --bundles app` passes. The packaged app was launched
  standalone (after quitting the previously installed instance, which the
  single-instance plugin otherwise forwards to): it started, rendered the dark
  shell with the active library at the saved window placement, and stayed
  stable, confirming the private-API flag pair is consistent. The rebuilt
  application is installed to `/Applications` and relaunched.
- Known limitation: automated capture cannot frame-sample the sub-second
  transition; owner observation across several launches remains the decisive
  visual check. If MAS distribution ever becomes a goal, ADR-0020 must be
  revisited.

## Implemented: renderer-acknowledged desktop startup (2026-07-21)

Direct-to-`main` desktop startup follow-up.

- The first implementation revealed the native window at
  `PageLoadEvent::Finished`, but owner testing still exposed a white frame. That
  event confirms navigation, not that WKWebView has composited the dark document,
  so it is no longer the normal reveal trigger.
- The native main window now starts hidden and is revealed and focused exactly
  once after React commits the mounted dark shell and a subsequent renderer task
  invokes `renderer_ready`. The page-load callback only schedules a two-second
  fail-safe so a renderer failure cannot leave the application invisible.
- Cold-start deep links and near-simultaneous second launches cannot bypass the
  readiness gate by calling `show()` early; once loaded, their existing restore
  and focus behavior is unchanged.
- The pre-existing native `backgroundColor`, inline document background, and CSS
  background remain unchanged. No macOS private WebKit API was enabled.
- Desktop formatting and Clippy pass; all 73 Rust tests pass against the real
  bundled sidecar. Frontend lint, formatting, type checking, all 300 component
  tests, the production build, and all 80 Playwright tests pass.
- A packaged probe delayed the native fail-safe to ten seconds; the window became
  available in 1.685 seconds, proving the renderer acknowledgment rather than the
  fail-safe revealed it. `tauri build --bundles app` passes, and the final rebuilt
  application is installed. Automated desktop capture samples after launch and
  cannot prove the sub-second color transition; owner observation remains the
  decisive visual check.

## Completed: immediate cover selection feedback (2026-07-21)

Direct-to-`main` inspector latency follow-up.

- Bundle metadata mutations optimistically update the cached detail, so the old
  cover star dehighlights and the selected star highlights before the request
  finishes. A failed write restores the previous cover and refetches detail.
- Successful writes adopt the authoritative PATCH response instead of issuing
  a second detail request. Browse-card and thumbnail invalidation remains
  asynchronous.
- Bundle detail is metadata-only and no longer stats every linked member.
  Bundle file-list, playback-manifest, media access, File Browser, and scan paths
  retain their scoped missing-file checks.
- Backend Ruff/format/mypy and all 578 tests pass. Frontend
  lint/format/typecheck, all 299 component tests, the production build, and all
  83 Playwright tests pass. Browser coverage holds the metadata request open to
  prove the highlight changes before the response, then separately proves
  failed-write rollback.

## Completed: desktop-safe file reorder and direct file play (2026-07-21)

Direct-to-`main` inspector interaction follow-up.

- Plain dragging a file row now uses pointer capture and hit-tested insertion
  gaps, avoiding the HTML drag/drop lifecycle that the desktop WebView also
  uses for native file handoff.
- Option-drag remains the explicit mapped-library copy-out gesture, and
  Option+Up/Down remains the keyboard reorder path.
- Each available supported image or video has a compact play action immediately
  after its cover action. It opens that exact file in the unified viewer and
  feeds the existing bundle-cursor behavior.
- Frontend lint/format/typecheck, all 298 component tests, the production build,
  and all 81 Playwright tests pass. The reorder browser test uses a real mouse
  gesture rather than synthetic HTML drag events. The quit desktop app's local
  tab was unreachable, so this pass could not add a live WKWebView acceptance
  check.

## Completed: compact current-cover indicator (2026-07-21)

Direct-to-`main` inspector follow-up.

- The filename no longer gets a leading star when its file is the bundle cover.
- The existing cover action now carries the state: muted “Set as cover” for
  eligible files and a yellow, pressed “Current cover” star for the active one.
- The image and camera glyphs remain reserved for media-kind and frame-capture
  meanings, so the existing star remains the least ambiguous compact icon.
- Frontend lint/format/typecheck, all 297 component tests, the production build,
  and all 80 Playwright tests pass. Browser coverage checks the active star's
  rendered yellow color, pressed state, label, and filename separation.

## Completed: wrapping bundle-inspector titles (2026-07-21)

Direct-to-`main` inspector follow-up.

- The bundle title editor is an auto-fitting textarea that wraps long titles,
  grows with their rendered line count, and re-fits after inspector resizing.
- Enter still commits without inserting a newline; blur behavior and the title
  API contract are unchanged.
- Frontend lint/format/typecheck, all 296 component tests, the production build,
  and all 79 Playwright tests pass. The new browser test measures real wrapped
  geometry and the Enter commit path. The in-app browser remained unavailable
  for the local URL under its security policy.

## Completed: direct bundle-file reordering (2026-07-21)

Direct-to-`main` inspector follow-up.

- The Files in bundle rows are direct drag sources and gap-aware drop targets;
  the separate up/down buttons are removed.
- Option+Up/Down preserves keyboard reordering. When desktop file handoff is
  available, Option-drag preserves copy-out to Finder while a plain drag
  reorders inside the bundle.
- Frontend lint/format/typecheck, all 296 component tests, the production build,
  and all 78 Playwright tests pass. The in-app browser could not claim the local
  URL under its security policy, so no separate live-tab check was performed.

## Completed: explicit relink for missed network renames (2026-07-21)

Direct-to-`main` follow-up after directory-aware grouping.

- Missing Files now includes stale provisional bundles instead of leaving their
  missing rows visible only in scan totals.
- A missing file with exactly one live, globally unique quick-fingerprint match
  gets one compact `↻` action in the inspector. No dropdown or persistent target
  selector consumes row space.
- Relink preserves the original `AssetFile.id`, established bundle/file metadata,
  cover/cursor/subtitle references, and newest playback progress while removing
  the duplicate metadata row. It performs no filesystem writes.
- Candidate lookup re-stats the current path and rejects an old path that has
  reappeared, stale candidates, and ambiguous fingerprints.
- Backend service/API/browser-count coverage and a frontend interaction test pin
  the repair flow. Backend Ruff/format/mypy and all 577 tests pass; frontend
  lint/format/typecheck, all 294 tests, production build, and all 77 Playwright
  tests pass. A read-only check against the live Lex library found all seven
  affected bundles and a unique candidate for every one of its 11 stale rows.
  The in-app browser could not reload the local URL under its security policy,
  so the Lex-specific check used the API and did not apply any repairs.

## Completed: directory-aware grouping stem sensitivity (2026-07-20)

Branch `codex/grouping-stem-controls`, based directly on `main`.

- Grouping heuristic v5 partitions provisional files into stem candidates before
  selecting an existing confirmed bundle. A directory with one confirmed bundle
  and many unrelated video stems no longer collapses into one addition.
- Balanced matching folds conservative terminal rendition labels, so a file that
  differs only by `- 720p` targets the matching confirmed bundle and displays the
  existing/new destination switch.
- Grouping plans persist per-directory `narrow`, `balanced`, or `wide` modes.
  Review shows one Narrow/Widen control for each represented filesystem folder;
  regeneration uses the selected modes without changing confirmed groupings or
  source files.
- The generation mutation seeds the returned plan and summary cache before list
  invalidation, keeping current candidates visible instead of replacing the
  review with a spurious empty state.
- File moves use the whole file row as a drag source and the target bundle
  heading or file list as a drop surface, so cross-bundle review edits do not
  depend on two small hit targets.
- Files retained as `missing` after scan are excluded from new suggestions, and
  a stale open plan reports them as apply conflicts instead of regrouping them.
- Backend regression/API/bootstrap coverage and frontend component/browser-flow
  coverage exercise multi-stem folders, rendition matching, missing-file
  exclusion, mode persistence, destination visibility, and non-empty
  regeneration.
- Verification: backend Ruff/format/mypy and 573 tests pass; frontend
  lint/format/typecheck, 293 tests, production build, and all 77 Playwright tests
  pass. A real isolated browser run with screenshot-shaped filenames confirmed
  balanced split/addition behavior, both sensitivity directions, destination
  switching visibility, and populated manual regeneration.

## Completed: Plan 3 D6 — local-server sidecar

Branch `feat/library-ownership-lease`. Unpushed, no PR (owner-triggered).
**Owner acceptance pass passed 2026-07-21**, followed by a whole-milestone
review round (below).

### Whole-milestone review round (2026-07-21) — one P1, two P2s, all fixed

A review pass over the full 28-commit milestone, weighted toward seams no
single-commit review saw. Every finding was confirmed by running code before
fixing (a failing test, a filesystem probe), and every fix is pinned by
mutation.

1. **P1 — activation never moved the JSON API base URL.** `setApiBaseUrl` was
   called in exactly one place: inside `verifyServer`, as a probe side effect.
   So a local activation left every JSON request pointed at the previous remote
   server (or at nothing on first run) while the UI said "This Computer", and a
   *failed* activation left them pointed at the dead server just probed.
   Confirmed with a test against the real `verifyServer` + `api/client` before
   fixing: three scenarios, three failures. Fixed by making the base an
   explicit activation **commit** step for both kinds, making `verifyServer` a
   pure probe (it asks the candidate URL directly), and teaching `restore` to
   re-point a *local* previous connection (the old `!previous?.serverUrl` guard
   skipped it — the one compensation path could not compensate for local).
   `connections.apiBase.test.ts` pins all five outcomes; deleting the commit
   step fails three of them.

   Why every earlier gate missed it: the connections suite mocks `verifyServer`
   wholesale and the app suites mock the platform fetch, so activation
   *ordering* was proven while nothing observed where a request would land —
   the milestone's model-not-exercise failure mode, seventh instance. The owner
   acceptance pass missed it because its scenarios ran with the main server
   also serving the test folder, which masks the wrong base.

2. **P2 — a heartbeat *read* blip surrendered the lease while a *write* blip
   was tolerated.** `read_lease` folded `OSError` into `corrupt`, which the
   watchdog treats as "someone else is writing this file" — so one transient
   NFS/SMB error during the 60 s re-read unmounted the library, cancelled its
   jobs mid-scan, and (while the blip lasted) showed a takeover prompt for the
   user's own healthy library. Confirmed with a chmod probe: read blip → lost,
   write blip → held. `LeaseSnapshot` now distinguishes `io_error` from
   parse-corruption; the heartbeat rides out an I/O error exactly like a failed
   write (stay held, skip the beat, **no blind rewrite** — writing over content
   we could not read could clobber a lease that moved on), and still surrenders
   on real corruption. Acquisition and `describe` still classify `io_error` as
   UNREADABLE, so "we could not find out" never becomes "nobody holds it".

3. **P2 — the relay's scope-flag derivation had zero test coverage.**
   `targets_running_sidecar` is the only guard keeping `server_scoped_token`
   derived rather than caller-supplied; it was referenced by no test, so any
   weakening (URL-only match, always-true) would have survived the entire suite
   and reopened the D2 hole. Five tests now drive the real function against a
   real `LocalServer` with the `info()` liveness check in play (a live stand-in
   child), covering the match, the two dangerous directions (device token at
   the sidecar's URL; sidecar token at a remote URL), URL normalization, no
   sidecar, and a dead sidecar. Dropping the token comparison fails exactly the
   device-token test.

Mutations run and killed this round: the activation commit step (3 tests), the
heartbeat io-error branch (1 test), the derivation's token match (1 test).

One pre-existing red gate fixed in passing: `npm run lint` failed at HEAD with
four react-compiler errors in `App.tsx` — the ⌘O menu handler read `libraries`
and `changeLibrary` before their declarations. Runtime-correct (the ref-based
`useDesktopMenu` delivers the latest render's closure), so the fix is a
mechanical reorder of the hook call below the declarations; behavior unchanged,
288 existing web tests unaffected. Worth noting the acceptance receipt claimed
this gate green, so it regressed (or was last run) before the final App.tsx
edits landed.

Gates after the fixes: backend ruff / format / strict mypy / **566 pytest**
(+2); web Prettier / ESLint / tsc / **289 Vitest** (+5) / Vite build; desktop
fmt / Clippy `-D warnings` / **71 tests** (+5), run with `CAIRNDEX_SIDECAR_BIN`
pointed at the real packaged bundle.

P3s from the same review (owner-directed disposition, follow-up commit):

- **Fixed — relaunch on the local connection.** `DesktopBootstrap` read the
  local entry's null URL as "unconfigured" and showed first-run setup on every
  launch to a local-only user. It now activates the entry (starting the
  sidecar) and falls back to setup only on failure, showing the shell's own
  reason. The bootstrap's redundant post-activation `verifyServer` probes were
  removed at the same time — activation verifies before committing. Pinned by
  two tests; reverting the null-URL guard fails both.
- **Fixed — bounded sidecar shutdown.** uvicorn's `timeout_graceful_shutdown`
  defaults to unbounded, so a connection held open at quit could eat the
  shell's 15 s `SHUTDOWN_GRACE` and reach the kill fallback — the path that
  strands leases. Now 10 s, inside the shell's budget; the two constants
  cross-reference each other. Verified by rebuilding the bundle and re-running
  the packaging smoke test plus the desktop lifecycle tests against it.
- **Accepted, not fixed — `release()`'s read-check→write window.** A racing
  acquisition between release's read and its write can be briefly clobbered;
  self-healing within one heartbeat, inside ADR-0018 §4's accepted exposure
  bound. Recorded here rather than coded around.

Gates after the P3 fixes: backend 566; web ESLint/Prettier/tsc/**291 Vitest**
(+2)/build; desktop fmt/Clippy/**71** against the rebuilt bundle; packaging
smoke test green.

### The owner acceptance pass (2026-07-21) — four defects, none visible to tests

This is the receipt the section below called "the remaining acceptance step".
The owner drove the packaged app and reported four failures in a row. Every one
of them passed the full suite beforehand, which is the finding worth keeping.

1. **⌘O did nothing.** The menu action was handled only in `DesktopBootstrap`,
   whose listener returns early once the app is `ready` — so the shortcut was
   dead in exactly the state a user is always in. 268 tests passed before and
   after.
2. **Re-opening a registered library did not switch to it.** The pending
   selection was consumed only on remount; it now notifies with a version bump.
3. **A naive lease timestamp was ignored.** `datetime.fromisoformat` on a
   timestamp with no offset returns a naive value, and comparing it to an aware
   `now` raises `TypeError` — which the heartbeat's never-die guard swallowed,
   leaving the library silently held. Missing offsets are now read as UTC.
4. **"Connect to <holder>" stranded the app** at "Cairndex did not respond at
   this address" — activation never called `verifyServer`. Reachability now runs
   before the commit, and a failure restores the previous connection.

Then a fifth report that was **not** a bug: ⌘O on a folder the current server
already served. Reproduced with two real servers on one folder — main mounted it
and took the lease, the sidecar registered the same folder and got `409
library_lease_held`. The lease worked exactly as designed; ⌘O was simply the
wrong action, and because both servers were on the owner's Mac the refusal named
their own machine. Opening a folder the active server already serves now selects
that library in place, keyed by the portable `library_uuid` (registry ids differ
per server), with no sidecar started. A successful open also now names the
library **and** the connection, because "opened on a server you are not looking
at" and "nothing happened" were indistinguishable.

**The pattern across all five: tests that modelled the code instead of exercising
it.** The worst case was the test harness itself — the mocked `useDesktopMenu`
used `??=`, freezing the *first* render's closure, so the handler under test saw
an empty library list while the real ref-based hook sees the current one. Four
increasingly "faithful" integration tests passed against a program that was not
the one shipping. Counting the earlier `beforeBuildCommand` guard and the smoke
test that ran the sidecar without `--watch-parent`, that is at least six
instances in this milestone. The harness now mirrors the hook.

Final gates: web ESLint/Prettier/tsc, **284 Vitest**, Vite build; desktop
fmt/Clippy/**66**; `tauri build` produces a launching `Cairndex.app`.

### Next
Plan 3 **D7 — first public release**. The only true blocker is pinning a static
ffmpeg (ADR-0019 §3); everything else there is pipeline and documentation.

Two gaps carried forward, neither D6-specific:
- **A lease redirect lands on the target server's first library**, not the one
  asked for — library ids are per-registry, so the fix is carrying
  `library_uuid` on the ownership response (plan 3 §7.1).
- **`localStorage` is undefined in this jsdom setup**, so `usePersistentState` is
  inert under test and *every* persisted UI preference is unverified. Pre-existing
  and much wider than D6; worth its own slice.

---

## Historical detail: Plan 3 D6 — local-server sidecar

### Landed: D6.4/D6.5 web layer (three commits)

Built to the reviewed sketch in plan 3 §7.1, in the three slices it specified.

1. **Connections store + activation.** N connections, one active; a pre-D6
   `serverUrl` migrates into the first remote connection. Activation is
   all-or-nothing (fallible steps first, commit last, and a failure re-points the
   media relay at the previous server — the only step with an effect outside
   module state) and serialized (same id joins, different id refused rather than
   queued). `QueryScope` scopes the cache per connection by **remounting**:
   `clear()` alone is insufficient because a query lives in the cache rather than
   the observing component, so an in-flight fetch resolves after the clear and
   repopulates that entry with the old server's answer under an id the new server
   also uses.
2. **"Open Library Folder…"** on ⌘O, ungated so it works from the first-run
   screen with no remote ever configured. Cancel is free: no sidecar start, no
   switch, no local entry. The library to show is handed across the switch
   through an explicit consume-once slot rather than storage — it is a handoff
   across a remount, not persisted state.
3. **Ownership UX** at the mount gate. A live holder is named and redirected to,
   never offered a takeover; stale/unreadable offers a confirmed takeover;
   a running takeover shows indeterminate progress and admits a live holder can
   still win.

Two things found while building, both worth keeping:

- **`localStorage` is undefined in this jsdom setup**, so `usePersistentState`
  is silently inert under test. That is pre-existing and wider than D6 — anything
  relying on persisted UI state is currently unverified.
- **The ownership gate must fail open.** It reads `mountable === false`, not
  `!mountable`: the server's mount gate is the enforcement and this UI is only
  the explanation, so an unparsed response must not hide a working library.
  Caught when unmocked App tests started failing.

Verified: web ESLint, Prettier, tsc, **268 Vitest** (was 229 at D6 start), Vite
build, Playwright browser partition **74**; desktop fmt/Clippy/**66**. Twelve
mutations applied across the three commits, each failing a test.

### The packaged run (2026-07-20)

Built the app with the sidecar staged and exercised it. Two real defects found,
both fixed — which is the point of doing this rather than trusting the mocks.

**1. A fatal abort in the sidecar, from a real crash report.**
`~/Library/Logs/DiagnosticReports/cairndex-sidecar-*.ips` showed `SIGABRT`,
`abort() called`, with the stack `_enter_buffered_busy → _Py_FatalErrorFormat →
abort`. That is CPython's *"could not acquire lock for `<_io.BufferedReader
name='<stdin>'>` at interpreter shutdown, possibly due to daemon threads"*, and
the cause was mine: `watch_parent` blocked a daemon thread inside
`sys.stdin.buffer.read()`, holding the BufferedReader's lock, so an interpreter
finalization from any *other* cause could not close stdin.

Reproduced deterministically as `--watch-parent` + SIGINT. The harm was not
cosmetic: **an abort skips the lifespan shutdown, so the ownership lease is never
released** — leaving exactly the stale lease and takeover prompt the whole design
exists to prevent. Fixed by reading the raw fd (`os.read`), which touches no
Python buffer object and takes no such lock; verified that the lease is now
released on SIGINT, where before it was not.

The smoke test could not have caught it: it ran the sidecar **without**
`--watch-parent` (unlike the shell) and never checked the exit code, so an
aborting process still counted as "stopped". It now runs the binary the way the
shell does and fails on `SIGABRT` or a logged fatal error — verified by mutation.

**2. The `beforeBuildCommand` guard was wired to the wrong path.** It ran
`node ../check-sidecar-staged.mjs`, but the command's working directory is
`apps/desktop`, not `src-tauri` — so it pointed outside the repo and failed
*every* build, including valid ones. My earlier "verification" ran the script
directly rather than through a build, which is the same mistake as testing a
component instead of the integration. Fixed and confirmed both ways: a real build
passes with the bundle staged and fails with the documented message without it.

**Client↔server contract verified against the packaged sidecar.** The web unit
tests mock `fetch`, so a wrong URL or renamed field would pass there and fail
only in a real app. Every URL and field the SPA depends on was driven against the
real binary: `GET …/ownership` returns exactly the declared field set,
`mountable` is a real bool, a live holder reports `fresh` / `can_take_over:
false` / a redirect URL, a loopback holder's URL is suppressed, a stale lease
reports `can_take_over: true`, content routes 409 with `library_lease_held` and
`library_lease_takeover_required`, `POST …/takeover` returns 202 with
`takeover.running` already true, and taking over a live lease is refused with
422. All passed.

*(The two paragraphs below were written on 2026-07-20 and are now answered by the
owner acceptance pass at the top of this file. Kept because what they predicted —
that the untested half was where the defects would be — turned out to be exactly
right, four times over.)*

**Still not verified: the UI itself.** Driving the menu bar and the native folder
picker needs assistive access this environment does not have. Note also that
`open -n` on the build-directory app was intercepted by the single-instance
plugin and focused the owner's already-running `/Applications` copy instead — the
same multi-registrant hazard D5c documented — so no second instance was launched.
The remaining acceptance step is a human: open a folder from the menu, watch the
sidecar start, hit a lease conflict, run a takeover.

**Not yet run end to end.** The Rust talks to a real sidecar in its tests and the
web layer is tested against mocks, but the two halves have never met in a running
packaged app. That owner pass is the remaining acceptance step for D6, and it
wants the ffmpeg manifest pinned first (ADR-0019 §3) — without it a packaged
sidecar falls back to a system ffmpeg, which works on this machine and not on a
user's.



Same branch `feat/library-ownership-lease`. Started 2026-07-20 once both
server-side prerequisites (the lease and §6 hygiene) were in place.

**Owner decisions, 2026-07-20 — see [ADR-0019](adr/0019-open-source-distribution-model.md)
(proposed).** ADR-0018 §5 deliberately left the sidecar's packaging open. It is
settled as **PyInstaller one-dir**, with **bundled static ffmpeg/ffprobe**.

**A first recommendation here was wrong and is corrected.** A staged uv runtime
was recommended over PyInstaller partly on the reasoning that the owner would be
the only person to hit a packaging bug. The owner then said Cairndex is going
open source with **prebuilt binaries published through GitHub Releases**, which
voids that premise: strangers with no toolchain will run these artifacts, so
PyInstaller's smaller, conventional, hermetic output is worth its cost. The
staged-runtime approach was verified working before being set aside (below) and
is recorded in ADR-0019 §2 as the fallback, since the sidecar's contract with the
shell is identical either way.

That correction reaches further than packaging. Three recorded decisions were
justified by "single-owner, built from source, not distributed" and are reopened
in ADR-0019 §4: **Developer ID signing** (the D5c amendment's reasoning is void —
an unsigned DMG makes every downloader click through Gatekeeper), **the
updater** (deferred for a private repo with no releases), and **ffmpeg
licensing** (a static build with libx264 is GPL; Cairndex invokes it via
subprocess, which is the aggregation case, but distributing the binary carries
source-offer obligations). Multi-arch release CI is a fourth. None block D6; all
block the first public release.

### Landed: server groundwork (D6.1)

- **`CAIRNDEX_LOCAL_TOKEN` sidecar mode.** Every API request must carry the
  loopback owner token; `/api/v1/health` stays open so the shell can wait for
  readiness before it has any reason to trust the process it just spawned. A
  loopback port is reachable by any local process, so this is the sidecar's
  access gate. It replaces the ADR-0015 pairing ceremony, which has nobody to
  approve it here.
- **The local token does not satisfy a library passphrase**, unlike a paired
  device token. Pairing is approved from an already-unlocked owner session, so a
  device token means somebody proved access; the local token is minted with no
  ceremony, and treating it as proof would make a locked library openable by
  whatever can read the token. Pinned by a test and by mutation.
- **ffmpeg/ffprobe resolution** moved to `media/tool_paths.py`: explicit setting,
  then `PATH`, then conventional install prefixes. The last step was added after
  confirming the actual failure: ffmpeg lives at `/opt/homebrew/bin` on this
  machine, and a Finder-launched app inherits launchd's `PATH`
  (`/usr/bin:/bin:/usr/sbin:/sbin`), so a spawned sidecar would report "ffmpeg
  not found" on a machine that plainly has it.
- Backend gate green (**559 passed**, +22). No OpenAPI change.

### Measured while choosing (pre-work for D6.2)

The staged-runtime option was tested rather than assumed, which is why ADR-0019
can record it as a real fallback. A copy of uv's `cpython-3.12-macos-aarch64`
tree plus a `uv venv --relocatable` venv, with the real binary-wheel dependencies
(Pillow, pillow-heif) and the `cairndex-server` package installed, was **moved
twice** and then started from the final path. It served `/api/v1/health` 200
without a token, `/api/v1/libraries` 401 without one, and 200 with the owner
token — so relocation and the new sidecar gate both work. Staged size **66 MB**,
the number that argued for PyInstaller once artifacts became downloads.

**One packaging complication found:** Homebrew's `ffmpeg` is a thin
dynamically-linked binary (652 KB) that depends on dozens of dylibs under
`/opt/homebrew`. It cannot simply be copied into a bundle — bundling it means
either a **static** ffmpeg build or rewriting install names for the whole dylib
closure. The static build is the sane path (ADR-0019 §3).

### Landed: sidecar packaging (D6.2)

`apps/server/packaging/` — a PyInstaller one-dir build, a checksum-verified
ffmpeg fetch step, and the smoke test ADR-0019 §2 required. A new `sidecar` CI
job is configured to build and smoke-test it. **That job has never run**: this
branch is unpushed, and CI triggers only on pushes to `main` or on a pull
request, so the three new/changed jobs are verified config, not observed runs.

- **`cairndex.sidecar`** binds its own ephemeral loopback port and prints
  `CAIRNDEX_SIDECAR_PORT=<port>` on stdout. Binding first and announcing second
  removes the race that having the shell pick a free port would leave. It
  refuses to start without `CAIRNDEX_LOCAL_TOKEN` rather than serving an
  unauthenticated API on a port any local process can reach, and handles SIGTERM
  as a graceful stop because that path is what releases ownership leases.
- **`hiddenimports` is empty, and that was measured, not assumed.** The first
  spec listed uvicorn, SQLAlchemy, Pillow and `cairndex` entries with comments
  claiming each was a runtime resolution PyInstaller could not see. Removing each
  group in turn and re-running the smoke test showed **every one was redundant** —
  PyInstaller 6.x ships `hook-PIL.py` and `hook-sqlalchemy.py`, and uvicorn's
  "auto" modules resolve through literal imports static analysis does follow. The
  comment was wrong and is now replaced by the finding. Speculative entries are
  not free: they make a future genuine gap look already handled.
- **The smoke test was strengthened when it failed to bite.** Dropping the Pillow
  hidden imports did not fail it, which showed the coverage proved less than it
  claimed. `pillow_heif` was the one real candidate (`media/previews.py` imports
  it inside a function) and JPEG/PNG never exercise it — so the test now
  generates a **HEIC fixture and renders a preview**. Verified by mutation:
  excluding `pillow_heif` from the bundle now fails with the real error.
- The smoke test drives the *packaged binary over HTTP* through library creation
  (SQLAlchemy's sqlite dialect, FTS5), a scan job, a thumbnail job, the HEIC
  preview, and SIGTERM — then asserts the lease came back with `released_at`.

Verified on the real bundle: **73 MB**, scan and thumbnail jobs succeeded, a
480×360 JPEG thumbnail served, HEIC preview rendered, lease acquired on first
serve and released on SIGTERM with the WAL folded in.

**Not done: the static ffmpeg source is unpinned.** `ffmpeg-manifest.json` ships
empty on purpose — choosing where those binaries come from is a supply-chain and
licensing decision for the owner (ADR-0019 §3), and any practical static build is
GPL. Until it is populated, builds use `--skip-ffmpeg` and the sidecar falls back
to a system ffmpeg via `media/tool_paths.py`. That works on a developer machine
and **not** on a user's, so this blocks a real release, not D6.3.
*(Resolved 2026-07-22 in D7 — see the entry at the top of this file. Both macOS
architectures are pinned; `--skip-ffmpeg` is now the Linux-only path.)*

### Landed: sidecar lifecycle in the shell (D6.3)

`apps/desktop/src-tauri/src/sidecar.rs` — spawn on demand, health-gate, stop with
the app. `tauri.conf.json` stages the bundle as a resource, so `tauri build` now
requires it (CI builds it first).

- **The port comes from the sidecar.** It binds ephemeral loopback and announces
  on stdout; picking a free port in the shell and passing it down would leave a
  window for something else to take it.
- **The token is generated per start and passed in the environment**, not argv,
  because a command line shows up in any process listing — and it is the
  sidecar's only access gate.
- **Shutdown closes stdin rather than sending a signal**, which is the decision
  worth remembering. It needs no target-OS branches (Windows has no SIGTERM, and
  plan 3 §2.1 exists to avoid such branches), and — the real reason — it survives
  the shell not getting to ask. A signal needs a shell alive enough to send it;
  a crash or `kill -9` sends nothing and would orphan a sidecar still holding
  ownership leases, which the user meets as a takeover prompt on their next
  launch. **Verified by SIGKILLing a parent process:** no orphan, and the lease
  came back with `released_at`. That is a strictly better property than the
  SIGTERM approach originally sketched.
- Sidecar shutdown hangs off `RunEvent::Exit`, not `ExitRequested` — the latter
  can be cancelled, and unmounting a library out from under a user who chose to
  stay would be worse than shutting down slightly later.

Verification:

- Desktop `cargo fmt --check`, Clippy `--locked --all-targets -D warnings`, and
  **60 unit tests** (was 55).
- The lifecycle test **spawns the real packaged bundle** — loopback bind, health
  open, 401 anonymous, 200 with the token, and stdin-close shutdown leaving the
  port dead. It skips unless `CAIRNDEX_SIDECAR_BIN` is set, so the desktop
  *tests* stay runnable without Python; CI's macOS job sets it, which is what
  turns it from a no-op into a real check. **Compilation is a different matter —
  see the review round below.**
- A release `tauri build` produced `Cairndex.app` (**88 MB**) with the sidecar at
  `Contents/Resources/cairndex-sidecar/cairndex-sidecar` — exactly where
  `binary_path()` looks — and **the staged copy was launched from inside the
  `.app`** and served health 200 and an authenticated request 200.

Known gaps: no UI consumes the commands yet (D6.4/D6.5), and the app still has
no way to *open a local folder* — that is the next slice. The bundled build
carries no ffmpeg until the manifest is pinned, so a packaged sidecar currently
falls back to a system ffmpeg.

### Review round — a CI break I would have shipped, and a start race

An external review of D6.2/D6.3 found one P1, one P2, and three smaller items.
All confirmed by reproduction before fixing, and all applied.

- **P1 — the desktop crate stopped compiling without the sidecar bundle.**
  `tauri-build` copies `bundle.resources` at *compile* time, not bundle time, so
  the missing path fails `cargo check`, `cargo test`, and `tauri dev` — not just
  `tauri build`, which is all I had claimed. **The Ubuntu "Desktop Rust" job
  would have failed on the first push**, since only the macOS job got a
  build-sidecar step. Reproduced exactly (`resource path … doesn't exist`,
  exit 101). Fixed with an empty-directory placeholder in the Ubuntu job — the
  resource copier skips empty directories, and `binary_path()` still reports
  `not_bundled` at runtime — rather than adding uv and PyInstaller to a job that
  gains no coverage from them. Verified both halves: empty dir compiles and
  passes tests; the real bundle still builds and runs. `development.md` now
  states the compile-time reality with the actual error text.
- **P2 — two concurrent `start_local_server` calls could hand back a dead
  server.** The `info()` check and the insert were not one critical section, so
  both callers could see an empty slot, both spawn, and the second insert
  terminate the first child *after* its caller had already been given that
  sidecar's URL and token. The comment asserting "`start_local_server`
  guarantees the slot is empty" named exactly the guarantee concurrency breaks.
  Not theoretical: React StrictMode double-invoking a mount effect is the normal
  way a UI produces those two calls, and D6.4 is about to add one. Fixed with a
  dedicated `startup` mutex held across check-launch-insert; the fast path in
  the command was *removed*, because checking outside the lock is what created
  the race. A new test runs two threads against the real bundle and asserts both
  get the same server *and* that it is still alive; removing the lock fails it.
- **P3 — `SO_REUSEADDR` on the sidecar's listening socket.** Pointless here (we
  bind `:0` and never rebind a specific port) and actively harmful on Windows,
  where it lets a different socket bind a port already in use and steal
  connections — a hijack primitive against a token-gated loopback server.
  Removed. Worth noting the shutdown design is justified by Windows portability,
  so a Windows-unsafe option had no business sitting next to it.
- **P3 — a non-ASCII bearer produced a 500 instead of a 401.**
  `secrets.compare_digest` raises `TypeError` on non-ASCII *strings*. Now
  compares encoded bytes. The HTTP-level regression test sends the header as raw
  **bytes**, because httpx refuses to encode a non-ASCII `str` header at all —
  a str-typed test would only ever have failed in the client and proved nothing.
- **Nits.** The `CAIRNDEX_SIDECAR_BIN` comment claimed it was "never consulted in
  a packaged app"; it is checked unconditionally, so the comment now says so and
  records why that is acceptable (anyone who can set the app's environment is
  already the user). A configured-but-non-executable ffmpeg path now logs before
  falling through to discovery — silence there would hide a lost execute bit in
  a bundle until it reached a machine with no system ffmpeg.
- **Not taken:** a `WWW-Authenticate` header on the middleware's 401. The
  reviewer marked it take-or-leave; every other error in this API is a bare
  structured body, and diverging for one gate is worse than being consistent.

**Correction to this receipt's own claims**, both flagged by the review: the
sidecar CI job "builds and smoke-tests on every push" was a statement about
config, not an observed run (this branch is unpushed), and "the desktop gates
stay runnable without Python" was true of the test skip but false of
compilation. Both corrected above.

Verification for this round: backend gate green (**561 passed**, +2 non-ASCII
bearer cases); desktop `cargo fmt --check`, Clippy `-D warnings`, and **61 unit
tests** (+1 concurrency), with the real-bundle tests run against a built sidecar.
Mutation-checked: reverting the byte comparison fails both new auth tests, and
removing the startup lock fails the concurrency test.

**Still unrun: CI itself.** Pushing this branch would not help — the workflow
triggers on pushes to `main` and on pull requests, so a feature-branch push
executes nothing. Getting a real verdict on the three new/changed jobs needs a
PR, which is the owner's call.

### Remaining
- Nothing in D6. See the acceptance receipt at the top of this file; the release
  work that D6 surfaced is now plan 3 **D7**.


## Completed: SQLite sync hygiene (ADR-0018 §6)

Same branch `feat/library-ownership-lease`, following the lease slices below.
Closes the last server-side item before plan 3 D6.

Established first, empirically, rather than assumed: a plain `engine.dispose()`
*already* folds the WAL in and removes `-wal`/`-shm`, and a normal interpreter
exit does too because CPython closes the connections during teardown. So the
"clean close" half was mostly working by accident. The two real gaps were that
**library engines were never disposed on shutdown at all** (`main.py` disposed
the worker and HLS sessions but not the per-library engines), and that a *running*
server leaves a live WAL indefinitely — SQLite's automatic checkpoint only fires
around 1000 pages, which a browsing session may not reach, and that is exactly
the state a sync engine uploads.

Implementation:

- **Idle checkpoint.** `persistence/checkpoint.py` plus a `SqliteMaintenance`
  timer thread; a library untouched past a threshold gets
  `wal_checkpoint(TRUNCATE)`. `TRUNCATE` rather than `PASSIVE` on purpose —
  passive leaves the WAL at its high-water mark, so the sync engine keeps
  shipping a large second file carrying nothing.
- **Periodic snapshot** to `.cairndex/library.db.bak` via SQLite's online backup
  API, temp file then rename. The backup API is required, not preferred: a file
  copy taken while a WAL is outstanding silently misses everything the WAL holds.
  A test pins that distinction by mutation.
- **Clean close** now checkpoints and disposes every library engine, ordered
  *before* releasing the leases, so each library is a single consistent file
  before another machine is invited to pick it up.
- Maintenance only touches libraries whose lease we hold — maintaining one we
  lost would be writing into another server's library. The owned set is passed to
  `SqliteMaintenance` as a callable, so `persistence` stays unaware of the
  ownership layer. It runs on its own thread rather than sharing the heartbeat's:
  a slow checkpoint on a sluggish mount must not delay a heartbeat into looking
  stale to other machines.

One defect found by its own test: **the snapshot was dirtying the library it was
protecting.** `with sqlite3.connect(...)` manages the transaction but does not
close the connection, and an open connection to a WAL database leaves a
`-wal`/`-shm` pair behind — so snapshotting recreated the exact torn triple the
module exists to prevent. Fixed with `contextlib.closing`; the file-set assertion
that caught it stays as the regression guard.

Verification:

- Backend gate green: ruff, ruff format, strict mypy, **537 passed** (was 518;
  +19). Four mutations applied, each failing a test: `PASSIVE` instead of
  `TRUNCATE`, a file copy instead of the backup API, ignoring the owned-library
  filter, and dropping the explicit connection close.
- **Live run** against a real server with short intervals: during activity the
  library showed the full `db`/`-wal`/`-shm` triple; after the idle pass the WAL
  was **0 bytes** and `library.db.bak` had appeared; after a clean shutdown the
  marker directory held `library.db` and the snapshot **and no sidecars at all**.
  The snapshot passed `PRAGMA integrity_check` and contained all 20 rows written.
  No errors in the server log; scratch state removed.

Known gaps: unchanged from the lease receipt — no multi-machine or real
SMB/NFS/sync-engine test. Snapshot restore is a manual file copy with no UI or
documented drill beyond the deployment note; worth a follow-up if the heal path
is ever wanted as more than a last resort.

Next recommended task: **Plan 3 D6 — local-server sidecar**. Every server-side
prerequisite is now in place.


## Completed: server-side library ownership lease (ADR-0018 §2–§4)

Branch `feat/library-ownership-lease` from `main` at `4b933f2`. This is build-order
**phase F's first item** and the stated prerequisite for plan 3 D6 — the owner
asked to start D6 on 2026-07-20, and the gate had not landed, so the lease was
built first (owner-chosen, same day).

**Correction to the D5 receipts below: D5a, D5b, and D5c are all merged.** Those
sections still describe the three branches as "stacked and unmerged", which was
true when written; all three are now ancestors of `main`. Verified with
`git merge-base --is-ancestor`.

Implementation:

- **The lease file** (`ownership/lease.py`) at
  `.cairndex/locks/active-owner.json` — inside the library, because the two
  servers in a conflict cannot see each other's registries and a cloud-synced copy
  has no server at all. Written atomically (temp + same-directory rename, fsynced
  before the rename) so a sync engine or a concurrent reader never sees half a
  record. Every write regenerates the `nonce`, heartbeats included; that is what
  makes an overwrite detectable at all.
- **Five states, not four.** Released / own / fresh / stale, plus **unreadable**.
  A lease we cannot parse is deliberately *not* folded into released: "we could
  not find out" must never become "nobody holds it", or a corrupt or
  partially-written file becomes a silent second writer. It routes to the same
  confirmation path as stale, with the holder unknown.
- **Write-then-verify acquisition.** No compare-and-swap exists on a synced
  folder or an SMB share, so a claim is only real once it survives a read-back.
  The uncontended path is an `O_EXCL` create, where exactly one of two racing
  servers can win with no timestamps involved.
- **The observation window is the part that does not trust clocks.** Staleness is
  judged against `heartbeat_at`, written by another machine, so it is only a hint
  — a skewed peer can look dead. Before a stale takeover the server watches the
  lease for longer than a heartbeat period; a live holder writing to the same disk
  (two servers on one NAS export) visibly touches it and keeps the library, even
  though the user already confirmed. Skew the other way — a future-dated heartbeat
  — reads as fresh, erring toward refusing to serve, which is the recoverable
  direction.
- **Takeover always needs confirmation** (owner-ratified). There is no
  auto-takeover after any TTL. Because clean shutdown releases, the prompt is
  reached only after a crash or under sync lag.
- **The heartbeat is the watchdog.** Every interval it re-reads before rewriting.
  A foreign `server_uuid`, *or our own under a nonce we did not write* (a sync
  engine resolving a conflict the other way), means ownership moved: never
  re-grab, stop writing, cancel that library's jobs, unmount. Two servers each
  re-grabbing would be exactly the alternating dual-writer the lease exists to
  prevent. Heartbeats continue while idle, because going quiet would make a
  healthy NAS server's libraries look stealable from every other machine.
- **Reads need the lease too.** Browsing writes (bundle cursors, missing-file
  reconciliation), and reading a SQLite DB another machine is writing through a
  share is what ADR-0008 rejected. No leaseless read-only mount.
- **Both mount gates**, content (`get_library_session`) and streaming
  (`get_library_access`). A byte-range request that skipped the lease would be
  precisely the read the model forbids. A library already held costs one
  dictionary lookup, so the gate adds no filesystem I/O to the request path.
- **Jobs re-verify at start and at every batch boundary.** The heartbeat also
  flags a library's jobs for cancellation, but that needs a registry round trip
  to be noticed; the batch check is in-memory, so a scan stops the moment the
  watchdog knows. `execute_job` uses `ensure_owned`, which acquires a released or
  own lease but never takes a foreign one — a background worker must not make the
  user's takeover decision.
- **Endpoints.** `GET /api/v1/libraries/{id}/ownership` sits outside the mount
  gate on purpose: it is what a client calls *because* a mount was refused.
  `POST .../ownership/takeover` returns 202 and runs the observation window on a
  background thread, since the window outlasts a heartbeat period and no HTTP
  request should be held open for minutes. Taking over a *live* lease is refused
  with 422 rather than forced — "that machine is gone" is not a claim anyone can
  make about a server that heartbeat seconds ago.
- **Sync-conflict artifacts** next to the lease are logged loudly and never
  resolved or deleted; that copy is the only evidence the library may have
  diverged (ADR-0018 §7).
- Persistent `server_uuid` in a new registry `server_identity` table, so a crashed
  server recognizes its own lease instead of prompting on every restart.
- `DomainError`/`ErrorBody` gained optional `details`, serialized with
  `exclude_none` so every existing error's shape is unchanged.

Two defects found and fixed during the work, both in my own code:

- `acquire` originally held the manager's state lock across its sleeps, so a
  two-minute takeover observation would have blocked `holds()` — and therefore
  every request to *every* library — for its full duration. Acquisition is now
  serialized per library, outside the state lock.
- The first observation-window test passed with the observation window deleted:
  it was catching the injected steal via write-then-verify instead. Found by
  mutation testing. The holder now stirs only during the long observation sleep
  and stays quiet through the short verify one, so the test discriminates between
  the two mechanisms it could have been proving.

Verification:

- Backend `ruff check`, `ruff format --check`, `mypy src` (strict), and full
  pytest: **518 passed** (was 497; +66 across three new files —
  `test_ownership_lease.py`, `test_ownership_api.py`, `test_ownership_jobs.py`).
  API tests deliberately run through `isolated_client`, because the shared-session
  `client` fixture overrides the dependency the gate lives in and would bypass the
  thing under test.
- **Mutation-tested rather than assumed.** Seven mutations were applied and each
  one failed a test: treating an unreadable lease as released, skipping the
  observation window, dropping the nonce comparison from the heartbeat, removing
  either mount gate, and removing either job-boundary check.
- OpenAPI and `schema.d.ts` regenerated; the diff is purely additive (two paths,
  three schemas, `ErrorBody.details`).
- Frontend gates re-run after regeneration: ESLint, Prettier, `tsc -b`, Vitest
  (**229 passed**), Vite build.
- **Verified against a real running server**, not only the test harness — an
  isolated `CAIRNDEX_DATA_DIR`, a scratch library, no user media. The full cycle
  was exercised end to end: creating a library wrote no lease; the first content
  request acquired one on disk with the configured machine name and advertised
  URL; planting a live foreign lease was caught by the **real 60 s heartbeat
  thread** (`… now held by the-NAS; surrendering` in the log), after which the
  library refused with `library_lease_held` and the redirect; aging that lease
  past the TTL switched the refusal to `library_lease_takeover_required` with
  `can_take_over: true`; `POST …/takeover` returned **202 immediately** while
  `takeover.running` stayed true, and the lease was acquired **exactly 120 s
  later** (10:15:47 → 10:17:47), matching the observation window rather than
  short-circuiting it; the library then mounted with HTTP 200. Stopping the
  server wrote `released_at`, and a planted Dropbox-style conflict copy was
  detected by name. No errors in the server log; all scratch state removed.

Known gaps, honestly:

- **No multi-machine test was run.** Every conflict scenario is simulated by
  writing a foreign lease into a temp directory from the same process. The logic
  is filesystem-agnostic and driven against real files, but genuine SMB/NFS
  behavior — rename atomicity, `O_EXCL` semantics, directory fsync — and real
  sync-engine conflict artifacts are unexercised. Worth an owner pass with the NAS
  before this is relied on.
- **The heartbeat thread was never observed running.** Tests call
  `heartbeat_once()` directly; the timing loop itself is exercised only by
  `start`/`stop`.
- **ADR-0018 §6 (WAL checkpoint hygiene and the periodic snapshot) is not
  implemented.** It is listed in the ADR's server work but is not part of the
  §3–§4 prerequisite. Cloud-synced libraries therefore still sync a
  `db`/`-wal`/`-shm` triple that can be captured mid-write. This is the next
  recommended slice before D6.
- No frontend work: the SPA does not yet surface the refusal, the redirect, or the
  takeover confirmation. That UI belongs with D6's connections model.

Next recommended task: **ADR-0018 §6 (idle/close WAL checkpointing + snapshot
job)**, then **Plan 3 D6 — local-server sidecar**, whose gate this branch clears.


## Open follow-ups from the D5 owner pass (2026-07-20)

Recorded so they survive the session; none is started.

- **No visualization of background work that this client did not start.** The
  sidebar's `JobProgress` is driven by `activeJob`, which exists only while the
  mutation that launched the job is still polling it. So progress vanishes exactly
  where it matters most: after an app restart or reload mid-job, for a job started
  from another client, and for the `Update` chain's fire-and-forget storyboard
  stage. The server already exposes `GET /api/v1/jobs` with
  `processed`/`total`/`phase`, so a persistent indicator sourced from *that*
  (rather than from local mutation state) would survive reloads, show other
  clients' work, and give the D5b dock badge something meaningful to reflect. Needs
  an idle strategy — poll while work is active, stop when idle — so it does not
  wake the server forever. Owner-reported 2026-07-20.
- **`execute_job` holds the registry session open for the whole job.**
  `apps/server/src/cairndex/jobs/worker.py` wraps the entire handler run in one
  `with registry_factory() as reg:`, so a long job keeps a SQLite connection
  checked out for its full duration — 442 s in the one observed case. That job
  failed with `Cannot operate on a closed database` *after* completing all its work
  (4/4 processed), failing only at commit. The most likely trigger was a
  `uvicorn --reload` restart during active editing rather than a product defect
  (the failure sits ~11 minutes after a commit that morning, and 48 jobs have run
  since with zero failures), but holding a connection across minutes of ffmpeg work
  is fragile on its own and is the same family of problem as the streaming-route
  connection issue. Worth restructuring so the registry session is opened per
  progress write rather than held.
- **Two historical scan failures are already fixed.** The
  `OverflowError: Python int too large to convert to SQLite INTEGER` failures on
  2026-07-10 (09:45 Z, 10:32 Z) came from unsigned 64-bit `st_dev`/`st_ino` on a
  network filesystem. `efa91d0` added `_sqlite_filesystem_identity` at 10:37 Z,
  after both. No scan has failed since. Recorded only so the entries in the job
  history are not re-investigated.


## Completed: Plan 3 D5c — desktop distribution (DMG + env-gated signing docs)

Branch `codex/plan3-d5c-distribution`, stacked on the **unmerged**
`codex/plan3-d5b-deeplinks-notifications` (which is itself stacked on D5a).

The owner settled the distribution question on 2026-07-19, which removed D5c's
only external blocker: **Developer ID signing is no longer a v1 requirement.**
**Superseded 2026-07-20 — see [ADR-0019](adr/0019-open-source-distribution-model.md) §4.**
The reasoning below rests on Cairndex being built from source and not
distributed. The owner has since decided to open source it and publish
prebuilt binaries, so signing is required again; the rest of this receipt
(the DMG target, the env-gated pipeline, the measurements) still stands.
Cairndex is single-owner and built from source, and Apple Silicon ad-hoc signs at
link time, so packaged builds have worked since D1 with no certificate. The
$99/yr Apple Developer Program buys nothing until a build must run on a second
Mac or reach someone else's hands. D5c therefore became docs + config with no
code changes. Recorded as a **plan amendment, not an ADR** — a scope and
distribution-model decision, no architecture change.

Implementation:

- **DMG target.** `bundle.targets` is now `["app", "dmg"]`, so a release build
  produces a drag-to-Applications disk image alongside the `.app`.
- **CI keeps `--bundles app`.** Tauri's DMG bundler drives Finder over AppleScript
  and is a known flake source on headless runners; CI only needs to prove the app
  compiles and bundles, so the config lists both targets and the workflow
  overrides. The reason is recorded inline in `ci.yml` so it is not "simplified"
  away later.
- **Signing pipeline, inert until configured.** `docs/deployment.md` gains the
  full Developer ID + notarization procedure — certificate creation,
  `notarytool store-credentials` (so no secret ever reaches a shell history or
  this repo), signing build, `notarytool submit --wait`, `stapler staple`, and
  verification. It is driven by `APPLE_SIGNING_IDENTITY` / `APPLE_TEAM_ID` / a
  keychain profile name; **unset, the build is exactly today's ad-hoc build**, so
  nothing is re-plumbed when signing is eventually wanted.
- **The docs say plainly that a DMG is not trust.** It is install ergonomics.
  An unsigned DMG on another Mac still needs System Settings → *Open Anyway*, and
  the section says so explicitly so the DMG is not mistaken for a signing
  substitute.

Verification:

- `npm run tauri build` with the signing variables explicitly unset produced both
  bundles: `Cairndex.app` and **`Cairndex_0.1.0_aarch64.dmg` (5.3 MB)**.
- The DMG was mounted and inspected: it contains `Cairndex.app` plus an
  `/Applications` symlink, so drag-to-install works as intended.
- The app inside the DMG reports `Signature=adhoc`, `TeamIdentifier=not set` —
  confirming the documented model rather than assuming it.
- Gatekeeper's verdict was captured rather than asserted: `spctl --assess` on the
  DMG returns `rejected` / `source=no usable signature`. That real output is now
  quoted in `docs/deployment.md`, so the "a DMG is not a signing substitute"
  warning is demonstrated instead of claimed.
- Desktop `cargo fmt --check`, Clippy `--locked --all-targets -D warnings`, and
  **54 unit tests** re-run green; no code changed in this slice.

### Review round — duplicate scheme registration and doc precision

An external review of D5c produced one P3, three documentation nits, and one
optional hardening. All applied.

- **P3 — the DMG introduces a duplicate `cairndex://` registrant, and the hazard
  is already live.** Installing from the DMG leaves two copies of the app: the
  `/Applications` one and the build-directory one, recreated by every build. Both
  claim the scheme, LaunchServices picks by its own heuristics, and `open
  cairndex://…` may cold-launch the stale build-dir copy. The sharper failure is
  the one the reviewer identified: if the intended copy is *running* and a
  different copy is launched for the link, single-instance forwards only **argv**,
  while macOS delivers the URL by **Apple Event** — so the link parks in a process
  that immediately exits and is silently lost.

  Investigating this found something beyond the report: **the DMG build alone
  already creates a second registrant.** `bundle_dmg.sh` stages the app on a
  temporary `/Volumes/dmg.XXXXXX` volume, and that claim survives the volume. On
  this machine, after one DMG build and *no* installation, two paths claimed the
  scheme — the build directory and `/Volumes/dmg.f9FEwK/Cairndex.app`, a mount
  point that no longer exists. This **supersedes the D5b receipt's claim** that
  LaunchServices reported exactly one claimant; that was true when written but is
  not a property the system maintains, and the D5b entry now says so. Documented
  in `docs/deployment.md` with the real inspection command and its actual output,
  plus cleanup steps, and added to the owner checklist as item 5 — deep-link
  testing against the wrong copy proves nothing.
- **Nit — the DMG-signing claim was too confident.** "Tauri signs the app and the
  DMG" was asserted, but whether the bundler codesigns the DMG *container* rather
  than only the app inside is version-dependent and unexercised here. Reworded to
  instruct verifying with `codesign -dv` on first use and signing the container
  manually if it did not, since notarization wants the container signed.
- **Nit — ad-hoc signatures change on every rebuild**, and some macOS privacy
  grants key off the signature rather than the bundle id, so a rebuilt app may
  re-prompt — most likely the local-network prompt Cairndex already triggers.
  Recorded as expected under the ad-hoc model.
- **Nit — `APPLE_TEAM_ID`'s role** is now stated: it is consumed only if Tauri
  performs notarization itself, since the manual `notarytool` keychain profile
  already carries the team id.
- **Optional hardening taken — the deep-link readiness gate is now `isSuccess`,
  not "settled".** On an errored libraries query the old gate enabled delivery
  against an empty list, so a valid `?library=` link flashed "not on this server"
  while the app was already showing a connection failure — a doubly wrong message.
  Classification now only ever runs against a list that actually loaded. Links are
  parked by the shell with a 30 s TTL, so an unreachable server drops the link
  rather than mis-reporting it.

**Correction (owner-reported, same day).** The cleanup procedure first shipped
here did not work, in two ways, and the owner hit both. `lsregister -kill` has
been **removed from macOS** ("dangerous and no longer useful"), so the documented
database rebuild was a no-op; and the `rm -rf` used a repo-relative path with no
stated working directory, so running it from `apps/web` silently deleted nothing.
Determined empirically on macOS 26 that `lsregister -gc` also does not drop these
claims, and that `lsregister -u <path>` is the tool that works — including for
paths on volumes that no longer exist. The docs now use `-u` per path, address the
build bundle through `git rev-parse --show-toplevel` so it cannot resolve
relatively, name both non-working commands so a reader does not retry them, note
that a *mounted* DMG is itself a claimant, and warn that every `tauri build`
recreates and re-registers the build-directory bundle. On the owner's machine five
paths claimed the scheme (an `/Applications` install, the build directory, a
mounted DMG, and two dead scratch mounts); after the corrected procedure, exactly
one does.

Verification for this round: web Prettier, ESLint, `tsc -b`, full Vitest
(**223 passed**, +1 asserting nothing is drained or classified while the libraries
query has not succeeded), the Vite build, and the Playwright browser partition
(**72 passed**). Desktop `cargo fmt --check`, Clippy, and **54 unit tests** re-run
green — no Rust changed. A release `tauri build` again produced both bundles.

Known issues: none specific to D5c. The acceptance criterion was retired with the
§3 requirement — "signed build produced by the documented pipeline" is replaced by
"**DMG produced by the documented pipeline; signing path documented and
env-gated**", both of which are met. The signing procedure itself is **documented
but unexercised**: it cannot be run without an Apple Developer Program membership,
so it stays untested until the owner has a reason to sign. The updater remains
deferred (private repo, no releases, and Tauri's updater would need a token
embedded in the shipped app).

**Plan 3 D5 is now complete (D5a + D5b + D5c).** All three branches are stacked
and unmerged; D5b's owner manual checklist still applies, and D5c adds one item:
open the DMG, drag Cairndex to Applications, and launch it from there.

Next recommended task: **Plan 3 D6 — local-server sidecar** (ADR-0018), which is
gated on the server-side ownership lease landing first; see
`docs/plans/README.md` phase F.


## Completed: Plan 3 D5b — deep links, job notifications, export seam

Branch `codex/plan3-d5b-deeplinks-notifications`, stacked on the **unmerged**
`codex/plan3-d5a-menus-shortcuts` (it builds on that platform seam), from
`4ae7c37`.

Implementation:

- **`cairndex://` deep links.** `cairndex://bundle/<id>` and
  `cairndex://collection/<id>`, with an optional `?library=<id>`; without it the
  target opens in the active library. The OS picks one of two delivery paths and
  they behave differently, which is the whole difficulty: macOS sends an Apple
  Event that can fire **before the webview exists**, so a link that is merely
  emitted is lost — `deeplink.rs` parks it and the SPA drains it through
  `take_pending_deep_link` once listening. Windows/Linux pass the URL in argv, to
  the first process on a cold start and to a second process on a warm one, whose
  argv the single-instance plugin forwards (hence single-instance is registered
  *before* the deep-link plugin). The SPA subscribes **before** draining, so a
  link arriving in between is not lost, and de-duplicates by identity, so a
  cold-start link that also arrives as an event opens once rather than twice.
  **Decision:** a link naming a library this server does not have is reported
  rather than opened in the active library — silently doing the latter could show
  a different bundle than the link meant. Over-deep paths are rejected rather than
  truncated, for the same reason.
- **Job notifications and dock badge.** Rides on the job snapshots the sidebar
  progress bar already polls, so no new polling. **Decision:** the unit is a
  *run*, not a job — `Update library` chains scan → probe → storyboards, so
  per-job notification would fire three times for one user action; a run ends only
  after activity has been absent for a settle window, since that chain briefly
  reports no active job between stages. A notification fires only when the run
  exceeded the length threshold **and** the window is unfocused (announcing a job
  to someone watching its progress bar is noise). Duration uses the server's
  `started_at`, so a run queued behind another job is measured by when it actually
  ran. A cancelled job is a deliberate user action and is not reported as a
  failure. Permission is requested when a run *starts*, so the system prompt
  appears while the user is present and has just asked for the work. The browser
  build stays inert deliberately: a web page prompting for notifications is the
  pattern users distrust.
- **Export save seam (M11 hook only, no export UI).** `save_export_file` takes
  bytes plus a suggested file *name*; the destination comes solely from the native
  save dialog, and any path structure in the suggestion is stripped first —
  mirroring the D3 rule that no client-supplied absolute path is trusted. Sized
  for plan 1 §10's small artifacts (a capped GIF, one contact sheet), not
  streaming media. `canSaveExports` lets M11's dialog choose between a native
  Save As… and an ordinary browser download.

### Review round — capability gap and a cold-start race

An external review found two P1s, both in exactly the places this receipt had
admitted were not runtime-verified. Applied, with the P3s and nits.

- **P1 — the dock badge was capability-blocked and failing silently.**
  `core:window:default` grants only *getter* commands, so `setBadgeCount` needed
  an explicit `core:window:allow-set-badge-count` that the capability file did not
  carry. Every badge call would have been rejected — and `useJobNotifications`
  swallowed the rejection with `.catch(() => undefined)`, so nothing would have
  surfaced. Notifications would have worked; the badge silently would not. Fixed
  by granting the permission **and** by reporting these failures instead of
  discarding them, since the silent catch is the reason a broken badge could have
  shipped at all. Verified against the compiled ACL rather than by inspection: the
  built app's granted set is exactly `core:default`,
  `core:window:allow-destroy`, `core:window:allow-set-badge-count`,
  `store:default`, `notification:default`.
- **P1 — a cold-start link with `?library=` almost always misfired.** The parked
  link is drained within milliseconds of mount, while `useLibraries()` is still in
  flight, so classifying it against an empty list reported every `?library=` link
  as "not on this server" — and the identity de-duplication then guaranteed the
  corrected link was never re-delivered. This broke the headline acceptance path.
  Fixed by gating delivery on the libraries query having settled: `useDeepLink`
  now takes an `enabled` flag and does not subscribe or drain until then. Nothing
  is lost by waiting, because the shell parks links until the SPA drains them —
  the fix falls out of the existing design rather than adding machinery.
- **P3 — a parked link outlived its delivery.** Links were parked unconditionally
  and cleared only by the mount-time drain, so after a warm delivery the copy
  stayed parked; a webview reload would re-open a link clicked hours earlier, its
  SPA-side de-duplication memory gone. Parked links now carry a timestamp and
  expire after 30 s, and a stale drain clears the slot rather than leaving it for
  a later one.
- **P3 — a run in flight was forgotten on Workspace remount.** The hook's state
  lived in refs inside a component keyed on `libraryId`, so switching libraries
  mid-scan — which deep links can now cause — dropped the run and it never
  notified. State moved to module scope (only one Workspace is mounted at a time),
  with a test-only reset mirroring `resetHostPlatformForTests`.
- **Nits.** `deep-link:default` was granted but unused — the SPA consumes links
  through a shell-owned event and command, not the plugin's JS API — so it was
  removed for least privilege. `get_current()` is now drained in `setup` as belt
  and braces, since macOS cold start otherwise rests on the Apple Event arriving
  after `on_open_url` registers. `sanitize_file_name` now also strips the
  Windows-illegal `<>"|?*`.
- **Deferred with a note:** the export seam passes bytes as a JSON number array,
  which is fine for a seam with no callers but would serialize a few-MB GIF into
  tens of MB of JSON. Recorded in plan 1 §10 so M11 moves it to
  `tauri::ipc::Request` before shipping a real export flow. The "run ends just
  before the user refocuses can still notify into a focused window" case is left
  as-is; the away-check at settle time is arguably the correct behavior.

Verification:

- Desktop: `cargo fmt --check`, Clippy `--locked --all-targets -D warnings`,
  **54 unit tests** (was 40; +9 deep-link parsing/argv/park-expiry, +5 export name
  sanitization and artifact write). Release `tauri build` produced `Cairndex.app`,
  and the packaged binary launched under an isolated `HOME` with the deep-link,
  notification, and dialog plugins initialized.
- Web: Prettier, ESLint, `tsc -b`, full Vitest (**222 passed**, was 202; +20
  covering warm/cold deep-link delivery, once-only double delivery,
  subscribe-before-drain ordering, run accumulation across a chained flow with a
  mid-run gap, silence when short or focused, permission timing, failure vs
  cancellation, browser inertness on every new surface, plus the two P1
  regressions — readiness-gated delivery and run survival across a remount), and
  the Vite build.
- Playwright: browser-only partition **72 passed**.
- The built bundle declares `CFBundleURLSchemes ["cairndex"]`, and LaunchServices
  reported exactly one bundle claiming `cairndex:` — ours. **Superseded: see the
  D5c review round.** That was true at the time, but the D5c DMG build later
  proved the single-registrant assumption does not hold in general — the bundler's
  scratch volume leaves a second, permanently dead claimant behind.

Known issues: **the end-to-end "deep link opens the right bundle from a cold
start" acceptance criterion is not machine-verified here.** OS-level routing is
proven (Info.plist + LaunchServices) and the parse/park/drain logic is unit-tested
on both sides, but firing `open cairndex://…` would have launched the packaged app
against the owner's **live server**, which was running on `:8000` during this
session; causing live side effects on the owner's real library to satisfy a test
was not an acceptable trade, so that step is deferred to the owner pass. The
notification and dock badge likewise need a real run to observe. Neither
notifications nor deep links function in `tauri dev` — both require a packaged,
registered app. D5c (signing) remains; the updater stays deferred.

Owner manual checklist for D5a+D5b:

1. Click the green zoom button while a video is fullscreen, and while windowed
   (the D5a P2 path no automated test can reach).
2. With Cairndex closed, run `open "cairndex://bundle/<a real bundle id>"` and
   confirm it launches and opens that bundle; repeat while running.
3. Start an Update on a large library, switch away, and confirm one notification
   and a dock badge appear when it finishes — and that the badge clears on focus.
4. Confirm the Playback menu is enabled for a video bundle and that only
   Previous/Next File are enabled for an image bundle.
5. **Before running item 2, check which copy owns the `cairndex://` scheme.** More
   than one bundle can claim it (an `/Applications` install, the build-directory
   copy, and a dead DMG scratch mount all register), and LaunchServices picks by
   its own heuristics. Deep-link testing against the wrong copy proves nothing —
   and if a *different* copy is launched while the intended one runs, the link is
   silently lost, because single-instance forwards only argv while macOS delivers
   the URL by Apple Event. `docs/deployment.md` has the inspection and cleanup
   commands.

Next recommended task: **Plan 3 D5c — Developer ID signing and notarization
pipeline** (needs the owner's paid Apple Developer Program enrollment; see the
D5a receipt).


## Completed: Plan 3 D5a — menus, shortcuts, window state, viewer fullscreen

Branch `codex/plan3-d5a-menus-shortcuts` from `main` at `736539d`. The owner
split D5 into three slices on 2026-07-19 (D5a menus/shortcuts/window, D5b deep
links/notifications/export seam, D5c signing), **deferred the updater**, and
asked for left-click play/pause. This receipt covers D5a.

Implementation:

- **One keymap table, not two.** `apps/web/src/platform/keymap.json` is the
  single source of truth for the native menu bar. The shell embeds it with
  `include_str!` and *builds* the menu from it (`src-tauri/src/keymap.rs`), so a
  label or accelerator cannot drift between shell and SPA — the usual failure
  mode of a mirrored table is structurally impossible. The SPA reads the same
  file through `platform/keymap.ts`. Enablement groups (`server` / `library` /
  `viewer`) are derived from the table instead of the previous hardcoded id
  lists.
- **Playback menu → open viewer.** A new Playback submenu (play/pause,
  previous/next file, ±10 s, speed, mute, subtitles, snapshot) routes to the
  mounted viewer. `runViewerCommand` is one dispatcher shared by the native menu
  and the key bindings, so the two surfaces cannot diverge; `useViewerMenu`
  enables the group only while a viewer is mounted, so its items are never live
  against a closed viewer. Previous/Next File work without a `PlayerController`
  so image bundles navigate too.
- **Shortcut audit.** ⌘1/⌘2, ⌘N, ⌘[ / ⌘], ⌘= / ⌘−, and ⌘⇧I are marked
  `browserReserved` and work only in the shell. **Decision:** every accelerator
  is modifier-based, enforced by a test — a bare-key accelerator is handled by
  the OS before the webview sees it and would intercept that letter inside every
  text field, which is why the Playback menu does not bind bare Space/K. Bare-key
  viewer bindings stay web-side and behave identically in both hosts.
- **Accelerators only where they add reach (owner, 2026-07-19).** The first cut
  gave all ten Playback items an accelerator; on owner review eight were pure
  duplicates of an existing bare viewer key, for commands reachable only with the
  viewer open, while permanently reserving a global combo each — including ⌘L and
  ⌘T, two combos the shell had just unlocked from the browser. Those eight were
  stripped (⌘K, ⌘J, ⌘L, ⌘T, ⇧⌘M, ⇧⌘P, ⇧⌘, ⇧⌘.), freeing them for future
  library-wide actions. Previous/Next File keep ⌘[ / ⌘] because they are the
  genuine gap: once a video loads the arrow keys become seek, so those two
  commands otherwise have **no** keyboard binding at all. A regression pins the
  rule — any Playback item with a `keys` entry must have a null accelerator.
- **Native viewer fullscreen.** The viewer is already a full-window overlay, so
  the shell toggles the real window instead of the HTML Fullscreen API, which
  WKWebView gates behind user activation a native menu item cannot supply (the
  D1 audit found this). State is tracked from the **window**, not from the
  commands the app issues: a `WindowEvent::Resized` watcher reads the real
  `is_fullscreen()` and broadcasts `cairndex://fullscreen` only when it changed.
  Escape leaves fullscreen before closing the viewer.
- **Window-state edge cases.** Size/position/maximized still persist;
  `FULLSCREEN` and `VISIBLE` are now excluded, because quitting from a fullscreen
  viewer otherwise relaunched into an empty fullscreen window, and a hidden
  window could relaunch with no window at all. The offscreen/monitor-disconnected
  case needed no change: the plugin already declines to restore a position no
  current monitor intersects.
- **Owner request:** left click on the video toggles play/pause; the previous
  right-click play/pause hijack is removed so right click stays available for
  viewer context-menu actions. (No viewer context menu exists yet — this frees
  the gesture rather than adding one.)

### Review round — fullscreen ownership and image-bundle gaps

An external review of the above found one P2 and two P3s, all applied.

- **P2 — the green traffic-light button bypassed the invariant.** The receipt
  claimed "one command owns every transition", but macOS can fullscreen the
  window itself (zoom button, Mission Control) and that path issued no command,
  so `player.fullscreen` went stale: the control showed the wrong icon and Escape
  would close the viewer while the window stayed fullscreen. The claim was simply
  overstated. Fixed by inverting the ownership — the shell now watches
  `WindowEvent::Resized` (which fires across every fullscreen transition), reads
  the window's **actual** state, and broadcasts on change. Tracking the observed
  rather than the assumed state also makes a mid-animation read self-correcting,
  and the de-duplication keeps a live-resize drag silent.
- **P3 — Escape did not leave fullscreen on an image bundle.** The behavior keyed
  off `player?.fullscreen`, and images have no player, so a fullscreen image
  viewer closed and left the workspace window stuck in fullscreen. Fullscreen
  state now comes from viewer-supplied `isFullscreen`/`exitFullscreen` actions
  (the `player` object exists for images; only its use as a *controller* is
  gated), so both media kinds behave the same.
- **P3 — the Playback menu was live-but-dead on image bundles.** All ten items
  were enabled whenever a viewer was mounted, though only Previous/Next File do
  anything without a player. The `viewer` group is now split into `viewer` and
  `viewer-video`, which is the same argument the "never live against a closed
  viewer" rationale already made.
- **P3 — initial-state race.** The initial fullscreen query and the event
  subscription were independent async channels, so a stale initial value could
  overwrite a newer event. Closed with a seen-an-event flag.
- **Nits applied:** the `keys` arrays were documentation only, so a test now walks
  every declared key through `handleViewerShortcut` and asserts it produces the
  same observable calls as `runViewerCommand` — closing the drift hole on the web
  side (verified by mutation: mis-mapping `J` fails it). Explicit accelerators are
  now checked against predefined items' implicit ones (⌘Z/⌘X/⌘C/⌘V/⌘A/⌘M/⌘W). The
  viewer's `toggleFullscreen` uses a new atomic Rust toggle instead of a
  get-then-set across two IPC round trips. `muda` is pinned to `=0.19.3` so it
  cannot drift from the parser Tauri actually registers with. The `StateFlags`
  comment now names `DECORATIONS` too.
- **Not addressed (recorded):** ⌘[ / ⌘] are Option-modified positions on several
  European layouts and may be awkward there — deferred to the per-platform
  bindings pass the plan already anticipates. `shortcutReference()` remains an
  unconsumed export, kept as the seam for a shortcut-reference UI.

Verification:

- Desktop: `cargo fmt --check`, Clippy `--locked --all-targets -D warnings`,
  **40 unit tests** (was 33; +7 keymap: embedded-table parse, accelerator validity
  through muda, accelerator uniqueness, collision with predefined accelerators,
  viewer-key/accelerator overlap, dispatch mapping, split enablement groups).
  Release `npm run tauri build` produced `Cairndex.app`.
- Web: Prettier, ESLint, `tsc -b`, full Vitest (**202 passed**, was 183; +19
  covering keymap/action-type parity, the shared dispatcher, the keys→command
  drift guard, Playback routing, split image/video availability, browser
  inertness, and native-fullscreen Escape on both media kinds), and the production
  Vite build.
- Playwright: browser-only partition **72 passed**, including the rewritten
  click-play case that asserts left click toggles playback and a right click is
  no longer cancelled.
- The packaged binary was launched under an isolated `HOME` and survived, which
  proves the menu is constructed without panicking (the builder panics on a bad
  table); the isolated home was then removed.

Known issues: **the menu bar's rendered contents were not machine-verified.**
`System Events` enumeration needs assistive access this environment does not
have, so the parity table below is derived from the keymap table and the
construction code rather than read off a running menu bar; an owner pass on the
packaged app remains the final acceptance step, as with D1–D4. That pass should
explicitly include **clicking the green zoom button while a video is fullscreen
and while windowed**, since that is the OS-initiated path the P2 fix addresses and
it is the one transition no automated test here can exercise. `muda` was added
as a **test-only** dependency (Tauri does not re-export `Accelerator`) pinned to
`default-features = false`, deliberately dropping its `libxdo`/`gtk` features so
the Ubuntu Rust-only CI job does not start needing `libxdo-dev`. Deep links, job
notifications, the export save-dialog seam, and signing remain in D5b/D5c; the
updater is deferred pending a public release channel.

Next recommended task: **Plan 3 D5b — deep links, job notifications, export
seam**.

## Completed: ADR-0018 — library ownership lease and local-server sidecar

Branch `docs/adr-library-ownership-lease` (documentation only; no code
change). An owner design discussion on 2026-07-19 ratified the
single-server-per-library direction and two conflict-semantics decisions
(stale-lease takeover always requires user confirmation; a server that loses
its lease unmounts the library rather than serving read-only). ADR-0018
records the full design: the `.cairndex/locks/active-owner.json` lease
(three-state classification, write-then-verify acquisition, pre-takeover
observation window, heartbeat watchdog with conflict-artifact scan), the
desktop local-server sidecar for opening local library folders, the
portability invariant (nothing authoritative in `registry.db`), cloud-sync
one-active-machine semantics with WAL checkpoint/snapshot hygiene, and the
accepted partitioned-dual-writer limitation. ADR index and CHANGELOG updated.
The owner ratified the milestone placement, so the roadmap now carries it:
the lease/sidecar work heads build-order phase F in `docs/plans/README.md`
(server-side lease first, then the plan 3 D6 sidecar, ahead of the
write-mode slices — owner-directed: no separate phase), and plan 3 gains
milestone D6 (§8/§10 updated from "noted, not planned"). No gates run
(prose-only change). Landed directly on `main` at the owner's request, and
the owner then marked ADR-0018 **accepted** (2026-07-19). Implementation
work heads phase F: server-side lease first, then the plan 3 D6 sidecar.

## Completed: Plan 3 D4 second review round — drag hardening

Branch `codex/plan3-d4-drag`; tip `329cec1` (docs receipt follows). A second
external review of the D4 hardening produced two unifying data-model changes,
one more P0, and P1/P2 items — all applied.

- **Per-reason skip reporting (change A, findings 1–3, 5).** `resolve_or_stage_paths`
  now *skips* a confirmed-bundle member instead of raising mid-loop (a folder of
  partly-organized media still adds the rest), and the single skip counter is
  split into `skipped_non_media` / `skipped_missing` / `skipped_already_bundled`
  (plus a derived `files_skipped` total) so a missing movie is no longer reported
  as non-media. The additive fields flow through the result/schema (OpenAPI +
  `schema.d.ts` regenerated) into a per-reason dialog note guarded with `> 0`
  (a partial payload can't render "undefined skipped"); the e2e apply fixtures
  carry them. **Decision:** counts only, no per-reason path lists (leaner
  response). The Create preview applies the same `classify()` filter as apply, so
  it can't propose a file apply would skip; an all-non-media selection previews
  empty and the dialog explains it and disables submit.
- **Categorized reverse-map (change B, findings 6, 8).** `reverse_map_paths`
  returns `{inside, outside, directories}`: `outside` echoes the dropped absolute
  paths (the caller's own strings — no new leak), so the W5 seam receives exactly
  the outside subset it would copy without re-running reverse-map, and an
  in-library folder gets its own "folders can't be dragged in yet" message rather
  than the misleading "move it into the library" one.
- **Self-drop guard (P0-4, finding 4).** Each drag is tagged with an id echoed in
  the ended event; the guard (a testable `dragGuard` module living on the runtime,
  so `resetHostPlatformForTests` drops it) clears only the current drag's id via
  `listen`+unlisten, with a ~300 ms grace, a drop-lands-on-us belt, and a
  last-resort timeout. `handleFileDrop`'s block reason is `'modal' | 'self-drag' |
  null`; a self-drag is a silent ignore, not the "close the dialog" flash.
- **Popover/menu drop hole (P1-6, finding 6).** `isBlockingSurfaceOpen` also
  matches an open context menu (`role="menu"`) and toolbar popovers
  (`.picker__panel`).
- **P2.** `selectionTargets` now also covers the collection context menu and the
  bundle-drag handler; a co-located `isMultiSelection` replaces the two `.size > 1`
  render guards; the `resolve_file_in_root` passthrough is gone
  (`resolve_within_verified_root` is `pub(crate)`).

Verification at `329cec1`: desktop `cargo fmt --check`, Clippy `-D warnings`,
**33 unit tests** (categorized reverse-map + echoed-absolutes cases); backend
Ruff, `ruff format --check`, mypy, full pytest (**452 passed**, +confirmed-skip,
per-reason, and preview==apply cases); web Prettier, ESLint, `tsc -b`, full
Vitest (**183 passed**, +dragGuard id/grace/timeout, categorized routing,
self-drag, empty-preview, isMultiSelection cases), the Vite build, and the
browser-only Playwright partition (**72 passed**, with the suggest-bundle fixture
made realistic). Release `tauri build` produced `Cairndex.app`. The native drag
gesture itself still needs the owner's manual pass on a packaged build.

## Completed: Plan 3 D4 review pass — drag hardening

Branch `codex/plan3-d4-drag` continues below the D4 receipt; tips `6757b4a`
(the fixes) then `e1f14c5` (a guard self-clearing follow-up and a comment). An
external code review of D4 produced three P0s, seven P1s, and two P2 cleanups —
all applied. (The gate counts below are from the `6757b4a` full-suite run; the
`e1f14c5` follow-up re-ran only the platform Vitest. A second review round then
carried this further — see the round-2 receipt above.)

- **Drag-in batch tolerance (P0-1).** A dropped directory or a non-media sidecar
  no longer poisons the fast-add batch. `relative_within_root` maps only regular
  files (directories count outside), and the server's `resolve_or_stage_paths`
  now skips and *reports* non-linkable paths instead of raising. The additive
  `files_skipped` flows through `ManualBundleResult` /`ManualBundleResultRead`
  (OpenAPI + `schema.d.ts` regenerated) into every manual-bundling success
  message; an all-non-media selection fails with a clear "not linkable media"
  message. **Decision:** classification stays server-side (single source of
  truth) rather than duplicating the extension list into Rust/web.
- **Drop gating (P0-3, P1-4, P1-8).** The drop hook ignores drops while any
  modal/viewer is open (detected via `aria-modal`, so Settings and both viewers
  are covered without threading their state), while the app's own drag-out is in
  flight (the shell emits `cairndex://drag-out-ended`; the SPA guards from invoke
  until then), and while the mapping is still resolving (tri-state defers instead
  of mis-reporting unmapped). The W5 seam (P1-6) is offered the un-addable
  remainder of *every* drop, mixed or all-outside.
- **List-layout marquee (P0-2).** A File Browser list row is a drag-out source
  only once selected, so a press-drag on an unselected row still starts the
  rubber-band marquee; grid cards are unaffected.
- **Drag-out internals (P1-5/7/9/10, P2).** A bundle drag validates each
  library's mount once (not per file); `start_file_drag` awaits its main-thread
  result over an async mpsc rather than blocking a worker; drag failures carry
  `drag_action_failed` / `no_draggable_files` instead of the reveal/open text; a
  file-less bundle cover is inert; and a shared `selectionTargets` helper replaces
  the hand-rolled selection rule in the file browser, opened album, and bundle
  context menu (the remaining sites — collection menu, bundle-drag, multi-select
  render guards — were finished in the round-2 pass above).

Verification: desktop `cargo fmt`, Clippy `-D warnings`, **33 unit tests**
(+ reverse-map directory + verified-root cases); backend Ruff, mypy, full pytest
(**450 passed**, +3 skip-tolerance cases); web Prettier, ESLint, `tsc -b`, full
Vitest (**170 passed**, +blocked/pending/mixed-seam/self-drop/list-selection/
selectionTargets cases), the Vite build, and the browser-only Playwright
partition (**72 passed**). Release `tauri build` produced `Cairndex.app`. The
native drag gesture itself still needs the owner's manual pass on a packaged
build (unchanged from the D4 receipt below).

## Completed: Plan 3 D4 — drag-out to Finder plus drag-in reverse-mapping

Branch `codex/plan3-d4-drag` from `main` at `8ca5547`; tip `91f1921`. Delivers
plan 3 §6 on top of the D3 mapping/validation boundary.

Implementation:

- **Drag-out.** A mapped desktop library can drag its real files out to Finder
  and other apps from the File Browser cards/rows, the opened bundle album tiles,
  the File inspector, and the bundle inspector — whose cover drags the whole
  bundle (all its files) and whose "Files in bundle" rows each drag that file.
  A shared `fileDragProps` helper resolves the selection-aware, library-relative
  paths lazily at drag time, hands them to the `start_file_drag` Rust command,
  and cancels the browser's own HTML5 drag so only the OS drag runs. The command
  resolves + validates each `{library_id, relative_path}` through `mappings.rs`
  off the IPC thread (skipping any missing member so a partially-available bundle
  still drags the rest), then starts the native drag on the main thread. Bundle
  grid cards keep their existing in-window reorder / move-to-collection drag and
  are deliberately not drag-out sources; existing marquee selection already tears
  down on `dragstart`, so the new draggable rows/cards coexist unchanged.
- **Drag-out engine.** The shell depends on the cross-platform `drag` crate
  (2.1.1) directly rather than `tauri-plugin-drag`, because the plugin's only
  surface is a JS command that takes absolute paths — which would break the §5
  rule that the web layer passes only ids + relative paths. `dragout.rs` mirrors
  the plugin's `run_on_main_thread` + GTK/raw-window-handle `#[cfg]` edge in one
  clearly-named module (§2.1). `§10`'s NSDraggingSession fallback still applies
  if the crate ever stalls.
- **Drag-in.** Tauri's `dragDropEnabled` webview event delivers dropped absolute
  paths; `reverse_map_paths` canonicalizes each against the active library's
  identity-verified root and returns the in-library relative paths plus an
  outside count (no absolute path returns to the web). `handleFileDrop` routes
  in-library files into the existing Create Bundle fast-add flow, tells an
  unmapped library to locate itself, and explains in-place linking for outside
  files. Its `onCopyIntoLibrary` hook is the explicit seam where plan 4 W5's
  copy-into-library flow attaches without reworking the drop handler.
- The `HostPlatform` seam gains `canDragOutFiles` (true on desktop), and the
  runtime gains `reverseMapPaths` + a `listenFileDrop` subscription; plain web
  and unmapped libraries keep every drag capability inert.

Verification (temporary scratch dirs only; no user media):

- Desktop: `cargo fmt --check`, Clippy `-D warnings`, and **31 unit tests** (was
  23; +8 reverse-map cases covering exact-case preservation, a macOS
  case-insensitive alias, a symlink escape counted outside, a symlink-into-root
  mapped to its real relative path, a trailing-slash directory drop, the root
  itself, and a mixed inside/outside/missing/relative partition). Release
  `npm run tauri build` produced `Cairndex.app` with `drag v2.1.1` linked.
- Web: Prettier, ESLint, `tsc -b`, full Vitest (**163 passed**, +13: platform
  drag surface, `fileDragProps`, `handleFileDrop`, FileInspector drag-out), and
  the production Vite build. The desktop-only runtime chunk grew (~5.9 kB gzip);
  the browser entry keeps the same lazy split.
- Playwright: the browser-only partition (`test:e2e:frontend`) ran **72 passed**.
  The `@fullstack` partition (Python backend + ffmpeg) was not run this session;
  CI covers it and no browser-visible flow changed (all drag surfaces are inert
  on the web platform, so the suite exercises them as no-ops).

Known issues: the **native drag gesture itself was not exercised** here — macOS
NSDraggingSession drag-out and Finder drag-in cannot be scripted in this
environment, and there was no packaged live run. The path-resolution and
reverse-mapping logic is unit-tested with real temp files and symlinks, and the
packaged app compiles the actual `drag` integration, but a manual owner pass on
a real build (and on an SMB-mounted library) remains the final acceptance step,
as with D1–D3. Drag-out starts the native session after an off-thread
canonicalize; on a healthy local/mounted volume that is sub-millisecond, but a
very slow mount adds latency before the OS drag attaches. Bundle grid cards do
not offer drag-out (they own the in-window collection/reorder drag); the bundle
inspector cover and album cover that goal instead.

Next recommended task: **Plan 3 D5 — shell polish** (menu/shortcut audit, window
state, deep links, job notifications, native save dialog for media exports,
updater + signing).

## Completed: Plan 3 D3 review pass — handoff hardening and seam cleanup

Branch `codex/plan3-d3-path-mappings` (continues below the D3 receipt); an
eight-angle code review of D3 produced one confirmed defect, two accepted
hardening/UX findings, and seven cleanup findings. Applied:

- **Async host commands.** `reveal_file`, `open_file`, and the mapping store
  commands were synchronous Tauri commands, which execute on the webview IPC
  (main) thread; their `fs::canonicalize` against an offline SMB mount could
  freeze the whole UI for the mount timeout. All now run the mount-touching
  work via `async_runtime::spawn_blocking`.
- **Identity re-proof at handoff.** Mappings persist the manifest UUID proven
  at locate time, and every reveal/open re-reads `.cairndex/manifest.json`
  under the mapped root and requires a match (`library_mismatch` otherwise),
  closing the remounted-different-volume window. Pre-release root-only mapping
  entries deserialize as unmapped and need one re-locate.
- **One mapping source of truth.** Workspace mapped-state and the Settings
  Libraries page now share react-query entries keyed
  `['library-mapping', libraryId]`; the `mappingRevision` counter and
  `onMappingChanged` threading are gone. A shared `hostFileMenuEntries`
  helper builds the Open/Reveal menu pair for all three context-menu
  surfaces. `hostOperationErrorMessage` maps the shell's structured error
  codes to web-owned copy (plan 3 §2.1). Host-action tests pin labels to
  `hostLabelsFor('macos')` and share one `FileBrowserEntry` fixture.

Verification: desktop `cargo fmt --check`, Clippy `-D warnings`, and **23
unit tests** (adds a swapped-library handoff rejection); web Prettier,
ESLint, `tsc -b`, and full Vitest (**150 passed**). `tauri build` and
Playwright were not re-run this session; the prior D3 receipt covers them and
no bundling or browser-visible flow changed beyond the refactors above.

Known deferred finding: the bundle-card context menu offers host actions only
when `resume_relative_path` is set, so audio-only/document/non-preview
bundles expose none there (the opened Bundle Album still offers per-file
actions). A proper fix wants a server-side always-present primary-file field
— decide alongside D4 drag-out, which needs the same "bundle → files on
disk" resolution.

## Completed: Plan 3 D3 — library mappings plus reveal/open

Branch `codex/plan3-d3-path-mappings` from `main` at `da92096`.

Implementation:

- Desktop Settings now has a Libraries page. **Locate on This Mac** opens a
  native folder picker; Rust canonicalizes the selection, reads
  `.cairndex/manifest.json`, requires its portable `library_uuid` to match the
  selected server library, and stores the canonical root by server registry id
  in shell-local configuration. Cancel is a no-op, and Remove changes only the
  local mapping.
- The Rust mapping boundary rejects missing library ids plus empty, absolute,
  current-directory, and parent-traversal relative paths. It canonicalizes the
  root and target, requires the root to be a directory, the target to exist, and
  the target to remain under the root after symlink resolution. An unavailable
  root returns the structured `volume_not_mounted` rejection. Error messages do
  not expose local paths.
- Only after validation does the shell call the cross-platform Tauri opener
  plugin to reveal the file in its directory or open it with the default app.
  No server endpoint or arbitrary command-execution surface was added.
- The File Browser file context menu, Bundle Album file context menu, current
  bundle context menu, and FileInspector expose the D2 per-OS host labels only
  when the active desktop library has a local mapping. Browser mode and unmapped
  libraries expose no host actions. Calls carry only the server registry id and
  a server-provided library-relative path; the native picker is the sole source
  of an absolute root.
- README, architecture, development, deployment, plan 3, changelog, and this
  status receipt now document the D3 behavior and safety boundary.

Automated verification:

- Frontend: Prettier, ESLint, TypeScript, full Vitest (**150 passed**), and the
  production Vite build.
- Playwright: full browser regression suite (**75 passed**).
- Desktop: Rust format, Clippy with warnings denied, and **22 unit tests** after
  adding manifest, registry-id, traversal, absolute/empty path, symlink escape,
  missing-mount, and missing-target coverage. Release `tauri build` produced
  `Cairndex.app`.

Known issues: this checkout had no disposable live SMB mount, so Finder/default-
app behavior on an actual SMB volume was not manually exercised. The filesystem
logic is mount-type agnostic and tested with real temporary files and symlinks;
the packaged shell compiles the actual dialog/opener integrations. The existing
Tauri bundle-identifier and Vite large-chunk warnings remain unchanged.

Next recommended task: **Plan 3 D4 — drag-out / drag-in**.

## Completed: Plan 3 D2 — platform seam + desktop pairing auth

Branch `feat/desktop-platform-auth` from `main` at `9ccc34b`. The first D2
completion receipt was invalidated after review found a cross-library auth
correctness gap and an under-specified relay security boundary. The correction
keeps the accepted ADR-0015 fail-closed bearer behavior and fixes the desktop
caller rather than weakening server authorization.

Corrected implementation:

- Pair approval now returns the granted library ids with the one-time token.
  Desktop persists that complete server-bound grant and sends the bearer only
  to URLs under an approved library id. Global and out-of-scope library requests
  remain anonymous, so an unprotected library retains browser-equivalent access.
  Older token records without explicit scope are ignored and require re-pairing.
- Library auth status is an explicit mount gate. A pending check shows a loading
  state; an error fails closed with retry/Settings recovery instead of mounting a
  query storm. An unscoped protected desktop library offers pairing rather than
  the browser-only passphrase form. Settings can forget the local grant so a
  revoked or incorrectly scoped device has a recovery path.
- The unused HostKeymap surface was removed until D5 has a real consumer. The
  exact OS-neutral `HostPlatform` seam, consolidated desktop detection, lazy
  runtime loading, and unchanged browser-mode URL/fetch behavior remain intact.
- Proposed ADR-0017 records the loopback media relay as infrastructure. A Tauri
  custom URI protocol was considered but rejected for D2 because Tauri 2.11's
  asynchronous responder requires an owned full response body, which would
  buffer multi-gigabyte ranges instead of streaming them.
- The relay now accepts only `GET`/`HEAD` for an allowlist of scoped media routes,
  fixes the upstream origin/base, disables redirects, allows only exact packaged
  and development shell origins, rotates its 256-bit route on reconfiguration,
  strips credentials and unsafe response headers, bounds connection and stalled
  body reads, and preserves known `206` lengths. Eight workers plus a bounded
  queue retain concurrent subtitle/thumbnail/progress service during a stream;
  startup failure returns a clean application error instead of panicking.
- OpenAPI and `schema.d.ts` were actually regenerated. The generated client now
  includes the auth-status `Authorization` header and pairing `library_ids`.
  README, architecture, development, deployment, desktop operation, plan, ADR
  index, changelog, and this status receipt describe the corrected boundary.

Automated verification after correction:

- Backend: Ruff check/format, mypy, and full pytest (**447 passed**).
- Frontend: Prettier, ESLint, TypeScript, full Vitest (**142 passed**), and the
  production Vite build.
- Playwright: full suite (**75 passed**), including real-backend device pairing
  and media fixtures. Existing hermetic scenarios now declare auth status
  explicitly so the production fail-closed gate is exercised honestly.
- Desktop: Rust format, Clippy with warnings denied, and **12 unit tests**. Relay
  coverage includes a 64 KiB `206` with `Content-Length`, stalled-body timeout,
  concurrent open stream, origin/method/route/scope denial, secret rotation, and
  redirect rejection. Final `tauri build` produced `Cairndex.app`.

Native packaged-app acceptance after correction (generated fixtures only; no
user media):

- An isolated server exposed three scratch libraries: one protected library in
  the device grant, one unprotected library outside it, and one protected
  library outside it. Before pairing, the protected out-of-scope library showed
  the pairing-only state with no passphrase input. After approval for only the
  first library, it explicitly offered re-pairing for the missing scope.
- The final packaged app mounted the scoped protected library and played an
  ffmpeg-generated 18 MB, 20-second H.264 MP4 from 0:00 through completion.
  Server logs recorded two authenticated `206 Partial Content` responses and
  typed progress `PUT 200` writes. Together with the 64 KiB framing regression,
  this proves the final known-length range response works in WKWebView.
- With that same stored token, switching to the unprotected out-of-scope library
  mounted its workspace without an auth error and played its generated five-
  second MP4 to completion. Its anonymous API and media requests returned 200/
  206; an incorrectly attached scoped bearer would have failed closed with 403.
  The app/server were stopped and all synthetic state was removed afterward.

The owner-supplied external medium review verified all 13 original findings: 12
were fully resolved and one re-pair state was initially only cosmetically
mitigated. Its follow-up found that desktop `pagehide` still sent the HLS teardown
POST into the now-read-only relay, leaving sessions to the idle reaper. D2 now
registers an awaitable desktop exit task that sends the ordinary authenticated
DELETE through `hostFetch`; web retains the POST beacon. Targeted tests prove
desktop exit waits for DELETE and emits no beacon, web still emits the beacon,
and a failed re-pair keeps the valid paired notice visible. No external review
findings remain open.

Known issues: ADR-0017 remains proposed pending owner review. The device token
remains plaintext in the Tauri store as specified by D2; server-side revocation
remains in the same-origin owner Devices UI. HLS, subtitle, storyboard, and
thumbnail routes have automated rather than separate native fixtures. Path
mappings, reveal/open, drag-out/in, deep links, updater/signing, and Linux/Arch
packaging remain in D3–D5. Tauri still warns about the owner-required
`dev.cairndex.app` identifier suffix.

Next recommended task: **Plan 3 D3 — library path mappings plus reveal/open**.

## Completed: Plan 3 D1 — Tauri 2 shell bootstrap

Branch `feat/desktop-shell` from `origin/main` at `766709b`; reviewed and tested
implementation tip `66ac9f8`; first fully green PR #15 tip `76eff40`.

Completed:

- `apps/desktop` is a Tauri 2 shell with bundle id `dev.cairndex.app`. Its
  `build.devUrl` and `frontendDist` use `apps/web` directly, so development and
  release builds have no desktop SPA fork. First run validates and probes a
  server URL before persisting it through the Tauri store plugin.
- The cross-platform single-instance and window-state plugins are registered in
  Rust. App/File/Edit/View/Window/Help menus map to the SPA's existing Settings,
  Pair Device, New Bundle, Bundles/Files, zoom, and pane handlers. Native Toggle
  Full Screen toggles the Tauri window directly, avoiding the HTML Fullscreen
  API's user-activation requirement. Workspace-only actions are disabled when
  no unlocked workspace is mounted; pane visibility persists with the other
  browse preferences, and explicit grid-column placement keeps the content pane
  full-width when the sidebar is hidden across a restart. Settings and Pair
  Device opened from the native menu still render over a locked-library screen
  instead of being swallowed by that early-return state. During first-run or an
  unreachable server, Settings selects the editable server URL while Pair Device
  stays disabled until bootstrap verifies the Cairndex health capabilities.
- Window close, Cmd+Q, application-menu Quit, and OS-level exit share one native
  shutdown handshake through the Rust `ExitGate`: the SPA awaits its ordinary
  typed JSON progress PUT, dispatches `pagehide` for synchronous persisted UI
  state, and explicitly completes exit, with a five-second native fallback.
  Browser mode retains the original same-origin typed JSON progress beacon; no
  hand-written Origin check sits behind reverse proxies.
- Desktop API and media paths resolve against the configured server, including
  manifest streams, storyboards, subtitles, HLS playlists, thumbnails, and
  progress/session beacons. Browser mode retains its relative same-origin URLs.
  FastAPI allows packaged Tauri origins by default, removes cross-origin cookie
  credentials, and denies the Vite development origin unless the owner sets
  `CAIRNDEX_CORS_EXTRA_ORIGINS=http://127.0.0.1:5173` explicitly. The macOS
  bundle declares local-network use and opts only webview content into cleartext
  HTTP so an explicitly configured private LAN server works outside localhost.
- Browser builds detect `window.__TAURI_INTERNALS__` before dynamically importing
  the desktop bootstrap/runtime. The final browser entry is **500.89 kB / 145.69
  kB gzip** (versus the reviewed eager D1 build's 519.00/150.41); desktop-only
  bootstrap and runtime code are separate **1.51 kB** and **4.44 kB gzip** chunks.
- Cross-platform posture is enforced from D1: no AppKit/`NSWorkspace` calls,
  no target-OS conditional application code, and only portable Tauri APIs/plugins.
  The only macOS-specific addition is declarative bundle metadata for ATS/local
  network permission. CI has cached macOS Rust/build and Ubuntu Rust-only jobs.
  `AGENTS.md`, architecture, deployment/development docs, README, the checked D1
  milestone row, and CHANGELOG reflect the package, gates, and remaining
  authentication boundary.

Native WKWebView audit (ffmpeg-generated 65-second H.264/AAC fixture only):

- The first-run screen connected to an isolated FastAPI server, the server URL
  survived a full `Cmd+Q` restart, a resized window reopened at its saved size,
  a second launch focused the single existing instance, and native File/App menu
  items opened the existing New Bundle and Settings dialogs.
- M12 hover autoplay advanced visibly from **0:01 to 0:09** without a play
  gesture. The real player opened already playing and advanced normally. Its
  in-app Fullscreen control expanded the video stage, and the native View →
  Toggle Full Screen item independently entered and exited macOS fullscreen.
- The initial native close audit exposed that WKWebView destruction did not fire
  `pagehide` early enough, and the initial Cmd+Q path bypassed window-close
  handling. A later gap sweep found window close still bypassed the new
  `ExitGate` and the progress-beacon workaround broke reverse-proxy browser
  deployments. The final packaged regression audit played a fresh isolated
  ffmpeg fixture through both Cmd+Q and the red window-close button; each path
  ended with a typed progress **PUT 200**, exited, and relaunch resumed at 0:12.
- The same packaged audit hid the sidebar, confirmed the center pane retained
  its full usable width, closed through the native window button, and relaunched
  with the hidden state preserved and the content pane still visible.
- `tauri dev` started the shared Vite server and debug binary, then the isolated
  backend logged health, library, browse, and thumbnail requests from the stored
  server configuration. The packaged release `.app` and browser-mode Vite host
  were also inspected directly; both rendered the same workspace.
- After the final review, the rebuilt packaged app used an isolated temporary
  home and connected to the same synthetic library through the Mac's non-loopback
  LAN address on port 8011 rather than a localhost exemption. Bootstrap Settings
  selected the URL, Pair Device changed from disabled to enabled only after
  connection, and a playing Cmd+Q exit ended with a typed progress **PUT 200**
  over the LAN path. The owner's stored `http://127.0.0.1:8000` setting was never
  changed.

Verification (temporary databases/libraries only; no user, Demo, or Eagle media):

- Backend: Ruff check/format, mypy, and full pytest (**445 passed**).
- Frontend: Prettier, ESLint, TypeScript, full Vitest (**129 passed**),
  and the production Vite build.
- Playwright: full suite run unpiped exited 0 (**75 passed**); the known
  pre-existing real-backend flake did not reproduce in this run.
- Desktop: Rust format, Clippy with warnings denied, and **4 unit tests** passed;
  release `tauri build` produced `Cairndex.app`.
- PR #15 ran all six CI jobs green on `76eff40`: macOS desktop Clippy/tests/build
  (**11m54s**), Ubuntu desktop Clippy/tests (**6m30s**), backend, frontend,
  full-stack real-backend e2e, and Docker. The final documentation-only receipt
  commit is required to repeat that same CI set before merge.
- The required final `/code-review medium` found one actionable P2: any HTTP 200
  JSON response could previously pass bootstrap and hide the only server editor.
  Bootstrap now requires healthy identity fields plus D1's pairing/progress
  capabilities, and a regression proves an incompatible endpoint is neither
  persisted nor allowed to mount the SPA. Earlier ATS/local-network,
  locked-settings, hidden-sidebar, and reverse-proxy findings remain fixed.
- The progress-beacon POST contract remains the typed `PlaybackProgressUpdate`
  JSON model. `openapi.json` and `schema.d.ts` were regenerated and committed.

Known issues: Tauri warns that the explicitly required identifier
`dev.cairndex.app` ends in `.app`, which can be confused with the macOS bundle
extension; the owner-specified identifier is retained. D1 stores only the
server URL and sends neither cookie credentials nor bearer tokens. A protected
library therefore cannot be unlocked in the shell, and Pair Device can approve
only unprotected library scopes; use the same-origin web app for protected
administration until D2 wires device-token authentication. Path mappings,
reveal/open, drag-out/in, deep links, updater/signing, and Linux/Arch packaging
remain in their planned D2–D5 slices. The five-second shutdown watchdog prevents
a hung server from blocking quit indefinitely but can still drop the final
progress write when a server round-trip exceeds that bound; the audit covered a
responsive LAN path, not a deliberately stalled NAS/VPN path.

Next recommended task: **Plan 3 D2 — platform seam + desktop device-token auth**.

## In review: Plan 2 T0 — device pairing and scoped bearer tokens

Branch `feat/device-pairing` (off `main` at `776e0d7`, after M12 merged as
#12). Implementation commits: `6e4cf5e` (`feat: add device pairing and bearer
auth`), `cfc754f` (`feat: add Settings Devices page`), and tested implementation
tip `d07ed2d` (`fix: block offline library pairing bypass`). Review hardening and
its final full-gate evidence are recorded in `93edc04` (`fix: harden device
pairing review findings`).

Completed:

- Anonymous `POST /api/v1/auth/pair/start` creates a bounded ten-minute pairing
  request with a six-character unambiguous code and a high-entropy poll key.
  The in-process store keeps only digests, caps outstanding requests at 16 and
  three per source, rejects capacity with structured 429 without evicting
  another device, and returns the same `pending` poll shape for unknown,
  expired, unapproved, consuming, and already-consumed requests.
- An ADR-0010-authorized browser session approves explicit library ids through
  `pair/approve`; every selected protected library must be unlocked in that
  cookie session. The first approved `pair/poll` creates a 256-bit
  `cdx_<device-id>.<secret>` bearer token, persists only its salted hash in the
  additive registry `device_tokens` table, returns plaintext once, then removes
  the request. The registry row records name, immutable library scope,
  creation/last-used timestamps, and revocation without portable-library schema
  changes.
  Unavailable libraries cannot be approved while their manifest is unreadable,
  preventing an offline-mount passphrase bypass without blocking emergency
  revocation of other devices.
- Review hardening treats existing but unreadable/corrupt manifests as protected,
  lets unrelated authorization schemes continue through the cookie path, and
  centralizes the protected-and-not-unlocked rule. Unavailable libraries still
  cannot be approved but no longer lock the owner out of listing or revoking a
  leaked device. Setting or replacing a passphrase revokes all live tokens
  scoped to that library, so an anonymously minted token cannot survive the
  transition to protected content.
- `get_library_session` and the cancellation-safe `LibraryAccess` streaming
  gate accept `Authorization: Bearer` alongside the existing cookie. Explicit
  invalid/revoked bearer credentials return structured 401; valid out-of-scope
  credentials return structured 403. Passphrase-less libraries remain
  anonymous when no bearer header is supplied. `last_used_at` writes at most
  once per minute and the streaming gate closes the registry session before
  returning bytes.
- Settings now has a Devices page for code approval with multi-library
  selection, created/last-used/scope audit details, and immediate revocation.
  A real-browser test drives start/poll from the simulated device side, approves
  in the web UI, sees the issued device, revokes it, and verifies the bearer is
  rejected by the real backend.
  The form excludes unavailable active/scoped libraries, filters input to the
  unambiguous pairing alphabet, surfaces FastAPI validation details, and clears
  mutation/code state between approvals. Device data refreshes after local
  mutations and briefly while an approved device is collecting its token,
  rather than polling throughout every Settings session.
- `GET /api/v1/health` advertises `api_features` with `trickplay`, `hls`,
  `progress`, and `pairing`. OpenAPI and `schema.d.ts` are regenerated. ADR-0015
  records token format/entropy/hashing, registry placement, scope and owner
  authorization, code UX/TTL/cap, cookie coexistence, usage throttling, and
  revocation. Architecture, data-model, deployment, plan cross-links, and
  CHANGELOG are updated.

Verification (temporary databases/libraries only; no user media):

- Backend: `ruff check`, `ruff format --check`, `mypy src`, and full pytest
  (**419 passed**, one pre-existing Starlette/httpx deprecation warning).
- Frontend: Prettier check, ESLint, TypeScript, full Vitest (**100 passed**), and
  production build. Two development runs hit the unrelated intermittent M12
  `falls back to a storyboard when direct playback rejects` timing assertion;
  focused/immediate full reruns passed, and the final required full run passed.
- Playwright: two full suite runs **unpiped** with seven workers each exited 0
  (**66 passed** each), including the new real-backend Devices flow. The known
  pre-existing real-backend flake did not reproduce. A configurable dedicated
  Playwright frontend port prevents the runner from reusing another checkout's
  Vite server.
- PR #13 CI follow-up partitions the same 66 cases into **63 browser-only**
  tests in the Node-only frontend job and **3 real-backend** tests in a
  dedicated full-stack job. The latter provisions ffmpeg, `uv`, and the locked
  server environment for Devices pairing plus the existing storyboard-job and
  MKV-remux coverage.
- The review-hardening pass reran both Playwright partitions unpiped: **63
  browser-only passed** and **3 real-backend passed**. The first real-backend
  run exposed the missing post-approval refresh after continuous polling was
  removed; adaptive polling limited to the token-collection window fixed it,
  and the final rerun passed all three cases.

Known limits: device tokens have no automatic expiry, refresh, or rotation;
they remain valid until revoked. Scope is immutable, so changing library access
requires pairing again. Outstanding pairing requests are intentionally lost on
server restart. Revoked rows remain visible for audit. This is still a
single-owner private-network guardrail, not public-internet hardening. Desktop
shell and TV client consumption remain out of scope for T0.

Next recommended task: **cross-platform-first desktop shell D1** (plan 3) per
`docs/plans/README.md`; D2 consumes this pairing/token contract.

## Current: grouping-review destination and drag-and-drop editing

An addition suggestion now keeps its confirmed bundle as the default while
offering a compact circular-arrows destination switch immediately after the
title. Existing-target rows read **Add to 🎬 [bundle name]** with the drag handle
pulled closer to the title. The switch's hover/focus tooltip describes the
action for the current mode, while the icon returns to its neutral appearance
after activation rather than remaining highlighted.
Switching preserves the proposal, checkbox, file list/order, collection parent,
and any edited new-bundle title; the reverse action restores existing-bundle
mode while the target still exists. Normal addition roles and fresh-bundle roles
are recomputed without changing the reviewed sequence. Applying new mode creates
a separate confirmed bundle and leaves the old target and every stable file id
intact.

Grouping regeneration now keeps the relevant branches of the existing logical
collection tree in the review plan. Additions default under their confirmed
target's collection, while fresh top-level proposals reuse the deepest
collection hierarchy matching their library-relative directory. Apply reuses
those collections instead of creating duplicates, so switching to a new bundle
does not silently leave it uncollected. The top-level drop target is rendered
only during a bundle drag and no longer leaves a blank block above the review
tree.

The additive `target_bundle_title` and `create_new_bundle` proposal fields
persist that reversible choice. Legacy open plans derive a fresh title and
snapshot the target title on their first switch. New mode remains applicable if
the old target later disappears; returning to existing mode requires a live
confirmed target. The library-scoped destination endpoint and generated frontend
types are current.

Bundle and collection title editors now use their rendered text as the minimum
width and grow live while typing, capped by the grouping dialog. Existing
double-click, Enter/F2, Enter/blur save, Escape cancel, validation, and focus
selection behavior is retained. The editor uses a wrapping text area sized by
the same live mirror as the rendered title and focuses without scrolling, so
activating rename preserves multi-line title geometry, surrounding row
positions, and modal size. Destination switches remain mounted at their normal
22px size while rename is active and are temporarily disabled instead of being
removed; rendered title buttons and editors also share the same 18px line box.

Grouping rows no longer show numeric confidence or manual badges. Ordinary
suggestions retain their human-readable reason, additions use a compact file
count, and title/switch/metadata share a nested content column so wrapped text
cannot fall back under the checkbox or drag handle.

Grouping review now uses native drag-and-drop instead of up/down buttons. Files
can move to an exact position within any bundle suggestion or into another
bundle; bundles can move into any suggested collection or back to the top
level. Double-click rename now applies to collection titles as well as bundle
titles. The generated default remains video, audio, image, then other files with
natural order inside each group.

An empty bundle suggestion now auto-deselects and disables its acceptance
checkbox. Collection selection is content-aware recursively: moving out its last
file-backed bundle also auto-deselects/disables the collection, while adding an
item makes it selectable again.

Suggester rule v4 improves flat multi-video directories. Sidecars first match a
unique normalized full video stem or a full-stem suffix, then fall back to the
coarser leading subject prefix. The screenshot case with two long `Ada Larson`
video/image pairs now yields two bundles instead of four single-file bundles;
image-only directories retain their item-per-file behavior. Existing open plans
remain snapshots; regenerate suggestions to receive the v4 result.

Every edit persists on the open plan. File moves recompute dense sequence and
derived roles for affected proposals, while apply preserves original bundle IDs
across reviewed provisional membership changes. Confirmed bundles stay settled
regardless of collection membership. The new persisted
`base_bundle_id` / `owner_edited` fields are additive, and no operation moves,
renames, or deletes a source file.

Repeated **Suggest grouping** now uses the same candidate boundary as Update.
Clicking it inside an already-open review supersedes the old plan without
reopening confirmed bundles; only still-unbundled files and new additions are
eligible. The former manual-only `uncategorized` scope was removed so
collection membership cannot be mistaken for bundling state.

The API replaces complete-order writes with library-scoped file-move and
bundle-parent routes and broadens proposal title updates to bundle or collection
suggestions. OpenAPI and frontend generated types are current. Regression
coverage checks within/cross-bundle movement, confirmed identity preservation,
collection rename/reparent, addition order, React interaction, and the
browser-visible drag flow. It also covers reversible destination persistence,
role conversion, rename eligibility, legacy backfill, missing-target behavior,
separate-bundle apply, title-editor growth, and one-row/one-checkbox switching.

Verified on `codex/grouping-review-drag-drop`: backend Ruff check/format, mypy,
and all 425 pytest tests pass. Frontend ESLint, Prettier, TypeScript, all 112
Vitest tests, the production build, and all 73 Playwright tests pass. Browser
flows cover title growth, destination-icon geometry and tooltip visibility,
reversible switching, repeated suggestion regeneration, and empty
bundle/collection deselection; the exact long-filename Python fixture covers v4
pairing. The in-app browser runtime was also attempted but could not initialize
(`Cannot redefine property: process`).

## Current: ordered bundle media cursor

Cover artwork and playback location are now independent (ADR-0016). Every
bundle resolves one current supported media file from its persisted
`bundle_cursors` row, then legacy unfinished video progress, then the first
ordered available media. The viewer opens that location, writes cursor changes
without bumping bundle metadata, and uses Files in bundle order for navigation
and end-of-video advance. Images therefore have a remembered location even
though only videos store a timestamp.

Bundle-card hover uses the same cursor instead of requiring the effective cover
to be a video. An image cursor appears as a still; a video cursor keeps the
existing direct/storyboard scrub and starts at its unfinished saved position,
even when the static cover is an image. A remembered file that later goes
missing stays current so the viewer can show the correct missing-file state.

The primary-file API field, inspector icon/action, grouping assignment, and
cover/playback fallback are removed. Existing databases retain the nullable
`primary_file_id` column as unread compatibility storage; legacy
`primary_video` roles display simply as video. The new cursor table is additive
and source files remain untouched.

Verified on `main`: backend Ruff check and format check, mypy, and all 416
pytest tests pass. Frontend ESLint, Prettier, TypeScript, all 100 Vitest tests,
the production build, and all 70 Playwright tests pass. The two new browser
flows cover image-cover/video-hover and ordered cursor navigation. An additional
in-app browser inspection was attempted, but that runtime could not initialize
(`Cannot redefine property: process`); the complete Playwright run is the browser
proof for this slice.

## Recently completed: bounded missing-file reconciliation

Opening a bundle checks every linked member of that bundle. Entering a File
Browser directory checks the indexed linked rows whose stored parent is that
directory, without walking unrelated database rows. Vanished paths are
persisted as `missing`; the directory response reports the number changed so
the web client refreshes bundle/count queries only when necessary.

The Missing Files sidebar value remains a compact numeric count of affected
bundles, so it renders `1` when one bundle contains two missing files. The
inspector's Files in bundle heading reports both total and missing counts, and
each missing row is highlighted and badged. The viewer continues to give the
selected file's missing state precedence over a stale unsupported-container
message.

Access-time checks do not infer that an unlinked path is a particular moved
file. Update/scan continues to own high-confidence moved-file repair and
stable-ID relinking.

Update and standalone Scan now report the total number of linked files that
remain missing after scan reconciliation. The message uses the persisted total,
so repeated scans continue to report an unresolved missing file rather than
dropping to zero when no additional path disappeared during that run.

Regression coverage moves multiple linked paths while leaving another bundle
member present, verifies bundle and directory reads persist every relevant
missing row, confirms directory scope leaves another directory untouched, and
exercises the sidebar/inspector/viewer behavior with two unlinked files and an
unsupported AVI reason present.

Verified on `main`: backend Ruff check and format check, mypy, and all 410
pytest tests pass. Frontend ESLint, Prettier, TypeScript, all 99 Vitest tests,
the production build, and all 68 Playwright tests pass.

## In review: Plan 1 M12 — Eagle-style thumbnail hover video preview

Branch `feat/hover-preview` (off `main` at `02cb18b`, after M9 merged as #11).
Implementation commits: `f6aefeb` (`feat: add thumbnail hover video previews`)
and `374f7e0` (`fix: address M12 hover preview review findings`). Hybrid
interaction tip: `37368b4` (`feat: make hover previews hybrid at rest`). The
first documentation handoff is `986e399`; the follow-up stability fix is
`37a8ef2` (`fix: stabilize hover preview resume`) plus final race/docs handoff
`e325cff` (`fix: finish stable hover resume`). The compositor/geometry and saved
progress follow-up is `ebc73bd` (`fix: unify hover preview frame geometry`). M12
then clips storyboard sprite sheets at the cue boundary in `daf96b7` (`fix: clip
hover storyboard tiles`) and aligns rest playback to that sampled frame in
`d9df60c` (`fix: align hover video with storyboard frame`). `7b40b95` (`fix:
keep hover resume scoped to storyboard cues`) removes the earlier broad paused-
compositor experiment, while `8520db9` (`fix: resolve hover cue when rest
begins`) closes the delayed-VTT race. `ab9d330` (`fix: align hover sprites with
playback frames`) fixes the underlying ffmpeg sample timing, invalidates old
artifacts as storyboard format v2, and retains
only a target-frame-gated sprite handoff. Its regressions compare generated tile
pixels to source frames and the first exposed browser decode frame to the actual
displayed sprite. Current implementation tip `f667ce1` (`fix: harden hybrid
hover preview review`) adds condition-based real-backend waits, a single hover
phase model, bounded metadata fallback, delayed prefetch, shared resume
filtering, and sidecar-only storyboard freshness checks. M12 remains in review
and is not merged. Final parallel-test tip `7f1a554` (`test: stabilize parallel
hover preview coverage`) makes motion assertions follow the committed skim
phase, targets a real outside element for leave, and pins teardown while the
aligned reveal animation frame is queued.

Completed:

- A shared `useHoverPreview` + `HoverPreview` path now drives bundle cards,
  bundle-album file tiles, and linked File Browser grid cards. A ~500 ms dwell
  mounts a muted, inline, non-looping direct `<video>` at the existing `/stream`
  URL and plays from incomplete saved progress when available, otherwise t=0.
  Storyboard VTT prefetch begins after a 150 ms sub-dwell, so a quick pass over
  a card issues no preview request. While the cursor moves, the video pauses and
  stays mounted with its source intact;
  the proportional storyboard sprite replaces it with zero video seeks. After
  250 ms rest, the clock and strip snap to the displayed cue's sampled timestamp
  and the video seeks once to that same frame. During a cue-backed rest, the
  paused video stays mounted beneath the sprite. The preview waits for both seek
  completion and presentation of the target frame, removes the sprite, then
  resumes playback in a cancellable post-paint task. Seek readiness also requires
  `currentTime` to match the requested target, preventing a late prior `seeked`
  event from revealing time zero. Dwell and rest timers are identity-checked,
  and activating the current page-wide owner is idempotent, so a queued callback
  cannot reset a playing preview to `transitioning`. The cue is resolved when
  rest begins rather than at the last pointer move, so a VTT prefetch completing
  during the debounce is included in the target. A transition sprite is shown
  only when that target matches its cue sample. Without a storyboard, rest
  retains the exact cursor time and the static cover masks only its seek
  transition. Static video covers, storyboard crops, and the live element share
  one contained,
  black-letterboxed viewport, preventing aspect-ratio stretch and transition
  shake while pillarboxing portrait media. The storyboard SVG additionally
  clips the full 5×5 sheet to the selected cue rectangle before that letterboxing
  transform; adjacent sheet rows therefore cannot render in the top or bottom
  bands. Current time stays at the lower right, with the click-isolated speaker
  toggle immediately to its left, plus a 2 px position strip along the bottom.
  Starting a skim while the initial
  `play()` is still pending ignores that intentional pause cancellation instead
  of falsely demoting the card to storyboard-only.
- One module-level owner enforces a single active preview page-wide. Pointer
  leave, card/virtual-row unmount, source/guard changes, and ownership transfer
  clear timers, pause, remove `src`, call `load()`, and unmount the element.
  Hover is disabled on coarse/touch pointers and while drag-select, native DnD,
  or a card context menu is active.
- Non-direct sources use the existing capability vocabulary and lazily fetch
  cached `storyboard.vtt`; the existing parser/crop renderer was generalized for
  cover-filling sprite tiles. A 404 or invalid/absent board leaves the card
  static. Direct sources with a missing board retain their frozen paused frame
  during motion, then seek once on rest. A rejected `play()` or media decode
  error demotes the active card to the storyboard-only path. Hover contains no
  playback-decision/session code and cannot start HLS.
- Browse summaries expose the effective cover video's relative path plus the
  probe-backed ffmpeg container list, video codec, audio codec, duration, and
  file id in the existing one-pass summary. The unpopulated MIME field was
  removed. Bundle summaries, bundle file rows, and linked File Browser entries
  also expose incomplete resume positions through their existing batched
  queries. OpenAPI and `schema.d.ts` are regenerated.
- Review fixes also restore hidden-path exclusion and alphabetical sorting in
  the unbundled File Browser query, gate direct preview on audio support, resume
  dwell when a menu/drag guard clears under a stationary cursor, restore
  Space/Enter album-tile selection semantics, and extract the leading/trailing
  `SeekBar` throttle into a reusable helper.
- The final review pass collapses hover state into skimming, transitioning, and
  playing phases; bounds a missing `loadedmetadata` event at five seconds before
  storyboard fallback; and centralizes the positive, unfinished resume-position
  predicate across bundle summaries, bundle file rows, and both File Browser
  paths.
- Owner follow-up (2026-07-12, tested against Eagle): browser video seeking is
  not used for motion skimming because every step creates frame-accurate seek
  and range work. The shared throttle remains with `SeekBar`; hover's hybrid
  state machine uses sprites for motion and one video seek at rest.
- Storyboard format v2 anchors ffmpeg sampling at t=0, rounds to the source frame
  active at each VTT cue start, stores the format marker plus source fingerprint
  in `index.fingerprint`, rejects legacy sidecars without that marker as stale,
  revalidates VTT responses, and versions immutable sheet URLs with the same
  inputs. Manifest checks read only the small sidecar rather than each full VTT.
  Existing libraries need one Update/storyboards run for all prior boards; that
  run also backfills 10–60 second videos after the default minimum dropped from
  60 to 10 seconds. Until regeneration, old boards intentionally appear
  unavailable.
- M9 follow-up: `SeekBar` now reports `onDragChange(false)` inside shared
  listener cleanup, preventing a mid-drag unmount from leaving controls pinned.

Verification (ffmpeg-generated scratch media and temporary libraries only; no
Demo/Eagle/user libraries):

- Backend: Ruff check + format, mypy, full pytest (**403 passed**). Browse tests
  cover realistic null-MIME/probe-container video covers versus image/empty
  bundles; File Browser tests cover linked preview metadata plus hidden-path and
  creation-order regressions. Storyboard tests cover the new default boundary,
  exact t=0/t=2 tile-to-source pixel matching, neighboring-frame rejection,
  format-v2 ffmpeg flags and marker/URL versioning, v1 rejection, VTT
  revalidation, scalar resume filtering, and sidecar-only current-index checks.
- Frontend: ESLint, Prettier check, TypeScript, full Vitest (**97 passed**),
  production build. Unit coverage includes dwell/cancel, cursor-time math,
  rest/skim transitions, zero motion seeks, retained video source, single
  rest-seek timing, seek-complete reveal, omitted-`seeked` readiness recovery,
  unmuted resume recovery, intentional initial-play cancellation,
  missing-storyboard frozen-frame/static-cover behavior, container/video/audio
  capability gating, page-wide ownership, guard recovery, direct-failure
  storyboard fallback, unmount source teardown, saved-progress clamping,
  frame-gated reveal, stale-frame callback rejection, bounded missing-callback
  recovery, cue-sampled rest targeting, VTT arrival during the rest debounce,
  metadata-stall fallback, delayed/cancelled VTT prefetch, contained storyboard
  geometry, queued-reveal pointer-leave teardown, and the SeekBar drag cleanup.
- Playwright: full suite (**65 passed**). Five consecutive unpiped full-suite
  runs at seven workers each exited 0 with **65 passed**. New real-browser cases
  use a generated moving-pattern MP4 on bundle, bundle-album, and File Browser
  cards. The stream mock now implements real HTTP byte ranges; the prior
  whole-body response reset native seeks to zero and could pass only by letting
  a black video play forward.
  At an 80% cursor position on a 3-second clip, the hover case asserts that the
  displayed VTT cue starts at 2.0 seconds, the raw cursor time is 2.4 seconds,
  and the browser's native `seeked` event lands at 2.0 seconds. It also covers
  VTT prefetch, no motion seeks, contained geometry, right-anchored controls,
  cue clipping, direct unmuted resume, album keyboard selection, leave teardown,
  MKV and decode-failure fallback, and zero stream or VTT requests during a
  rapid sweep.
  Request interception proves hover sends no playback-decision or
  playback-session requests. A separate real-backend case generates a moving
  65-second MP4 and its production storyboard, skims inside the 26–28 second
  cue, and verifies the first exposed video decode frame lands at 26–26.3
  seconds and pixel-matches the displayed sprite (mean RGB error below 12)
  before playback advances. The exact unpiped blocker command
  `npx playwright test -g "storyboard generated" --repeat-each=10` passes all
  10 repeats with seven workers. The hybrid-card case additionally passes
  **20/20** under `--repeat-each=20 --workers=7`. Its final parallel flake was
  test-side: a raw move to `(0, 0)` did not prove Chromium delivered a leave,
  while sequential motion assertions could outlive the real 250 ms debounce
  under load. The test now captures the last committed skim state inside the
  page and explicitly hovers the Files tab to leave. A unit regression confirms
  that an actually delivered pointer leave cancels the reveal queued between
  target-frame presentation and the `flushSync` playing handoff.

Known limits: unlinked or unprobed File Browser paths have no stable file id or
API duration and remain static; storyboard fallback remains cached-artifact-only.
A direct source with a 404 board uses its frozen video frame during motion and
its static cover while the resting seek completes; a non-direct source without
a board remains static. If a board arrives only after rest has already begun,
the transition keeps the static cover and uses the cursor target; the board is
available on the next motion. Exact sprite-to-video continuity means rest can
snap back within the selected storyboard sampling interval (2–30 seconds
according to source duration); the cursor-proportional clock remains exact
during motion.
Cue-backed handoffs use `requestVideoFrameCallback` where available; browsers
without it use completed seek as the best frame-ready signal, and an omitted
post-seek callback has a bounded 250 ms fallback. No hover transcode/HLS,
image/audio/viewer preview, or new runtime dependency was added. The
reviewer-requested live scratch-library feel check remains the final
re-verification step. Run Update/storyboards first so every scratch file has a
format-v2 board, including newly eligible sub-60-second clips. This fix pass used
generated media in Playwright and never touched Demo/Eagle/user libraries.

Next recommended task: **pairing + device tokens (plan 2 T0)**, then the
cross-platform-first macOS desktop shell (plan 3 D1–D5) per
`docs/plans/README.md`.

## Merged: Plan 1 M9 — player interaction polish (#11)

Merged to `main` as #11 at `02cb18b`. The review history includes implementation
commit `88c334e` (`fix: address M9 player polish review findings`), the
collection-cover fix `7f4ce9c`, speed/seek Settings refactors `af2f9be` +
`4ddced9`, source-aware Resolution submenu `463fad9`, and the UI polish series
`f203dcd` → `9cc8440`.

Completed:

- Video-surface right-click now suppresses the native menu and toggles
  play/pause without affecting controls or side panels. The shared shortcut map
  uses the persisted 2/5/10/30-second seek step for arrows, keeps J/L at 10
  seconds, and restores `<`/`>` frame step plus `,`/`.` speed adjustment.
- Drag scrubbing retains pointer capture plus window-level move/release tracking,
  pins auto-hide chrome until release, keeps the 150 ms seek coalescing, and
  commits the exact clamped release position even off-track.
- Persisted player prefs now include seek step and `preservesPitch`; file loop is
  intentionally session-only and takes precedence over bundle auto-advance. The
  seek-step and speed controls are compact Settings sliders, with pitch
  preservation grouped beside speed; no standalone speed control occupies the
  control bar.
- Resolution choices are a foldable Settings submenu derived from the current
  video's probed height (Auto plus standard tiers at or below the source), so
  4K sources expose 2160p and 1440p instead of stopping at 1080p.
- Additive nullable `asset_files.cover_time` plus path-safe POST/DELETE
  `cover-frame` endpoints set/clear a server-extracted current-frame cover,
  regenerate only the cached thumbnail, select that video as the bundle cover,
  honor the timestamp on later regeneration, and version file/bundle card URLs
  so the UI refreshes without reload. OpenAPI and `schema.d.ts` are regenerated.
- Storyboards count sampled frames from `showinfo` in the existing ffmpeg pass
  and trim VTT cues before final-sheet tile padding. Existing cached storyboards
  are not force-regenerated; normal fingerprint invalidation applies.
- Review fixes: ended transitions are consumed once (no double auto-advance or
  loop-toggle restart); EOF cover requests clamp 100 ms before duration; reset
  restores the displaced image/automatic bundle cover; Inspector/viewer URLs
  use bundle timestamps; cover writes use shared file mutations without
  discarding their optimistic file cache; storyboard parsing strips ANSI and
  falls back to sheet capacity with a warning; collection refresh candidates
  are limited to membership ancestors and explicit selectors. Seek drags also
  remove their window listeners on unmount.

Verification (scratch ffmpeg fixtures only; no Demo/Eagle/user libraries):

- Backend: Ruff check + format, mypy, full pytest (**398 passed**).
- Frontend: ESLint, Prettier check, TypeScript, full Vitest (**75 passed**),
  production build (hls.js remains a separate chunk).
- Playwright: full suite (**59 passed**), including video context-menu toggle,
  off-track drag with controls pinned, seek-step selection, and a real-backend
  set/clear cover-frame flow that compares regenerated thumbnail bytes, plus a
  three-video ended transition that advances exactly one file.
  Scratch libraries/data directories are removed in `finally` blocks.

Historical M9 limits at merge: file loop does not persist; previously cached
storyboards keep their old final padding cues until normal regeneration. If an
ffmpeg build omits parsable `showinfo`, new generation safely caps cues to sheet
capacity but cannot trim padding within its final sheet; a warning records that
fallback. A-B loop/GIF range selection, video adjustments, slideshow, and
subtitle depth remain out of scope. Hover previews followed in M12 above.

The next task after M9 was M12; it is now the in-review section above.

## Latest: roadmap re-sequenced (docs only, 2026-07-10)

Branch `docs/roadmap-resequence` (off `main`). Owner decision after plan 1
M7 (web HLS) merged (#9):

- **Plan 1 M8 (subtitle depth), M10 (web video wall), M11 (media exports)
  moved to the future bucket.** Plan 4 W2 (save exports into library) moves
  with M11.
- **New order:** plan 1 **M9 player polish** → pairing/device tokens (plan 2
  T0, pulled forward for desktop auth) → **macOS desktop shell** (plan 3
  D1–D5) → **write mode** (plan 4, re-ordered W0 → W1 → W5 so Finder
  drag-and-drop _into_ the app lands early) → **Android client** (plan 2).
- A **Linux desktop app is a stated future want**; plan 3 gained §2.1
  (cross-platform posture): cross-platform Tauri plugins only, OS-specific
  Rust isolated behind `#[cfg]` edges, OS-neutral `HostPlatform` seam +
  label/keymap maps, an Ubuntu clippy/test CI job from D1, and accepted
  WebKitGTK codec deltas (the decision pipeline transcodes what Linux can't
  decode). Android reuse stays server-side only (OpenAPI + pairing).

Updated: `docs/plans/README.md` (build order), plans 01–04 headers/milestone
tables, this file, CHANGELOG. No code changes; no gates run (docs-only).

**M9 recomposed + M12 added (owner, 2026-07-11):** A-B loop moved to M11
(it's really the GIF range-picker); video adjustments deferred (owner wants
color/tone, not brightness sliders); image slideshow deferred. M9 is now
interaction polish: right-click play/pause, drag-scrub surviving cursor
leaving the track (bug — suspect control-bar auto-hide breaking pointer
capture), configurable seek step, pitch-preserve, file loop, frame-step
rebound to `<`/`>` with speed moving to `,`/`.`, set-cover-to-
current-frame (plan 1 §13.1), storyboard padding-tile trim. New **M12 —
Eagle-style thumbnail hover video preview** (plan 1 §13.2: dwell-to-play
muted, cursor-x skim + position bar, time + sound toggle, storyboard-skim
fallback for non-direct-playable sources, never spawns HLS sessions) lands
after M9, before the desktop shell.
Next recommended task: **plan 1 M9 — player interaction polish**.

## In review: playback DB-pool exhaustion fix

Branch `fix/playback-pool-exhaustion` (off `main`).

### Follow-up pass: registry-pool abort leak (actual root cause) + load watchdog

After the first three fixes below, sustained scrubbing still eventually broke
playback. Reproduced live against a real 6.8 GB 4K file (NAS-backed library):
the drag's aborted range requests produced `/stream` **500s**, which Chrome's
demuxer surfaced as fatal `PIPELINE_ERROR_READ` media errors, draining the
native-recovery budget.

Root cause (two mechanisms, both verified empirically on FastAPI 0.138):

1. `get_library_access` still took the `get_registry_db` **yield** dependency.
   Yield-dep teardown runs only after the response body finishes — and when a
   client abort cancels the request task, the teardown **never runs at all**,
   stranding the registry connection until GC. Drag-seeking aborts dozens of
   in-flight range requests → the registry QueuePool (5+10) drained → new gates
   blocked 30 s at resolution → 500s mid-drag. A 600-request abort-storm against
   a real server produced **240** QueuePool tracebacks pre-fix and **zero**
   post-fix.
2. A range request wedged on a half-open connection emits no media `error`
   event, so a recovery reload could stall at `readyState 0` forever — a silent
   black frame with no card (observed live).

Changes in this pass:

- **Backend.** `get_registry_access`/`RegistryAccess` in `api/deps.py`:
  `get_library_access` now opens the registry session imperatively inside the
  sync dependency (cancellation-immune) and closes it before returning; no
  yield dependency remains in the streaming gate chain. The other burst-aborted
  `FileResponse` routes — `/preview`, `/storyboard.vtt`,
  `/storyboard/{sheet}.jpg`, `/subtitles/{id}/vtt` (`api/v1/playback.py`) and
  bundle/file thumbnails (`api/v1/bundles.py`) — moved to the same scoped
  `LibraryAccess` gate. New regression test
  `test_stream_releases_registry_connection_before_body` drives the real,
  unoverridden dependency chain and asserts neither pool has a connection
  checked out once the body streams (the cancellation strand itself is masked
  in-process by refcounting GC; it was proven with the live abort-storm A/B).
- **Frontend.** `MediaViewer`: 15 s **load watchdog** (`LOAD_WATCHDOG_MS`) — a
  source that never reaches `HAVE_METADATA` is treated as a stage error, so the
  bounded recovery path reloads on a fresh connection instead of freezing;
  verified live against a never-responding server (wedge → auto-reload →
  playing). Plus a **burst guard** (`nativeRecoveringRef`, mirroring the HLS
  `reattachingRef`): extra error events during an in-flight recovery no longer
  each consume a budget slot.

Verification: backend `ruff`/`mypy`/`pytest` (**390 passed**, +1); frontend
`lint`/`format:check`/`typecheck`/`test` (**69 passed**); live e2e — a 120 s
automated scrub of the real 4K file through the real dev stack recovered from a
dev-proxy 502 and the wedged-load case automatically; abort-storm A/B as above.
Note for local testing: uvicorn's worker can wedge if its stdout pipe stops
draining while it spews tracebacks (SIGTERM-immune, needs SIGKILL) — another
reason the pre-fix traceback storms could hard-hang the server.

Fixes a viewer hang where dragging the scrub bar eventually wedged playback with
repeated 30s `QueuePool` timeout 500s and a stuck "Preparing playback…" screen.

Root cause: media byte-streaming routes took their content session via the
`LibrarySession` `yield` dependency, which FastAPI holds open until the response
body finishes. A streaming `FileResponse` therefore pinned a per-library **and**
registry connection for the whole transfer; overlapping drag-seek range requests
drained both QueuePools (SQLAlchemy defaults: size 5 + overflow 10, 30s timeout),
so the next `playback-decision` blocked on a registry connection and 500ed.

Changes:

- **Backend (essential).** New `LibraryAccess` dependency + `get_library_access`
  in `apps/server/src/cairndex/api/deps.py`: same registry-resolution +
  passphrase-lock gate as `get_library_session`, but returns a handle whose
  short-lived `session()` scope the endpoint closes _before_ returning the
  `FileResponse`. `stream_file`, `file_content`
  (`api/v1/playback.py`), and the HLS `playback_session_artifact`
  (`api/v1/playback_sessions.py`; it never used the session — pure auth gate)
  now use it, so no DB connection is checked out while bytes stream. Test
  override added in `tests/conftest.py`; regression test
  `test_stream_releases_db_connection_before_body` asserts zero checked-out
  connections on the real per-library pool mid-stream (verified failing before
  the fix).
- **Frontend (resilience).** `useHlsSession` now caps the decision request at a
  finite `DECISION_TIMEOUT_MS` (15s) and adds a distinct `'unavailable'` status
  - `retry()`. On timeout or a 5xx, a non-degradable video shows a retryable
    "Playback server is unavailable" card (`MediaViewer`/`MediaFallback`);
    directly-playable sources still degrade to the native stream.
- **Frontend (efficiency).** `SeekBar` coalesces drag scrubbing: the real
  `seek()` is throttled (leading edge + one trailing flush per ~150ms) and the
  exact position is committed on pointer release, instead of a `seek()` per
  `pointermove`. The thumb/tooltip track the pointer live via a local drag
  override. A drag now issues a handful of range requests instead of dozens of
  cancelled ones.
- **Frontend (native error recovery).** A transient media error on a direct-play
  video (a stalled/dropped range read while seeking into an unbuffered region —
  the reported "seek to an unbuffered spot → stuck → Preview failed" bug) used to
  dead-end on an unrecoverable card. `MediaViewer` now reloads native playback at
  the current playhead up to `MAX_NATIVE_RECOVER` (3) times before giving up
  (mirroring the HLS re-attach budget, refunded on healthy progress via the same
  forward-progress effect), and the terminal card is a retryable "Playback
  interrupted — Try again" (`MediaFallback` action) instead of a dead end.

Verification: backend `ruff`/`mypy`/`pytest` green (**389 passed**, +1);
frontend `lint`/`format:check`/`typecheck`/`test` (**69 passed**, +5)/`build`;
Playwright `player.spec.ts` (**15 passed**) exercises real MP4/MKV-remux
streaming end to end. The native error-recovery flow was verified live against a
real backend + a generated 4K MP4: forcing a media error mid-play auto-reloaded
and resumed at the playhead (36s→48s, no card); exhausting the budget surfaced
the retryable "Playback interrupted" card; and its **Try again** restored
playback. (The mocked e2e harness swallows media `error` events by design, so
this path is proven by live verification rather than a Playwright spec.)

## In review: media-player M7 — web HLS integration

Branch `feat/web-hls` (off `main`, after the M6 playback-sessions merge #7).
Latest commit subject: `feat: web HLS integration (hls.js/native-HLS engine)`
plus a review-fix pass (below). Implements plan 1 M7 — the web player now
consumes the M6 decision + session foundation, so a source the browser can't
play directly streams over a server remux/transcode HLS session. Browser-verified
end to end: an **MKV/H.264 remux** session and a **480p libx264 transcode**
session both play via hls.js, and the **native-HLS** path plays in WebKit. HEVC
and other transcode-only _sources_ use the same machinery but have not been run
end to end, so they are not claimed as verified (AGENTS.md).

- **Capability profile (§6.3).** `apps/web/src/app/viewer/player/caps.ts`:
  memoized once per tab, probing `HTMLVideoElement.canPlayType` **and**
  `MediaSource.isTypeSupported` for containers (mp4/webm), video codecs
  (h264/hevc/vp9/av1), audio codecs (aac/mp3/opus/vorbis/flac), and `native_hls`.
  Only probe-confirmed formats are advertised (AGENTS.md: no untested-format
  claims); `max_height` is null (no browser decode-ceiling API). Pure
  `computeCapabilities(probe)` is unit-tested with mocked probes.
- **Per-file decision + engine (§6.3).** `useHlsSession` POSTs
  `.../files/{id}/playback-decision` when a video starts. `direct` → existing
  `NativeEngine` path (unchanged; a decision failure also degrades to the
  manifest's direct stream). `remux`/`transcode` → the session playlist via the
  new `HlsEngine` (lazy `import('hls.js')`; native-HLS uses `NativeEngine` with
  the m3u8). `createEngine()` picks the engine; hls.js is a **separate build
  chunk** (~157 kB gz) so the main bundle stays flat (verified in `build`). The
  manifest (`GET /bundles/{id}/playback`) is unchanged and still carries the
  per-video metadata (subtitles/chapters/storyboard/duration/progress).
- **Session lifecycle (§6.3).** Teardown (DELETE) on player close, file switch,
  and unmount; a new **POST `.../playback-sessions/{sid}/teardown`** alias lets
  `navigator.sendBeacon` reap the session on `pagehide` (mirrors the M4 progress
  beacon; OpenAPI + `schema.d.ts` regenerated — `gen:api` reached the registry).
  On a playlist/segment failure (idled-out session) or an hls.js fatal error the
  client transparently re-requests a decision and re-attaches at the current
  playhead; the re-attach budget (3) is refunded only when the playhead actually
  advances (not on the `play` intent), so a persistently broken stream falls
  back to the "can't play" card instead of looping.
- **Quality/audio/burn-in menus.** A settings menu (gear) offers a `max_height`
  ladder (Auto/1080/720/480), an audio-track picker (from `decision.audio_streams`),
  and a burn-in toggle for non-native subtitle tracks (`burn_subtitle_track_id`).
  Each switch re-decides + starts a new session at the current position (no
  in-stream ABR); identical params reuse the live session (M6 F6), changed
  params tear down the old one. Watch progress/resume is unchanged over the 1:1
  VOD timeline.

Verification:

- Backend: `UV_CACHE_DIR=/private/tmp/cairndex-uv-cache uv run ruff check` /
  `ruff format --check` / `mypy src` / `pytest` all green (**387 passed**, same
  pre-existing Starlette/httpx deprecation warning). New: a POST-teardown-alias
  test in `tests/test_hls_sessions.py`. The only server change is the beacon alias.
- Frontend: `lint` / `format:check` / `typecheck` / `test` (**58 passed**, +11:
  `caps.test.ts`, `engine.test.ts` engine-selection matrix, `useHlsSession.test.tsx`
  teardown/switch/re-attach/direct) / `build` (hls.js is its own chunk, main
  bundle unchanged) / `test:e2e` (**52 passed**, +3 in `player.spec.ts`: mocked
  decision→hls.js path with real fMP4 bytes + quality/audio menus + a 720p switch
  re-decide; transparent re-attach on 404 segments → fallback after the budget;
  and a real-backend H.264 **MKV** that scans/probes then plays over a remux
  session with the session DELETE firing on close). e2e ran escalated (the
  sandbox blocks Vite's `::1:5173` bind).
- Live (real uvicorn on an isolated port + a throwaway generated **720p 2-audio
  MKV** library in `/tmp` — never the Demo library): a Chromium-like caps profile
  decided **remux** ("mkv container is not in client capabilities") and started a
  session; `max_height:480` decided **transcode** and `audio_stream_index:2`
  decided **remux**, each a **distinct** session id (switch semantics); the POST
  **teardown alias** returned 204 and removed the session dir; the **idle reaper**
  (`CAIRNDEX_TRANSCODE_IDLE_TIMEOUT=8`) removed untouched session dirs. The full
  browser play/seek/re-attach/switch/close-DELETE path is covered by the
  real-backend + mocked Playwright specs above (Chrome-extension driving was
  unavailable this session, so the interactive walkthrough was replaced by the
  deterministic real-browser e2e + live curl checks, which exercise the same
  server + client paths). The throwaway library/data dir were removed afterward;
  the owner's Demo backend on :8000 was left untouched.

### Review-fix pass (pre-merge, same branch)

Addressed 8 findings (3 confirmed session-lifecycle bugs, 1 docs violation, rest
hardening/cleanup):

1. **Abort-orphan (confirmed, reproduced live).** A decision that resolves after
   its effect was torn down (fast open→close) now DELETEs the session the server
   started, instead of leaving it to the idle reaper.
2. **Fallback flash (confirmed).** The hook starts in `deciding` (and the Stage
   treats `idle` as loading too), so a playable file never shows a frame of the
   "can't be previewed" card while opening.
3. **Degrade-to-direct leak (confirmed).** The decision-failure `.catch` tears
   down the superseded session before swapping to native playback.
4. **Rapid-switch 429s.** A capacity rejection is retried once (~350 ms) — the
   superseded session's teardown usually frees a slot in that window — before the
   error card shows.
5. **Re-attach window race.** An in-flight re-attach is tracked; a burst of stage
   errors is swallowed (one budget slot) instead of returning false on the nulled
   ref and surrendering to the fallback.
6. **Docs (AGENTS rule).** Scoped the playback-support wording (this section +
   CHANGELOG): MKV remux and 480p transcode + native-HLS are browser-verified;
   HEVC-source playback is not claimed. Fixed the stale "~90 kB" hls.js size.
7. **Cleanup.** Extracted a shared `BaseVideoEngine` for the 7 byte-identical
   media-delegating methods (Native/Hls keep only load/destroy).
8. **Cleanup.** Removed the dead `method` field; collapsed the three switch
   setters into `setParam(key, value)`; shared one `beacon(url, body?)` helper
   (bodyless teardown, CORS-safelisted) and dropped the gratuitous Blob type; a
   typed `HttpError` carries the HTTP status.

Tuning applied (reviewer note): the re-attach budget refunds only after ~10 s of
continuous healthy playback past a re-attach (was ~1 s), so a flapping stream
still exhausts the budget and falls back.

Fix-pass verification: frontend `lint`/`format:check`/`typecheck`/`test`
(**61 passed**, +3 hook tests: abort-orphan reap, double-error burst = one slot,
429 retry-once)/`build` (hls.js still its own chunk, main bundle flat)/`test:e2e`
(**54 passed**) all green. No backend source changed in this pass. Live
verification runs through the real-browser + real-backend Playwright specs: the
real-MKV remux spec now also asserts the server's `{DATA_DIR}/transcode` is
**empty after close** (no orphaned session dir), and a new spec proves a playable
file opening shows the loading state with **no fallback-card flash** (a
MutationObserver records any `.media-fallback` mount). The abort-orphan reap is
additionally pinned by a unit test (a decision that resolves post-abort DELETEs
its session).

Known issues / out of scope: embedded text-subtitle **extraction** to servable
tracks and the multi-track subtitle menu/styling are M8 (M7 still shows only the
default external track and burns in non-native tracks on transcode); `max_height`
has no browser probe so it is advertised null (the ladder is user-driven); in-
stream ABR is deliberately not implemented (switches re-create the session). Next
recommended media-player task: **plan 1 M8 — subtitle upgrade**.

## Fixed: library switch refreshes the browser shell

Branch `codex/library-switch-refresh` (off local `main` after the three approved
enhancements were fast-forwarded directly). The workspace already remounted on a
library-id change, but its TanStack query keys were not library-scoped, so the
shared query client reused the previous library's still-fresh 30-second content
cache. The switch handler now points requests at the next library, removes only
active-library content queries, then changes the selected id. Registry and
library-keyed auth queries are preserved.

Verification: the focused Playwright regression fails before the fix and passes
after it, with two libraries returning different bundle titles. Live browser
verification against the real local app switched `lex` (4 items) → `Demo` (21
items and its own collection tree) → `lex` (4 items) without a page reload; the
original selected library was restored afterward. Full frontend `lint`,
`format:check`, `typecheck`, `test` (**51 passed**), `build`, and Playwright
(**53 passed**) are green.

## In progress: pinyin-aware picker search

Branch `codex/pinyin-picker-search` (stacked on the two preceding Update fixes).
Chinese tag and collection names now match full pinyin, initials, partial
pinyin, mixed Latin/pinyin, and polyphonic readings in the single- and
multi-bundle add pickers. The same shared local matcher also covers tag filters,
All Tags, File Browser entry names, and local file-selection filters. Normal
case-insensitive substring search and literal exact-name/create behavior are
unchanged.

`pinyin-pro` 3.28.1 is frontend-only and offline. It is split into a ~142 kB
gzip lazy chunk loaded when a search-bearing surface mounts; the initial app JS
remains ~131 kB gzip. Whole-library Bundle Browser search is still server-backed
SQLite FTS and intentionally does not gain pinyin aliases in this low-cost
slice, since that would require new indexed data and a per-library FTS rebuild.

Verification: frontend `lint`, `format:check`, `typecheck`, `test` (**51
passed**), `build`, and Playwright (**52 passed**) are green. Unit coverage
checks literal, full/initial/partial, mixed, and polyphonic matching. The new
browser case searches `摄影` with `sheying` and `电影` with `dianying` in the
actual single-bundle tag and collection pickers.

## In progress: standalone Update stages

Branch `codex/standalone-update-actions` (stacked on the network-library scan
overflow fix). **Update** runs scan/move repair + new-scope grouping suggestions,
metadata collection, then non-blocking storyboard generation. Its maintenance
overflow now exposes each capability independently as **Scan new files**,
**Suggest grouping**, **Collect metadata**, and **Generate storyboards**.
Standalone and Update-triggered storyboard completion invalidate cached playback
manifests so trickplay availability refreshes without a page reload.

Verification: frontend `lint`, `format:check`, `typecheck`, `test` (**48
passed**), `build`, and Playwright (**51 passed**) are green. The new browser
case opens the maintenance overflow, verifies all four standalone labels, and
confirms **Generate storyboards** sends its own storyboard-job request.

## Fixed: network-library scan overflow

Branch `codex/fix-unsigned-filesystem-identity` (off `main`). **Update** no
longer fails when a mounted/network filesystem reports an unsigned 64-bit inode
or device identifier above SQLite's signed `INTEGER` maximum. The scanner stores
the same 64 bits in signed two's-complement form, preserving exact equality for
moved-file repair without a schema migration. Regression coverage exercises an
initial scan and same-volume move with an inode above `2^63 - 1`.

Verification: backend `ruff check`, `ruff format --check`, `mypy src`, and
`pytest` (**387 passed**) are green. A read-only scan of the mounted `lex`
library into an in-memory database discovered and persisted all 4 supported
media files without touching its real library database.

## In review: multiple notes per bundle

Branch `feat/bundle-multiple-notes` (off `main`, i.e. after the M6 playback
sessions merge #7). Owner-requested feature ahead of the next milestone: a
bundle can hold several freeform note/description blocks instead of a single
note, used as clean separators (no predefined roles under the hood).

- **Data model.** New `asset_bundles.notes` JSON column (ordered `list[str]`),
  added additively via `ensure_content_indexes` so existing libraries gain it on
  open (verified live). It is the **single source of truth** — the old scalar
  `note` column/field and its compatibility shim were removed (early-dev cleanup
  per owner); libraries created earlier keep a harmless unused `note` column. A
  `notes IS NULL` row reads back as `[]`. Both note-aware read paths were
  re-pointed at the array: the `notes` **filter** (field key renamed `note` →
  `notes`) compiles to a per-note `EXISTS` over `json_each(notes)`, and the
  **`bundle_search` FTS index** concatenates `json_each(notes)` into its `notes`
  column. `ensure_search_schema` rebuilds the FTS table + triggers (and always
  recreates the source view) when the column set no longer matches, so an
  existing library migrates its search index on open — verified live on the Demo
  library (existing titles stayed searchable, a new note indexed).
- **Service/API.** `create_bundle`/`update_bundle` accept `notes` only (blank/
  whitespace-only blocks dropped, order preserved, ≤50). `BundleRead.notes` is
  always a list; the `note` field is gone from `BundleCreate`/`Update`/`Read`.
  OpenAPI + `apps/web/src/api/schema.d.ts` regenerated (`gen:api` reached the
  registry).
- **Frontend.** The inspector "Note" section became **NOTES** with a small `+`
  **icon** (`IconPlus`) that appends a note box below the current ones; each box
  commits on blur, and a hover `×` removes one (at least one empty box always
  remains). A synchronously-updated `notesRef` mirrors the list so a blur landing
  in the same tick as the last keystroke still commits the latest text. Each note
  box (`NoteBox`) **auto-grows** to fit its content by default (no scrollbar);
  only an explicit **drag** (>3 px) of a small centered bottom grip switches it
  to a fixed height with `overflow-y: auto` — a stray click on the grip stays in
  auto-expand, and `resize: none` on the textarea means there is **no native
  resizer/scroll-corner box** — and each note remembers **its own** height across
  sessions (`cairndex.noteHeights`, per bundle, aligned with the notes list by
  index; add/remove keep the arrays in step; double-click the grip to return that
  box to auto-fit).

Verification:

- Backend: `ruff check` / `ruff format --check` / `mypy src` clean; `pytest`
  **386 passed** (`test_bundles.py`: multi-note roundtrip incl.
  reorder/blank-strip/clear, create-with-notes, `notes IS NULL` reads `[]`,
  `notes` filter matching a non-first note + `not_contains`, non-string
  rejection; `test_search.py` gained a stale-FTS-schema rebuild test;
  `test_search.py`/`test_scan_repair.py` updated to `notes`). Same pre-existing
  Starlette/httpx deprecation warning.
- Frontend: `lint` / `format:check` / `typecheck` / `test` (**47**) / `build` /
  `test:e2e` (**50**, +1 new `edit.spec.ts` case: `+` adds a second note box and
  both persist in the PATCH body) all green.
- Live (real uvicorn + web dev server against the Demo library): the NOTES
  section renders (uppercase label + `+`); typing note 1, clicking `+`, typing
  note 2, and blurring persisted `notes = ["Synopsis…","Cast…"]` (confirmed via
  the API and a page reload); no console errors. After the single-source-of-truth
  cleanup, a fresh backend against the (existing) Demo library recreated the FTS
  view and both indexed notes: `q=xylophone` and a `note contains "penguins"`
  filter each returned only the bundle whose _notes_ held those terms; the
  throwaway bundle was then deleted (Demo back to 21).
  The box refinements were also verified live: the `+` renders as a centered
  14×14 SVG icon; an auto-mode box grew to fit multi-line text (117 px, no
  clip); dragging each of two boxes to different heights stored
  `cairndex.noteHeights = {<bundle>: [121, 71]}` and both survived a same-origin
  reload, and removing the first box left the second keeping its own 71 px height
  (the stored array spliced to `[71]`). All Demo edits were reverted afterward, so
  the Demo library is unchanged for review. (Note: synthetic browser
  `input`/`blur` events don't drive React's controlled inputs / focusout
  `onBlur`; the real path is covered by `preview_fill`/`preview_click` and the
  Playwright case.)

Known issues / out of scope: `MultiBundleInspector` still has no notes field
(bulk-overwriting prose is intentionally omitted); collections keep their single
`note`. Next: the pre-M7 owner may proceed to plan 1 M7 (web HLS integration).

## In review: media-player M6 — playback decisions + HLS session foundation

Branch `feat/playback-sessions` (off `main` after the browser-terminology
rename). Implements plan 1 M6 server-side only — the web hls.js/native-HLS
engine integration is M7. Commit subject: `feat: playback decisions + HLS
remux/transcode session foundation`.

- **Decision matrix (§6.1).** Pure `media/playback.decide_playback` +
  `CapabilityProfile` decide `direct`/`remux`/`transcode` from the client's caps
  versus the source's M1 `tech_metadata` (container from extension, video/audio
  codecs, height). Container+codecs in caps → direct; codecs in caps but
  container not → remux; else transcode. A non-default audio track or
  unsupported audio codec forces at least remux; a burn-in subtitle or an
  over-height source forces transcode. Legacy rows missing M1 keys degrade
  safely (unknown codec optimistic, never 500). Container/codec alias
  normalization (`m4v`→`mp4`, `avc1`/`h265`→`h264`/`hevc`, `mp4a`→`aac`, …).
- **Decision endpoint (§6.1).**
  `POST /api/v1/libraries/{lib}/files/{id}/playback-decision`
  (`{caps, audio_stream_index?, burn_subtitle_track_id?, max_height?}`) returns
  `method`, `reason`, `stream_url` (direct) or `session {id, playlist_url}`
  (else), plus `duration`, `audio_streams`, `subtitles`, `chapters`,
  `storyboard_url`, and resume `progress`. Non-direct decisions **start** a
  session. `GET /bundles/{id}/playback` stays the playlist-level manifest.
- **HLS session manager (§6.2, ADR-0014).** New `media/hls.py`
  (`SessionManager`, in-process dict+locks, **not** the job queue) +
  `api/v1/playback_sessions.py`. `POST .../files/{id}/playback-sessions`
  (`{caps, start_s?, …}` → `{session_id, playlist_url, kind}`),
  `GET .../{sid}/index.m3u8` (VOD fMP4 playlist computed up front from duration,
  6 s target), `GET .../{sid}/{init.mp4|{n}.m4s}`, `DELETE .../{sid}`. One
  ffmpeg per session writes segments into
  `{CAIRNDEX_DATA_DIR}/transcode/{session_id}/` (server-local ephemeral, never
  inside a library package). Segment ahead of the encoder → bounded wait; far
  seek or backward seek → kill + restart at `t=n*6` (`-ss` + `-start_number`).
  Remux copies video with an AAC audio fallback (keyframe drift accepted);
  transcode is `libx264 veryfast` + `force_key_frames` for exact 6 s segments +
  a capped ladder honoring `max_height`, optional burn-in.
- **Bounds/lifecycle/security.** `CAIRNDEX_TRANSCODE_MAX_SESSIONS` (default 2;
  structured **429** `capacity_exhausted` beyond it), idle reaper
  (`CAIRNDEX_TRANSCODE_IDLE_TIMEOUT`, default 60 s → kill + delete dir),
  teardown on DELETE and server shutdown (lifespan hook), optional decode-only
  `CAIRNDEX_FFMPEG_HWACCEL`. Session routes reuse the `LibrarySession` gate;
  random library-scoped session ids; ffmpeg args from server-side-resolved
  paths only; every ffmpeg call has a timeout/bounded wait and is killed on
  teardown (M3 no-timeout lesson applied). New `CapacityError` → 429.
- **Docs/artifacts.** ADR-0014 (proposed; owner ratification pending) + index;
  `docs/architecture.md` (new endpoints + transcode dir; resolved the
  transcode-cache-location debt item); CHANGELOG. Regenerated OpenAPI +
  `apps/web/src/api/schema.d.ts` (this time `npm run gen:api` reached the
  registry, so no manual patch was needed).

Verification:

- Backend: `UV_CACHE_DIR=/private/tmp/cairndex-uv-cache uv run ruff check` /
  `ruff format --check` / `mypy src` / `pytest` all green (**368 passed**, one
  pre-existing Starlette/httpx deprecation warning). New tests:
  `tests/test_playback_decision.py` (caps × source matrix incl. legacy rows,
  normalization, session-kind, HTTP direct decision) and
  `tests/test_hls_sessions.py` (fake-ffmpeg stub covering
  start/serve/wait/far-seek restart/backward-seek restart/idle-reap/concurrency
  bound/teardown/library-scoping; ffmpeg argv builder unit tests; a real-ffmpeg
  integration test over a tiny generated MKV doing remux **and** transcode,
  skipped with a clear message when ffmpeg is absent; HTTP decision→session,
  playlist/segment serving, DELETE, and 429 capacity).
- Frontend: `npm run lint` / `format:check` / `typecheck` / `test`
  (**47 passed**) / `build` / `test:e2e` (**49 passed**) all green. No frontend
  source changed (M6 is server-side); e2e ran non-escalated this session.
- Live (real uvicorn against a temp data dir): the Demo library's MP4s
  (`space_race`, `deep_ocean`, `waves`) decided **direct**. A throwaway 300 s
  h264+aac MKV in a temp `/tmp` library (never the Demo or any Eagle library)
  was scanned+probed, then decided **remux** ("mkv container not in client
  capabilities"); the remux session served a VOD playlist (`no-store`),
  `init.mp4`, and media segments, and `DELETE` 404'd the playlist. (The
  keyframe-derived segment count is re-verified in the review-fix pass below;
  this initial run predated that fix.)
  A forced-transcode session far-seeking to segment 40 left `[40,41,42,43]` on
  disk with a gap before 40 — proving ffmpeg was killed and restarted at the
  seek point — and `DELETE` removed the dir. A left-idle session's transcode
  dir was removed and its playlist 404'd after the idle timeout (reaper), and
  server shutdown completed cleanly (sessions torn down).

### Review-fix pass (pre-merge, same branch)

Addressed 8 review findings (4 confirmed merge-blockers) on top of the M6 slice:

1. **Lock discipline (F1).** `serve_artifact` no longer holds the session lock
   across the stat-poll wait — only to read/update state and (re)start ffmpeg —
   so parallel init+segment fetches serve concurrently and teardown kills ffmpeg
   promptly (new test: teardown during an in-flight wait completes in <3 s, not
   `segment_wait`).
2. **Burn-in + seek (F2).** Burn-in runs now seek output-side (`-ss` after
   `-i`), keeping captions in sync after a far-seek restart; non-burn-in keeps
   the fast input seek. Unit-tested command placement.
3. **Unknown-duration decision (F3).** A non-direct decision on an un-probed
   row returns 200 with `session=null` and an annotated reason instead of 422.
4. **Audio-index validation + ffmpeg failure (F4).** `audio_stream_index` is
   validated whenever supplied (422 on unknown, including un-probed rows); a
   nonzero ffmpeg exit surfaces a structured **500** (`media_processing_failed`)
   instead of a restart→404 loop.
5. **Remux tail thrash (F5).** Measured: a 120 s clip with 36 s GOPs advertised
   20 uniform segments and triggered **6** ffmpeg restarts fetching them
   sequentially. Fix: remux derives its playlist from a one-time keyframe scan
   (ffprobe `-skip_frame nokey`), mirroring copy-mux splits → same clip now
   advertises **4** segments with **0** restarts (uniform grid remains a
   fallback when the scan fails). Transcode keeps the exact 6 s grid.
6. **Session reuse (F6).** A decision retry/reload with identical
   `(file_id, params)` reuses the live session instead of 429-ing against the
   bound; a real quality/audio switch changes `params` → a new session.
7. **Docs (F7).** `docs/deployment.md` documents the new env vars and the
   `{DATA_DIR}/transcode` scratch dir (ephemeral, safe to wipe, sizing).
8. **Refactors (F8).** Promoted `playback.effective_max_height`; extracted the
   shared resolve→decide→build→create endpoint helpers; removed dead
   `HlsSession.playlist_path`; cache the VOD playlist string on the session;
   `_segment_name` helper; wired `ahead_window`/`segment_wait`/keyframe timeout
   from `Settings`.

Fix-pass verification: full backend gate green (**380 passed**, +12 new tests,
same pre-existing deprecation warning); frontend `lint`/`format:check`/
`typecheck`/`test` (**47**)/`build`/`test:e2e` (**49**) all green (no frontend
source changed; OpenAPI + `schema.d.ts` unchanged — the fixes were behavioral).
Live re-run (fresh uvicorn): Demo MP4s decided **direct**; two identical remux
decisions returned the **same** session id (reuse); the remux playlist for the
throwaway 300 s MKV advertised **12 keyframe-derived** segments (a uniform grid
would be 50) and all 12 + init served sequentially with no restart thrash;
DELETE 404'd the playlist; a forced-transcode far-seek to segment 40 left
`[40,41,42,43]` on disk (restart observed); the idle reaper removed a left-idle
session's dir; shutdown was clean.

Known issues / out of scope: no web engine wiring yet (M7); embedded
subtitle extraction to servable text tracks is M8; hardware acceleration is
decode-only in this MVP (encode stays `libx264`); audio is copied only when the
source is already AAC, else transcoded to stereo AAC; the remux keyframe scan
adds a bounded one-time ffprobe cost at first play on large files (falls back to
the uniform grid on timeout). Next recommended media-player task: **plan 1 M7 —
web HLS integration** (`PlaybackEngine`/hls.js, quality/audio menus, burn-in
option).

## In review: browsing-surface terminology rename (Bundle Browser / File Browser)

Branch `refactor/browser-terminology` (off `main` after M5). Renamed the two
browsing surfaces product-wide: "Collection/Bundles View" → **Bundle Browser**,
"File View" → **File Browser**. Owner-requested full rename including the public
API.

- **Breaking API rename:** `GET .../file-view/entries` → `.../file-browser/entries`;
  OpenAPI schemas `FileViewEntryRead`/`FileViewListingRead` →
  `FileBrowserEntryRead`/`FileBrowserListingRead`. OpenAPI + `schema.d.ts`
  regenerated. The old route now 404s (verified).
- **Backend:** `services/file_view.py` → `file_browser.py` (+ `FileViewEntry`/
  `FileViewListing` → `FileBrowser*`), `api/schemas/file_view.py` →
  `file_browser.py`, `previews.file_view_preview_cache_path` →
  `file_browser_preview_cache_path`, endpoint `list_file_view_entries` →
  `list_file_browser_entries`, `tests/test_file_view.py` → `test_file_browser.py`.
- **Frontend:** `app/FileView.tsx` → `FileBrowser.tsx` (component `FileView` →
  `FileBrowser`, `useFileView` → `useFileBrowser`, `fileViewPreviewUrl`/
  `fileViewContentUrl` → `fileBrowser*`, `FileViewEntry`/`FileViewListing`
  types), `.file-view` CSS classes → `.file-browser`, `file-view` query keys →
  `file-browser`, `e2e/file-view.spec.ts` → `file-browser.spec.ts`.
- **Docs:** prose updated across product-brief, architecture, data-model,
  plans, ADR bodies, README, AGENTS. Preserved historical branch names
  (`feat/collection-view`, `feat/collections-and-file-view`) and the stable
  ADR-0007 filename slug (title/body now read "File Browser").

Verification: backend `ruff`/`ruff format --check`/`mypy`/`pytest` (`333
passed`); frontend `lint`/`format:check`/`typecheck`/`test` (`47`)/`build`;
Playwright (`49 passed`). Live: started the real backend against the Demo
library, confirmed `GET .../file-browser/entries` returns 200 and the old
`.../file-view/entries` 404s, and drove the web File Browser tab — directory
entries render via the new route with `.file-browser__*` styling and no console
errors. No behavior change; the surfaces work identically under the new names.

## Merged: media-player M5 image viewer v2 + preview derivatives (#5)

Branch `feat/image-viewer`, merged as **#5**. Implemented plan 1 M5's image
viewer v2 and preview derivative slice, then two review fix passes (the second
fixed a progressive-upgrade stall the first pass missed — see Verification):

- Added lazy WebP preview derivatives at
  `/api/v1/libraries/{library_id}/files/{file_id}/preview?size=640|1600|2560`
  with an allowlisted size ladder, safe source re-resolution, deterministic
  linked-file cache paths under
  `.cairndex/cache/previews/{file_id[:2]}/{file_id}_{size}.webp`, quick
  fingerprint sidecars, versioned `?v={quick_fingerprint}` URLs, and immutable
  cache headers. File Browser can also request
  `/api/v1/libraries/{library_id}/file/preview?path=...&size=...`; those
  unlinked path previews use a deterministic path-hash cache key and a
  stat-derived quick fingerprint.
- Extracted shared derived-cache helpers for immutable cache headers,
  version-param escaping, `.fingerprint` sidecars, and current-cache checks.
  Image previews and storyboards now use that shared sidecar convention;
  previews use per-artifact `fcntl` locks, atomic replacement, and a bounded
  decode semaphore.
- Added Pillow + pillow-heif as lazy preview-generation dependencies. They are
  pure-wheel runtime dependencies used only when a derivative must be generated,
  and they unlock HEIC/HEIF, TIFF, BMP, and sized WebP previews for browser and
  future TV clients. PSD is not advertised openable until a tested decoder path
  exists. Preview generation remains lazy-only in this slice; no
  Update/precompute job was added.
- Preview-capable images now count as supported/openable in bundle/file payloads
  and File Browser entries. HEIC/TIFF/BMP can therefore open in the media viewer
  through preview derivatives even when the browser cannot display the original
  source bytes. Preview-only cover thumbnails route through the Pillow preview
  pipeline instead of ffmpeg, so selected HEIC/TIFF/BMP covers do not fail the
  card thumbnail path.
- Replaced the bare image stage with a transform stage: fit/fill/100% mode
  cycling, wheel zoom to cursor, pointer-drag panning, two-pointer pinch zoom,
  keyboard `+`/`-`/`0`/`1` shortcuts scoped to the viewer, zoom clamping,
  viewport-clamped pan bounds, zoom-percent display, dark/light/checkerboard
  backgrounds, resize-aware fit capped at 100% for initial fit, progressive
  source swaps after `Image.decode()`, and keyed transform/source reset when the
  selected file changes. The loader keys its effect on the discrete wanted tier,
  preserving an in-flight decode across viewport scale-only rerenders. Native
  images load thumbnail → original; non-native images load thumbnail → 1600px
  preview and request 2560px only when zoomed past 100%.
- Regenerated OpenAPI and `apps/web/src/api/schema.d.ts` for the preview route
  and new file/browse support hints. `schema.d.ts` was patched manually for this
  pass because `npm run gen:api` could not reach the npm registry in the
  sandbox after OpenAPI regeneration.

Verification:

- Backend: `UV_CACHE_DIR=/private/tmp/cairndex-uv-cache uv run ruff check`,
  `UV_CACHE_DIR=/private/tmp/cairndex-uv-cache uv run ruff format --check`,
  `UV_CACHE_DIR=/private/tmp/cairndex-uv-cache uv run mypy src`, and
  `UV_CACHE_DIR=/private/tmp/cairndex-uv-cache uv run pytest` passed
  (`333 passed`, one existing Starlette/httpx deprecation warning).
- Frontend: `npm run lint`, `npm run format:check`, `npm run typecheck`,
  `npm run test` (`47 passed`, existing jsdom media-method warnings), and
  `npm run build` passed.
- Focused review-fix checks also passed:
  `uv run pytest tests/test_previews.py tests/test_thumbnails.py
tests/test_storyboards.py tests/test_file_view.py` (`44 passed`) and
  `npm run test -- ImageStage` (`6 passed`).
- OpenAPI was regenerated with
  `UV_CACHE_DIR=/private/tmp/cairndex-uv-cache uv run python -m
cairndex.devtools.openapi > ../web/src/api/openapi.json`. `npm run gen:api`
  could not complete in this sandbox because `npx` waited on the registry path,
  so `apps/web/src/api/schema.d.ts` was patched manually to match the small
  OpenAPI delta.
- Playwright: non-escalated `npm run test:e2e` still fails before tests run
  because Vite cannot bind `::1:5173` (`listen EPERM`), but the escalated
  `npm run test:e2e` gate passed (`49 passed`). Native and non-native image e2e
  coverage now asserts the displayed `.mv-image` tier and source rather than
  only observing a request.
- Live Demo-library verification used `Photos/Vacation2025/Paris/eiffel.jpg`
  (600×800) at an 800×600 browser viewport. The actual image stage measured
  672×456 and opened at fit scale 0.57. With no interaction after open, a 10 ms
  sampler observed the displayed image advance from the bundle-file thumbnail
  to `data-tier="original"` with the `/files/{file_id}/content` source in about
  31 ms.
- Independent reviewer verification before merge (fix pass 2): all gates re-run
  green (backend 333, frontend unit 47, Playwright 49), and the same Demo
  `eiffel` bundle opened at fit 72% reached `data-tier="original"`
  (naturalWidth 600, `/content` source) with zero interaction, reproduced twice
  including a cold-cache first open. Review history: the first fix pass left
  `renderedTransform.scale` in the tier-load effect deps, so the mount →
  viewport-measure scale change cancelled the only in-flight `/content` decode
  and images never upgraded past the 480px thumbnail; the second pass keys the
  effect on a discrete `wantedTier` memo, stops cancelling in-flight decodes on
  re-run (a lifetime symbol invalidates them only on unmount; `key={file.id}`
  remounts on file switch), and the e2e now asserts the displayed `.mv-image`
  `data-tier`/src advance instead of only observing a network request.

## Merged: media-player M4 watch progress/resume (#4)

Branch `feat/watch-progress`. Implemented plan 1 M4's watch progress and resume
slice, then applied the review fix pass:

- Added `playback_progress` to each library DB via the existing additive
  bootstrap path, with `file_id` as the primary key/FK to `asset_files` and
  indexes for bundle lookup and continue-watching ordering. SQLite foreign keys
  are enabled by the shared engine pragma, so deleting an `AssetFile` cascades
  progress cleanup.
- Added `PUT /api/v1/libraries/{library_id}/files/{file_id}/progress` for
  idempotent video progress upserts, plus a POST alias for
  `navigator.sendBeacon`'s POST-only pagehide transport. The API schema
  validates finite non-negative seconds; the service clamps position to known
  duration, marks completion at `position_s / duration_s >= 0.95` only when
  duration is known and positive, and stamps `updated_at` via
  `core.time.utcnow()`. The web reporter sends the media element duration
  whenever it is finite and only sends `duration_s = null` when duration is truly
  unknown.
- Playback manifests now embed `progress` per `PlayableVideo`, batch-loading all
  listed videos' progress rows in one query. OpenAPI and
  `apps/web/src/api/schema.d.ts` were regenerated.
- Added
  `GET /api/v1/libraries/{library_id}/continue-watching?limit=20&offset=0`,
  returning the existing browse-summary row shape plus
  `progress: {file_id, position_s, duration_s}` for bundles with unfinished,
  non-zero video progress, newest progress first with a deterministic file-id
  tie-breaker.
- Moved-file repair continues to preserve progress for free because progress is
  keyed by stable `AssetFile.id`. The denormalized progress `bundle_id` is now
  aligned from a single `AssetFile.bundle_id` re-parent hook rather than
  per-call-site updates, and bundle/file deletion cascades progress cleanup
  through the active SQLite foreign keys.
- The web media viewer resumes unfinished videos once after `loadedmetadata`,
  shows a transient "Resumed at mm:ss — Click to restart" affordance, and reports
  progress every ~10 seconds of playback plus pause, close/unmount, and pagehide
  beacon. Changing files resets player time/duration/loading state before the
  next reporting window, restart explicitly writes position zero, and successful
  progress writes invalidate continue-watching only when completion state changes
  or when the viewer closes/unmounts. Bundle/file deletion invalidates
  continue-watching too.

Known issues / deferred: no dedicated Continue Watching web view was added in
this slice. The optional bundle-card progress strip was deferred because normal
browse payloads do not yet carry progress; only the required continue-watching
endpoint and viewer resume/reporting are wired. No HLS, image preview, or
multi-user behavior changed; `user_id = NULL` remains the owner convention.

Verification:

- Backend: focused review-fix check `uv run pytest tests/test_playback.py
tests/test_scan_repair.py` passed (`19 passed`, one existing Starlette/httpx
  deprecation warning). Full backend gate also passed: `uv run ruff check`,
  `uv run ruff format --check`, `uv run mypy src`, and `uv run pytest`
  (`317 passed`, same existing warning).
- Frontend: focused review-fix check `npm run test -- usePlayer
usePlaybackProgressReporter` passed (`11 passed`). Full frontend gate also
  passed: `npm run lint`, `npm run format:check`, `npm run typecheck`,
  `npm run test` (`36 passed`), `npm run build`, and `npm run test:e2e`
  (`48 passed`).
- Manual Demo-library verification: ran the local app against
  `/Users/owner/DemoLibrary`, seeded Cosmos resume progress through the API,
  opened the viewer, verified the resume seek/affordance, captured
  `/private/tmp/cairndex-m4-resume-affordance.png`, clicked restart, and verified
  the manifest reported `position_s = 0` and Cosmos no longer appeared in
  continue-watching. The Demo library has no bundle with multiple video files, so
  live file-switch verification used Cosmos video → poster image and confirmed no
  progress write targeted the image file; the multi-video stale-position case is
  covered by the Playwright regression.

## Merged: media-player M3 storyboards/trickplay (#3)

Branch `feat/storyboards`. Implemented plan 1 M3's storyboard/trickplay and
chapter-tick slice:

- Added a registry-backed `storyboard` job type and worker handler. It scans
  available video files with probed duration, skips videos below
  `CAIRNDEX_STORYBOARD_MIN_DURATION` (default 60 seconds when M3 merged; current
  default 10 seconds after the M12 follow-up), can be disabled with
  `CAIRNDEX_STORYBOARDS=off`, dedupes queued storyboard jobs per library, reports
  `storyboarding` progress, and cooperatively honors cancellation before each
  file. Running storyboard jobs do not dedupe; a follow-up queued job can sweep
  files the in-flight pass missed.
- Storyboards are generated into deterministic portable cache paths:
  `.cairndex/cache/storyboards/{file_id[:2]}/{file_id}/index.vtt` plus
  `index.fingerprint` and `sb_*.jpg` 5×5 tile sheets. As of M12, the sidecar
  stores the storyboard format plus source quick fingerprint for cheap
  request-path validation without opening the VTT; the VTT keeps the source
  fingerprint in a `NOTE` for artifact inspection.
- Added cached-only storyboard endpoints:
  `/api/v1/libraries/{library_id}/files/{file_id}/storyboard.vtt` and
  `/storyboard/{sheet}.jpg`. They never generate on request and return 404 when
  absent/stale/disabled. VTT indexes revalidate; versioned sheets use immutable
  cache headers.
- Extended playback manifests with `storyboard_url` (null until a current cache
  exists, versioned with `?v={format-and-quick-fingerprint}`) and `chapters` from
  M1 `tech_metadata`; regenerated OpenAPI and `apps/web/src/api/schema.d.ts`.
- Updated the web Update flow to run scan → probe as the blocking mutation, then
  enqueue storyboards fire-and-forget while reusing the existing sidebar job
  progress UI. Storyboard failures surface as their own job error state instead
  of failing Update. No new sidebar button was added.
- Added `StoryboardPreview` and a constrained WebVTT parser for seek-hover
  trickplay. The tooltip lazy-fetches once with `retry: false`, treats 404 as
  optional/no-preview, resolves VTT payloads like
  `storyboard/sb_001.jpg?v=...#xywh=...` by standard relative-URL rules, crops
  and scales tiles via CSS background positioning/sizing, and preloads
  neighboring sheets while scrubbing.
- Seek bar chapter starts now render visual ticks, and the hover tooltip shows
  the current chapter title beside the timestamp only inside chapter ranges or
  at/after the last chapter start. No chapter-skip keys were added.

Verification:

- Backend: `uv run ruff check`, `uv run ruff format --check`,
  `uv run mypy src`, and `uv run pytest` passed (`311 passed`, one existing
  Starlette/httpx deprecation warning).
- Frontend: `npm run lint`, `npm run format:check`, `npm run typecheck`,
  `npm run test` (`26 passed`), `npm run build`, and `npm run test:e2e`
  (`45 passed`) passed.
- Playwright includes mocked hover coverage, 404 fallback coverage, and a real
  FastAPI/Vite integration test that generates a >60s fixture, runs the probe and
  storyboard jobs through the API, opens the viewer, and verifies the preview.
- Manual Demo-library verification: ran the local app against
  `/Users/owner/DemoLibrary`, clicked **Update**, opened `trailer_neon`, hovered
  the seek bar, verified the storyboard preview loaded from a versioned URL, and
  captured `/private/tmp/cairndex-storyboards-demo.png`. Demo videos are 4–6 seconds, so this manual run used
  `CAIRNDEX_STORYBOARD_MIN_DURATION=1`; the M3 production default was 60 seconds
  and the M12 follow-up lowers the current default to 10 seconds.

Known issues / out of scope: no HLS/remux/transcode work, no subtitle upgrade, no
image zoom/pan, and no chapter-skip keys. Next recommended media-player task:
plan 1 M4 — watch progress/resume.

## Merged: media-player M2 unified media viewer (#2)

Branch `feat/media-viewer`. Implemented plan 1 M2's direct-play web viewer
slice without new runtime dependencies and without backend/API changes:

- Added `apps/web/src/app/viewer/MediaViewer.tsx` plus `VideoStage`,
  `ImageStage`, and `viewer/player/*` (`PlaybackEngine`/`NativeEngine`,
  `usePlayer`, `ControlBar`, `SeekBar`, shortcuts, idle-hide). The `HlsEngine`
  slot remains a later M8 extension.
- Replaced the old bundle playback modal and bundle-file lightbox entry points:
  bundle double-click, the inspector play affordance, and bundle-album file
  double-click now open the unified viewer. `Player.tsx` and `FileViewer.tsx`
  were removed.
- Direct-play videos now use custom auto-hiding controls, root fullscreen,
  PiP, MediaSession metadata/actions, snapshot PNG download, speed 0.25–3x
  with pitch preservation, volume/mute, buffered seek/scrub UI, subtitle
  on/off over existing external VTT tracks, and the M2 keyboard map scoped to
  the open viewer.
- Player preferences (`volume`, `muted`, `rate`, `subtitlesOn`) persist inside
  the existing `cairndex.prefs` localStorage object with legacy-default
  merging. Review fix pass: Workspace/App remains the single prefs writer,
  player updates are functional so same-tick writes compose, localStorage writes
  are debounced and flushed on pointer-up/page unload, and raising volume
  un-mutes consistently from keyboard or slider paths.
- The viewer handles loading, empty bundles, query errors, missing files,
  unsupported/unplayable videos, and image preview errors with structured
  fallback states. The inline bottom file filmstrip was removed after owner
  review because it overlapped the video control bar; current M2 navigation is
  previous/next only.
- Review fix pass hardened the native player mount path: `usePlayer` now keys
  engine creation, listener attachment, and persisted volume/mute/rate
  application on the actual `<video>` element identity; controller commands read
  live media time where needed; `PlaybackEngine` exposes an `on(event, cb)`
  listener seam for the future M8 HLS engine; MediaSession commands use refs
  while metadata depends only on title/artwork.
- Review fix pass also scoped shortcuts to the focused viewer root, made `Esc`
  exit fullscreen before closing, lets left/right step files when no playable
  video is active, shares one filtered subtitle source list with native
  `<track>` identity/default-track selection, uses shared fallback cards for
  Media Viewer and File Browser, and replaced emoji control glyphs with SVG icons.
- Reviewer verification pass (live, against the local Demo library): cold-cache
  open shows a live clock/seek bar/play state (the original mount-race is
  fixed); player prefs survive subsequent browse-pref writes; muted slider
  drags land exactly and unmute; image files arrow-step between bundle files;
  Esc closes the viewer when not fullscreen (entering fullscreen can't be
  exercised in the headless preview — that branch is code- and unit-test
  verified; worth one manual spot check). One residual bug found and fixed in
  the same pass: Chromium's automatic text-track selection could flip a
  second language to `showing` after its cues loaded, stacking two subtitle
  lines on initial open — `VideoStage` now re-asserts track modes on each
  `<track>` load event (verified live on the two-subtitle DeepOcean bundle:
  only the selected track shows, and disabled tracks skip their cue fetch).
- File Browser still uses `FileEntryViewer` with path-based URLs and native
  browser controls, but now shares the fallback card component. Follow-up:
  migrate File Browser onto the same viewer/stage primitives when plan 1 reaches
  the path-based File Browser completion work.
- Follow-up recorded in plan 1: replace the removed inline file list with an
  expandable bundle-files side panel, and expand the right-side metadata panel
  into a first-class file/bundle metadata drawer.
- Dev tooling: `apps/web/vite.config.ts` honors a `PORT` environment override,
  and `.claude/launch.json` uses automatic port assignment.

No Pydantic/OpenAPI surface changed, so OpenAPI and
`apps/web/src/api/schema.d.ts` were not regenerated. Next recommended task for
the media-player track: plan 1 M3 — **storyboards/trickplay** (the owner
re-sequenced plan 1 after M2: subtitle depth moved to M8 behind HLS, and dual
subtitles are far-deferred to M9 at the earliest).

Verification: frontend `npm run lint`, `npm run format:check`,
`npm run typecheck`, `npm run test` (18 tests), `npm run build`, and
`npm run test:e2e` (41 Playwright tests) passed. Player e2e now includes an
unmocked tiny ffmpeg-generated MP4 smoke test that verifies real media time and
the visible clock advance; it skips with a clear message when ffmpeg is
unavailable. Manual verification against the local Demo library
(`/Users/owner/DemoLibrary`) used a cold browser page on `trailer_neon` and
confirmed the real stream advanced to `0:01 / 0:04` with persisted
`volume=0.5`, `muted=true`, and `rate=1.25`; screenshot captured at
`/private/tmp/cairndex-media-viewer-demo.png`. Backend gates were not run
because this slice did not touch backend code.

## Merged: media-player M1 probe enrichment (#1)

Branch `feat/probe-enrichment`; latest commit subject:
`feat: enrich media probe metadata`. Implemented plan 1 M1 server probe
enrichment for the first-class media-player foundation:

- `ffprobe` now runs with `-show_chapters` and stores additive
  `AssetFile.tech_metadata` keys: `audio_streams` (all audio streams with
  index/codec/channels/language/title/default), `subtitle_streams`
  (index/codec/language/title/default/forced), `chapters` (float-second
  start/end/title), `hdr` (`hdr10`/`hlg`/`dv`/`null`), `bit_depth`, and
  `probe_version`.
- Existing metadata keys used by current playback and browse flows remain
  present and compatible: `width`, `height`, `duration`, `video_codec`,
  `audio_codec`, `embedded_subtitles`, etc. `embedded_subtitles` remains in the
  legacy shape consumed by embedded subtitle-track sync.
- The existing **Collect metadata** probe job still uses the `probe` job type but
  keeps its normal empty payload. Routine probes skip only rows whose
  `tech_metadata.probe_version` matches the current probe version, so rows
  probed before M1 refresh once and future Updates stay incremental. Internal
  callers can still use `probe_library(..., reprobe=True)` for explicit full
  re-probes.
- No database schema, migration, OpenAPI, or frontend API type changes were
  needed because `tech_metadata` remains an opaque JSON dictionary on the
  existing API surface.

Tests/verification: backend `uv run ruff check`, `uv run ruff format --check`,
`uv run mypy src`, and `uv run pytest` are clean (`301 passed`, one existing
Starlette/httpx deprecation warning). Focused tests cover canned HDR
classification, generated multi-audio/subtitled/chaptered media, the existing
Collect metadata version-refresh path, current-version incremental skips, and
legacy `tech_metadata` playback-manifest degradation. Manual verification probed
a throwaway generated library and showed the new keys on a
multi-audio/chaptered/subtitled MKV.

Known issues: none for M1. M2 has since merged; next recommended media-player
task is plan 1 M3 — storyboards/trickplay (subtitle depth was owner-deferred
to M8 behind HLS; dual subtitles to M9+).

## Earlier: client platform & media experience plans (docs only)

Branch `docs/client-platform-plans` (repo renamed VaultLeaf → Cairndex; this is
the first work in the new repo). Owner-requested detailed technical plans for
three post-first-release initiatives, plus the cross-cutting server foundations
they share:

- `docs/plans/README.md` — strategy overview, reuse map, repo strategy
  (desktop shell in this monorepo at a future `apps/desktop`; Android TV in a
  future separate `cairndex-android` repo), shared server foundations, and the
  recommended phase order (server foundations → web player/viewer → HLS →
  desktop shell → TV → multi-video wall).
- `docs/plans/01-web-media-player-and-viewer.md` — unified media viewer,
  custom headless player (probe enrichment, embedded-subtitle extraction,
  storyboards/trickplay, watch progress, image preview derivatives, playback
  decision endpoint, bounded HLS remux/transcode sessions, hls.js
  integration, zoom/pan image stage), 9 milestone slices.
- `docs/plans/02-android-tv-client.md` — technology study (native
  Kotlin/Compose for TV + Media3 chosen over web/RN/Flutter), repo/module
  layout, device pairing/bearer tokens, 10-foot browse UX, player, and the
  priority **video wall** (1×2/2×2) with decoder-budget policy, 8 milestones.
- `docs/plans/03-macos-desktop-app.md` — Tauri 2 shell hosting `apps/web`,
  platform abstraction seam, manifest-UUID-validated library path mappings,
  reveal/open-with (ADR-0007), drag-out/drag-in, native menus, 5 milestones.
- `docs/adr/0012-client-platform-strategy.md` — **accepted (owner-ratified
  2026-07-04)** after a decision-by-decision review: Tauri 2/WKWebView
  confirmed for macOS (Electron is the recorded fallback), custom headless
  player confirmed with the UX bar set to desktop-native players
  (**Movist/Elmedia/IINA** — Eagle's own player is explicitly _not_ the
  playback reference), and a separate `cairndex-android` repo confirmed for
  the TV client. Plan 1 gained the Movist/Elmedia-inspired features (dual
  simultaneous subtitles, subtitle styling, A-B loop, snapshot capture,
  video adjustments, configurable seek step) and a new M9 polish slice.
  Also fixed the stale ADR index (0011 was missing).

Post-ratification owner additions (same day): confirmed seek-bar hover
trickplay is covered (plan 1 §4.2/M4), and requested two non-priority export
features now specced as plan 1 §10 + milestone M11 — **GIF-from-snippet** and
**contact-sheet generation** (metadata header + timestamped frame grid),
server-generated via bounded interactive export tasks, download-only (never
written into the library root), desktop-first with native save/notification
hooks in plan 3 D5, web included, TV excluded.

Owner then prioritized **library write mode** as the next major initiative
after the core player (ahead of desktop/TV), so it is now planned in full:
`docs/plans/04-library-write-mode.md` + **ADR-0013 (accepted — owner-ratified
2026-07-04)**. Design pillars: per-library opt-in gate stored in the
registry (never the portable manifest) + deployment master switch;
trash-first deletion into `.cairndex/trash/` with a `trashed` availability
state so restores are lossless; a `file_operations` journal in `library.db`
(intent-before-action, reconciler on open, Undo); in-app move/rename updates
`relative_path` preserving `AssetFile.id` (no repair needed by construction);
no in-place overwrites — path collisions surface an Eagle/Finder-style
**Replace / Skip / Keep both** prompt (owner requirement) where Replace is
journaled trash-then-write, recoverable until Empty Trash; bulk ops as jobs
on the existing single-worker queue.
Slices W0–W6; W2 closes the exports-into-library open item (save contact
sheet/GIF, link to bundle, set as cover); W5 enables the desktop drag-in
copy. Note: W0 must amend the AGENTS.md/CLAUDE.md "never rename/move/delete"
safety wording to carve out journaled write-mode operations (recorded in
ADR-0013 consequences).

No code changes; no gates run (docs-only). Next recommended task for this
track: plan 1 M1 (probe enrichment). The pre-existing next tasks below still
stand for the core web app.

## Latest merged: collection & bundle ordering UX (#47)

Merged as **#47** (`feat/collection-bundle-ordering`). Six reviewable slices plus
five rounds of review-feedback follow-ups (summarized below):

- **Slice 0 — data model.** New `asset_bundle_collections.sort_order`
  (per-collection bundle order) and `asset_bundles.manual_order` (global bundle
  order), both `server_default 0`, patched into existing library DBs via the
  additive `ensure_content_indexes` bootstrap (no migration chain).
- **Slice 1 — collection ordering.** Collections order by `sort_order` (name
  tie-break) in both the sidebar tree and the main-browser folder cards; native
  drag-reorder in either surface updates both (`PUT …/collections/reorder`).
  `create_collection` appends after siblings. "Clean up by… Title" A–Z/Z–A
  (`POST …/collections/cleanup-order`). Shared `moveBefore()` + `CleanupOrderDialog`.
- **Slice 2 — bundle manual order.** `BundleSort.MANUAL` (membership order inside
  one collection, global `manual_order` elsewhere); Toolbar **Manual** sort +
  drag-reorder in `Browser`; "Clean up by…" over the five toolbar sorts × asc/desc
  (`PUT …/bundles/reorder`, `POST …/bundles/cleanup-order`). Drag is best-effort
  over the loaded window; cleanup is the deterministic full-scope rewrite.
- **Slice 3 — flatten subcollections.** "Show subcollection contents" now also
  flattens every descendant collection into the Subcollections section
  (depth-first, manual order).
- **Slice 4 — folder-card context menu.** Right-click folder cards → Delete
  Collection / Delete N Collections (multi-select); generalized
  `RemoveCollectionDialog` for multi-delete.
- **Slice 5 — decoupled sizing.** Folder cards follow their own smaller curve off
  the shared zoom slider (`collectionCardWidth`, max ~180px by mid-slider); slider
  floor dropped to 80px.
- **Slice 6 — Shift-range select** for bundle cards and folder cards.

Verified: backend `ruff`/`ruff format --check`/`mypy` clean, `pytest` **288
passed** (new: engine ensure-columns in `test_models`, collection reorder/cleanup/
append in `test_taxonomy`, bundle MANUAL ordering + reorder/cleanup in
`test_browse`). Frontend `lint`/`format:check`/`typecheck`/`vitest`/`build` clean;
Playwright **37 passed** (new `e2e/ordering.spec.ts`). Manually verified against
the local Synthetic Library via the browser preview (decoupled sizing, Manual sort

- Clean up button, flatten → 165 descendants, folder Delete-Collection menu,
  Shift-range select) plus a reversible live `collections/reorder` round-trip
  (swapped then restored the root order). OpenAPI + `schema.d.ts` regenerated.

Out of scope / known limitation: bundle drag-reorder only rewrites the loaded
window (use "Clean up by…" for a full deterministic order); reparenting collections
by drag is not a gesture here (drag reorders within a sibling group only).

**Follow-up refinements (same branch, review feedback):** bigger folder
thumbnails (cap ~2/3 of the slider — see `collectionCardWidth` in
`apps/web/src/app/layout.ts`); "Clean up…" moved out of an inline button into the
folder-section / empty-grid right-click menus and the sidebar Collections heading;
foldable **Collections**/**Smart Collections** sidebar sections (hover caret +
highlighted label); the **Show subcollection contents** toggle now also appears in
the All view; drag-reorder reworked to **gap insertion** with an accent
insertion-line (replacing the edge highlight) across the bundle grid, folder
cards, and sidebar; **Manual** is now the first/default sort (persisted prefs
remember any later choice); a new **sort-control popover** (`SortControl.tsx`) with
sort field, asc/desc, and a **per-collection** scope checkbox (each
collection/view remembers its own sort); card text no longer highlights during
multi-select; double-click-to-open / single-click-metadata confirmed. New
`cairndex.sidebar.*` + expanded `cairndex.prefs` (sortScope/collectionSorts)
persisted keys; `e2e/ordering.spec.ts` updated (6 specs). All gates green;
Playwright 39 passed.

**Second follow-up round (review feedback):** chevron fold icons (bigger on the
sidebar section headings); the **All tab** now shows top-level collections +
_uncategorized_ bundles by default and flattens to everything with the toggle
(there is no global manual order — reorder/"Clean up…" are disabled and greyed
when flattened); **cross-surface drag** to reparent collections (center = into,
edge = reorder) and move bundles into a collection (Alt = add without removing),
in both the sidebar and the main browser (`app/dnd.ts` `DragItem`/`dropZone`,
App-level `dragItem`, `PATCH …/collections/{id}` `parent_id` reparent, batch
add/remove for bundle moves); bundle-album file selection (click/drag/Shift, the
inspector keeps the bundle) + **"Locate in File Browser"**; drag-select on **list
rows** (bundle + file views) and Shift-range file selection. All frontend gates
green; Playwright 39 passed. Verified in the browser against the Synthetic Library
(incl. a reversible live reparent + move round-trip).

**Third follow-up round (review feedback):**

- Fold arrows reverted to a **solid disclosure triangle** (slightly larger, kept
  narrow) — `IconChevron` in `app/icons.tsx`, `.chevron`/`.chevron--lg` sizes.
- **Collection drag-reorder reliability:** the drop zone is recomputed from the
  cursor at drop time (a stale hover slot no longer turns a reorder into a
  reparent); cross-parent edge drops reparent+reorder (`moveCollection` in
  `App.tsx` = `PATCH parent_id` then `collections/reorder`), so a subcollection
  can be dropped out to the **top level**; a `CollectionListEnd` drop zone below
  the last sidebar row catches drags "behind the last collection".
- **Alt/Option bundle drag** fixed on macOS (drag advertises `copyMove` +
  reflects copy/move cursor) so add-to-collection-without-removing works.
- **Stuck "drop into" highlight** fixed by gating folder-card / sidebar-row drop
  feedback on the live `dragItem` (a bundle drag begins in the Browser and never
  fires those surfaces' `onDragEnd`).
- **File Browser directories** now join drag-select + Shift-range select like
  files (bundling targets still filter to files).
- **"Review grouping" → "Suggest grouping" (ADR-0011):** the user-facing
  **"Needs review" badge was removed** while internal provisional/confirmed
  state remains the grouping boundary. The 2026-07-14 amendment removed the
  manual-only `uncategorized` scope after it caused repeated suggestion
  generation to reopen confirmed bundles.

Verified: backend `ruff`/`format`/`mypy` clean, **pytest 291 passed** (new
`tests/test_grouping_scope.py`). Frontend `lint`/`format`/`typecheck`/`vitest`/
`build` clean. Browser-verified the triangle icon and the "Suggest grouping"
rename / removed review badge against the Synthetic Library; native DnD and the
File Browser weren't exercisable there (synthetic files aren't on disk). The
former categorization-driven pass was covered by unit/service tests and has
since been removed by the ADR-0011 amendment above.

**Fourth follow-up round (review feedback):**

- Fold caret made **much narrower** (`.chevron` 9×13, `--lg` 11×15;
  `.collection-row__toggle` 12px) so it barely widens a row.
- **All tab reverted** to "every top-level collection + every bundle flattened";
  the "Show subcollection contents" toggle is gone from the All view (kept inside
  a collection), and bundle reorder / Clean Up are disabled there (`isAllView`
  gating in `App.tsx`; `browseView` no longer special-cases `uncategorized`).
- **Reorder past the content edge** now lands at the beginning/end via
  container-level drop handlers (`Browser` root, `CollectionHeader` `.collhead`),
  plus the existing sidebar `CollectionListEnd`.
- **Drag hint** pinned lower-left (`.drag-hint`, driven by App `dragItem`): plain
  = move, ⌥ Option = copy (bundles).
- **File Browser list drag-select** no longer draws a rubber-band box (row
  highlight only in list; box kept in grid) — `Browser`/`FileView` gate the
  `.marquee` on non-list / grid layout.
- **File Browser "Date Added"** column + sort: `created_at` added to
  `services/file_view.FileViewEntry` (+ schema, OpenAPI/client regenerated) from
  `st_birthtime`/`st_ctime`; FileView shows a column and a sort option. New
  `test_file_view` assertion.
- **Sidebar order:** Unbundled moved above Missing Files (`SYSTEM_VIEWS`); All
  Tags moved to the bottom of the system section.

Verified: backend `ruff`/`format`/`mypy` clean, **pytest 292 passed**; frontend
gates clean, **Playwright 39 passed** (updated the empty-space Clean Up spec to
enter a collection first). Browser-verified the narrow caret, the All-tab counts
(313 top-level collections + 100k bundles, no toggle), the sidebar order, the
lower-left drag hint, and the File Browser "Date Added" sort option against the
Synthetic Library. The reorder-past-edge and list drag-select (real files) rest
on the gates + code review (native DnD / on-disk files aren't exercisable in the
Synthetic Library).

**Fifth follow-up round (review feedback):**

- **Sidebar collection tree redesign:** compact rows (`.collection-row` gap 3 /
  4px inset), and hierarchy guide rails via a rebuilt shared `PickGuides`
  (ancestor `trail: boolean[]` + `isLast` → per-level vertical rule + elbow that
  bends into the last child). Threaded `trail`/`isLast` through `CollectionBranch`.
  `.pick-guide` CSS now centres the line and draws the elbow; `--guide-bleed`
  joins rails across rows. Same guides shared by the tag/collection pickers.
- Distinct icons (`icons.tsx`): `IconFolderQuestion` (Uncategorized),
  `IconTagQuestion` (Untagged); All Tags keeps the plain tag.
- File inspector: **Date Added** + **Date Modified** (renamed) with time
  (`formatDateTime`). Removed the **"openable"** list badge (updated two e2e
  specs to assert its absence). Restored the list-view marquee box (the prior
  removal was wrong). Terser drag hint.
- **Edge-drop:** the sidebar end-of-list drop zone expands to 72px min-height
  while a collection drag is live.

Verified: frontend `lint`/`format`/`typecheck`/`vitest`/`build` clean,
**Playwright 39 passed**. Browser-verified the compact tree + guide rails
(elbow/last-bend via classes; line aligns to the parent caret, matching Eagle),
the distinct Uncategorized/Untagged/All-Tags icons, and the drag hint text
against the Synthetic Library. No backend changes this round.

## Previously merged: ad-hoc filters + tag management (#46)

Eagle-like ad-hoc filtering + tag management, merged as **#46**
(`feat/adhoc-filters-tag-mgmt`), in three reviewable slices on top of `main`
(which already included the collection-view GUI rework, #45).

- **Slice 1 — ad-hoc Tags filter.** A funnel button in the bundle toolbar reveals
  a filter row with a **Tags** chip. Its popover has an Any/All/Equal rule + a
  subtags toggle, tag-group tabs (display-only scoping), search, and a tag tree:
  left-click includes, right-click excludes (mutually exclusive; browser context
  menu suppressed). Counts are **faceted** — a new
  `POST /filters/facets` endpoint returns tag/rating counts scoped to the current
  browse context and the _other_ active categories (never global static counts),
  with parent-tag counts rolled up as distinct-bundle counts in Any/All or direct
  in Equal. `apply_scope()` was extracted in `services/browse.py` so the grid,
  its counts, and facets scope identically. Tag Equal/direct needs no new AST —
  it maps to `contains_any` with `include_descendants=false`.
- **Slice 2 — Rating filter.** A rating-specific `is_null` compiler operator
  (Unrated). Toolbar Rating chip = star row + `=`/`≥`/`≤` + an Unrated row; the
  Smart Collection editor's rating row uses the same star picker and an "is
  unrated" operator, so saved collections round-trip it.
- **Slice 3 — All Tags page.** A sidebar entry (below Untagged) opens a
  management surface (`mode='tags'`): left panel (All / Uncategorized / groups,
  each with a tag count) + an Eagle-style, pinyin-segmented, multi-column
  **accordion grid** of top-level tags that expand in place to reveal children
  (folded = rolled-up subtree count, expanded = direct). **Drag reparents** a tag
  (onto another = nest; onto empty space = top level); the tree is name/pinyin
  ordered, so manual sibling ordering was dropped (the `PUT /tags/reorder` and
  `PUT /tag-groups/{id}/tags/order` endpoints were removed). Backend safe tag
  delete blocks a
  parent with children. Double-clicking a tag applies a global Equal/direct
  filter. (Initial cut was a single-column drag-reorder tree; reworked per review
  into the accordion grid with reparent-by-drag.)

Both toolbar filters and Smart Collections compile to the one canonical
FilterExpression AST and stack under AND with the view/collection and text search.

Verified: backend `ruff`/`ruff format --check`/`mypy` clean, `pytest` green
(new `test_facets.py`; rating/tag/reorder cases in `test_filters.py`/
`test_taxonomy.py`). Frontend `lint`/`format:check`/`typecheck`/`vitest`/`build`
clean; Playwright green (new `e2e/filters.spec.ts`, `e2e/all-tags.spec.ts`, plus
the Smart Collection unrated round-trip). Manually exercised against the local
Demo Vault (Tags include/exclude, Rating stars + Unrated=22, All Tags page,
double-click→global Equal filter) — all metadata-only, no demo data mutated.

Out of scope (explicit follow-ups): Types filter, Collections toolbar filter,
Starred tags, exact tag-set equality, URL/localStorage persistence of ad-hoc
filters.

## Earlier: `feat/collection-view` (merged, #45)

GUI-only work. Treat this section as the collection/browse UI history; the rest
of this doc is backend/maintenance history.

Latest session's changes (frontend-only, no backend files touched):

- **Subcollection cards get the same left-click marquee drag-select as the
  bundle grid** (`useMarqueeSelect`, scoped to `.collcard__grid`/`.collhead`
  so a drag there can't also pick up bundle cards), plus click-on-empty-space
  deselects. Subcollection selection (`selectedCollectionIds: Set<string>`)
  and bundle selection (`selectedIds`) are mutually exclusive — selecting one
  clears the other.
- **The "All" view now shows root-level collections as cards** above the
  bundle grid, via the same `CollectionHeader` component used inside a
  collection (generalized with a `sectionLabel` prop: "Collections" at the
  root, "Subcollections" inside a collection).
- Folder cards got a **stacked-sheet visual** (offset box-shadow "sheets")
  and their footer shows **both** the direct bundle count and the
  subcollection count.
- **Collection and bundle titles commit on Enter**, not just blur.
- Fixed: bundle cards showed a duration badge on image bundles when the
  primary file's metadata had a stray `duration` — now gated on `media_kind
=== 'video'`.
- **Removed the top "batch bar"** (`BatchBar.tsx`, deleted) for 2+ selected
  bundles. Replaced with a right-panel `MultiBundleInspector`: title
  overwrites all, rating shows the common value (or unset) and overwrites all,
  tags/collections common to every selected bundle show as assigned and
  toggling adds/removes across the whole selection (via the existing
  `POST /bundles/batch` endpoint — no backend change needed), size/files are
  summed. No note field (bulk-overwriting prose doesn't make sense). New
  hooks: `useCommonBundleTags`, `useCommonBundleCollections`,
  `useBulkUpdateBundles` (parallel PATCH per id, no `If-Match` — a bulk
  overwrite is an explicit one-shot action and per-row versions aren't loaded
  in the browse grid).
- Right-click context menu items are now consistently Title Case.

Verified: frontend `lint`/`format:check`/`typecheck`/`vitest` (9)/`build`
clean; Playwright **24/24** passed (added a subcollection-marquee test and
rewrote the multi-select test for the new right-panel editor). Manually
exercised in the browser preview (marquee + deselect on both bundles and
subcollections, Enter-commit on both title fields, bulk rename/rating/
tag-picker/collection-picker on a real 2-bundle selection against the local
demo library, then reverted those demo-data edits via direct API calls so the
demo library is unchanged for review).

**Follow-up fixes session (same day):**

- **Fixed a marquee-drag runaway-scroll bug.** The drag-selection overlay was
  sized from raw, unclamped mouse coordinates; dragging past the loaded
  content inflated the container's scrollable area (since the overlay is an
  absolutely-positioned child of an `overflow: auto` container), and because
  that gave auto-scroll more room to advance — which let the overlay grow
  further — the two fed each other every animation frame. A ~400px drag
  paused near the bottom edge for ~1s inflated one container's scrollable
  height from 232px to 14,198px, confirmed via direct DOM measurement before
  and after the fix. Fixed in `useMarqueeSelect.ts` by clamping every
  content-space point to the wrapper's true `scrollWidth`/`scrollHeight`,
  measured once at drag start (before the overlay exists) — applies to both
  the bundle grid and the collection cards (shared hook). No dedicated
  automated test added (hard to assert scrollHeight growth reliably in
  Playwright); verified via direct `scrollHeight` measurement in the browser
  preview before/after, with mouseup/mousemove sequences reproducing the
  original bug.
- **"Create '<search>'" in the tag/collection pickers.** Typing a search (in
  the single-bundle TagEditor/CollectionPicker, and the multi-bundle bulk
  editor's pickers) shows a "+ Create "…"" row whenever the search doesn't
  already name an existing tag/collection _exactly_ — including when it's a
  substring of one (searching "Act" while "Action" exists still offers to
  create "Act", alongside the "Action" partial match; first cut only showed
  it when there were zero matches at all, corrected same-day per feedback).
  Clicking it creates a top-level tag/collection and assigns it immediately.
  New `POST /tags` client call + `useCreateTag` hook (the endpoint already
  existed; only the frontend was missing). e2e-covered (both single-bundle
  pickers, incl. the partial-match case); the multi-bundle picker's create
  path shares the same `BulkPicker` component and is exercised the same way
  manually.
- Empty-inspector placeholder now says "Select a bundle or collection…".
- Confirmed (not a bug): a collection with only subcollections and no direct
  bundles already resolves its cover correctly from anywhere in its subtree
  (`resolve_cover_bundle_id` walks the full recursive descendant set, not
  just direct children) — covered by
  `test_collection_cover_prefers_chosen_bundle_then_auto_picks`.

Verified: frontend gate green again (lint/format/typecheck/vitest 9/build);
Playwright **27/27** (3 create-tag/create-collection tests, incl. the
partial-match case). Manually verified the runaway-scroll fix and all create
flows (incl. partial-match) in the browser preview against the real demo
library, then reverted the demo-data mutations (2 created tags + 1 created
collection, across both rounds) via direct API `DELETE` calls.

Not yet a PR — branch also carries the prior collection-view slices (picker
redesign, empty-collection sidebar fix, collection inspector, cover cards)
from earlier sessions.

## Latest merged milestones

Maintenance-readiness sequence, merged as four independent PRs (#38–#41):

- **#38 — Job progress & observability (`feat/job-progress-observability`).**
  Scan/probe/thumbnail jobs report a coarse `phase` + `message` with throttled
  registry progress writes and path-redacted terminal errors; the sidebar shows
  a live determinate/indeterminate progress bar under Update.
- **#39 — Large-library perf baselines + indexing (`perf/large-library-baselines`).**
  `cairndex.devtools.synthetic_library` + `benchmark_queries` devtools; measured
  SQLite indexes (`asset_files.bundle_id` + association-table reverse indexes,
  backfilled by `ensure_content_indexes` on library open) and a non-correlated
  membership **semijoin** in the filter compiler and browse. Browse went from
  ~5.4 s to ~12 ms and view-counts ~12 s to ~14 ms at 5k bundles; all paths stay
  interactive at 100k. Baselines in `docs/performance.md`.
- **#40 — Whole-library indexed search (`feat/indexed-metadata-search`).**
  Per-library `bundle_search` FTS5 index (title/note, file
  title/filename/path/source/media-kind, tag + collection names) kept fresh by
  SQLite triggers; browse gained a `q` param composed as an FTS semijoin;
  `cairndex.devtools.reindex_search` rebuilds it. The toolbar search now covers
  the whole library, not the loaded window.
- **#41 — Per-library passphrase lock (`feat/per-library-passphrase-lock`, ADR-0010).**
  Optional owner passphrase per library (PBKDF2 hash in the manifest), unlocked
  via a library-scoped in-memory server session (opaque HTTP-only cookie), gated
  in `get_library_session`; `set_passphrase` CLI + frontend LockScreen. A private
  LAN/Tailscale guardrail, not public-internet hardening or multi-user auth.

Before this sequence, PR #37 (`feat/remove-and-context-menu`) added web-UI
removal of bundles/collections and right-click context menus (metadata-only,
`cascade` param on `DELETE /collections/{id}`).

## Earlier branches

ADR-0008 / ADR-0009 work landed on `feat/scan-grouping-review`.

ADR-0008 is implemented: Cairndex now uses portable per-library metadata
packages (`<root>/.cairndex/{manifest.json,library.db,cache/}`) plus a separate
server-local registry DB for registered libraries and the runtime job queue. The
old global storage-root content model and Eagle importer are removed from the
current product path.

ADR-0009 (suggestion-based bundle grouping, Option A+) is functionally rolled
out. The scanner still performs conservative discovery/repair first and stages
new files as provisional bundles. Scan jobs now also persist a durable grouping
plan without applying it, so grouping remains a user-reviewed decision.

PR 36 was the UI/workflow follow-up before the removal/context-menu milestone:
the sidebar exposes one primary **Update** action, with individual **Scan new
files**, **Collect metadata**, and **Review grouping** actions in the overflow
menu. Update waits for scan/grouping plan generation and ffprobe metadata
collection, invalidates affected queries, and opens grouping review when a scan
produced suggestions.

## Earlier milestone: unbundled staging + manual bundling assistant

> Historical note (long merged). The current work is the media-player
> foundation — see the M1–M4 sections at the top of this file and
> `docs/plans/` for the roadmap.

**Unbundled staging + manual bundling assistant (branch
`feat/manual-bundling`).** Scan-staged provisional bundles are now surfaced only
in a dedicated **Unbundled** view (hidden from All/Recent/Collections), and a new
`cairndex.manual_bundling` service + `/manual-bundling/*` API + web dialogs let
the owner turn unbundled files into confirmed bundles by hand with automatic,
never-auto-applied suggestions. All metadata-only; see the notes below and
`CHANGELOG.md`. Two follow-up fixes on top: removing a file from a bundle (the
inspector ×) now re-stages it back into **Unbundled** instead of unlinking it
(shared `_restage_file` helper with `delete_bundle`), and a changed cover now
shows without a manual refresh via a `cover_key` cache-buster on browse summaries
and the inspector thumbnail URL. Backend `uv run ruff check/format --check/mypy`
clean, `pytest` 265 passed; frontend typecheck/lint/format/test/build clean and
Playwright 17 specs pass (incl. `e2e/manual-bundling.spec.ts`). Not yet merged.

**Maintenance-readiness sequence complete (#38–#41).** Job progress, large-library
browse indexing + benchmark tooling, whole-library FTS5 search, and an optional
per-library passphrase lock all landed. The next candidates are richer
edit-before-apply grouping review, File Browser write-mode planning, and search
relevance ranking (see _Next recommended tasks_).

The grouping/maintenance flow it builds on is unchanged — the normal maintenance
path matches the intended product model:

1. scan the active library root;
2. repair high-confidence moves without changing original files;
3. stage new files in provisional bundles;
4. generate and persist a reviewable grouping plan;
5. collect technical metadata;
6. let the user accept selected grouping proposals.

Applying a grouping plan is the only operation that confirms scan-staged
bundles, creates suggested logical collections, assigns roles, selects
cover/primary files, links external subtitles, or adds newly discovered files to
an existing confirmed bundle. It never moves, renames, deletes, or rewrites
original files.

## Current implementation notes

- **Primary maintenance flow:** **Update** is the main sidebar action. It runs
  scan + grouping-plan generation first, then probe. The overflow menu keeps
  scan-only, probe-only, and review-only actions for exception cases.
- **Grouping review:** The modal shows the persisted plan, explains that
  regeneration reruns the same heuristic against current library state, and
  supports checkboxes, cascading parent toggles, **Select all**, **Deselect all**,
  and **Accept selected**.
- **Selected accept semantics:** `POST /grouping/plans/{id}/apply` accepts an
  optional `proposal_ids` list. When supplied, only those proposals are applied;
  the plan is then marked applied, so unchecked proposals are intentionally left
  unapplied for that plan. Regenerate suggestions after library changes if the
  owner wants a fresh plan.
- **Unbundled staging (file-first):** scan-created provisional bundles
  (`grouping_state = provisional`, `grouping_source = scan_suggestion`) are treated
  as _unbundled files_ and hidden from All/Recent/Uncategorized/Untagged/Missing
  and every collection (browse keeps a `view=unbundled` + count for the hiding
  logic). The two top-left tabs are **Bundles** (renamed from Collections) and
  **Files**; the sidebar **Unbundled** view opens the **Files** surface as a flat,
  cross-library list of not-yet-bundled files (`GET /manual-bundling/unbundled-files`)
  with the file inspector. File Browser entries carry a derived `unbundled` flag and
  badge each path `unlinked` / `unbundled` / (openable).
- **Manual bundling assistant:** `cairndex.manual_bundling` confirms unbundled
  files by hand — add to an existing confirmed bundle, create a bundle from
  selected files, create an empty bundle, or add suggested files from a bundle’s
  inspector — reachable by right-clicking files in either Files surface.
  Suggestions (target bundles / unbundled files / a bundle draft) are automatic on
  dialog open, ranked with a confidence + reason, and computed only from the DB +
  FTS index; applying is always explicit and metadata-only (files re-parented,
  emptied provisional bundles reaped, subtitles auto-linked). Apply/suggest accept
  `relative_paths` as well as `file_ids`; an unlinked File-View path is staged as
  provisional at apply, and a path in a confirmed bundle is rejected. Shared
  membership logic lives in `grouping/membership.py`.
- **Hidden/cache exclusions:** scan and grouping ignore dot-directories/files and
  known hidden/cruft names such as `.cairndex`, `.DS_Store`, `__pycache__`,
  `node_modules`, and `Thumbs.db`. Rescan cleans up scan-staged provisional rows
  that were previously created for now-hidden paths. Browse hides hidden-only
  bundles while preserving legitimate empty bundles.
- **Thumbnail UI:** the global sidebar thumbnail button was removed. The backend
  thumbnail job/API and lazy bundle/file thumbnail endpoints remain; cover
  fallback is explicit cover → first image → selected primary video → first video
  → placeholder/no thumbnail.
- **Production deployment:** the library root mount must be writable because the
  per-library package stores `.cairndex/{manifest.json,library.db,cache/}` under
  that root. Normal MVP flows still avoid changing original media files. Backups
  should cover `/data/registry.db` plus each library's `.cairndex/library.db`;
  derived cache files are regenerable.

## Completed in ADR-0009

- **Phase 1 — bundle grouping review state (merged, #29).** Added
  `grouping_state`, `grouping_source`, `grouping_rule_version`, and
  `confirmed_at`; scan creates provisional bundles while fast-add/manual actions
  create confirmed bundles.
- **Phase 2 — read-only grouping suggester (merged, #30).** Added the pure
  heuristic and DB adapter that produce BUNDLE/CONTAINER proposals with roles,
  confidence, reasons, and stable ordering.
- **Phase 3 — apply-plan service + API (merged, #31).** Added durable grouping
  plans/proposals, apply semantics, conflict reporting, role assignment,
  collection creation, subtitle linking, and generated OpenAPI/frontend types.
- **Phase 4 — grouping review UI (merged, #32).** Added the review modal and
  frontend hooks for generating, reading, and applying grouping plans.
- **Phase 5 — re-scan additions (merged, #33).** New files found under a
  directory already owned by a confirmed bundle are proposed as additions instead
  of disturbing the confirmed grouping.
- **Phase 6 — external subtitle auto-link across grouping flows.** Fast-add
  single-bundle grouping now runs the same external-subtitle auto-link behavior as
  grouping-plan apply.
- **Follow-up — scan grouping review workflow (merged, #36).** Scan jobs persist
  open grouping plans; Update is the primary maintenance flow; hidden/cache paths
  are excluded; grouping review supports selected accept; the global thumbnail
  action is removed from the sidebar.
- **Follow-up — bundle suggestion inline rename.** New-bundle titles can be
  edited in grouping review by double-click (or Enter/F2 while focused), persist
  on the open plan, and become the confirmed bundle title on apply. Collection
  suggestions and additions to existing bundles remain read-only; source files
  are unchanged.

## Completed in ADR-0008

- Registry database and library package skeleton.
- Per-library engine/session cache and library-scoped content route migration.
- Clean-break schema collapse: no content `storage_roots` table and no
  `asset_files.storage_root_id`; each `library.db` is scoped by its library root.
- Registry-owned `job_queue` and in-process worker that opens the target
  library DB for scan/probe/thumbnail handlers.
- Per-library portable cache under `.cairndex/cache/{thumbnails,subtitles}/`.
- Optimistic concurrency for frequent metadata edits via `version` + optional
  `If-Match`.
- Eagle import removal; ADR-0004 remains only as superseded history.

## Tests and validation

For the maintenance-readiness sequence (#38–#41), each branch ran the full gates
locally and on GitHub CI (Backend / Frontend / Docker build) before merge:

- backend: `uv run ruff check`, `uv run ruff format --check`, `uv run mypy src`,
  `uv run pytest` (`235 passed` on `main` after #41);
- frontend: `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run test`, `npm run build`, and Playwright `npm run test:e2e` (15 specs).

New coverage added by the sequence: `test_jobs.py` (phase/message, path
redaction), `test_devtools_perf.py` (generator + benchmark), `test_search.py`
(FTS coverage/freshness/escaping/API), `test_auth.py` (hashing, session
scoping/expiry, the full lock gate), and e2e flows for the progress bar,
whole-library search, and the passphrase unlock.

For `feat/manual-bundling` (not yet merged): backend `pytest` is `253 passed`
locally with all static gates clean; frontend gates clean and Playwright is 17
specs. New coverage: `test_browse.py` (Unbundled view/counts + hiding from normal
views/collections), `test_manual_bundling.py` (all mutations, role/cover/primary
assignment, subtitle auto-link after add, confirmed bundles undisturbed, unbundled
source guard, metadata-only invariance, suggestion ranking),
`test_manual_bundling_api.py` (end-to-end over a real scan through the API), and
`e2e/manual-bundling.spec.ts` (Unbundled view + create-from-files + add-to-bundle
dialogs).

## Known issues / environment gaps

- Optional per-library owner passphrase lock (ADR-0010) is implemented: a library
  can require a passphrase (hash in its manifest; set via
  `cairndex.devtools.set_passphrase`), gated by a library-scoped server session
  (opaque HTTP-only cookie). It is a private LAN/Tailscale guardrail, not
  public-internet hardening and not multi-user auth. Branch
  `feat/per-library-passphrase-lock`. Sessions are in-memory (re-lock on restart);
  no rate limiting/lockout.
- Job progress is now observable: scan/probe/thumbnail jobs report a coarse
  phase + message with throttled progress writes, and the sidebar shows a live
  (determinate/indeterminate) progress bar under Update plus redacted error
  text. Branch `feat/job-progress-observability`. Cancellation is wired but has
  no dedicated UI button yet.
- Grouping review can select/deselect proposals, rename new-bundle suggestions,
  and reorder proposed bundle files, but does not yet provide edit-before-apply
  merge/split/reclassify controls.
- Whole-library indexed metadata search (SQLite FTS5) is implemented: the toolbar
  search box queries a per-library `bundle_search` FTS5 index (kept fresh by
  triggers; rebuildable via `cairndex.devtools.reindex_search`) over
  bundle/file/tag/collection metadata, composing with views/collections/filters.
  Branch `feat/indexed-metadata-search`. Ranking is match-only for now (results
  keep the active sort, not a relevance score).
- Browse-summary queries are profiled with synthetic-library + benchmark
  devtools; targeted indexes (`asset_files.bundle_id` + association-table reverse
  indexes) plus a non-correlated membership semijoin take browse/counts/filters
  from seconds to single-digit/low-tens of ms at 5k and keep all paths
  comfortably interactive (browse ~120 ms, filters <150 ms) at 100k bundles (see
  `docs/performance.md`). Branch `perf/large-library-baselines`.
- Same-volume high-confidence moved-file repair and explicit relink to an
  already-linked unique quick-fingerprint replacement are implemented. Arbitrary
  cross-filesystem/content-changed repair and duplicate/copy handling remain
  future work.
- File Browser is read-only. Write mode, reveal/open-with-default-app, and desktop
  helper/Tauri integration are not yet implemented but are now **planned and
  design-ratified**: library write mode in `docs/plans/04-library-write-mode.md`
  (ADR-0013, accepted), and the macOS desktop/host-handoff path in
  `docs/plans/03-macos-desktop-app.md` (ADR-0012, accepted).
- Remux/transcode fallback and embedded subtitle extraction are deferred —
  scheduled as plan 1 M6/M7 (HLS sessions) and M8 (subtitle upgrade); see
  `docs/plans/01-web-media-player-and-viewer.md`.

## Next recommended tasks

1. **Plan 1 M6 — playback decisions + HLS/remux/transcode session foundation**
   (M5 merged as #5). Subtitle depth remains owner-deferred to M8 behind HLS,
   and dual subtitles to M9 — see
   `docs/plans/01-web-media-player-and-viewer.md`. M6 needs the HLS session
   model / transcode-cache location ADR recorded at implementation time
   (flagged in plan 1 §12 and ADR-0012).
2. Add richer grouping review editing: merge/split/reclassify before apply,
   while preserving the current safe apply/conflict model.
3. Continue File Browser planning toward guarded write mode and safe desktop-native
   handoff. _(Planning now done: `docs/plans/04-library-write-mode.md` +
   proposed ADR-0013; desktop handoff in `docs/plans/03-macos-desktop-app.md`.)_
4. Consider relevance ranking for text search (results currently keep the active
   sort).
5. Consider hardening the passphrase lock for wider exposure (rate limiting,
   lockout, persistent sessions) if it ever needs to face more than a trusted LAN.
6. File Browser toolbar/search follow-ups (the toolbar now mirrors the bundle
   browser — breadcrumb + count + search + sort + layout + zoom; single-click
   selects and drives the inspector, double-click navigates/opens):
   - File search is currently a **client-side name filter of the loaded
     listing**. Add whole-library/recursive file search (file titles are
     already in the `bundle_search` FTS index, but that returns bundles, not
     File-View entries — needs a file-entry-shaped search path).
   - Enrich File-View metadata in the inspector: for a **directory**, show its
     child count (needs the backend `list_entries`/entry schema to carry a
     `child_count`). (A collection's note is already editable — see the
     collection inspector, `feat/collection-view`.)

## Unresolved decisions

- Authentication mechanism: shared owner secret vs. per-user accounts.
- Native/desktop host integration design for `open with default app`, reveal in
  file manager, and future File Browser write mode.
- Cache policy for future large transcodes: portable inside-library cache vs.
  server-local cache.
