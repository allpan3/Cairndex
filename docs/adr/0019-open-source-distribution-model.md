# ADR-0019: Open-source distribution and desktop sidecar packaging

- Status: accepted (owner input 2026-07-20; ratified with amendments 2026-07-21)
- Date: 2026-07-20
- Branch/PR: `feat/library-ownership-lease`

## Context

Cairndex is going open source, and the owner intends to publish **prebuilt
desktop binaries through GitHub Releases** (owner, 2026-07-20).

Several accepted decisions rest on the opposite assumption. The D5c distribution
amendment (2026-07-19, recorded as a plan amendment rather than an ADR) argued
that Developer ID signing is not a v1 requirement precisely because "Cairndex is
single-owner and built from source", and that the $99/yr membership "buys nothing
until a build must run on a second Mac or reach someone else's hands". The
updater was deferred on the grounds that "the repo is private with no releases".
Both premises are now false.

Plan 3 D6 also needs the Python server bundled into the desktop app, and
[ADR-0018](0018-library-ownership-lease-and-local-server.md) §5 deliberately left
the packaging mechanism open ("PyInstaller or a shell-managed `uv` runtime — an
implementation-time choice for the milestone, not fixed here"). That choice
depends directly on the distribution model, which is why it is settled here
rather than in isolation.

An initial recommendation of a staged `uv` runtime was made on the reasoning
that the owner would be the only person to hit a packaging bug. That reasoning
was wrong — it assumed a private project — and is corrected here.

## Decision

### 1. Published binaries are a supported distribution channel

Releases are for people who are not the author and cannot be assumed to have a
toolchain, Python, or ffmpeg. Every packaging choice below follows from that.

### 2. Desktop sidecar: PyInstaller

The server ships as a PyInstaller **one-dir** bundle, invoked as a Tauri sidecar.

- One-dir, not one-file: one-file re-extracts to a temp directory on every
  launch, which is wrong for a process spawned on demand when a user opens a
  library folder.
- Smaller artifacts than a staged interpreter (measured: a staged uv Python plus
  venv with the real dependency set is **66 MB**), which matters when strangers
  download it.
- It is the conventional choice, so contributors recognize it and Tauri's own
  sidecar documentation assumes its shape.

The accepted cost is PyInstaller's analysis missing dynamic imports —
SQLAlchemy's dialect loading and Pillow's plugin discovery are the known
offenders here. Mitigation: a **smoke test that runs the packaged sidecar and
exercises a real request path** in CI, so a missing hidden import fails the build
rather than a user's first launch.

The alternative (staged relocatable `uv` interpreter + venv) was **verified to
work** before being set aside — a staged tree with Pillow and pillow-heif
installed was moved twice and still served the API. It is recorded as the
fallback if PyInstaller's import analysis proves unmanageable, since the
sidecar's contract with the shell (spawn a command, loopback port, env token) is
identical either way.

### 3. ffmpeg is bundled, and must be a static build

The sidecar cannot rely on the user having ffmpeg. Bundling it has one
non-obvious constraint discovered while measuring: a package-manager ffmpeg (e.g.
Homebrew's, 652 KB) is a thin dynamically-linked binary over a large dylib
closure under its own prefix, so it cannot be copied into a bundle. A **static**
ffmpeg/ffprobe build is required.

**Licensing consequence.** Cairndex transcodes with libx264, so any practical
static build is GPL rather than LGPL. Cairndex invokes ffmpeg as a separate
executable via `subprocess` (`media/ffmpeg_exec.py`), which is the standard
aggregation case rather than a derived work, so this does not dictate Cairndex's
own license — but **distributing** the binary carries GPL source-offer
obligations. This ADR records the constraint; it is not legal advice, and the
owner should confirm before the first release.

### 4. Decisions this reopens — resolved by the owner, 2026-07-21

The first draft of this section claimed signing was "no longer optional" and
listed four release blockers. The owner reviewed it and **only one is a blocker**.
Corrected here rather than left standing.

- **Project license: MIT** (owner, 2026-07-21). Cairndex's own code is MIT. This
  is compatible with shipping a GPL ffmpeg binary in the same release artifact —
  §3's aggregation reasoning is what makes that true — but the GPL obligation
  attaches to *that binary*, so the release must carry the corresponding source
  or a written offer for it. That is a release-notes line, not a code constraint.

- **Developer ID signing stays an upgrade path, not a requirement** (owner,
  2026-07-21). The draft's claim was reasoned from Gatekeeper's *default* refusal
  and skipped the step every macOS user of unsigned software already knows:
  System Settings → Privacy & Security → **Open Anyway**. That path works, it is
  what a large share of open-source macOS software ships behind, and the D5c
  amendment's conclusion survives its premise. The cost is real but bounded — a
  scary first-launch dialog, an install step in the README, and support questions
  — and it is a documentation problem, not an engineering one. Revisit when the
  friction is actually costing users, not on principle.

  **Amendment (2026-07-22, D7): the cost recurs per update, not per install.**
  "First-launch dialog" understated it. There is no updater, so every update is
  a fresh download — quarantined again — and an ad-hoc signature has no stable
  identity for macOS to carry the previous approval across; the CDHash changes
  every build. So the Open Anyway walk repeats on every version a user
  installs. That does not overturn the decision (a $99/yr membership still buys
  only the removal of a documented dialog), but it changes the shape of the
  trade: the cost is paid on every release rather than once, and it grows with
  release frequency rather than with user count. Revisit if Cairndex starts
  shipping updates often enough that the repetition, not the first encounter,
  is what users complain about.

  **Ad-hoc signing is an invariant that already holds — not a task.** Apple
  Silicon kills any mach-O without a valid signature, and the toolchain handles
  this without being asked: the arm64 linker ad-hoc signs at link time
  (`Cairndex.app` reports `flags=0x20002(adhoc,linker-signed)`), and PyInstaller
  re-signs each binary it rewrites install names on. Measured 2026-07-21 across
  the shipped bundle — the sidecar executable and all **52** bundled
  `.so`/`.dylib` files report `Signature=adhoc`.

  It is recorded here only because of how it would break: a future build step
  that modifies a binary *after* signing (`strip`, `install_name_tool`, a
  resource copy) invalidates the signature, and an **invalid** signature fails
  harder than an absent one. Anything touching binaries post-build must re-sign.

  Separately, the **downloaded** path is still unobserved. The D6 packaged run
  launched a locally-built app carrying `com.apple.provenance` but no
  `com.apple.quarantine`, which is precisely why it opened with no dialog. What
  an actual downloader sees needs a real browser round-trip to confirm — D7.

  **Correction (2026-07-22, D7): the invariant did not hold at the bundle
  level, and this ADR's own warning is what it broke on.** The measurement
  above was of individual Mach-O files, and every one of them was indeed
  ad-hoc signed. The *bundle* was not: Tauri only runs `codesign` when a
  `signingIdentity` is configured, and none was, so `Cairndex.app` shipped with
  no `Contents/_CodeSignature/CodeResources`. A bundle whose executable carries
  a bundle-style signature but has no resource seal is **invalid**, not
  unsigned — `codesign --verify` and `spctl` both refuse it with *"code has no
  resources but signature indicates they must be present"*. That is exactly the
  "an invalid signature fails harder than an absent one" case, reached without
  any post-signing build step.

  It stayed invisible because Gatekeeper assessment only runs on a quarantined
  app, and every build observed so far was local. Applying
  `com.apple.quarantine` to a locally built copy — what a browser download
  sets — surfaced it immediately, which is the cheap version of the "real
  browser round-trip" this section was waiting on.

  Fixed by setting `signingIdentity: "-"` in `tauri.conf.json`, so the bundler
  ad-hoc signs the bundle itself. Tauri signs without `--deep`, so the nested
  notarized ffmpeg binaries keep their own Developer ID signatures. The
  quarantined verdict is now a plain `rejected` — the ordinary
  unsigned-app state that **Open Anyway** clears, rather than a malformed
  bundle. So §4's conclusion stands (Developer ID remains an upgrade path);
  what changes is that ad-hoc signing is a build setting that must be present,
  not a property the toolchain supplies for free.

- **ffmpeg pinning is greenlit** (owner, 2026-07-21). It was written up as an
  owner decision because it hardcodes a third-party trust choice into the repo,
  and because §3's GPL consequence follows from it. Both are now answered, so it
  is ordinary work: pick a genuinely static build, verify it is static rather
  than trusting the label, record URL + sha256 in `ffmpeg-manifest.json`, and let
  the existing checksum gate in `build_sidecar.py` hold it. libx264 is not
  avoidable — `media/hls.py` uses it for the transcode ladder, and only the remux
  path is `-c:v copy` — so an LGPL build would silently lose transcoding.

- **The updater** and **per-architecture release CI** are release-pipeline work,
  not decisions. Both move to plan 3 D7 (§9).

Net: nothing here blocks D6, and only the ffmpeg pin blocks a usable release.

## Alternatives considered

- **Staged uv interpreter + relocatable venv** — verified working and simpler to
  debug, but larger and unconventional. Kept as the recorded fallback (§2).
- **Source-only distribution** — would have preserved every D5c premise and kept
  signing, the updater, and ffmpeg licensing out of scope, but the owner wants
  published binaries.
- **No bundled server; require Docker or `uv run` separately** — rejected: it
  defeats D6's premise that a local library folder opens with no server
  administration.
- **Bundling a dynamically-linked ffmpeg with rewritten install names** —
  rejected as fragile relative to a static build, for no benefit.

## Consequences

Easier: a user can download one artifact and open a local library folder with no
toolchain, no Python, and no ffmpeg.

Harder / follow-up: a packaged-sidecar smoke test in CI (§2) — done — and a
static ffmpeg acquisition step (§3), which is the one remaining blocker on a
usable release. The rest of §4 resolved into a licence file, a README install
note, and plan 3 D7 work.

## References

- ADR-0018 §5 (left this packaging choice to milestone time), ADR-0012 (client
  platform strategy), ADR-0005 (server packaging/deployment, unaffected — the
  container path is unchanged).
- `docs/STATUS.md` D5c receipt and `docs/plans/03-macos-desktop-app.md` §3, whose
  "signing is not a v1 requirement" amendment §4 supersedes.
- Owner decision, 2026-07-20 (open source; prebuilt binaries via GitHub
  Releases).
