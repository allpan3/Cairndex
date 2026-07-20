# ADR-0019: Open-source distribution and desktop sidecar packaging

- Status: proposed (owner input 2026-07-20; awaiting ratification)
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

### 4. Decisions this reopens

Recorded explicitly so they are not rediscovered at release time:

- **Developer ID signing** is no longer optional. The D5c amendment's reasoning
  is void; an unsigned DMG makes every downloader walk through System Settings →
  *Open Anyway*, and `spctl --assess` already returns `rejected` (measured in
  D5c). The signing pipeline is already documented and env-gated in
  `docs/deployment.md`, so enabling it is configuration plus an Apple Developer
  Program membership — not new work.
- **The updater** returns to the table. Its deferral cited a private repo with no
  releases; with a public repo and releases, Tauri's updater no longer needs a
  token embedded in the shipped app.
- **Project license** must be chosen before the first public push, and interacts
  with §3.
- **CI** must produce per-architecture release artifacts (Apple Silicon and
  Intel at minimum), which the current macOS build job does not do.

None of these block plan 3 D6; all block the first public release.

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

Harder / follow-up: a packaged-sidecar smoke test in CI (§2), a static ffmpeg
acquisition and licensing step in the release pipeline (§3), and the four
reopened decisions in §4 — signing, updater, license, and multi-arch CI — before
the first public release.

## References

- ADR-0018 §5 (left this packaging choice to milestone time), ADR-0012 (client
  platform strategy), ADR-0005 (server packaging/deployment, unaffected — the
  container path is unchanged).
- `docs/STATUS.md` D5c receipt and `docs/plans/03-macos-desktop-app.md` §3, whose
  "signing is not a v1 requirement" amendment §4 supersedes.
- Owner decision, 2026-07-20 (open source; prebuilt binaries via GitHub
  Releases).
