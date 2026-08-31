# Project status

> **Repository privacy incident resolved (2026-08-30).** The live public repository
> is the newly created `allpan3/Cairndex`; its clean `main` starts at
> `52c8f6785ad2faad886bd56f0575a279f880b169`. The contaminated repository is now
> `allpan3/Cairndex-archive-3`, private and archived. No pull-request refs, tags, or
> releases were migrated. The clean repository's first CI run passed all seven jobs.
> The incident record immediately below describes why recreating the repository was
> necessary; its statement that remote remediation is pending is historical.

> **Release hardening in progress (`chore/release-hardening`, 2026-08-30).** Docker
> contexts now exclude nested environment files, runtime databases, virtualenvs, and
> sidecar build/vendor output. CI seeds synthetic private-data canaries into each risky
> path, builds all development and production images, rejects a context above 50 MiB,
> and inspects every image for leaks. The production smoke path builds a fresh,
> commit-specific image by default and deletes it afterward; passing an explicit image
> tag is the only reuse path. Image publication now smoke-tests the exact tagged image
> IDs that it pushes rather than rebuilding after the test.
>
> Release metadata is now synchronized at the existing `0.1.1` baseline across
> Python, npm, Cargo, their lockfiles, and Tauri. A repository gate checks them
> against root `VERSION`; tag-triggered desktop and image publication additionally
> require the `v*` tag to match. The desktop release validates version metadata and
> the changelog on Linux before starting any macOS build. This does **not** choose the
> next release number.
>
> Distribution licensing is now self-contained. The stale GPL-2.0-or-later line in
> `LICENSE` is corrected to the manifest's GPL-3.0-or-later result. Tauri embeds the
> MIT license, third-party notice, GPLv3 text, and LGPLv3 text in the app. macOS CI
> verifies the app resources, while the release workflow additionally mounts and
> checks the finished DMG and attaches the same texts beside it.
>
> Repository security automation now covers weekly dependency updates across all
> five package ecosystems, pull-request dependency review at high severity, and
> scheduled/PR CodeQL analysis for Python and JavaScript/TypeScript. Secret scanning
> and push protection were already enabled on the recreated public repository;
> Dependabot alerts/security updates and private vulnerability reporting are enabled.
> CI now audits both npm lockfiles, the complete Python lock, and the Rust lock. Four
> vulnerable web build-tool transitive dependencies are pinned to patched versions.
> The sole remaining advisory is `RUSTSEC-2024-0429` in Linux-only GTK/glib 0.18:
> Cairndex does not call the affected iterator API, it is absent from the macOS release
> graph, and current Tauri cannot move GTK 0.18 to the patched glib 0.20 line. The CI
> exception names only that advisory and must be removed when Tauri's GTK line moves.
> `main` still has no branch rule: choosing PR/approval/admin-bypass semantics is a
> separate owner decision because the wrong rule can lock out a solo maintainer.
>
> Backup/recovery acceptance is now executable. Library backups include the portable
> UUID and a unique suffix instead of every library competing for `library-<second>.db`.
> The image ships a stopped-only restore helper that rejects WAL sidecars, validates a
> temporary SQLite copy, fsyncs and atomically replaces the destination, and preserves
> prior bytes. Docker CI proves live registry/library backup, simulated database loss,
> restore, and reopen; the same script accepts an older source image for a release
> upgrade rehearsal. Documentation no longer claims arbitrary downgrades are safe.

> **Repository privacy incident (2026-08-30): local history is clean; the public
> remote is not.** An extensionless, flag-like file named `-D` was a private desktop
> screenshot. It had been removed from the working tree long ago, but both retained
> histories still carried its blob and every live pull request inherited one of the
> introducing commits. `git filter-repo --path=-D --invert-paths` rewrote all 1,156
> locally controllable commits and refs, expired reflogs, and garbage-collected the old
> blob and commits; object lookup, full-history path search, and `git fsck` now prove
> they are absent locally. **Nothing was pushed.** GitHub's existing `refs/pull/*`
> still retain the old remote commits, so an ordinary force-push cannot make the public
> repository clean. Remote remediation must be either a Support-assisted sensitive-data
> purge after pushing audited rewritten refs, or another public repository recreation
> with the current repository made private/archived.
>
> `AGENTS.md` now contains the full agent procedure formerly split across
> `CLAUDE.md`, plus a mandatory object/binary/Docker privacy gate before every push or
> PR. `CLAUDE.md` is a symlink to `AGENTS.md`, preventing the two instruction sources
> from drifting again.

> **Repository note (2026-08-09): the repository was recreated a second time.**
> The 2026-07-30 recreation (below) removed user data from the _old_ repo, but the
> same strings came back in with the source that was pushed to the new one — a
> performer name, a studio domain, and dated release titles across 40 lines of
> four files, published on `main`.
>
> An in-place history rewrite could not have fixed it. GitHub maintains
> `refs/pull/N/head` for every pull request; those refs are permanent, cannot be
> deleted by the owner, and survive branch deletion and force-pushes. All eleven
> of them held the offending commits as ancestors, so every commit would have
> stayed reachable at its SHA after any rewrite. **That is the trap to remember:
> deleting tags, releases, and branches does not orphan anything a PR ref pins.**
>
> So: `allpan3/Cairndex` is again a new repo, carrying the full 637-commit history
> with **every SHA rewritten** and the strings replaced by invented
> shape-equivalents throughout. The previous repo is `allpan3/Cairndex-archive-2`,
> **private and archived**; the one before it remains `allpan3/Cairndex-archive`.
> Tags and releases were deliberately **not** carried over — v0.1.0 and v0.1.1 are
> gone, and the next release will be **v0.2.0** cut directly from this history.
> SHAs quoted in these docs were remapped from `filter-repo`'s commit map (77
> references); the fourteen noted below remain unresolvable for the same reason as
> before.
>
> Verified after the move: zero occurrences of any original token across all 637
> commits and every blob; 972 backend tests and 577 frontend tests green on the
> rewritten tree, with lint and type checks clean.
>
> **Repository note (2026-07-30):** the repository was **recreated** to remove user
> data from published history. `allpan3/Cairndex` is a new repo carrying the full
> history with **every commit SHA rewritten**; the previous repo is
> `allpan3/Cairndex-archive`, private and archived. Commit SHAs quoted in this file
> were remapped to their new equivalents. Fourteen remain unresolvable — the
> `feat/hover-preview` work of 2026-07-13, which was squash-merged, so those
> individual commits never entered `main` and have no counterpart. They are left as
> written; each is labelled with its subject, which is what the record needs.
>
> **Merged and released (2026-07-30):** `chore/docker-dev-and-deploy` is
> **merged** (PR #1) and cut as **v0.1.1** — the Docker path is now how Cairndex
> is deployed, with a published image at `ghcr.io/allpan3/cairndex` and the
> owner's NAS running it against a real library. Half-star ratings are
> **merged**. The grouping
> round-trip work is merged too, but was never reproduced against the owner's
> reported 30-second stall; if it recurs, that entry records what was and was not
> measured.

> **Current position:** PR numbers below belong to **two different series**, and
> the entries do not say which. Anything numbered above #30 is
> `allpan3/Cairndex-archive`, whose numbering the recreation could not carry
> over; the live repository started again at #1 and is up to **#9**
> (`fix/tag-management-and-panel-sizing`, merged 2026-08-24). Where it matters,
> the merge commit on `main` is the unambiguous reference, not the number.
>
> Plan 4 write mode is **merged** (PR #30), as are the post-merge interaction
> fixes (PR #31) and the File Browser's move onto the
> app's real media viewer (PR #32) and the collection-creation affordances
> (owner-reported: the sidebar "+" nested instead of creating at the top level,
> and creating one was unreachable from the grid and the shell menu). Plan 4 W6
> is **merged** (PR #33), closing the write-mode track; W2 stays blocked on
> plan 1 M11. Eight rounds of UI refinement are **merged** (PR #34): contact
> sheets, the viewer's two panels, tag pill actions with cascading deletes, and
> one layout control across every browsing surface. An owner-reported HEVC
> playback failure in the desktop app is **merged** (PR #35), which also fixed a
> `just check-web` gate that had not been type-checking anything. The viewer's
> failure copy (PR #36) and the MP4 keyframe-index read (PR #37) are **merged**,
> as are file formats, encoding facts and richer file rows (PR #38). **`main` is
> the v0.1.0 content**, and **v0.1.0 was published** (release withdrawn in the 2026-08-09 recreation)
> (2026-07-28) — tag `v0.1.0` at `0821890`, one Apple Silicon DMG with its
> checksum and the third-party notices, verified by the owner on a genuinely
> downloaded build. PR #39 (folder-as-bundle-member) is open and deliberately
> _not_ in this release; it lives on as branch `feat/folder-as-bundle-member`
> (renamed from `plan/…` on 2026-08-29, once it stopped being a plan).
> Ten owner-reported faults in the Suggest-grouping review dialog are **merged**
> (PR #40), two of which could silently drop files from a plan.
>
> **Merged 2026-07-30, after the repository was recreated** (so with no PR
> numbers): five more owner-reported faults found by using the app — a renamed file
> keeping its old name inside its bundle, a drop onto a bundle landing in the
> library root, an image double-click zooming instead of closing the viewer, the
> viewer's two notices sitting apart, and a rename box selecting the extension;
> the grouping review's per-suggestion round trips; and half-star ratings.
>
> **Merged (2026-07-30):** `perf/storyboard-keyframe-sampling`, which answers
> the owner's "why is storyboard generation so slow" — it was decoding every
> frame of every video. Running it against a network-mounted library then showed
> the remaining cost is the read, not the decode; the section below records both
> the fixture numbers and what the share actually did. **Job control followed
> and is merged** (PR #5, `34295b3`): every running job can now be stopped from
> the sidebar, and a job whose server died no longer claims to be running.
>
> **Open, unreviewed (2026-07-30):** `fix/inspector-parity-and-collection-covers`
> — seven more owner reports from using the app. The Bundle Inspector shown during
> playback is now the shell's own pane rather than a starved copy of it; a bundle
> filed into a collection is in that collection's listing when you open it;
> collection covers appear, refresh with membership, and keep their full cover
> frame; and a video's cover frame no longer reassigns the bundle's cover. The
> viewer's top-right buttons also stay with the media when that inspector is
> docked, and bundle note boxes now start at one line before auto-growing for
> overflow; the old saved-height preference is reset so existing notes follow
> that default. The native `just dev` stack now shuts Uvicorn down gracefully
> too; its old process-group kill could stop the worker before FastAPI released
> the library lease, making the bundled desktop wait through stale-lease
> recovery after an ordinary Ctrl-C. File navigation now works in both directions
> between a file's physical File Browser location and its one owning bundle,
> including from the File Browser inspector and right-click menu; unlike native
> Open/Reveal, both location actions work on the web.
> Contact-sheet exports now use a three-row metadata header and a larger branded
> Cairndex mark; the middle row is labelled Details, and probe format v5 supplies
> separate primary video/audio bitrates plus the audio sample rate. Their width
> presets are now 1600, 2048, and 2560 px, with 2048 selected by default.
> **Open, unreviewed (2026-07-30):** `fix/library-journal-mode-portability` — an
> owner-reported production incident where a library served by the NAS container
> became unopenable from any machine reaching it over SMB. See the section below
> and ADR-0021; the residual unclean-shutdown risk was accepted by the owner
> deliberately.
>
> **Merged (2026-08-24, PR #10):** an unbundled file is never "missing" — the
> Missing view and its badge are registered bundles only, a scan drops staging
> rows for files it can prove are gone, and **Forget** dismisses a dead member
> without dissolving the bundle around it. See the first section below.
>
> **Merged (2026-08-24):** a bundle card's Open/Reveal entries no longer depend on
> the web viewer being able to play the file, which had removed them from every
> card in Missing Files and from any unsupported format. Confirmed in the app by
> the owner. See the first section below.
>
> **Merged (2026-08-28, PR #12):** four owner enhancements from one pass over
> the app — the job queue runs what the owner is waiting for first (and a
> running pass stands aside for it), two jobs on screen keep their own progress
> rows, the Collections heading folds the tree instead of hiding it, a grouping
> suggestion no longer states a confidence, and bundle notes can be dragged into
> a new order. See the first section below.
>
> **Moments and the range loop are built on `feat/moments`** and awaiting
> the owner's pass (2026-08-29) — see the first section below, plus
> [ADR-0025](adr/0025-moment-tag-propagation.md) and
> [ADR-0026](adr/0026-armed-range-loop.md).
>
> **Next is phase I, the Android client** (plan 2 T1–T7). One owner-requested
> branch is open and unreviewed (`chore/docker-dev-and-deploy`). Two things still
> need the owner: a pass on a genuinely
> downloaded build (deferred from D7),
> and a pass on the **native Finder drag gesture** on a packaged build, which
> cannot be automated here. One diagnosis is parked rather than
> queued: **[plan 5](plans/05-network-library-latency.md)** — why a NAS-mounted
> library's inspector takes ~500 ms, deferred post-v0.1.0.
> **[Plan 6](plans/06-folder-as-bundle-member.md)** (a folder as one item inside a
> bundle, so an album of 1000 photos is one row) is no longer parked: its
> deferral expired with v0.1.0 and its design questions are settled. It is
> designed and unbuilt — see the branch section below.

## Merged: moments, and the range loop they carry (2026-08-31, PR #14)

Owner wants to save the frames and spans that matter inside a video, tag and
comment them, read them back in the Bundle Inspector, and — related, and the same
infrastructure — loop between two points.
[Plan 7](plans/07-moments-and-range-loop.md) holds the design and the two
decisions worth arguing with. **Merged as PR #14, after the owner's pass in the
app.** The 24 commits the work actually took were squashed to four before review
— four attempts at one chevron and a preview design added, removed and re-added
are the owner's history, not a reviewer's. All seven CI checks green.

**The model.** A moment is one instant (`end_s IS NULL`) or one span inside
one `AssetFile`, with an optional comment and any number of library tags. Two new
tables, `moments` and `moment_tags`, added to an existing library on open.
`file_id` is the truth and `bundle_id` is denormalized for the same two reasons
`playback_progress` denormalizes it, and maintained by the same re-parent hook —
so the whole lifecycle came free: the cascade handles a dropped file row, move
repair preserves `AssetFile.id` so a rename keeps the moments, trashing repoints
rather than deletes, and removing a *present* file from a bundle carries its
moments to the one-file bundle it is re-staged into.

**A range moment is an loop pair**, which is what makes the owner's two asks one
feature. `useClipPlayback` went from two booleans to one `ClipPlaybackMode` of
`off`/`session`/`armed` — simpler than it was, because "confine, do not repeat,
and survive a pause" was never a state that meant anything.

**Two ADRs, both accepted, both flagged to the owner before building:**

- [ADR-0025](adr/0025-moment-tag-propagation.md) — a moment's tag propagates
  to its bundle **one way**: assignment adds, and nothing un-adds. A derived
  union would make tag counts, filters, facets and Smart Collections all learn
  about a second source to avoid a one-line write; two-way propagation is unsound,
  because a propagated assignment and a hand-made one are the same row.
- [ADR-0026](adr/0026-armed-range-loop.md) — an armed range loop confines ordinary
  playback, Space included, and survives a pause. This **extends** the owner's
  2026-08-16 decision that a marked span must not redefine the play button, on
  the reading that what was rejected was the *quiet* redefinition. The ADR records
  the fallback if the owner would rather keep the older rule: it is a two-line
  change to the pause handler.

**One departure from the approved design, made while building.** §5.1 planned an
empty state wherever the section appears. An unmarked video now shows *nothing*
in a pane with no playhead: the planned hint would have put a permanent "press B
while playing" line — and its height — on every video bundle's rail, in a pane
where `B` does nothing. A bundle that *has* moments shows them in both rails.

**One bug fixed on the way, found by the new e2e and not specific to this
feature.** `ContextMenu` dismissed itself: clicking a row's `⋯` near the edge of a
scrollable rail focuses it, the browser scrolls it into view in the same dispatch,
and the scroll listener closed the menu that click had just opened. Scroll and
resize dismissal now arm a frame later. Every rail row deep enough to need
scrolling had the same fragility.

**The hover preview took three tries, and the third is a generated artifact
after all.** Owner: it sits on the first frame for about a second, and that frame
is not even inside the range. Measuring rather than guessing separated two causes.
About 340ms of a ~400ms wait was two of our own constants — an arm delay paid
*before* anything loaded, then a fade after it was already playing — and those are
now 100ms and 60ms. The rest was inherent to streaming the original: an accurate
seek makes the decoder run forward from the preceding keyframe (14ms landing just
after one, 123ms just before the next, on 1080p/30fps, and worse with resolution
and GOP length). The wrong-frame half was the storyboard grid: tiles are sampled
every 2 to 30 seconds, so the still for an in-point is usually from before the
range.

So **two pre-made artifacts** (`media/moment_previews.py`), 480px, cached under
`.cairndex/cache/moment-previews/`.

- **A poster frame** for *every* moment, decoded at the marked instant, queued by
  the save rather than the first hover — it is the picture rather than the motion,
  and one frame is a keyframe seek and a JPEG (~1KB). This is the fix for the
  wrong-frame report, and the whole fix for a **frame** moment, which had only the
  stale tile and no second act to correct it.
- **A clip of the span** for a range, muted and faststart, keyed by the source
  fingerprint *and* the span. Plays from byte 0, and its own first frame is the
  in-point too. Same 1080p source, hover to first moving frame: **385ms streaming,
  181ms from the clip**, 8-84KB per five-second span. Cut lazily on first hover
  (owner's choice), since a range can fall back to streaming while it builds.

Both routes answer 404 until the artifact lands and the request is what queues it,
so the client keeps what it can already show — no hover waits on ffmpeg, and the
cache stays disposable (owner asked directly; there is a test for it). This
reverses the GIF-removal decision from earlier on this branch: what was wrong
there was *when* it ran, not *what* it made. Plan 7 §4.3 records all three
attempts.

**Three bugs worth remembering, all caught by verification rather than review.**

1. `raise HTTPException` **discards `BackgroundTasks`** — the exception handler
   builds a fresh response — so the queued cut never ran and the clip would never
   have been built at all. The 404 is returned, not raised.
2. **A moment's two artifacts shared a fingerprint sidecar and a lock.**
   `derived_cache` derives both with `with_suffix`, so `{id}.mp4` and `{id}.jpg`
   resolved to `{id}.fingerprint`; the clip's value overwrote the poster's, every
   range moment's poster then failed `is_current` forever, fell back to the stale
   tile on every hover, and silently re-encoded itself each time. A frame moment,
   having one artifact, looked perfectly fine — which is exactly how it survived a
   round of testing, and why the owner still saw the original symptom after the
   "fix". The kind now goes in the stem, not the suffix, and a test builds both
   and asserts each survives the other.
3. A throwaway in-page timing harness was reading Chrome's 1000ms
   background-tab timer clamp rather than the product, which is why the first two
   readings were a suspiciously round ~1001ms. All numbers here are from a visible
   Chromium via Playwright.

**A fourth bug, and this one was mine and new.** Owner: it saves, but it does not
render until I reload the app. Queueing the poster from `POST /moments` as a
**Starlette background task** was the cause: those run *before* FastAPI exits the
`yield` dependency that commits the library session, so a moment's own preview
build held its own write invisible for as long as ffmpeg took. Proven by slowing
the encode to 2000ms and watching the row stay invisible for 2121ms. The rail
refetches about 20ms after the POST, so it read `[]` and — nothing invalidating
again — stayed empty until a reload. On a large source the encode is slow enough
to lose that race every time, which is why it looked absolute rather than flaky.

Preview builds now go through `moment_previews.schedule`, a daemon thread, so the
response, the commit, and the encode are independent. The read routes moved to it
too, for a milder version of the same hazard: a background task there delays the
teardown of the library access dependency and so holds it across an ffmpeg run —
the stranded-dependency shape ADR-0014's scoped sessions exist to avoid.
Re-verified in the browser with the encode slowed to 3000ms: the row renders at
55ms. The regression test asserts the POST returns *before* its build finishes and
that the write is already listed in that window; it fails on the old behaviour.

**And the last of the owner's pass: create and remove felt slow.** Neither moved
the rail until the write had answered *and* a refetch after it had answered too;
create additionally invalidated `bundle-tags`, `tag-counts` and `view-counts`,
none of which a moment saved without tags can have changed. Now: remove is
optimistic (rollback on error), create writes the row it was handed into the list
at the `(start_s, id)` position `list_moments` would have put it, and the
tag-shaped invalidation only runs when the create actually carried tags. Measured
locally: press-to-row 64ms -> 52ms, and 5 requests -> 1. The local delta is small
because a loopback round trip is milliseconds; the requests removed are the ones
that scale with library size, so the owner's machine should see more of it.

Create is deliberately *not* optimistic ahead of the write, unlike `setTags`: the
id comes from the server and the poster URL, the clip URL and the capture note
that opens the comment box all need the real one, so a placeholder row would have
to be swapped underneath an open editor. If one round trip still reads as a delay
that is the next thing to try.

**How the previews were verified**, since "shows the right frame" is not something
a unit test can assert: a fixture whose colour is a pure function of `floor(t)`,
so any frame decodes back to its own source timestamp. The clip is 150 frames
covering exactly `[90.000, 95.000)`; the composited pixel of the preview at the
instant it opens is the in-point's colour with zero error, and a frame moment's is
its marked instant's.

**One more bug from the owner's pass, and it was not in this feature.** The first
click on Save Moment did nothing and the second worked. The chrome auto-hides
after 2.6s of pointer idle, and `.media-viewer--idle` sets `pointer-events: none`
as well as `opacity: 0` — so resting the cursor on a control while reading it let
the chrome idle out from under it, and the next click passed through to the video
and was spent waking the chrome. Every button in the bar had it; the `b` key never
did, which is why frame moments seemed fine. `useIdleHide` now declines to idle
while the pointer is on a control, which is the same root cause as the wheel-zoom
case fixed earlier on this branch — that one was a *specific* wake source, this is
the general rule. Reproduced first (0 moments after one click, 1 after two), then
fixed, then re-checked all four save paths — key/click/idle-click for a range and
`b` for a frame — each saving exactly one moment of the right kind.

Worth recording because it cost time: `list_moments` returns **time order**, so
reading `.at(-1)` of the list to find "the moment just saved" returns whichever has
the largest `start_s`. That made a correct range save look like it had saved a
frame, and sent me looking for a stale closure in `useShortcuts` that was not
there. Diff the id set instead.

**Tests run.** Backend 1225 passed, 1 skipped (36 new: frame vs range, span
validation, file-must-be-in-bundle, time ordering, the four propagation rules, the
version guard, comment cleaning, five lifecycle paths, and the additive
bootstrap). Frontend 1107 passed across 112 files (22 for the section, 6 hooks,
6 seek markers, 6 clip modes/`armLoop`, 2 for the `b` binding, 1 `ContextMenu`
regression). `ruff`, `ruff format`, `mypy src packaging`, and frontend
lint/format/typecheck/build all clean. Frontend e2e 142 passed with **one
pre-existing failure** — `reports real MP4 progress and resumes on reopen`, which
fails identically with the branch stashed, so it is not this work; two new e2e
tests cover the armed loop surviving a pause and the whole
mark→read→comment→loop→forget round trip.

**Not run:** the desktop Rust/Tauri gate. No Rust changed, and the shell embeds
the same `apps/web` build that passed here.

**Known gaps, deliberate (plan 7 §9).**

- A moment needs an `AssetFile` row, so an unindexed File Browser path cannot
  have one — the same limit clips already carry. An *unbundled* file does have a
  row and could show moments in the `FileInspector`; not built.
- Seek-track markers are non-interactive. The track's own `pointerdown` scrubs,
  and a click target competing with it is a separate design problem.
- No keys to step between moments (`Alt+←/→` was considered and left out); the
  rail is the way to jump. Cheap to add if the owner wants them.
- No *Export this moment* — loading a span into the marks and using `Save GIF…`
  already works in two steps.
- Clips are cut on first hover, not at save time (owner's choice, 2026-08-30), so
  the first hover of a *range* is the slow one. Posters are made on save, so the
  picture is right from the first hover either way.
- The seek-bar hover tooltip still reads a storyboard tile, which is correct for
  it: it follows the pointer over arbitrary times, where a moment has one fixed
  instant worth decoding.
- No `has_moments` / `moment_count` filter field. Propagation means the tag
  filters already reach these bundles.

**Next recommended task:** phase I — the Android client, plan 2 T1–T7 — which is
what the roadmap has after this. The gaps listed above are all deliberate and
none of them block it.

**Worth carrying forward from this branch.** Four of the six bugs the owner found
were invisible to reading the diff and only appeared in a running app against a
real file: a fill class resolving against the viewport, two cache artifacts
colliding on a `with_suffix` sidecar, a background task holding its own write
invisible, and chrome idling out from under a resting pointer. Two of those were
*introduced by the fix for the previous one*. On anything that generates a cached
artifact or touches the request lifecycle, budget for driving the real app rather
than trusting the gates — and reproduce before fixing, because three of these had
a plausible wrong diagnosis that testing killed.

## Merged: a folder as one item inside a bundle (2026-08-29, PR #13)

Owner wants a folder of 1000 photos to sit in a bundle without filling the
inspector and the grouping dialog with 1000 rows. Design 2026-07-28, questions
settled 2026-08-28, built and merged 2026-08-29;
[plan 6](plans/06-folder-as-bundle-member.md) holds the design and its answers.

> **Merged at `aa8a4300`** with all seven CI checks green. The feature: a bundle
> may record one of its directories as a single member; the inspector draws it
> as one row that opens to show its files nested; the grouping dialog proposes
> it, lets you look inside without deciding, and take a decline back; the
> scanner keeps it correct as the folder grows or is renamed.
>
> Also merged, unrelated and carried at the owner's request: every scrollbar in
> the app is half-transparent, and the two side panels draw their own so it
> costs no width.

Owner wants a folder of 1000 photos to sit in a bundle without filling the
inspector and the grouping dialog with 1000 rows. Design 2026-07-28, questions
settled 2026-08-28; [plan 6](plans/06-folder-as-bundle-member.md) holds both.


The record of how it got here follows, kept because several entries are
decisions with reasons rather than progress notes.

Rebased onto `main` on 2026-08-28, which exposed a **duplicate ADR number**: the
directory-groups analysis written here and the journal-mode lifecycle decision
that landed on `main` were both 0021. The accepted one keeps the number; the
superseded one is now [ADR-0024](adr/0024-directory-groups-in-bundles.md) and is
indexed in `docs/adr/README.md`, which the branch had never done.

**The six open questions are answered** (plan 6 §4) and none of them changed the
design. Two landed better than the plan had guessed, because the codebase
already had the machinery: the cover fallback is a query against the existing
`asset_files.directory_path` index rather than the disk read the plan proposed
(which AGENTS.md forbids in a request handler), and folder deletion is one
journaled operation rather than N, because `file_ops/trash.py` already trashes a
directory in a single rename. The structural finding is that **reversibility is
free** — the feature stores which directories are entities and never contents,
so collapse and expand are one row inserted and one row deleted, with no file
row, id, rating or resume position touched either way. That also yields a second
entry point — "Collapse into a folder" on a file selection — which answers
ADR-0024's "where do I create one?" objection without the grouping dialog.

Still genuinely open, neither blocking: whether entity directories may nest
(leaning no), and the threshold value, which wants a real library to pick it.

**S1 is built** (2026-08-28): the `bundle_directory_members` table, the
collapse/expand service, three library-scoped endpoints, and 12 tests. Backend
only — no UI reads any of it yet, so nothing user-visible changed. The table
stores no contents, so the reversibility guarantee is structural rather than
defended by code: collapsing is one row in, expanding is one row out.

Two things the build settled that the design had not: a folder row covers its
**subtree** (matching only the exact directory would leave a nested album's
files loose, and would contradict the File Browser handoff), and **nesting is
refused** for now, in the service rather than the constraint — refusing is the
direction that can be relaxed later without a migration.

Gates run on 2026-08-28: `ruff check`, `ruff format --check`, `mypy` (175 files)
and `pytest` (**1165 passed**, 1 skipped) from `apps/server`; `npm run
typecheck` from `apps/web` after regenerating `openapi.json` and `schema.d.ts`,
whose diff is additive only. Not run: the rest of the web gate and Playwright —
no frontend source changed in S1.

**S2 is built too** (2026-08-28), and the feature is usable end to end: the rail
draws one folder row in place of the files it covers, right-click collapses a
file's directory or expands the folder back, double-click hands off to the File
Browser *inside* that folder, and playing the bundle skips a folder's contents.

Three things the build settled. Opening a folder needed its **own shell action**
— `onLocateFile` lands in a file's parent and highlights it, which for a folder
shows everything except what is inside; `onOpenFolderInBrowser` navigates into
it. The **playlist rule has two cases**: playing the bundle skips a folder's
contents, but opening one of them pages through that folder, because filtering
unconditionally would strand the viewer on a file its own playlist denied. And
the **album grid deliberately still shows every photo** — the owner's complaint
named the rail and the grouping dialog, and a grid of a thousand photos is what
an album view should look like.

Folder rows are **not draggable yet**: plan 6 §4.5's shared key space is designed
but the reorder endpoint still takes file ids only, so the row does not claim a
grab cursor it cannot honour.

Verified by running it, not only by tests: an isolated stack against a throwaway
library (`CAIRNDEX_DATA_DIR` pointed at a scratch dir, so the real registry and
its leases were never touched) with a bundle of one loose image and a six-file
folder. Collapse → two rows; expand → all seven back in their original order;
double-click → the File Browser inside the folder. That run is what caught the
`onLocateFile` mistake, which every test had happily agreed with.

Gates on 2026-08-28, from `apps/web`: `lint`, `format:check`, `typecheck`,
`vitest` (**1022 passed**, 109 files) and `build`. Backend unchanged in S2 and
still green from S1. Not run: Playwright, and the desktop gate (no Rust changed).

**S3 is built** (2026-08-28), and it corrected plan 6's own §2. The design
assumed the dialog's problem was a bundle proposal listing a thousand files; it
is not. The suggester turns a thousand-photo folder into a *collection wrapping a
thousand single-photo bundles*, and those thousand rows are the complaint —
annotating a bundle proposal could never fire, because a bundle proposal's files
always come from exactly one directory. **Owner-confirmed answer:** above the
threshold the folder becomes one bundle whose single member is the folder.

The threshold counts **subjects, not files**. A flat folder of 300 releases is
900 files but 300 subjects of three — a video, a cover and a subtitle sharing a
stem — and must stay 300 suggestions; an album is 300 subjects of one. A first
attempt thresholded on file count and swallowed the release shelf, which is the
movie-folder lesson at scale, and an existing performance test caught it.

Verified by running it against a throwaway library (`CAIRNDEX_DATA_DIR` in a
scratch dir, so the real registry and its leases were untouched): a folder of 30
photos beside a clip and a poster. Scan produced **3 proposals, not 33**; the
dialog drew one `🗁 album · Folder · 30 files` row with **List files** beside it;
declining listed all 30; accepting created a real folder member, and the bundle's
inspector then read `Files in bundle (30 · 1 folder)` with a single row.

Gates on 2026-08-28: `ruff`, `ruff format`, `mypy` (175 files), `pytest` (**1174
passed**, 1 skipped); `lint`, `format:check`, `typecheck`, `vitest` (**1024
passed**) and `build` from `apps/web`. Not run: Playwright, desktop (no Rust
changed).

**S4 is built** (2026-08-28), which finishes plan 6's slice list. Two of §4's
answers turned out to be already true, and are now pinned by tests rather than
assumed: the **cover fallback** needed no code, because `effective_cover_file`
already walks the bundle's own files and a collapsed folder's files are still
its files — the disk read §4.3 proposed would have been a filesystem walk in a
request handler, which AGENTS.md forbids. **Trash and Put back** likewise work
over a folder member unchanged, because trashing keeps the bundle.

What S4 built is the scanner half. A file dropped into a collapsed folder now
**joins that bundle** instead of arriving as its own suggestion, so an album
stays one row as it grows. And a **renamed folder keeps its row**: move repair
already followed the files, but the row naming the directory was left pointing
at somewhere gone, which silently un-collapsed the album on the next scan. A
nested file votes for the folder's new location, not its own parent's. A folder
whose files genuinely scatter drops its row and lists individually — visible and
harmless, which beats a row pointing at nothing.

Gates on 2026-08-28: `ruff`, `ruff format`, `mypy` (175 files), `pytest`
(**1182 passed**, 1 skipped). No API surface changed, so no regeneration was
needed. Frontend untouched in S4.

**Owner testing on a real library (2026-08-28) found two faults, both fixed.**
The synthetic fixtures for S1–S3 all put the album *alone* in its folder, so the
shape the plan was actually written about — a work whose extras live in a
subfolder — was the one case never tested. A folder holding one video and an
album subfolder was suggested as a *collection*, so the video became one bundle
and the album another and the thing being looked at had no single row; it is now
**one bundle**, its own media plus a folder row per album child. Merging is
narrow on purpose: only when the folder's own media is a single subject and every
child is an album. And **Convert to bundle** was destroying the folder row it had
just been handed, which is the likeliest action to take on a folder that has one.

Owner also reported the review dialog's rows **misaligning at the same level**
(2026-08-28). Measured rather than guessed: a `.grp-row--collection` carries
`padding: 2px 4px` that `.grp-row--bundle` does not, so sibling rows sat 4px
apart and read as parent and child. Cancelled with a negative margin, keeping the
padding that gives the folder-header background its room. Verified by measuring
every row's disclosure, checkbox and content against its depth — all three
kinds now agree. A second, pre-existing one surfaced while checking: the amber
attention bar hangs 6px into the left margin and only nested rows had room, so
it was never drawn on a top-level row; the tree now reserves the space.

**Neither is covered by a test.** jsdom applies no stylesheet, so a layout
regression of this kind cannot fail in `vitest` — it would need a Playwright
run with real CSS. Recorded rather than papered over.

Owner also reported (2026-08-28) that **"List files" was the only way to see
inside a proposed folder, and it had no way back** — so deciding whether a folder
*should* be a folder meant destroying the suggestion to find out. Split into two
controls: a disclosure that lists the folder's files read-only and changes
nothing about the plan, and a button that now toggles both ways. Declining marks
the row (`grouping_proposal_directories.expanded`) instead of deleting it, so the
row stays visible saying which state it is in and apply honours whichever it was
left on. Adding a column there is safe where it would not be in `library.db`: the
plans database is deleted wholesale at every server start (ADR-0022 §5), so it is
genuinely always at the current shape.

A follow-up on the same report (2026-08-29): listing a folder's files pushed the
folder row to the *bottom* of the list, where it read as an empty folder with no
relation to the 73 rows above it. The rule is now one line — **a folder is
anchored where its files begin** — which covers both states: collapsed, the row
sits exactly where the files it replaces would have been; listed, it is a header
immediately above them, with the control that folds them back beside them. The
listed files are indented under it so the run reads as that folder's contents.
Ordering lives in `proposalEntries` with its own tests, rather than in the JSX.

Owner-reported 2026-08-29: *Expand folder into the bundle* "seems irreversible".
It is not — **Collapse** appears on any of the expanded files — but the way back
sits on a different row under a different name, with nothing on screen saying so.
The rail's folder row now has a **disclosure**: its files show nested beneath it
and the row stays. Same split the review dialog already had, and the same rule —
a control that reveals must not also decide. Expand remains for the case where
the folder should stop being one member.

**Left open at merge, none blocking:**

- **The threshold value** (12 subjects) — plan 6 §5.2. Owner ran it against the
  real library on 2026-08-29 and reported the result good, so the number is
  validated against one library's shapes rather than merely guessed. Left open
  because it is one sample, and because it stays cheap to change: it only ever
  decides what to *propose*.
- ~~No Playwright coverage~~ **Closed 2026-08-29.** `e2e/grouping-folders.spec.ts`
  covers the class of fault that reached the owner: sibling rows share one
  indent, the attention bar is not clipped off a top-level row, a folder row sits
  above the files it covers with its files indented under it, and looking inside
  decides nothing. Relationships rather than pixel values, and each
  mutation-checked against the bug it exists for. Untagged, so it runs in
  `just e2e` and in CI.
- **Folder rows are not draggable — withdrawn, not pending.** Built 2026-08-29
  and reverted the same day at the owner's call ("I don't think this is
  significant"). The rail's drag gesture has no visible affordance — grab cursor
  and tooltip only — so it added an invisible capability to one more row, and
  ordering inside a bundle barely matters for the shape the feature is for. If
  reordering ever does matter, fix the missing affordance for *every* row first.
  Recorded here because plan 6 §4.5 reads like an obvious requirement and will
  otherwise invite rebuilding.
- **Folder-level trash** (§4.6) still journals one entry per file. Moving a whole
  folder in one rename is an optimisation of ADR-0013's journalling, not a
  correctness gap, and deserves its own slice.
- **Nested entity directories** are refused (§5.1), in the service rather than
  the constraint, so the rule can be relaxed later without a migration.

Owner-tested throughout, and merged once they were satisfied.

Three designs were considered in one session, and the first two were killed by
the owner in a sentence each. *Folder as a bundle member* collides with
`product-brief.md:67/124` and with the owner's own requirement that every file in
the folder be in the bundle. *Automatic grouping* cannot work at all: a movie
folder (film + subtitles + poster + cover) and a mixed-media album are
indistinguishable from file properties, because the difference is what the folder
*means*. That left explicit user-chosen groups — [ADR-0024](adr/0024-directory-groups-in-bundles.md),
now **superseded** — which fell to the sharpest objection of the three: there was
no answer to "where in the UI do I create a group?" that did not invent a new
noun.

The owner then proposed nesting bundles, and reconsidered that too as "kind of
messy". The **accepted design is smaller**: a bundle member may be a *directory*,
opened in the File Browser rather than entered, its files kept out of the
playlist, never a cover, carrying no rating. Its contents stay indexed — an
amendment made in review, because unindexed they would lose search, tags and
playback resume, and the owner's own example is an album of short videos. The
decision of which folders are entities is made in the grouping-suggestion
dialog, which is what finally answered "where do I create one?".

Sub-bundles were rejected on cost: **12 modules touch `AssetBundle`**, and a
nested bundle must be invisible in every one. A directory member is not a bundle,
so that entire class of bug does not arise. Also recorded: an early objection of
mine that a folder could not be a bundle member misread
`product-brief.md:67/124`, and cost two rounds of design.

## Merged: four owner enhancements in one pass (2026-08-28, PR #12)

Branch `feat/job-priority-and-browsing-polish`, off `main` at `fbeca040`,
**merged through PR #12** (`a5c52836`) with all seven CI jobs green — backend,
frontend, full-stack e2e, packaged sidecar, Desktop Rust (Ubuntu), Desktop shell
(macOS), and Docker.

The eleven commits it was written in were squashed to six before review, one per
coherent change: the four grip-placement attempts folded into the note-reordering
commit, whose message keeps *why* the grip ended up under the remove button
rather than the route there, and the e2e assertion joined the grouping commit it
belongs to. Verified content-preserving — the tree hash before and after the
rewrite was identical (`1fd8aeee`) — and each of the five code commits
typechecks on its own.

Four enhancements the owner asked for in one pass over the running app. They are
unrelated to each other; they are one branch because they are one review round.

### 1. Update pressed while another job runs

The report was two things at once. The visible half: *"the new job's progress bar
would overlay on top of the old one and the UI is broken."* The half behind it:
*"storyboard generation is low priority. Scan should be prioritized."*

**The overlay was one slot holding two jobs.** Every maintenance flow reported
its polled snapshots into a single `activeJob` state, on the assumption that one
runs at a time. The Update flow breaks that itself — it waits for the scan, then
hands metadata and storyboards to background watchers and returns — so pressing
Update during a storyboard pass left two pollers writing to that slot half a
second apart. One row rendered, and its label, count and bar each belonged to a
different job every 500 ms. It is now a map keyed by job id (`app/liveJobs.ts`),
so a snapshot can only ever refresh its own row, and a flow reporting "settled"
drops what finished rather than everything.

**A second, quieter half of the same bug:** `useActiveJobs` stops polling while
its list is empty, which is the state every enqueue starts from, and nothing
invalidated it on enqueue. So the server's list — the authoritative one, and the
only one that survives a reload — stayed empty for the whole run, leaving the
client's own snapshots as the only source of rows. Enqueuing now nudges it.

**Priority is two mechanisms, not one.** Ordering the queue
(`registry/jobs.py:JOB_PRIORITY` — scan, then probe/thumbnail, then storyboard;
FIFO within a class) only decides what starts *next*, which does nothing for the
case the owner actually hit: the long job is already running. So a running job
also asks, at its checkpoints, whether more urgent work is waiting, and stands
aside if it is (`JobYielded` → `requeue_after_yield`).

Standing aside is deliberately neither a cancellation nor a failure. The row
keeps its identity — so the client watching it sees it return to *waiting*, and
`get_or_create_queued_job` reuses it instead of stacking a second copy of the
same pass behind it — and only the item in flight is rolled back. Counts reset
because the resumed pass sweeps from the start again; every library-wide pass
skips work that is already current, so what it re-reads is cheap. The check is
raised only from the checkpoint path, so a pass stands aside *between* items
rather than mid-ffmpeg, and the urgent job waits at most one item.

Worth knowing for next time: **a scan is not slow, so the fix is mostly
invisible.** Measured against a synthetic 300-clip library, a scan enqueued
behind a forced storyboard pass showed
`scan:running | storyboard:queued [paused while more urgent work runs]` within
half a second, and the pass resumed immediately after. The Update button reads
**Waiting…** rather than *Updating…* for that half second, because the job
already running keeps the worker until its next checkpoint.

### 2. The Collections heading

It hid every collection. That is the one thing the gesture could do that nobody
wants — those rows are the sidebar's main content — so it now folds the *tree*:
one click down to the top level, another back out to every level. A collection's
right-click menu carries the same for its own branch (**Expand All / Collapse
All Subcollections**), offered only where there is something under it to fold.

Both read the current fold state rather than keeping a flag of their own, which
is what keeps the heading and a row's menu agreeing after individual carets have
been clicked. The section's persisted collapse state is gone with the behaviour
it drove; revealing a collection (creating or renaming one from elsewhere) now
only has ancestors to unfold.

### 3. The grouping suggestion's confidence

Removed at the owner's request: *"It's often wrong anyways."* Every bundle row
carried its band in words — confident / likely / guess — and a wrong claim of
certainty is worse than no claim.

The distinction worth keeping is that **what survives is evidence, not
confidence**: a row the suggester grouped from its folder rather than from
matching names is still flagged, still says so in the suggester's own words
beside the title, and is still counted above the list. That one is checkable by
looking at it; the band was not.

### 4. Dragging bundle notes into order

The stack could be added to and removed from but never rearranged. Each box now
carries a grip directly under its remove button, both hover-revealed, on rows
that have something to reorder.

**Where the grip goes took three attempts, and the sequence is the useful
part.** It began in the box's bottom-left corner, on the strip the resize grip
already occupies, chosen because it cost the text no room. The owner: "not well
placed" — and right, because a handle sharing a strip with the resize grip reads
as part of the resize grip, and no list anywhere puts its reorder handle in a
bottom corner. So it moved to a rail inside the box's left edge with the text
inset to clear it, which is where list handles conventionally live. The owner
again: too much margin, "I prefer the old way" — put it on the right, under the
cross.

That is the answer, and in hindsight the obvious one: **the remove button had
already bought the space.** A right inset exists on every note box for the `×`;
a second control stacked beneath it is free, where both a left rail and a wider
right column charge every line of text for the privilege. The lesson worth
keeping is that the question "where does this affordance go" was really "which
margin already exists", and two of the three attempts went looking for new room
instead of spending room already spent.

**And the room already spent turned out to be too much** — "do we need this
much?" — so the column was measured rather than inherited. Its floor is the 5px
scrollbar it must not cover, plus a 12px glyph: **18px**, down from the 26 the
`×` had reserved on its own since before any of this. Both controls fit a
one-line box (34px, the shortest a note box gets) with 5px to spare: `×` at
3–17px from the box top, the grip at 17–29px. Below 18 the glyphs stop being
clickable targets or start sitting on the scrollbar, so the affordance that
*added* a control also gave the text two pixels back.

Two smaller notes on it. **The glyph is an inline SVG, not `⠿`** — U+283F is not
in every platform's default font, and `icons.tsx` exists precisely so an icon
cannot render as a tofu box on the Linux deployment. **Why pointer capture
rather than HTML5 dnd:** a `draggable` ancestor hijacks text selection inside
the box, which is the one thing a note box exists for — the same reason the
bundle's file rail uses pointer capture, and the gesture is now the same on
both.

The order is carried through `moveTo` as *indices*, not ids: notes are plain
strings and two of them can be identical (two empty draft boxes, most obviously).
Per-note heights are permuted the same way, so a note arrives at its new position
with its own height instead of inheriting whatever used to be there.

### Verification

**Gates:** `ruff check`, `ruff format --check`, `mypy src packaging`, and **1153
backend tests** green (1 skipped); `npm run lint`, `format:check`, `typecheck`, **1004
frontend tests**, and `build` green. Playwright frontend e2e: **133 passed**,
with one player spec failing on each of two full runs — a *different* one each
time, both passing when their spec runs alone, and no playback code is touched
by this branch. **Not run:** the desktop Rust/Tauri gates (no Rust, Tauri or
packaging file changed) and the full-stack e2e.

**Verified in a browser** against a throwaway library on a scratch
`CAIRNDEX_DATA_DIR` — 316 synthetic clips, never the owner's own, and no lease
of a real library was touched. All four: the queue transition above; the
Collections heading folding to the top level and back, and a branch folding from
its menu two levels deep in one gesture; a 303-row grouping plan with no
confidence anywhere; and a note dragged by its grip, with the insertion line on
the row it will land beside, the source row dimmed, the reordered list PATCHed,
and the arrow-key path doing the same move.

One honest gap in that browser pass: **the pointer drag was dispatched
synthetically**, because a synthetic `PointerEvent` carries no live pointer id
and the real `setPointerCapture` rejects it, so capture was stubbed for the
dispatch. Everything else in the gesture — hit-testing under the pointer, the
geometry deciding which edge of which row, the drop line, the commit — ran for
real. A genuine mouse drag is unverified here, as the same gesture on the file
rail was when it shipped.

## Merged: filing what you add, into a bundle or a collection (2026-08-28, PR #11)

Branch `feat/filing-into-bundles-and-collections`, off `main` at `21619138`,
**merged through PR #11** (`8c92ba85`) with all seven CI jobs green — backend,
frontend, full-stack e2e, packaged sidecar, Desktop Rust (Ubuntu), Desktop shell
(macOS), and Docker. CI was dispatched against the branch head before the PR
existed (`workflow_dispatch` runs the full matrix on any ref), so the merge
needed no second run.

Renamed from `feat/suggest-bundle-on-import`, which stopped describing it several
rounds in: the work is about getting a file you have just added into the place it
belongs — a bundle, or a collection — plus the indexed lookups that made those
paths quick enough to use.

**On first open after this, each library rebuilds its FTS search index once**
(~0.5 s per 60k bundles, lossless). Expect it on the NAS library.

The fourteen commits it was written in were squashed into eight along contiguous
runs, with no reordering, so each one lands on a state that was green when it was
made. Verified content-preserving: the tree hash before and after the rebase was
identical (`51ed7fca`).

Checked for user data before the PR went public, since the owner asked and the
repository is public: no library filenames, folder names, machine paths, or
library names in the diff, the commit messages, or the PR body; every fixture is
invented or pre-existing. One near-miss worth recording — the bundle title from
the owner's screenshot was typed into a *scratchpad* profiling script rather than
replaced with an invented name, and stayed out of git only because of where that
file happened to live. Invent the fixture at the point of writing it, not at the
point of committing.

Sections below are in the order the work happened, which is not the order of the
commits; the PR description is the summary that reads top to bottom.

**What the owner asked for.** Not the refactor it started as. The opening request
was "a bundle identifies one root directory, its files must live in that
directory or below", then narrowed to the goal behind it: *quickly assign a file
to a bundle while importing it*, through either route — the File Browser's
drag-in/Add Files Here, or the Bundle Browser's `Add Files to Library…` — with
good performance on a large library and **no live scan**. The owner explicitly
dropped the root-directory concept: "we may not even need to explicitly record a
root for each bundle. It doesn't necessarily have to be a concept."

That turned out to be right, and it is the design note worth keeping: **the root
dissolves into an indexed query.** "Which bundles could a file landing here
join?" is "bundles with a file in this folder or a folder enclosing it", which is
a bounded set of equality probes on `asset_files.directory_path`. No column, no
migration, no invariant to maintain, and nothing to keep in step with a file that
moves. `product-brief.md:124` still stands unamended.

**A full table scan was found and fixed on the way.** Candidate gathering in
`manual_bundling/suggest.py` matched `relative_path LIKE 'folder/%' ESCAPE '\'`.
SQLite cannot use an index for that — its default case-insensitive `LIKE` rules
it out, and an `ESCAPE` clause disables the `LIKE` optimization outright — so
each distinct folder in a selection cost one full read of `asset_files`, on
dialog open, and paid it in full even when the folder matched nothing. Measured
on a synthetic 100k-file library: **5.00 ms per folder against 0.06 ms** for the
indexed form; ~4.84 ms even for a folder with no matches. Worse on
network-mounted storage, where it is a whole-table read versus a few index pages.

Both directions of the relation are now indexed:

- *bundles enclosing a file* — `directory_path IN (folder, …ancestors)`, one
  probe per level, bounded to three levels up;
- *files within a bundle's folder* — a half-open range, `>= dir + '/'` and
  `< dir + '0'`, since `'/'` is 0x2F and `'0'` is the next byte, which bounds the
  subtree exactly (`Set1-old` sorts below it, `Set1x` above). Verified against
  both sibling-prefix shapes.

The library root is excluded from the walk in both directions: it encloses
everything, so matching on it is evidence of nothing, and its subtree is the
whole library.

**The plan test asserts the index by name, not the absence of a scan.** Reverting
to `LIKE` does *not* reliably produce `SCAN asset_files` — the planner may drive
from `asset_bundles` and test each bundle's files instead, which is just as slow
and reads as innocent. The first version of that test passed against the old
spelling; it was rewritten and then confirmed to fail against it and pass once
restored.

**Two cases deliberately stay quiet** rather than guess, both in
`app/importBundleOffer.ts`: a suggestion below 0.4 confidence, and a leader less
than 0.05 ahead of the runner-up. The second is the owner's original worry —
"a file system directory can contain multiple bundles so the path is not unique
to a bundle" — and it is real: two bundles in one folder score *identically*, so
naming one in a toast would present a coin flip as a recommendation. Both cases
remain available under **Add to Bundle…**, which applies no threshold.

**Verified end to end in a browser**, against a throwaway library on a scratch
`CAIRNDEX_DATA_DIR` (never the owner's own; no lease of a real library was
touched). Dropping `reel-behind.mp4` into a folder holding two bundles offered
*Add to "Alpha Reel"* beside *Undo*; taking it linked the file as `video_part`;
dropping a neutrally-named `IMG_4021.mp4` into the same folder offered nothing
but Undo. All five imports 201, all five `suggest-targets` 200, the `add-files`
200, `link=false` unchanged on every import.

**Gates:** `ruff check`, `ruff format --check`, `mypy src packaging`, and
**1137 backend tests** green; `npm run lint`, `format:check`, `typecheck`,
**951 frontend tests**, and `build` green. **Not run:** Playwright e2e, and the
desktop Rust/Tauri gates — no e2e spec, Rust, or Tauri file changed.

**Known gap, not a regression.** The picker half is reachable only from the
desktop menu bar (`File ▸ Add Files to Library…`; `useDesktopMenu` early-returns
off a desktop host), so a browser cannot exercise it — the same coverage gap
recorded under *Add Files to Library* below. It is covered by component tests;
its appearance in the packaged app is unverified.

**Two owner reports on this branch (2026-08-26), both fixed.**

*"Right now it doesn't seem to suggest a bundle"* when dropping into a File
Browser folder. Correct, and a gap in the work rather than a tuning problem: a
Finder drag-in **on the desktop** goes through the shell's own importer
(`useDesktopFileDrop` → `hostImports.copyIn` → `useHostImports`), which is
separate machinery from the browser upload (`useWebImports.copyIn`) all the way
down. Only the second had been wired, so the offer existed on the web and was
silently absent in the packaged app. `useHostImports` now accumulates what
reached disk and reports it once the batch settles — deliberately a batch-level
callback, because `onImported` fires per file and knows only an operation id,
while the offer needs the landed *paths* and has to wait until nothing more can
join them. Called before the stopped-batch summary flash, so that summary still
wins the toast, matching the web path's precedence.

Worth keeping straight, since it decides where to look next time: **Add Files
Here** and the toolbar picker always worked — they are `<input type=file>` and go
through the web path even inside the desktop app. Only the Finder *drag* differed.

*Locate a bundle in the File Browser.* Its context menu now opens the folder the
bundle's own file sits in, with that file highlighted, reusing
`locateFileInBrowser` and `bundleHostPath` so the three card actions agree on
what "this bundle's file" means. Placed above Open/Reveal and offered on the web
too, since it navigates inside Cairndex.

It opens the **primary file's folder, not the common ancestor** of every member.
For the ordinary single-folder bundle these are the same; for one spanning
sibling folders the ancestor contains none of its files, so it would open a
folder showing nothing you were looking for — and landing on the file the card
stands for is what lets it be highlighted.

**A debugging note worth not repeating.** The new e2e test failed on its
highlight assertion, and the cause was the test's own fixture: a scripted
edit that pointed the bundle at `Show/clip.mkv` while the mocked folder held
`clip.mp4` had silently not applied, because that one `str.replace` was written
without asserting the match count while its neighbours had one. The feature was
correct throughout. Assert the count on every scripted source edit.

**Third report, same day: "Add Files Here still does not work", in the desktop
app.** That path was *not* broken — driving the real hidden `<input type=file>`
against a live server produced `Add to "Alpha Reel"` + `Undo`, and
`useWebImports` has no host-specific branch, so the desktop app takes the same
code. What was wrong is that **withholding the offer looked identical to the
feature not working.** The toast said nothing whenever the leader was below 0.4
or within 0.05 of the runner-up — and one of those, two bundles in one folder,
is common.

So there is now *always* an action: an unconvincing guess degrades to **Add to
Bundle…** on the same toast, opening the full ranked list plus a search over
every confirmed bundle. A failed suggestion lookup lands there too, rather than
being swallowed. Verified live: the neutral-name tie case that produced silence
now offers the picker, and taking it opens the dialog with both tied candidates
listed.

**Resolved (2026-08-26), and it was discoverability.** The offer had been there
the whole time: *"it looks like I have to explicitly click on the button in the
toast to bring it up, so I didn't know about that."* Nothing was broken in either
build. Worth keeping as the lesson: a toast action is easy to miss, and three
rounds went into diagnosing a feature that worked.

The owner's read on that round — *"maybe all the fixes you've done in the latest
rounds are not necessary"* — is half right. **Locate in File Browser** was its own
request and stands; the **desktop Finder-drag** wiring was a genuine gap, since
that path offered nothing at all; the **always-an-action** change was motivated by
a misread but still fixes the tie case, and now composes with the work below.

**The actual need, once the misunderstanding cleared:** *"a way to create a
bundle along with the add to a bundle."* The suggester can only ever propose
joining an existing bundle, and a file arriving in the library is at least as
likely to be a new one. **New Bundle…** now sits beside the add-to action on
every import toast, opening the same `CreateBundleDialog` the File Browser's
Create Bundle… uses — title proposed from the filename, nearby files offered.

Put in the toast rather than in `DirectoryPicker`, because the toast is the one
place every import route converges; the picker stays a question about *where*.
The picker's "Don't add to a bundle" now falls through to that toast, so
answering it is a *not yet* rather than a no.

Verified live end to end: the toast shows `Add to "Alpha Reel"` / `New Bundle…` /
`Undo`; taking the second opens the dialog titled `reel-featurette` from the
filename; completing it reports *"Created a bundle from 1 file."* and the API
confirms a third bundle holding that path.

**The picker flash, and what it was hiding (2026-08-26).** The owner noticed the
destination picker reloading on every folder click, and asked the better
question: *"does this mean it will potentially produce wrong behavior?"*

The flash was cosmetic — a new cache key with nothing stored, so the list was
replaced by "Loading…". But it sat on top of a real defect, and the obvious fix
would have activated it. The rule *"forget the chosen bundle when you leave the
folder"* had been implemented as *"forget it when the id is no longer in the
fetched suggestion list"* — a correctness rule keyed on a network state, which
held only because TanStack retains `data` across a refetch. Any render where that
list was momentarily empty for the **same** folder would have discarded an
explicit choice and imported the file unbundled, and `placeholderData` is exactly
the change that produces such a render. It is now keyed on the folder the choice
was made in, and carries its own title so the confirm button can say what it will
do before any list arrives.

Then extended to the File Browser at the owner's request. Higher stakes there:
its rows feed Rename, Move to… and Move to Trash, so a click on a held row could
target a file from the folder just left. Held rows are dimmed, `aria-busy`, inert
in CSS **and** guarded in the click / double-click / context-menu handlers —
jsdom does no hit testing, so a CSS-only guard is both untestable and dependent
on a stylesheet having loaded. Band-select and arrow keys are suspended for the
same window; path-keyed affordances (drop, New Folder, background menu) stay
live, because `path` is already the destination.

`keepPrevious` stays **opt-in** on `useFileBrowser` rather than becoming its
default: any caller holding a stale listing must guard against acting on it, and
that guard depends on what its rows do. No other caller needs it — the only two
consumers are these, the collection picker reads one non-navigable query, and the
bundle-drop destination wraps the same directory picker.

Both fixes have regression tests verified to fail against the previous code.

**"Creating a bundle takes about 5 seconds. I expect this to be instant"
(2026-08-26).** Diagnosed and fixed; almost none of it was the bundle work.

Every FTS maintenance trigger in `search/index.py` located a bundle's index row
with `WHERE bundle_id = ?`. `bundle_id` is `UNINDEXED` in the FTS5 table and FTS5
has no secondary indexes, so that is a **full scan of the whole index** — plan
confirmed, `SCAN bundle_search VIRTUAL TABLE`. A create fires about ten of them
(an `asset_files` update reindexes both the old and new bundle).

Measured on a synthetic 60k-bundle library:

| | |
| --- | --- |
| `create_bundle`, triggers on | **94 ms** |
| `create_bundle`, triggers dropped | **6 ms** |
| `DELETE … WHERE bundle_id = ?` | 8.5 ms (full scan) |
| `DELETE … WHERE rowid = ?` | 0.0 ms |
| the reindex `INSERT` from the view | 2.1 ms |

So the delete was the cost, and the *view* — which the module's own docstring
blamed, and which cost me a wrong first hypothesis — was never the problem. That
docstring is corrected in place.

Every trigger now keys on the bundle's own integer rowid, which its FTS row
shares (`asset_bundles` has a TEXT primary key, so it is an ordinary rowid
table): **94 ms → 21 ms**, and flat in library size rather than linear — 15 ms at
4 bundles against 7 ms at 60k. Two invariants this rests on, both tested:
`AFTER DELETE ON asset_bundles` must read `OLD.rowid` (the row is gone, so an id
lookup would orphan the index row forever), and a rebuild must reassign the same
rowids.

**One-time rebuild on first open**, ~0.5 s for 60k bundles, because rowids
assigned under the old scheme bear no relation to their bundles.
`ensure_search_schema` detects the old scheme by its trigger body not mentioning
`rowid`.

**Two process notes, both mine.** A scripted edit adding the migration was in the
same script as an assertion that failed, so nothing was written and a later
script silently re-applied only part of it — the fix ran for two measurements
before I noticed the trigger was untouched. And the first version of the rowid
invariant test *passed against the old scheme*, because on a fresh database auto
rowids and bundle rowids coincidentally agree; it needed an edit first (a reindex
is delete-then-insert, and the reinserted row took a fresh auto rowid) to bite.
Both are the same lesson twice: verify the edit landed, and verify the test fails.

**New Collection from Folder… (2026-08-26).** A folder's context menu can now
turn it into a collection: name (defaulting to the folder), a parent picker, and
every bundle in the folder **and below** filed in. `bundle_ids_under_directory`
reuses the same indexed `directory_path` half-open range as the suggestion work,
so it is an index seek rather than a `LIKE` scan, and the sibling-prefix cases
(`Alphax`, `Alpha-old`) are covered by tests.

Three judgement calls worth recording, none of them forced by the request:

- **Subtree, not direct children.** A collection is flat rather than a mirror of
  the directory tree, so "the collection for this folder" means everything filed
  under it. The dialog shows the count before the button is pressed, so the
  choice is visible rather than guessed.
- **Confirmed bundles only.** Provisional scan rows are guesses the owner has not
  confirmed, and browse already hides them from every collection.
- **One request, not create-then-assign.** A collection that exists but never
  received its members is worse than one that was never created, and only the
  server can make the two atomic.

**The parent picker is a foldable tree, not a `<select>` (owner, 2026-08-28:
"native list won't work well once it gets long").** Rows come from the shared
`visibleHierarchy` in `usePopover.ts`, and **`CollectionPicker`'s near-identical
local copy has been folded into it** at the owner's request — 25 lines gone.

Neither the shared helper nor `CollectionPicker` had any tests, so the fold was
done back-to-front on purpose: first a throwaway differential check running both
walks over 200 pseudo-random forests × three collapse states and comparing row
for row (identical), then a permanent `usePopover.test.ts` covering the helper
that now backs three pickers, and only then the deletion. The differential also
pinned the one input where they disagree — a row whose parent is absent from the
list, which the retired walk dropped and the shared one re-parents to the top
level. `CollectionPicker` always passes the complete list, so it cannot occur
there, and where it can (a filtered subset) keeping the row is the better answer.

Verified live afterwards, since the component still has no tests of its own:
the picker renders the full hierarchy, folding `By Year` hides exactly its three
children, and assigning a bundle to `Reference` adds the chip.

Three details that are not obvious from the requirement:

- **Rows are `<button>` elements, not clickable divs.** This is a form field in a
  modal, so it has to be operable from the keyboard, and a button gets focus,
  Enter and Space for free. The fold chevron is a *sibling* button, because a
  button inside a button is invalid HTML and folding is a different action from
  choosing.
- **Searching flattens the tree**, so a match is never hidden inside a folded
  branch — verified live by folding `Archive` and then finding `2025` three
  levels inside it.
- **Folds survive a search** and its clearing, so narrowing to find one thing
  does not throw away how you had arranged the rest.

**The parent rows are radios, not tick boxes (owner, 2026-08-28).** Exactly one
parent can be chosen, and a tick box reads as "any number of these". Round, with
a centre dot rather than a glyph, and `role="radio"` inside a `role="radiogroup"`
so the semantics match the appearance.

**An unexplained intermittent, recorded rather than waved away.** Immediately
after that change the full frontend suite failed twice in a row on
`GroupingReview > a long plan opens folded, and Expand all still opens it` — a
test this branch does not touch. It then passed 5/5 full runs, 2/2 with
`--no-file-parallelism`, and in isolation; the baseline passed 4/4 under the same
stress. So it is not a deterministic break from this work, and the likeliest
story is that adding a test file changes worker scheduling and surfaced existing
order/timing sensitivity in a fold interaction. Not reproduced, so not fixed —
if it reappears, that test is where to look and this is the first sighting.

**A folder's context menu is no longer write-mode-only.** It used to open only
when writing was permitted, because Rename was the only reason it existed. It now
carries two metadata-only entries (Copy Path, New Collection from Folder…), so it
opens read-only and the filesystem entries are gated individually.

**Pre-existing quirk found while testing, deliberately not changed:**
`UNIQUE(parent_id, name)` does not constrain *top-level* collections, because SQL
treats NULL as distinct from NULL — so two top-level collections may share a
name, while two siblings under a parent may not. True of every route that creates
one, including the sidebar's "+". A test now asserts both halves so the
difference is recorded rather than rediscovered. Worth deciding on separately.

**Not reproduced:** the flash the owner also sees on window resize. With
`refetchOnWindowFocus: false` and a 30s `staleTime`, a resize should not refetch
at all, so that may be a layout reflow rather than a reload.

**Gates re-run:** `lint`, `format:check`, `typecheck`, **963 frontend tests**
green. Playwright is **137/137 with `--workers=1`**; parallel runs flake between
zero and two failures, always in `player.spec.ts` media timing and once in
`libraries.spec.ts`, each passing alone. Pre-existing and unrelated to these
changes. The backend gate was **not** re-run — no server file changed.

**Next:** owner verification in the desktop app, particularly whether 0.4/0.05
are the right bars against a real library, and whether the picker's offer wants
the confidence pill the bundling dialogs show.

## Merged: an unbundled file is never "missing" (2026-08-24, PR #10)

Branch `fix/unregistered-files-never-missing`, off `main` at `3a96d255`, **merged
through PR #10** (`f82869da`) with all seven CI checks green — including the
full-stack e2e and the packaged-sidecar smoke test. Five code commits,
`907b7dda` → `13371bf4`; the four incremental status notes were squashed into one
before merge. Started from an owner report while testing the card-menu fix below.

Owner: "Why are deleted files put into its own bundle and show up in Missing
Files? Now the only way to dismiss them is to delete the bundle." Then, after the
mechanism came out: "if a file is never bundled, I don't think it should ever be
*missing*… I treat a bundle to be formally registered in the library. Unbundled is
the pending zone waiting to be registered."

**That model is the fix, and it is better than what was being designed.** Two
rounds of guard design (a `missing_since` column, a grace window, a
survive-one-scan rule, a 10% ratio, a batch cap) existed only because the scan
could not tell a deletion from an outage. Given the distinction, all of it goes.

### 1. Deleting a bundle re-staged its dead members (`9e026844`)

Verified before touching anything: a two-file bundle with one missing member left
`MISSING` at **1** after Delete Bundle, as a fresh one-file provisional bundle
titled after the dead file. `_restage_file` had no availability test, and the
Missing view included provisional rows, so the card came back under a new id and
took a second delete to shift — while the first delete had already dissolved the
grouping. `delete_bundle` now leaves a missing member attached so it goes with the
bundle; `remove_file` drops it through a new `_forget_file`, which also takes a
bundle the removal emptied.

### 2. Forget (`ec3b345f`)

`forget_missing_files(session, bundle_id, file_ids=None)` +
`POST /bundles/{id}/files/forget-missing`, reporting `{forgotten, bundle_deleted}`
so the client can leave an album view rather than refetch a bundle that is gone.
Refuses anything not `MISSING`: a present file is removed or trashed, and a
trashed one is recoverable rather than dead (ADR-0013 §3.2).

In the file-row menu it **replaces** Remove from Bundle when every target is
missing — post-fix-1 those do the same thing, and only one of the names says so.
A caller that has not wired forget keeps the detach rather than losing the row.
The card menu offers it for a bundle with `has_missing`, single selection only.

### 3. The scan drops what it can prove is gone (`1aaa3bbf`)

Missing Files and its badge cover **registered bundles only**, which clears the
existing ghosts without waiting for a scan. Then `scanning/staging_cleanup.py`
drops the rows, on two conditions read off the scan that finds them:

- **the walk read every directory it tried.** `_list_directory` swallowed
  `scandir` failures ("vanished or unreadable; nothing to report"), which is
  exactly the distinction the delete rests on. It reports now, and one failure
  anywhere disqualifies the sweep.
- **the file's recorded filesystem is still mounted where it was.** The owner's
  correction, and the one that killed the previous draft: *"whenever the volumes
  that I mounted on SMB dropped, the folder will be gone"* — so a vanished folder
  is not proof. The surviving ancestor is then on the outer filesystem, and
  `AssetFile.filesystem_device` (recorded every scan since D2) does not match it.
  An unmounted mountpoint left behind as an empty directory fails the same check,
  since it reverts to its parent's device. `sqlite_filesystem_identity` moved to
  `scanning.fingerprint` so both sides encode the comparison identically.

Never swept: registered bundles, and any staging row carrying something
owner-made — tag, rating, note, source, collection, watch position, cover frame,
cover or subtitle reference. `ScanSummary.forgotten` and the job result report the
count. `missing_total` was deliberately **left raw**: after the sweep the only
rows it can still count are a genuinely unreachable mount or an owner-decided
staging row, and both are worth the scan-complete flash saying so.

**Residual, accepted:** a nested mount that is *remounted* between scans gets a
new device number, so anything deleted in that window is refused permanently and
lingers until Forget clears it. Fails toward keeping rows, and the blast radius is
unregistered staging rows, so the worst case of any wrong call is a re-probe and
re-thumbnail of files that come back — never lost data.

### 4. The count was reported nowhere (`9acb7333`)

Owner, immediately: *"where do I see forgotten? They don't show up anywhere
right?"* — correct. `ScanSummary.forgotten` reached the job's result payload and
stopped there, which is not a surface. The scan-complete flash now reports both
counts (*"Scan complete: 0 linked files are missing. Forgot 2 unbundled files that
are gone."*), built by `scanCompleteMessage` in `app/scanSummary.ts` so the copy is
testable and the payload reading is defensive — a cancelled run or an older server
carries neither key and reads as zero. The forgotten clause is omitted entirely
when nothing was forgotten.

### 5. The inspector kept describing what was gone (`c5c0fc31`)

Owner, testing: *"after a bundle/file is deleted/forgot, the inspector still shows
the information"* — with a screenshot of a single-file bundle's panel, MISSING
badge and Relink Unavailable, for a bundle that had just been forgotten.

Two causes, both fixed. The detail request 404s and react-query keeps the last
successful data on error, so the panel had something to render and no reason to
stop — and `getJson` threw a bare `Error`, so nothing could tell "gone" from
"failed". GETs now throw the status-bearing `HttpError` the module already had
(same message, so every existing catch is unaffected), and
`useBundle`/`useBundleFiles` resolve a 404 to `null`/`[]`: absence is a normal
outcome for a row that can be forgotten, swept, or deleted in another window, and
a 404 stops being retried three times. The inspector reads `null` as gone and says
so, still distinct from `undefined` — not loaded. Second cause: the forget path
left the selection on a bundle it had just deleted, so it now clears the selection
and closes the open bundle and viewer as deleting a bundle already did, and the
album view backs out when forgetting takes the bundle it was showing.

Not done, and deliberately: an effect backing the album view out when a *scan*
sweeps the bundle it is showing. There is no BundleAlbum test harness to pin it,
and the inspector already says gone; the forget path — the one that actually
happens — backs out explicitly.

### Tests and gates

Server: three tests for fix 1, four for Forget (including a route-level one that
asserts the bytes survive), six for the sweep — the plain case, a whole folder
deleted, both guards, an owner-rated row that survives — and the Missing view
inverted. Four existing tests were **re-based on the model rather than deleted**:
repair and missing-not-deleted now register their bundle first, because repair is
for a file the owner committed to and an unregistered row has nothing to preserve.
Web: four for the menu entry, four for the scan-complete copy, three for absence
(a 404 resolving to gone for both hooks, and any other status still failing), two
for the inspector's gone-versus-loading states, and the new hook added to three
Inspector mocks (the parity test caught that drift, again).

`apps/server` ruff / ruff format / mypy / **1130 tests**; `apps/web` lint /
format / typecheck / **934 tests** / build. Desktop untouched.

**Rehearsed end to end on real media, outside the test suite.** A generated
scratch library — half a megabyte of ffmpeg `testsrc` clips under invented names,
two of its folders confirmed as bundles and one staged file rated — walked the
whole flow: a staged file deleted → `forgotten=1`, row and bundle
gone, Missing Files still empty; a whole folder → 2; the rated staged file →
`forgotten=0`, kept; a registered bundle's member → in Missing Files, then Forget
leaves the bundle with its other three files; the single-file bundle → Forget takes
the bundle. **The nested-mount guard was verified against a real disk image**
mounted inside the library root (distinct device id): dropped with its mountpoint
left behind *and* with the mountpoint removed, both refused to forget, and
re-attaching returned the row to available with no re-probe.

Not verified in a browser: the owner's `tauri dev` was live on the same registry,
and a second server would have contended for the library lease. The card menu
cannot render in jsdom either (no layout, so no cards), so the menu wiring rests on
its unit tests.

Next: nothing queued. Two follow-ups are recorded in PR #10 and deliberately not
done: a Forget entry in the Unbundled list for a kept staging row, and an effect
backing the album view out when a scan sweeps the bundle it is showing.

## Merged: a bundle card's file on disk (2026-08-24)

Branch `fix/card-host-actions-primary-file`, off `main` at `df9b9c72`,
fast-forwarded onto `main` as `d4184223` at the owner's request. The follow-up the
⌘↩/⇧↩ work recorded as known and not fixed (section below).

Owner: "whether [the] file format is supported … should not dictate whether we
can open with default app or reveal in Finder. Those buttons should exist either
way."

**The card menu was asking the wrong question.** It gated both host entries on
`resume_relative_path`, and `_summarize` fills that only when `is_openable` —
`AVAILABLE and is_supported`. So a present file in a format the viewer cannot
stage, and every card in the Missing Files view, produced a null path and
`hostFileMenuEntries` was never called: two rows gone with nothing said. The
inversion is the point — reveal exists so *another* application can have the
file, which is most useful precisely when Cairndex cannot show it. ⌘↩ and ⇧↩ had
the same hole, through `selectedBundlePath`.

`BundleSummary` now carries **`primary_relative_path`**: the file the bundle
stands for on disk, resolved as cursor file → the effective cover's source →
first file, with no playability or availability test. Three steps rather than
one, because `select_current_file` only ever returns a *supported* file, so an
audio-only or document bundle has no cursor at all; the cover's source is then
the file the owner is actually looking at, and the first file is what is left for
a bundle with no cover source either. Computed from rows the summary already
loads, so a page still costs four statements (the count test covers it).

`resume_*` did not move and still means "the viewer can play this" — the viewer,
hover previews and the card's own metadata keep reading it. The web reads the new
field through one documented helper, `bundleHostPath`, used by both the card menu
and the shortcut resolver so they cannot drift again.

**A missing file is refused by the filesystem, not by the flag** — a deliberate
narrowing of the brief's "keep Open gated on availability". `availability` is a
snapshot from the last scan, so refusing on it would block a file that has since
come back, while the shell resolves every handoff against the real filesystem and
already answers `path_not_found` ("The file does not exist at its mapped
location") or `volume_not_mounted` ("Reconnect it and try again"), each mapped to
web-owned copy. So the rows are present and explain themselves on use, which is
what the owner asked for, and no disabled rows were added to a context menu — the
thing they rejected on 2026-08-24.

Tests: three in `test_browse.py` (an unconvertible image and an audio-only bundle
both name a file while `resume_relative_path` stays null, an empty bundle names
nothing; a missing file keeps its path in the Missing view; the cursor beats the
first file), plus the playable case asserted in the existing enriched-summary
test. Two in `hostFileTarget.test.ts` for `bundleHostPath`.

Gates: `apps/server` ruff / ruff format / mypy / **1117 tests** (3 new);
`apps/web` lint / format / typecheck / **922 tests** (2 new) / build. Desktop
gates not run — nothing under `apps/desktop` changed, and the shell's own path
resolution and its `PathNotFound` test are untouched.

**Not verifiable in either test harness, and the reason is structural:** jsdom has
no layout, so the virtualized grid renders no cards (`App.test.tsx` says so at the
top), and a browser has no host actions at all, so Playwright would assert two
rows that never render there. **The owner confirmed it in the desktop app**: a
card in Missing Files now carries both entries, and clicking one raises the
refusal toast rather than doing nothing.

They also asked the obvious question of the screenshot — the rows are not greyed
out. That is the design: `availability` is a snapshot from the last scan, so a
greyed row would refuse a file that a remount or a restore has already brought
back, while the shell's check is current at the moment of the click. The badge
says what the library last knew; the toast says what the filesystem says now.

Next: nothing queued.

## Merged: four owner reports — Random, notes, the playlist, tag management (2026-08-23)

Branch `fix/tag-management-and-panel-sizing`, off `main` at `47e2b34a`; the last
code commit is `7d637310`. Four reports from using the app, in the order they
were given.

### 1. "Opening Random takes almost 10 seconds. It shows loading library"

**The shuffle is not the cause, and this was measured before anything was
changed.** `RANDOM` and `ALL` compile to the same plan (`SCAN asset_bundles` +
`USE TEMP B-TREE FOR ORDER BY` for both — the `_visible_file_exists` OR
predicate already denies either an index walk) and cost the same:

| one browse page, before                    | statements | time         |
| ------------------------------------------ | ---------- | ------------ |
| ALL, network-mounted library               | 56         | 145–185 ms   |
| RANDOM, same library, same page size       | 56         | 178–184 ms   |
| ALL, local synthetic, 1500 bundles         | 102        | 12.7 ms      |
| RANDOM, same                               | 102        | 12.9 ms      |

**What it was: the summarizer ran one query per bundle.** Which is the exact
shape the 2026-08-13 diagnosis below says this deployment cannot afford — the
owner's library is on SMB at ~36 ms a round trip, so *count statements, not
milliseconds*. That finding fixed the grouping code; it should have been read as
a constraint on the whole read path. A 100-row page was 100 extra round trips
(~3.7 s cold, on top of the page and its count).

Every view paid it. **Random paid it worst**, for two reasons that are both
structural rather than incidental: its rows are scattered across the table by
design, so no per-row lookup lands on a page an earlier row already warmed; and
it is the one view a session can never arrive at already cached, because a fresh
seed is a fresh query key and every Reshuffle re-pays the whole cost.

`browse._load_page_rows` now loads the page's files (with progress, via the same
outer join) and its cursor rows in two statements, so a page is **four
statements regardless of its size**. Measured read-only against the owner's
library: **56 statements / 145–185 ms → 4 / 13 ms**; local synthetic, 102 / 13 ms
→ 4 / 5 ms. `continue_watching` had the identical per-row load and now shares
`summarize_page`. A test pins the statement count (verified failing at 8 with the
per-row form restored) and `browse_random_first_page` was added to the query
benchmark.

**Not claimed: that this fully accounts for ten seconds.** 4 statements at 36 ms
is ~0.15 s, and the page/count scans on a larger library are still O(bundles)
page reads over the share. The other candidate mechanism was *not* reproduced and
is recorded here rather than acted on: cover thumbnails are generated
synchronously on the request path (`GET /bundles/{id}/thumbnail` →
`thumbnails.generate_for_bundle`, no concurrency bound), and a Random page is by
construction ~a screenful of covers that have never been generated. Over HTTP/1.1
those occupy the browser's six connections, and each is an ffmpeg seek into a
multi-gigabyte file over SMB. If the owner still sees a multi-second Random after
this branch, that is where to look next — and the discriminating observation is
whether the previous view's thumbnails are still filling in when Random says
"Loading library…".

### 2. The bundle note box could not be dragged smaller

Reproduced in the running app, and the cause is not the drag. A drag on the grip
is also a press-and-release on the same element, so the browser counts it as a
click; two drags in quick succession synthesise a `dblclick`, which was bound to
fit-to-text. Bringing a tall note down takes several short drags, so the second
one always sprang it back to full height and the box read as un-shrinkable.

Fixed by recording whether each of the last two gestures on the grip moved the
box and fitting only when neither did. **Gestures rather than a timeout**: a
700 ms guard was written first and measured losing to a slow double-click in the
running app, because the double-click threshold is a system setting — no fixed
window is reliably longer than it.

### 3. The viewer's info panel ran the full height of the window

Its file list had no cap, so a bundle with two dozen files pushed the panel to
the bottom of the screen and buried the metadata above it. Capped at 50vh with
its own scrollbar; verified against a 28-file bundle (`scrollHeight` 796 px
clamped to 450 px, panel 646 px against its 730 px max).

### 4. All Tags could not create a tag, or do anything at all with tag groups

Correct as reported, and the API had supported every missing operation since the
taxonomy went in — the page just never grew the affordances. Added: **New Tag**
(with `/` as a hierarchy divider, joining the open group panel's group), **New
Child Tag** on a tag's menu, a **+** on the side rail's Tag Groups header,
**Rename/Delete Group** on a group row, **Add to / Remove from** a group on a
tag's menu, **drag a tag onto a group row** (membership, not nesting — the tag
keeps its parent), and **Expand all / Collapse all**. All metadata-only; no
server or schema change, so no OpenAPI regeneration.

### Three follow-ups on the same branch (2026-08-23)

Asked for after using the four fixes above.

**Right-click the All Tags blank space → New Tag.** Every create affordance was
in the toolbar or on a tag's own menu, so the obvious spot for "a new one here"
did nothing. The blank-space menu offers New Tag plus the fold toggle, mirroring
the bundle grid's empty-space menu, and "here" is the open panel — in a group
panel the new tag joins that group. The tile's own handler now stops the event:
without that the click reached the grid too and the blank-space entries replaced
the tag's.

**A right-click no longer leaves a highlighted word behind.** WebKit selects the
word under the cursor when a context menu opens and Chromium does not, so this
was desktop-only and invisible in a browser check — which is also why it cannot
be reproduced in the preview: it was verified there by planting a selection
first, right-clicking, and watching it go. The clear lives in
`useContextMenu.open`, the single path every custom menu in the app passes
through, so it covers every such surface without a list to maintain. Surfaces
with **no** custom menu are deliberately left alone: there the native menu does
appear, and clearing the selection first would strip its Copy and Look Up
entries. Skipped inside text fields, which includes the inline rename boxes that
sit inside rows carrying their own menu.

**Rename Collection.** The inline rename box existed but nothing reopened it —
it appeared once, on a row, in the seconds after that collection was created —
so a collection carrying a placeholder name was stuck with it. The entry is now
on a sidebar row's menu and on a folder card's in the grid. Both land in the one
box: the card path goes through a `renameCollectionRequest` the sidebar
consumes, which is the same shape the grid's New Collection already used,
because the box and the unfolding needed to reach it are the sidebar's state.
`createCollectionUnder`'s ancestor-unfolding half is factored out as
`revealCollection` and shared, so a rename asked for on a card three levels deep
opens a box that is actually on screen. Single selection only.

Tests for the three: 7 new component/unit tests (900 web tests total, up from
893) and 1 new e2e; `all-tags` (5) and `ordering` + `library` (49 → 50) suites
green. No server file changed, so the backend gate was not re-run for this
round.

### Two more, one of them the first desktop-shell change (2026-08-23)

**Toolbar actions sit left of the resident controls.** Random's Shuffle stood in
the sort control's slot — defensible, since Random has no sort — but that put it
between the search box and the layout buttons. The residents are furniture whose
positions are worth learning, so an action appearing among them shifts all of
them. Actions now go immediately after the spacer, which is where the File
Browser's Add Files Here / New Folder and Trash's Empty Trash… already were, and
Random simply omits the sort control. A test pins the order and was verified
failing against the old placement.

**⌘H hides the app.** The shell builds its whole menu bar from
`apps/web/src/platform/keymap.json`, and that table's App menu was About /
Settings / Quit. On macOS the Hide *menu item* is where ⌘H comes from, so with no
such item the combo was simply dead — nothing was intercepting it. Added the
standard trio (`hide`, `hide-others`, `show-all`) with their arms in
`app_menu.rs`. **Not target-gated:** Tauri and muda expose all three on every
platform and they no-op where the concept does not exist, checked against
`muda-0.19.3`'s source rather than assumed, so the Ubuntu Rust-only job is
unaffected and no `#[cfg]` module was needed (AGENTS.md §gates).

Two guards, because that table is edited from the web app's side too: every
`predefined` name in it must be one `app_menu.rs` can build (an unknown one
panics when the menu is built, i.e. at startup in a packaged build), and the App
menu must still carry the hide family. ⌘H and ⌘⌥H joined the keymap test's
`IMPLICIT` list so a future explicit accelerator cannot shadow them.

Gates for this round: `apps/web` lint / format / typecheck / **903 tests** /
build, and `apps/desktop/src-tauri` cargo fmt --check, clippy
`--all-targets -D warnings`, and `cargo test` — **117 passed**, 2 of them new.
**`npm run tauri build` was not run**: the change is a menu-table edit that
clippy and the tests already cover on every target, the packaged build adds no
check it could fail, and it would have held the cargo build lock against the
owner's live `tauri dev` for minutes. That dev session did rebuild and restart on
the Rust edit, so ⌘H is testable in the app already open — **the runtime
confirmation is the owner's**, since reading a native menu bar here needs
accessibility permission this session does not have.

### Reveal in Finder was there, and invisible (2026-08-23)

Owner: "I need a way to reveal a file in Finder… map to command-enter", then
"What? I don't see it" when told it existed.

It did exist, on three context menus (bundle card, a bundle's file rows, File
Browser rows) — but `hostFileMenuEntries` **omits** the entries rather than
disabling them, and the callers gate them on several things at once. Any of these
removes the action with no trace:

- more than one bundle selected (the card menu passes a path only when `n === 1`);
- a bundle whose current file is missing **or of an unsupported format**, because
  the card menu gates on `resume_relative_path`, which `_summarize` fills only
  when `is_openable` — `AVAILABLE and is_supported`;
- a library with no local mapping (`libraryMapped`), which is also what silences
  Open and drag-out.

Checked the owner's own store: `cairndex-settings.json` holds five
`libraryMappings`, so the mapping gate was probably *not* the cause for them —
the likelier one is the second, since the Missing Files view is entirely made of
bundles with no openable current file.

**The fix is a menu-bar item**, `File ▸ Reveal in Finder` on ⌘↩, because the menu
bar is the one surface that can always be looked at. It is gated on the existing
`library` group so it is always shown, and every refusal explains itself through
the flash rather than vanishing: nothing selected, a folder selected, or the
library needing to be located on this computer.

`app/revealTarget.ts` resolves the target from the **visible surface** rather
than a priority chain — File Browser entry; or, in the Bundle Browser, the file
selected inside an open bundle, else the selected bundle's playback file. All
Tags resolves to nothing, because it shows no files and a bundle selection
carried over from the grid is off screen. The viewer is deliberately not a
source: its current file lives in its own state, and an accelerator is handled by
the OS before the webview sees it, so wiring it would mean publishing the
viewer's position upward for a case the context menus already cover.

The label is macOS wording by decision, recorded in the table's own comment: the
shell is macOS-only (ADR-0012), and the per-platform strings the context menus
use are `hostLabels.revealFile` in `platform/index.ts`. A second desktop platform
would need to set this item's text at runtime from those.

**Then the owner sent a screenshot** of a bundle file-row menu with four items
and neither host action, and added that Open in Default App was missing too.
Which located the real fault: `hostFileMenuEntries` **omits** the pair whenever
its callbacks are absent, and App withholds both for a library with no local
mapping — so a library on a network mount comes up two items short on all four
menus with nothing to say why. Verified on the owner's machine: of the two
libraries their shell knows, the **network-mounted one has no entry in
`libraryMappings`** while the local one does. Two silently absent actions read as
two features that were never built.

A first attempt rendered the pair **disabled** in the context menus with
**Locate on This Mac…** beside them. **The owner rejected that** — "Do not put
this in context menu" — and it was withdrawn, along with the two fields it had
threaded through the inspector-actions context, the album grid, the File Browser
and the file-row menu. `hostFileMenuEntries` is back to leaving the pair out.
The right conclusion in hindsight: with the local server's path now adopted
automatically (below), the case those rows explained does not arise in normal
use, and the menu bar is where an explanation belongs anyway.

The menu-bar items are greyed out when nothing is actionable, as asked: both sit
in a `host-file` enablement group behind `set_host_file_menu_enabled`, published
from the SPA as the selection moves. Sitting in `library` would have made them
live and then apologetic. One group for both because they need the same thing — a
resolvable local path for the selected file — and one handler, since they differ
only in which handoff runs.

**Open in Default App joined it on ⇧↩** (owner, 2026-08-24).
`revealTarget.ts` became `hostFileTarget.ts`, since one resolver now serves both.

It was first bound to ⇧⌘↩ on the reasoning that a bare ⇧↩ would "take the soft
line break out of every note box". **The owner asked who had taken ⇧↩, and the
answer was nobody** — and the stated cost was wrong: the note box has no keydown
handler at all, so its line break comes from *plain* Enter, which an accelerator
on ⇧↩ does not touch. Rebound as asked. The keymap table's own comment now
records ⇧↩ as the one Shift-only accelerator, what was checked before agreeing to
it, and the cost that does remain: Shift held over from typing turns the next
Enter into a file launch rather than a newline. **The lesson is the general one —
"a text field wants that key" is a claim to verify against the handlers, not a
reflex.**

Threading the two new fields through the inspector-actions interface made
`Inspector.parity.test.tsx` fail until the shell fixture supplied them — the
drift that test was built to catch, working.

**Then the owner asked the question that mattered:** "Why do we need locate on
this mac? library is on a mounted disk and can be directly opened." Right, for
their case — and it is now automatic.

The ceremony exists for a *remote* server, whose `root_path` names a directory on
that machine (`/volume1/media`), which Finder cannot open here; the shell cannot
derive a local path, so it asks, and proves the pick with the folder's
`.cairndex` marker. None of that describes the local sidecar: this shell spawned
it, its `root_path` is a path on this Mac, and the SPA already receives it on
every `LibraryRead`. The app was asking the owner to locate a folder it had open.

`mappings::adopt_library_mapping` records it with no picker, through the **same**
`validate_library_root` the pick uses — the folder must exist here and carry a
marker whose uuid matches. That check is what makes accepting a server-named path
safe rather than a breach of "never trust a client-supplied absolute path": the
path is validated, not believed. The caller restricts it to `kind: 'local'`
connections regardless, because for a remote server a coincidentally-present
local **copy** of the library would satisfy the marker and then reveal the wrong
files — that is the one hazard the ceremony still earns its keep against.

Three Rust tests pin the seam: the folder that is this library is accepted, one
holding a different library is refused as `LibraryMismatch`, and a path absent
from this machine is refused as `VolumeNotMounted` — which is what a remote root
looks like from here, and is indistinguishable from a detached volume, so the
same class is the honest answer.

**Known and not fixed** (spawned as follow-up work): a bundle card whose current
file is missing or unsupported still has no reveal target on either the menu or
the shortcut, for the `resume_relative_path` reason above. Revealing an
*unsupported* file is one of the better reasons to want Finder, so this is worth
correcting; revealing a *missing* one should be refused with a reason.

Gates: `apps/web` lint / format / typecheck / **918 tests** / build;
`apps/desktop/src-tauri` fmt / clippy `-D warnings` / **117 tests**. ⌘↩ itself is
**not verified here** — an accelerator only exists inside the shell, and driving
the native menu bar needs accessibility permission this session does not have.
The owner's `tauri dev` rebuilds on the keymap edit, so it is testable in the app
they have open.

### The bundle layouts: black frames, one name, one range (2026-08-23)

Four reports about the two grid layouts.

**The Card layout's cover frame was 1.61:1**, which is not a shape any camera
produces. Its height was whatever remained after the title block, so the frame's
real proportions were a by-product of the meta's font metrics and the card's 1px
border — the `META_HEIGHT = 44` constant was 5px off the meta's actual 39, and
the border took 2 more. Measured in the app it came out **1.716** against an
intended 1.778, so every 16:9 cover — nearly all of them — kept a thin letterbox.
Fixed by moving the shape into CSS (`.card--framed .card__thumb`,
`aspect-ratio: 16 / 9`) so it cannot be a by-product of anything;
`computeRows` now only has to reserve enough height, and `META_HEIGHT` is
documented as a reservation rather than a measurement. Measured after: **1.7778**
at zoom 120, 200 and 480, with ~4px of card surface below the text as slack.

**The Justified layout shaped each tile from the wrong file.** `aspect()` read
`width`/`height`, which describe the file under the playback *cursor* — what
plays. The cover follows its own rule (selected → first image → first video), so
any bundle where the two differ got a tile shaped for one file and a cover from
another. That is the black frame the owner saw, and it is why it was worse here
than in Card: the layout looked precise and was precisely wrong. The browse
summary now carries `cover_width`/`cover_height` (no extra query — `_summarize`
had already resolved the cover), and `aspect()` prefers them, falling back to the
cursor file and then to 16:9.

**Follow-up on the same day: Justified was still too small, and its last row was
strange.** Both came out of one packing rule. It always broke a row *after* the
tile that overflowed it, so a wide cover arriving at the end dragged the whole
row down; measured on a four-shape fixture, rows landed at 101–130px against a
140px target — **every row under it, the worst 27% under**. The target was never
actually reached, which is why pushing the slider never fixed the feeling. The
rule now breaks on whichever side of the target is closer: the same fixture comes
out within 2.3%, and in the running app 116–153px around a 140px target.

Separately, a short last row was allowed `targetH * 1.3` while full rows
undershot, so the final row — a single bundle, often — was nearly twice its
neighbour. Capped at the row above's own height rather than at the target,
because a single-shape library packs its full rows a little under the target and
a last row sitting *at* it would still stand out. Verified at zoom 200 (last row
127.9 against 127.9 above) and 640 (448 against 448.9).

The shared slider moved again, 120–480 → **140–640**, and a Justified row now
aims at **0.7** of the slider value rather than 0.6. The two layouts are judged
separately and Justified was the one still reading small: it carries no title
block under each tile, so the same height has less presence. Worth remembering if
this is revisited — the Card cover's height is 9/16 of the slider value, so 0.7
deliberately makes a Justified row *taller* than a Card cover at the same
setting.

**Also: the layout buttons got real icons.** Card and Justified were `▦` and
`▥`, which are near indistinguishable at 15px and describe nothing. Three inline
SVGs in `icons.tsx`'s existing Lucide line style: **Card** a single card (cover
above, title below), **Justified** rows of unequal widths flush to both edges,
**List** a thumbnail beside its text. All three were converted, not just the two
named — a text glyph between two SVGs in one segmented control sits at a
different weight and baseline. The File Browser's buttons share them.

Checked at 96/24/16px in the running app. The justified split was widened to 11:5
after the first pass read as a *misdrawn* grid rather than a deliberately uneven
one. Card went through four candidates rendered side by side for the owner (a
2×2 of tiles, two cards with captions, a 3×2 of tiles, and one card); **the owner
picked the single card**. It draws the tile rather than the arrangement, which is
the trade — it says nothing about how many there are — but it is unmistakable at
15px and shares a silhouette with neither neighbour, nor with the sidebar's
"All" icon, which is itself a 2×2 grid. That last point is what ruled out the
2×2 candidate that shipped first.

**Known and deliberately not fixed:** a rotated video reports its *coded*
dimensions, while ffmpeg applies the display matrix when generating the
thumbnail — so a portrait phone video probed as 1920×1080 still gets a landscape
tile. Pre-existing, and fixing it means parsing `side_data_list` rotation and
bumping the probe format.

**"Grid" is now labelled "Card"**; the stored `LayoutMode` value stays `'grid'`
(a persisted pref and an e2e selector, and only the label was asked for). One
e2e locator followed the label.

**The size slider spans 120–480 px** instead of 80–360, with stored values
clamped on read. Worth knowing: the column count still stretches to fill, so at
the top of the range in a narrow pane you get one very large card per row rather
than two — that behaviour is unchanged, the new maximum just reaches it sooner.

Gates: `apps/web` lint / format / typecheck / **908 tests** / build, plus the
`manual-bundling`, `ordering` and `library` e2e specs (**53 passed**);
`apps/server` ruff / mypy / **1114 passed**. OpenAPI and `schema.d.ts`
regenerated. Verified in the running app against a synthetic library whose files
carry assorted dimensions — the geometry is measured, not eyeballed, because
synthetic bundles have no real cover images to look at.

### Tests run

- `apps/server`: ruff check, ruff format --check, mypy, pytest — **1112 passed,
  1 skipped**, clean.
- `apps/web`: lint, format:check, typecheck, `npm run test` — **893 passed** —
  and `npm run build`.
- Playwright: `all-tags` suite, **5 passed** (2 of them new), on
  `CAIRNDEX_PLAYWRIGHT_PORT=5299` so it did not disturb the owner's running dev
  server. Other e2e specs were not re-run: no file they touch changed.
- Manual: all four items driven in the browser preview against synthetic
  libraries (1500 bundles, and a 40-bundle one with 24–30 files each for the
  playlist cap). No real media was read and no user data left the machine.

### Known issues and next steps

- **Owner verification against the real library is what settles item 1.** The
  before/after numbers here come from read-only probes of the SMB-mounted
  library, not from the app running against it.
- Tag-group membership, and now collection rename, go through a context menu, as
  tag rename and delete already did. Consistent, but still pointer-first; a
  keyboard path for these is unclaimed work.
- The word-selection fix is verified by test and by planting a selection in the
  preview, not by reproducing the symptom — that needs the desktop shell, since
  Chromium never made the selection in the first place.
- Desktop gates were not run — no Rust, Tauri, or `apps/desktop` file changed.

## Merged: the grouping review drew a collection twice (2026-08-23)

Branch `fix/grouping-context-duplicate-root`, off `main` at `2f09f0de`. Owner
report: placing a new collection suggestion into an existing collection made the
panel "generate a new listing with the hierarchy I selected", even though the
selected parent's own parent was already a top-level row in the same listing.

**Cause.** `plan_store._materialize_collection_context` built the destination's
ancestry from the live collection tree unconditionally, deduplicating only
against proposals already carrying that `target_collection_id`. A suggester
folder container named after the collection carries none — plan generation links
them (`service._proposed_collection_paths`), but only for collections some bundle
proposal matched, and in a library where every bundle sits inside a proposed
folder container that matching never runs (`_with_collection_context` returns
early with `chosen` empty). So the same collection was drawn twice: once as the
plan's editable top-level row, once as the head of a fresh "Existing" path.

**Fix.** `_adoptable_container` looks for the editable collection suggestion that
already stands for each level — same title, under the level resolved so far, not
pinned elsewhere, and neither the row being moved nor one of its descendants —
and the walk adopts it instead of creating a context node. Adopting **pins**
`target_collection_id` on it, which is required rather than cosmetic: apply
rejects a read-only context child whose parent has no target ("an existing
collection cannot be nested under a new collection suggestion").

**Apply was already correct**, before and after: `_ensure_collection` resolves an
unlinked container to the existing collection of the same name under the same
parent, so both rows always fed the one collection. Verified on the repro —
`collections_created: 0`, no conflicts, the moved bundle in the child collection
and its sibling still in the parent. This was a structural-display bug only.

**Two consequences of the pin, both covered by tests.** A row that stands for a
collection is refused as a destination for itself (it would become its own
parent, and a self-parented row leaves the tree); and the structural refresh of
title/reason is now limited to actual context rows, so a pinned editable row
keeps an owner rename instead of having it reverted on the next placement edit.

**Known, pre-existing, deliberately not changed:** a pinned container's title is
ignored by apply, which reuses the collection the pin names. That has been true
of generation-time links since they were introduced (see the `suggester`
docstring on `is_collection_context`); adoption widens the cases in which it can
be reached. Renaming such a row is therefore visible in the panel but not in the
result. Fixing it properly means deciding what renaming an existing collection
from the grouping panel should mean, which is a product question, not a bug.

### Second report on the same branch: the dial reset the row it sits on

Renaming a folder's collection suggestion, placing it in an existing collection,
then nudging Narrow/Widen undid both — and pruned the "Existing" path the
placement had built, since it then led nowhere.

`set_directory_stem_level` splices one directory by deleting every row whose
`directory` is that folder and re-inserting the suggester's output for it. That
set included the folder's **own** row, which is where the dial lives and where its
title and placement live. `_folder_header` now picks that row out — the outermost
non-context container for the directory, so a collection the owner converted
*inside* the folder is still grouping and still redone — and the splice keeps it,
skips the fresh container, and hangs the fresh bundles under it.

One further fold, found while testing rather than reported: a folder the suggester
insists is one bundle (`owns_directory`, e.g. explicit multipart names) proposes
that bundle with the folder's *parent* as its parent. Kept header or not, that row
landed beside the folder's row rather than inside it, so a hand-made conversion
went childless and was deleted — the dial dissolving a collection on a folder it
cannot regroup at all. Fresh rows for a non-root directory now always go inside
the kept header.

Behaviour deliberately changed, and the two tests that asserted the old shape were
updated with it: the folder's row keeps its id across a splice (it was asserted to
be replaced), and its subdirectory children stay attached rather than being
re-linked to a successor. The re-link is still there for the no-header case.

Tests: `just check-server` clean (1089 passed, ruff format/check, mypy). No web,
desktop, or e2e file changed — the placement e2e is fully mocked — so those gates
were not re-run. Next: owner verification against the real library, since both
shapes were reproduced from the reports rather than from their data.

## Merged: Add Files to Library (2026-08-23)

Branch `feat/add-files-to-library`, off `main` at `ea3f12a7`. `File ▸ Add Files
to Library…` (⇧⌘A) picks files, asks for a destination, and copies them in. Most
of the machinery already existed — W5's import op, W3's `DirectoryPicker` — so
the work was joining them and adding New Folder to the picker.

**Deliberately desktop-only.** The owner removed the Bundle Browser toolbar
button, and the web build has no menu bar, so this command is unreachable in a
browser tab. `Add Files Here` in the File Browser is unaffected. That also means
the flow has **no end-to-end coverage**: nothing in a browser can dispatch a
native menu event (`useDesktopMenu` early-returns unless `isDesktopHost()`), so
the picker is covered by component tests and the one line the menu action runs is
covered by nothing.

**Self-import: what is and is not guarded.** Dragging in a file that already
lives in the library is refused (`importer.rs`, `path_is_inside`). The **Add Files
picker cannot be guarded the same way** and this is not an oversight: the browser
does not give the page a `File`'s path, which is the same boundary that stops the
web layer reading arbitrary files, and the import endpoint takes bytes with no
path by design (plan 4 §6). So neither the app nor the server can tell that
picked bytes came from inside the library.

Worth knowing before anyone "fixes" that: nothing is ever destroyed — an upload
stages to a `.part` file before anything moves, and Replace is journaled
trash-then-rename — but the outcomes are still bad. A different destination
folder makes a **silent** duplicate (no collision, so no prompt; `link` defaults
false, so nothing appears until the next scan). The same folder prompts, and
answering **Replace** is the worst choice while sounding the most innocuous: a
trashed row keeps its id and moves its `relative_path` into the trash, so a
bundle containing that file **loses it**, while identical bytes land at the
original path with no row. On a file already in the library, Skip is the right
answer.

**Deferred by the owner (2026-08-23):** a name+size warning in the picker was
offered and declined. The intent is an Eagle-style **hash-based duplicate
detector** as its own feature later. That is the right shape — it is the only
thing that turns a guess into proof, and as a deliberate pass rather than an
inline request-path check it is not bound by the no-full-hashing rule. Do not
add the heuristic in the meantime.

## Merged: `hev1` HEVC off HLS entirely, and playback you can see (2026-08-16)

Branch `fix/hevc-direct-play-and-playback-resilience` (renamed from
`fix/desktop-relay-and-stall-watchdog` as its scope grew), off `main` at
`12a16828`. The measurement and design below were written first and are kept
because they are the argument; **it is built now** — `media/hevc_relabel.py`,
`media/ranged_stream.py`, and the `_effective_video_tag` hook in the playback
routes, with the equivalence to `-tag:v hvc1` pinned byte-for-byte at 8- and
10-bit. The one design change: offsets are memoised in-process on
`(path, size, mtime_ns)` rather than stored in `tech_metadata`, so an unindexed
File Browser path gets the same treatment as an indexed row and a replaced file
is never served stale offsets.

**Owner-verified on a real library, 2026-08-19.** Ready for review; no PR opened
(the owner's call).

**The trap that cost most of this branch's debugging: the desktop app serves a
compiled backend, so server-side work does not apply until it is rebuilt.** The
owner reported an `hev1` file still deciding `remux` after the relabel shipped,
and the panel's reason carried none of the new explanation. Neither was a defect:
the bundled `cairndex-sidecar` had been built at 18:47 and `hevc_relabel.py` did
not exist until 22:33, so none of the HEVC work was in the running process. The
frontend *was* current — Vite serves it, so the new Playback row appeared — and
that split is exactly what makes this misleading: half the change is live and
half is four hours stale.

`just bundled` rebuilds when `apps/server` is newer (`apps/desktop/
dev-bundled.mjs` compares mtimes), so it cannot happen that way. Launching a
packaged `.app`, or `npm run tauri dev`, uses whatever binary is on disk. When a
desktop symptom contradicts a green backend suite, date the sidecar first:

```
ls -la apps/server/packaging/dist/cairndex-sidecar/cairndex-sidecar
```

Note that grepping the bundle for a module name proves nothing either way — the
modules are inside a compressed PYZ, so `hevc_relabel` and `ranged_stream` are
both absent from a bundle that contains them. Compare build time against
`git log --diff-filter=A -- <file>` instead.

**Also on this branch: the info panel now says how a video is playing.** The
owner's question was literally "how do I even know it does?" — the server had
always decided `direct`/`remux`/`transcode` and always written a human reason,
and none of it reached the screen. `useHlsSession` exposes `method` alongside
`reason`; `player/playbackInfo.describePlayback` turns the pair into a label, an
`HLS session` badge for remux and transcode, and the server's reason underneath;
`InfoPanel` renders it as a **Playback** row. It returns null before a decision
lands, so the row is hidden rather than showing an em-dash or a guess.

**A refused relabel now explains itself, because the first owner report after it
shipped was a file that stayed on `remux`.** The reason read "hev1 codec tag is
not in client capabilities", which was true and unactionable: three unrelated
situations produced it and nothing distinguished them. `inspect_hevc` returns an
`Outcome` carrying the refusal in words; the routes append it to the reason; the
Playback row shows it. The ladder, in the order worth checking:

1. **"this client plays no HEVC tag progressively"** — the client decodes HEVC
   only through MSE, so relabelling would not help and a session is correct.
   Chromium is *not* this case: measured here, Chrome 148 answers _probably_ to
   `hvc1` **and** `hev1` at both depths, so it direct-plays either without any
   relabel. WKWebView is the case that matters.
2. **"its header carries no VPS…" / "…no hvcC configuration"** — the file itself.
   Correctly refused: claiming `hvc1` when the decoder needs parameter sets
   in-band breaks playback partway, which is worse than a remux. Do not weaken
   this guard to make a file direct-play.
3. **"its container header does not match its probed codec tag"** — the parser
   found no `hev1` sample entry in a file the probe called `hev1`. This one is a
   defect here, not a property of the file, and was previously silent.

To ask the question directly about one file, from `apps/server`:

```
uv run python -c "
import sys
from pathlib import Path
from cairndex.media.hevc_relabel import inspect_hevc
outcome = inspect_hevc(Path(sys.argv[1]))
print(outcome.relabel and 'direct play' or ('needs a session: ' + (outcome.why or 'not hev1')))
" /path/to/file.mp4
```

Worth knowing, because it is now the only easy way to reach a session on this
machine: **taking `hev1` direct removed most of what used to need one.** To force
a transcode on any file, pick a quality below the source's own height from the
player's settings menu (`qualityOptions` offers only heights at or below the
source, and `decide_playback` transcodes when `source_height > max_height`) — the
Playback row flips while you watch. A `-c copy` remux into MKV is the other
route: no browser advertises the container, so it is always a session.

**Why the relabel is the fundamental fix and everything else is a safety net.** An
`hev1`-tagged HEVC file needs an HLS session for one reason: AVFoundation refuses
that four-character code progressively, so the only route to a decoder is MSE,
and MSE is only reachable through HLS. Every downstream problem — ffmpeg running
at all, sessions expiring, the reaper, keepalives, segment holes, transcode disk
— exists solely because of that refusal. Remove it and the whole class goes,
rather than being managed. The owner asked for exactly this ("if there is
something fundamentally missing, fix it fundamentally").

**Measured on the actual engine, not inferred.** A WKWebView probe (a ~60-line
Swift harness; worth rebuilding rather than trusting Chrome, which answers
differently):

| probe | `canPlayType` | `MSE.isTypeSupported` |
| --- | --- | --- |
| hevc `hvc1` 8-bit | probably | true |
| hevc `hvc1` **10-bit** | **probably** | true |
| hevc `hev1` 8-bit | **(empty)** | true |
| hevc `hev1` 10-bit | **(empty)** | true |
| h264 High10 | (empty) | false |

Two conclusions. The bit-depth rule added in PR #4 is **not** implicated —
WKWebView advertises `hvc1` 10-bit as playable, so `hevc10` is in the profile and
the rule never fires for it. And `hev1` is refused progressively at *both*
depths while MSE accepts it, which is the whole story.

**The conversion is five bytes.** Encoding the same content twice with
`-tag:v hvc1` and `-tag:v hev1` produces files that differ in exactly five bytes,
all inside `moov`:

- the sample-entry fourCC — 2 bytes, since `hvc1`/`hev1` share `h` and `1`;
- `array_completeness` on each of the VPS/SPS/PPS arrays in `hvcC`, `0xA0/A1/A2`
  vs `0x20/21/22` — 3 bytes.

Both files carried an identical 2433-byte `hvcC`, so the parameter sets are in
the header either way. **A remux is therefore byte-equivalent to patching five
bytes of header and serving the original `mdat` untouched** — no ffmpeg, no
session, no reaper exposure.

**Design, as planned** — shipped as described except for where the offsets live
(see above). At probe time, locate and store the offsets; at serve time, patch
them in a range-aware reader.

1. Parse `hvcC` properly. `hev1_relabel_offsets` belongs beside `mp4_index.py`,
   which already walks `moov` boxes byte-wise. Record the offsets in
   `tech_metadata` so serving costs no re-parse.
2. `hvcC` layout: 23 bytes of fixed fields, then `numOfArrays`, then per array a
   `completeness/reserved/NAL_unit_type` byte, `numNalus`, and length-prefixed
   NALs. The sample entry is 8 + 78 bytes before its child boxes.
3. Guard: only claim `hvc1` when the arrays are present and complete. If a stream
   genuinely varies its parameter sets in-band, relabelling is a lie that breaks
   playback partway, so the guard is load-bearing rather than defensive.
4. `decide_playback` then treats a relabellable `hev1` as `hvc1`, and the direct
   `stream_url` serves the patched header.

**Do not byte-search for the array bytes.** Tried it: searching for `0x20/21/22`
after the fourCC hits arbitrary payload and left two offsets wrong out of five.
The parse is the work; the patch is trivial once the offsets are right.

**Both "remaining session issues" were closed as not-a-defect — they were my own
arithmetic**, and the correction is worth keeping because the mistake is easy to
repeat. I read "240 s file, 6 s segments, so 40 segments", then treated 29
segments and an instant 404 on segment 30 as two bugs.

A **remux** splits on the *source's own keyframes*, not a 6 s grid — its playlist
is keyframe-derived, which `docs/architecture.md` §6 already says. The fixture was
encoded `-g 250` at 30 fps, so its GOP is 8.33 s and the playlist is 29 segments
averaging 8.28 s. ffmpeg had produced every one and **exited 0**; segment 30 does
not exist, and refusing it instantly is correct. Only a *transcode* forces
keyframes onto the 6 s grid that would have given 40.

Verified against a real session afterwards: the last segment (28) and a mid-file
one (14) each serve in 0.1 s from a cold far seek, and the first index past the end
is a clean 404. If a far seek misbehaves again, suspect the client, not this.

## Merged: the frozen player, and the relay that 404'd its sessions (2026-08-16)

The first commit of the branch recorded above, under its original name. One
commit. Owner-reported live, while testing on `claude/export-watermark-settings-41db44`
(which contains the PR #4 merge).

**Report.** A video open in the desktop app froze: could not play, could not
seek, the rest of the UI fine. Later refined — it happens after seeking the
playhead past the buffered region, and the bar then "drifts to the right end,
goes back to the left, and reads 0.0/0.0". That reading is the signature of the
element being *reset*: `currentTime / duration` renders 100% when duration hits
0, then 0% when currentTime follows.

**What the live system ruled out**, before touching any code — worth repeating
because it took minutes and saved hours:

- the sidecar was healthy throughout (`/health` 2–5 ms, library-scoped DB routes
  3–20 ms), so no pool exhaustion;
- zero jobs, both library roots readable in ~20 ms;
- **no `transcode/` directory at all**, and the session manager mkdirs it the
  moment any playback route resolves — so no HLS session existed and the source
  was progressive;
- **no version skew**: the prebuilt sidecar was rebuilt at 02:04:03, after the
  01:51:16 merge, and its live `/openapi.json` matches HEAD's committed artifact
  path-for-path;
- `lsof` on the sidecar port showed only the LISTEN socket over a 6 s sample —
  the client was requesting nothing at all;
- the File Browser path reader **does** honour Range (verified live: `206`, a
  correct `content-range` on a 3.3 GB file), so the seek was not failing there.

**Three fixes landed.**

1. `media_proxy.rs` had no allowlist arm for
   `["file-browser", "playback-sessions", _, artifact]`, so the desktop shell
   404'd the path-scoped sessions PR #4 added — in the app only; a browser does
   not go through the relay. **This allowlist has now bitten three times**
   (contact sheets 2026-07-27, GIF exports on the watermark branch, this). It is
   an explicit list with no compile-time tie to the routes it mirrors; a fourth
   occurrence should probably buy a real fix rather than a fourth arm.
2. `player/stallDetector.ts` plus a sampler in `ViewerShell`: a progressive read
   that dies without an `error` event now ends in the existing
   "Playback interrupted" path instead of silence.
3. `nativeRecoveringRef` was cleared only on a new `source` object, but the
   `unavailable` and `error` branches settle without minting one — so one failed
   recovery made the player swallow every later error, frozen with no card.
   Pre-existing on `main`, and the likeliest explanation for the report.

**Adversarial review earned its keep** and should be repeated for anything in
this file. It caught two false positives in the watchdog before it shipped, both
worse than the bug: sampling only `buffered.end(length - 1)` (a refilling
*earlier* range reads as a dead read — i.e. it would have fired on exactly the
seek-past-the-buffer gesture that motivated it), and applying to HLS, where the
server holds a segment request for two 20 s passes and 15 s would have been the
tightest deadline in the stack.

**Not verified by the owner yet.** The fix is reasoned and unit-tested; nobody
has yet reproduced the freeze *with* it in place. The recovery that needs no
restart is a quality or audio-track switch, which bumps the epoch and reloads
the element.

**Known local-only e2e failure**, unchanged: `transparently re-attaches a fresh
session when HLS segments fail` fails on this machine and on unmodified `main`,
and passes in CI.

## Merged: library setup and the videos that would not play (2026-08-16)

Branch `claude/library-setup-scan-issues-db7786`, off `main` at `a8e077a4`.
Three owner reports from using the app on a newly created library, plus one
related export gap raised mid-session.

**What was reported.** (1) "Scan new files" also ran other steps and popped the
grouping suggestion pane. (2) A new library could not play anything until both
**Scan new files** and **Collect metadata** had been run by hand — and the owner
wants file-browser-only use to work at all. (3) A video still failed with "This
video can't be played here." (4) A contact sheet cut from the File Browser
printed `Details: … · — / —`.

**What was actually wrong.** All of (2) and (3) are one defect with two halves.
The decision matrix (`media/playback.decide_playback`) tested container and
codec _family_ and nothing else, and was deliberately optimistic about anything
it did not know:

- **Nothing probed → `direct` for everything.** An unprobed row has no codec, so
  `video_ok` is true by default. A fresh library therefore handed every file
  straight to the browser, and anything the browser could not decode failed with
  the format card. Verified against the real code, not inferred.
- **Probed, and still wrong for 10-bit.** Every capability string a browser can
  be probed with is an 8-bit profile — `avc1.640028` is High, `hvc1.1.6.L93.B0`
  is Main — so a 10-bit source passes the family test and is refused by the
  engine anyway. `bit_depth` was already recorded by the probe (v5) and simply
  never consulted. Measured with ffmpeg-built fixtures: High 10 H.264 and
  Main 10 HEVC both decided `direct` before, both correct after. **High 10 H.264
  is decoded by no browser at all**, which makes it the most likely explanation
  for the screenshot (an hour-long MP4 whose codec name is just `h264`).
- **Dolby Vision has the same shape** — an ordinary HEVC base layer, so family
  and tag both pass — and is now transcoded.

**What landed.**

1. `suggest_grouping` on the scan job; "Scan new files" sends `false`, Update
   keeps the default, and a scan-only run reports a null `grouping_plan_id` so
   the client has nothing to open.
2. Depth and Dolby Vision in the decision matrix; `h26410`/`hevc10`/`vp910`/
   `av110` capability tokens; `assess_playability` stops claiming a 10-bit or DV
   source is natively playable (it is the client's fallback when a decision
   fails, so claiming it sent playback back to the same refusal).
3. `probe_service.ensure_probed` — one bounded ffprobe of one file's header on
   the way to the decision, written back, silent on failure.
4. Path-scoped playback: `POST …/file-browser/playback-decision` plus its own
   session/teardown routes, backed by `probe_service.probe_path`. Sessions are
   keyed for reuse by `path:{relative_path}` and share the manager, bound, and
   reaper with the per-file ones. `useHlsSession` takes `fileId` **and**
   `browserPath` as primitives (an object target re-decided on every render).
5. `useIndexNewLibrary` — creating a library enqueues discovery then metadata.
   Registering an existing one does not.
6. `width`/`height`/`fps` (and `bit_depth`) on `FileBrowserEntryRead`, through
   `viewerItemFromEntry` and the File Browser's contact-sheet target.

**Verified.** Full gates green: backend ruff/format/mypy and **1039 pytest**;
frontend lint/format/typecheck, **737 vitest**, and build. Note that
`tsc --noEmit -p tsconfig.json` checks _nothing_ in this repo — the root config
is a solution file with `files: []`. Use `npm run typecheck` (`tsc -b`).

Also verified by hand against a synthetic three-file library (8-bit MP4, High 10
MP4, H.264-in-MKV) on a scratch `CAIRNDEX_DATA_DIR`: unindexed paths decided
direct/transcode/remux correctly with **no scan at all**; a transcoded segment
pulled from the session ffprobes as 8-bit High H.264; a scan-only job left zero
grouping plans; the decision filled in metadata with no probe job ever run; and
in the browser both the 10-bit MP4 and the MKV played (`readyState` 4, no
fallback card) where the 10-bit one previously showed the owner's screenshot.

**Also fixed (owner-reported while testing).** The viewer's docked pane showed
the Bundle Inspector for an unbundled video, stating it was in a bundle. The
trap is that "has a `bundle_id`" is not "is in a bundle": a scan stages every
new file into a provisional one-file bundle, so every unbundled file has one.
`inspectorTargetForEntry` / `inspectorTargetForBundleFile` in
`app/fileFacts.ts` now decide, and `ViewerShell` is told rather than guessing —
the shell cannot know, because only the opening surface has the `unbundled` flag
(File Browser) or the bundle's `grouping_state` (Bundle Browser). Note the
Bundle Browser needs it too: its views exclude provisional bundles, but **Missing
Files does not**, so a scan-staged bundle can be opened there. An unindexed path
now gets the file pane as well, where it previously got nothing and a disabled
toggle. `factsFromEntry` also picks up the width/height/fps the listing gained
above — the File Browser's own inspector was showing "—" for numbers the server
already had.

**Also fixed (found while verifying, owner asked for it).** `PUT
…/files/{id}/progress` 500'd when two progress writes for the same file raced —
`upsert_progress` was read-then-insert, so both saw no row and the second hit
`UNIQUE constraint failed: playback_progress.file_id`. Now one
`ON CONFLICT DO UPDATE`; last-write-wins is unchanged, and the ORM identity map
is expired after the Core statement so a session that had already loaded the row
does not keep stale numbers.

**Worth knowing for the next person: this race cannot be reproduced as a
deterministic test, and it is not for want of trying.** SQLite serializes
writers, and pysqlite runs SELECTs in autocommit — so two in-process sessions
always see each other's committed row, even with one holding an open
transaction. Six concurrent threads against the old code collided in **zero of
eight trials**. The window is real but needs two genuinely concurrent HTTP
requests with I/O between the read and the write. What is pinned instead is the
invariant that closes it: `test_progress_is_written_as_one_atomic_statement`
records the statements the write emits and asserts there is exactly one and it
carries `ON CONFLICT`. Verified to fail on the old code, printing the very
SELECT/INSERT pair that is the bug. Do not "improve" it into a threaded test.

## Merged: HDR tone mapping (2026-08-23)

Branch `feat/hdr-tone-mapping`, off `main` at `ea3f12a7`. Built from the scoping
below, which held up except on one point that mattered.

**The scoping was wrong about filter availability, and it mattered.** It recorded
that Homebrew's ffmpeg has `tonemap` but neither `zscale` nor `libplacebo`, and
left Debian's and the pinned macOS sidecar build unchecked with "check both
before designing around either". Checked now: **the shipped sidecar build
(martin-riedl 8.1.2) has `zscale`** — so the deployment that actually matters on
macOS can tone map, and only the dev machine cannot. Debian's is still unverified
(no daemon here), which is why availability is **probed at runtime** rather than
assumed. `media/tonemap.py` does it once per process off `ffmpeg -filters`.

Note for anyone touching that probe: the flags column is **two** characters wide
on ffmpeg 8 (`.S`) and three on 7 and earlier (`..C`), so keying on its width
matches nothing. The `in->out` column is the discriminator. The first version of
this parsed exactly one filter name out of 483 and reported "cannot tone map" on
a build that can.

**What landed.** `zscale=t=linear -> format=gbrpf32le -> zscale=p=bt709 ->
tonemap=hable:desat=0 -> zscale=t=bt709:m=bt709:r=tv`, inserted into the
transcode's `-vf` graph, behind `CAIRNDEX_FFMPEG_TONEMAP=auto|off`, with
`SessionParams.hdr` carrying the signalling (constant per source, so it does not
fragment equality-based session reuse). Verified end to end: a PQ/BT.2020 source
comes out tagged `bt709`/`bt709`/`bt709`, and `normalize_metadata` reports
`hdr: None` for the result.

**Graph order is the substance, and it is measured.** Scale comes *first* so the
float32 linear intermediate covers as few pixels as possible; burn-in comes
*last* so subtitle graphics are not composited onto linear-light pixels. On this
machine, 10 s of source through the chain:

| source | wall | vs real time |
| --- | --- | --- |
| 1080p HDR -> 1080p SDR | 1.00 s | 10x |
| 4K HDR -> 4K SDR | 6.73 s | **1.4x** |

So a 4K source on **Auto** quality (no height cap, so no downscale) has only 40%
headroom here and would plausibly fall *below* real time on the NAS, where a
session must stay ahead of the player. Deliberately not "fixed" by silently
capping resolution — that is a product decision, not a bug fix. The mitigations
that exist are the quality ladder (picking 1080p makes it 10x, because the
downscale runs first) and `CAIRNDEX_FFMPEG_TONEMAP=off`. **Measure on the NAS
before trusting `auto` there.**

**Dolby Vision is still excluded, and now says so.** Profile 8.1 has an
HDR10-compatible base layer and would tone map correctly; profile 5 is IPT and
this chain would turn it green and magenta, which is worse than flat.
`ffprobe._hdr` reports only `"dv"`, so the two cannot be distinguished —
recording `dv_profile` remains the prerequisite, and is the obvious next slice.

**Next.** Owner pass on real HDR content; NAS throughput measurement; then
`dv_profile` and DV 8.1.

**Superseded by the branch above — kept for the measurements it records.** A
transcoded HDR source gets `-pix_fmt yuv420p` and
no colour conversion, so PQ values are read as BT.709 gamma and the picture
comes out flat. Scoped smaller than it first looked, and measured rather than
assumed:

- **10-bit SDR needs nothing.** High 10 H.264 (the common Hi10P case) is BT.709;
  the existing 8-bit conversion is already correct for it.
- **Most HDR never reaches the transcoder on a current browser.** Measured on
  Chrome 148/macOS: `hvc1.2.4.L120.B0`, `hev1.2.4.L120.B0`, `av01.0.05M.10` and
  `vp09.02.10.10` all answer _probably_, so 10-bit HEVC/AV1/VP9 direct-play and
  the capability tokens do their job. Only `avc1.6E01E0` (High 10 H.264) is
  refused — and that is SDR.
- **So the reachable cases are** HDR on a client without 10-bit HEVC/AV1 decode
  (Firefox, Chrome without HEVC hardware), and **Dolby Vision on every client**,
  because the DV rule forces a transcode regardless of caps. DV is therefore the
  priority, and the worst-looking: profile 8.1 has an HDR10-compatible base layer
  and merely goes flat, while profile 5 is IPT and comes out green/magenta.
  `_is_dolby_vision` does not record `dv_profile`, so the two cannot currently
  be told apart — recording it is a prerequisite for treating them differently.
- **Availability genuinely varies.** Confirmed locally: Homebrew's ffmpeg has
  `tonemap` but neither `zscale` nor `libplacebo`, and `tonemap` alone is
  useless — it needs zscale to linearize either side of it. Debian's apt ffmpeg
  (the Docker image) and the pinned martin-riedl static build (the macOS
  sidecar) were **not** checked; no Docker daemon was running and the bundle is
  not in this worktree. Check both before designing around either.

Suggested order when it is picked up: (1) say so in the decision `reason` and
surface it, so wrong colour is explained rather than mysterious; (2) detect
`zscale`/`libplacebo` once at startup rather than assuming; (3) tone map only
when `hdr` is non-null, behind `CAIRNDEX_FFMPEG_TONEMAP=auto|off`; (4) measure
on the NAS before trusting it — the float32 linear intermediate is the expensive
part, sessions serve segments just ahead of the player, and a 4K HDR tone-mapped
transcode may not keep up.

**Next.** Owner pass on a real library: confirm the previously-failing files now
play, and confirm "Scan new files" no longer opens the grouping pane.

## Merged: the clip strip's play control (2026-08-16)

On the export-watermark branch by the owner's leave, though unrelated to it.

Started as "a play button that starts from the In mark", shipped once, and the
owner's own use of it produced the better shape: the strip was **too crowded**,
and the action and the mode next to it — `From In` and `Range` — only ever
meant anything together. They are now one control, **Play Range**, bound to
`\` (beside the `[` and `]` that mark the ends). `⟳ Loop` survives as the one
genuine modifier.

**The real change is what Space means.** `Range` was a standing mode, so the
play button did one thing with a clip marked and another without — the marks
silently redefined playback. Confinement is now a _session_ rather than a mode:
`useClipPlayback` runs only while a span is playing, and any pause ends it, so
resuming with Space is ordinary playback. One consequence worth knowing: pausing
mid-loop drops the loop, which is the honest reading of "Space ignores the
range" and is one keypress to resume.

Deliberately deferred: range-loop replay will drive the same span from playback
settings, and the `useClipPlayback` seam is still the place for it.

Tests: 827 frontend, including two e2e that exercise the button, the shortcut,
and Space-ends-the-span in a real browser — which matters here, because the
preview pane throttles `requestAnimationFrame` to 1 fps and cannot measure the
out-point at all.

**Not verified in the running app.** The attempt surfaced one of the owner's
real libraries instead of the throwaway one, so it was stopped rather than
continued; the e2e in real Chromium is the standing evidence.

## Merged: the export watermark (2026-08-15)

Branch `claude/export-watermark-settings-41db44`, rebased onto `main` at
`a8e077a4` (the drag-and-drop merge); cut from the GIF export merge, which it
builds on. Owner request:
one watermark setting covering snapshot, GIF, and contact sheet, retiring the
contact sheet's hardcoded brand block, with custom **text** now and a custom
**image** next.

**Owner decisions taken before implementing.** Stored **client-local** in
`localStorage` (`cairndex.exportPrefs`), matching `displayPrefs` and the export
folder beside it; **off by default**; contact-sheet mark at the **top right of
the header**, where the retired block sat, rather than over a frame.

### The one real design question: the GIF is encoded server-side

Snapshots and contact sheets are composed on a canvas in the browser, so a mark
is a few lines each. A GIF is encoded by ffmpeg on the server, and **the ffmpeg
builds Cairndex runs against have no `drawtext`** — verified on the dev machine's
Homebrew ffmpeg 9.0.1, which reports no such filter and no freetype/fontconfig
in its configuration. That is the same constraint that put the contact sheet's
header in the browser in the first place. `overlay` is present.

Two ways out were considered:

- **Pillow on the server.** It is already a dependency and its bundled default
  font is scalable (`ImageFont.load_default(size=…)` returns a `FreeTypeFont`),
  so the server _could_ draw the text. Rejected: it makes two renderers, and the
  same setting would then look different on a GIF than on a snapshot of the same
  frame. It also only defers the image mark's upload problem rather than solving
  it.
- **The client renders, the server composites.** Chosen. The mark is drawn once
  in `app/watermark.ts` and, for the GIF only, sent as a bare base64 PNG on the
  existing create-export request; ffmpeg `overlay`s it. Base64 in the JSON
  rather than multipart because there is no upload route and no
  `python-multipart`, and a text mark is a couple of kilobytes. **The image mark
  needs no server change at all** — a rendered string and a chosen image arrive
  as the same transparent PNG.

Two details worth keeping: the overlay runs **before `palettegen`**, so the
mark's colours are in the palette rather than being quantized to whatever the
footage needed; and the corner is an ffmpeg expression (`max(0\,W-w)`), not a
baked coordinate, so the scaler rounding the height to an even number of lines
cannot shift the mark off its corner. The mark's inset is baked into the tile as
transparent padding, so layout is decided in one module.

### Measured: a still mark is free, and motion is nearly free

The owner asked what a moving watermark would cost before committing to a still
one. Measured at 480 px, 5 s, 15 fps against two synthetic sources:

| source       | no mark  | still            | moving           |
| ------------ | -------- | ---------------- | ---------------- |
| `testsrc`    | 439 KB   | 427 KB (−2.7%)   | 461 KB (+5.0%)   |
| `mandelbrot` | 4,882 KB | 4,704 KB (−3.6%) | 4,796 KB (−1.8%) |

A **still mark makes the file slightly smaller**: its pixels stop changing
between frames, and a GIF stores inter-frame differences. **Motion costs 2–8%
over a still mark** — far less than feared, so the still-first decision is not
being forced by encoding cost. Synthetic sources, so treat the direction as
sound and the exact percentages as indicative.

### The image mark, added the same day

The second half of the owner's request, and it needed **no server change at
all** — the payoff of rendering client-side. A picked image and a rendered
string both leave `app/watermark.ts` as the same transparent PNG, so ffmpeg
never learns which it composited.

Three decisions worth recording:

- **Fitted inside both a height and a width bound**, not scaled by one. The two
  shapes people use pull in opposite directions: a square badge scaled to a
  fixed width becomes enormously tall, a long wordmark scaled to a fixed height
  runs off the frame.
- **Stored inline as a `data:` URL** beside the rest of `exportPrefs`, bounded
  on import to 1024 px on the longest side and re-encoded to PNG when resized.
  A browser hands out no usable path, and a copy under the data dir would make
  a machine-local preference into server state.
- **No SVG.** It is a document that can carry scripts and fetch external
  references, and nothing here needs one — the mark is rasterized regardless.

Placement was unified while doing this: text and picture now share one
`cornerOrigin` calculation rather than text relying on canvas alignment, which
is what guarantees the two land in the same place.

### A real bug the image work surfaced

`HTMLImageElement.decode()` is the obvious way to wait for an image, and it is
the wrong one. In a window that is not painting it can **never settle** —
observed directly here: an image reporting `complete` and its true 520×160
dimensions while the promise hung indefinitely past a 4-second race, where
`onload` fired immediately on the same image. Left in, an export started from a
backgrounded tab would have hung forever with no error.

Both call sites now wait on `onload` (`loadImage` in `watermarkImage.ts`). The
test double for `Image` **throws from `decode()`** so nothing can quietly reach
for it again.

### Owner-reported: the sheet's mark sat too low (2026-08-16)

Reported from a real export as a placement preference; it was two defects, both
pushing the mark down, and the second was worse than cosmetic.

- **It used its own inset, not the header's.** `watermarkMargin` is derived from
  the mark's size (`0.9 × width/52`); the header's padding is `1.15 × width/95`.
  The former is ~40% larger, so the mark began below the first metadata row
  instead of level with it — 35px against 25px on a default 2048px sheet.
- **A picture mark could overflow the band and be clipped.** It is scaled to the
  sheet's _width_ (`width/18`), which knows nothing of the header's height, and
  the header's height comes from three rows of text. At 2048 the mark ran to
  149px in a 140px band; the frame grid is drawn _after_ the mark, so the grid
  painted over the overflow and shaved its bottom. Overflowed at every width
  from 1280 up — by 9px at the default, 33px at 6144.

Fixed by giving `WatermarkBox` an optional `margin` (the contact sheet passes
the header's own) and adding `fitWithin`, which shrinks a mark to its box
keeping aspect. Text honours the same scale through its _font_, since glyphs do
not shrink just because the reported box did. At 2048 the mark now runs 25–115
in a 140px band: level with the rows, and clear of the grid.

### State

Implemented and green after rebasing onto `main` at `12a16828` (PR #4):
1,054 backend tests, 807 frontend tests, lint, format, typecheck, and the web
build. A real-ffmpeg test encodes a clip with a mark and
asserts the burned-in pixel in the corner. Verified in the running app: the
Exports page appears in a browser, defaults off, switches between Text and
Image, previews a chosen picture on a checkerboard, and both mark kinds were
rendered through the real module against white, mid-tone, and near-black. A
shadow alone was not enough on pure white, so the text mark is outlined too.

### The desktop gap, closed by the owner actually running it (2026-08-16)

The untested desktop path finally got exercised, and it was broken: **a GIF
export failed with a 404 in the shell while working in a browser.** Not the
watermark — the artifact download.

The finished GIF is fetched through the shell's loopback media relay, the way a
contact sheet is, so a bearer never travels in a URL. The relay keeps a strict
route allowlist (`media_proxy::media_route_library_id`), and
`files/{id}/exports/{export_id}/download` was not on it, so the _shell_ answered
404 before the request reached the server. That is precisely how contact sheets
shipped broken in 2026-07; a route added since repeated it, and the allowlist
test even carries a comment about the first occurrence.

Fixed by listing the download route, with a test beside the contact-sheet one.
Only the download is relayed: create, poll and delete carry their own auth over
`hostFetch`, and the relay refuses anything but GET/HEAD regardless, so nothing
destructive became reachable.

**The lesson worth keeping:** any new read-only media route the web layer
fetches needs an allowlist entry, or it works in the browser and 404s in the
desktop app. Two routes have now hit this.

**Not done:** the desktop shell is otherwise still lightly exercised — the
`save_export_file` raw-IPC hop has not been confirmed end to end — and there is
no e2e Playwright spec for the setting. A **moving**
mark remains unbuilt, but is now a known-cheap option rather than an open
question — see the measurements above.

## Merged: drag-and-drop between collections (2026-08-15)

Branch `claude/drag-and-drop-fix-36cb63`, rebased onto `main` at `9853bb9` (the
clip-range/GIF-export merge). Seven commits, ending in ADR-0023 and the native
modifier read. This replaces the root-level `NEXT-SESSION-drag-and-drop.md`
handoff, now deleted.

**Owner-confirmed on the packaged shell (2026-08-15):** moving a bundle between
collections, ⌥ mid-drag copying, a parent's count dropping when a bundle goes into
its child, and repeated fast drags keeping every number right. Nothing on this
branch is outstanding; it has not been opened as a PR, which is the owner's call.

Owner-reported, two symptoms from one gesture: **(1)** dragging a bundle into a
collection often does not show — it stays in the collection it left or never
appears in the one it joined, reloading always shows the correct state, and the
sidebar count sometimes moves when the listing does not; **(2)** **⌥-drag should
copy and mostly moves.** Owner's framing, which is the right one: _"This seems to
be a lasting issue. Even if the files are on SMB, I had no issue with Eagle."_
Not the network — client-side cache behaviour, plus one server inconsistency.

### Fixed: a count that disagreed with its own listing

`collection_counts` and `tag_counts` counted membership rows without joining
`asset_bundles`, so a scan-staged provisional bundle — which belongs to the
Unbundled view and nowhere else — was counted against every collection and tag it
was filed into. Unrelated to the drag, and a real inconsistency on its own. The
collection query restricts the _join_ rather than filtering the result so a
collection holding nothing keeps its zero; tags can use an inner join because
every tag is already backfilled to 0. Both new tests fail against the old
queries.

### Fixed: invalidation is not enough for a listing the projection skipped

`useBatchUpdate` optimistically rewrites the cached browse listings on every drop
and reconciles with `invalidateQueries`. The rewrite is best-effort and used to
fail **silently**, and invalidation does not cover for it: React Query serves a
stale query's data the instant it is observed and refetches behind it, so a
listing the rewrite skipped shows its pre-drop contents on open — while the count
beside it moved immediately. That is symptom 1, and it explains why a reload
always looked right.

Four ways the rewrite could skip a listing, all now recorded rather than ignored:
a filter or a search (whether a bundle belongs in one is the server's judgement);
an arrival whose summary row is in no cached page, so there is nothing to draw;
Uncategorized and Untagged, which no projection writes; and a bundle whose
membership was never loaded, which kills the whole projection — the case a fast
drag hits before `prefetchBundleMemberships` lands. `projectCollectionListings`
now returns those keys and settling **removes** the queries nobody is watching
while refetching the one that is, so the grid on screen never blanks.

Also cancels in-flight `browse` fetches in `onMutate`. One started before the drop
resolves after it, writes the pre-drop page over the projection, and the settle
invalidation is then deduplicated against that same request. It is a genuine
clobber and it survived every other attempt at this bug.

Weighed and rejected: dropping the listing rewrite entirely and making the server
authoritative. Removing _all_ inactive browse listings on settle is the blunt
version — it broke four existing tests, and those tests are the specification of
the instant-feel behaviour. Keeping the rewrite for what it can prove and
evicting only what it cannot leaves all four passing untouched, and only the
fifth changed: it asserted that a filtered listing keeps its stale rows, which is
exactly the behaviour being removed.

### Fixed: ⌥ to copy, read from the OS in the shell (ADR-0023)

Four attempts each bet on one web channel and lost. The owner's pass on the
packaged shell settled why, and their objection — _"I use many apps and none of
them have this restriction"_ — settled what to do about it.

What was always true: `update_bundles` honours ⌥ correctly (with
`remove_collection_ids` empty the change is a pure add) and the flag reaches it
intact. The break was only ever in _reading_ the modifier.

Measured, not assumed:

- **Chrome delivers modifier flags on drag events.** Verified against real
  `DragEvent`/`DataTransfer` objects; the verdict flips to copy when ⌥ arrives and
  back when it is released before the drop.
- **The shell's WKWebView delivers neither channel.** ⌥ pressed mid-drag changed
  nothing while ⌥ held _before_ the drag worked, which only the `dragstart`
  reading explains. `dropEffect` never varied either, sampled from a capture-phase
  listener on both `dragover` and `dragenter` (the latter is written by no
  handler, so it cannot be the app's own value returning).
- **Tauri was not the cause.** `dragDropEnabled` is already `false`.
- **Keyboard events are impossible.** The window server owns the keyboard during a
  native drag; no `keydown` reaches the page.

This is a limit on what WKWebView passes to web content, **not** a macOS one.
Native apps read the system's own event state, which stays current throughout a
drag. So the shell does too: `alt_key_held` in
`apps/desktop/src-tauri/src/modifiers.rs`, over
`CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState)` — a
thread-safe C function needing no main thread and, unlike a `CGEventTap`, no
Input Monitoring permission. One `#[cfg(target_os)]` module, `false` off macOS so
the Ubuntu Rust-only gate keeps building, and no new dependency: `core-graphics`
does not bind that call, so the module declares it and its two constants.

`isCopyDrag()` in `apps/web/src/app/dnd.ts` polls the host every 40ms between
`dragstart` and `dragend` and ranks the channels: either _real_ modifier reading
(host, or drag-event flags where an engine delivers them) settles it, and either
saying "down" is enough since neither can invent a copy; `dropEffect` is consulted
only when it has been seen to change, which is what stops the
stuck-at-`copy`-with-nothing-held default from copying every time; and the
`dragstart` reading is the last fallback, so ⌥ held before a drag begins works
with no host at all. Default is move — a wrong move is one undo, a wrong copy
silently duplicates membership.

**Confirmed by the owner on the packaged shell (2026-08-15):** ⌥ pressed _mid-drag_
copies. That was the one link no test here could reach — the Rust read is
unit-tested and the channel ranking has sixteen unit tests against a fake host,
but only a real ⌥ during a real drag in the shell exercises the join. The
temporary `DragModifierProbe` that informed this work has been deleted along with
its test, as its header always said it would be.

### Fixed: a drop that outran React did nothing at all

Reproduced in Chrome against a synthetic library: a drop delivered in the same
tick as its `dragstart` sent no write — no card moved, no count changed, and
nothing corrected it later because nothing had happened.
`moveBundlesToCollection` re-read the reactive `dragItem` for the ids, while every
caller had already resolved the drag from the synchronous store to decide it was
holding bundles at all. `dnd.ts` says in as many words why commit paths must read
the store; this was the last one that did not.

### Fixed: the badge counted a subtree while the grid listed one collection

Also reproduced before changing anything: a parent read `1` beside an empty grid
whenever its only bundle sat in a child, and moving a bundle from a parent into
its own child left the parent's number motionless while the grid lost a card.
Both numbers were correct; they were answering different questions with the same
visual weight.

The owner chose "match the grid". `/collections/counts` now returns
`direct_counts` alongside `counts`, and the badge follows whichever the grid is
listing — the collection's own bundles, or the subtree total when _Show
subcollection contents_ is on. Both arrive in one request, so the toggle costs no
round trip. They cannot be derived from one another on the client: summing direct
counts over a subtree double-counts a bundle filed in both a parent and its child,
which the server's `DISTINCT` avoids. `CountsResponse` stays shared with tags,
which have no subtree; collections got their own schema. The optimistic path
already computed both delta sets for the inspector and now applies the direct one
to the sidebar too.

Verified in Chrome: badge `1` beside "1 items", badge `3` beside "3 items" with
the toggle on.

### Ruled out, with tests to keep it ruled out

`hooks.countRace.test.tsx` reproduces the three count races that looked like
suspects — the server's answer landing over the optimistic guess, a second drop
cancelling the first one's reconciling refetch, and a refetch already in flight
answering with pre-drop numbers. All three already settle on the server's
figures, so none of them was the reported fault.

Two behaviours that are _by design_ and worth remembering, because both look like
a count that will not update: dragging from All/Recent/search removes the bundle
from nothing (there is no collection in view to remove it from), and with _Show
subcollection contents_ on, dropping a bundle whose membership is in a child
targets the parent for removal, which it is not a member of.

### Tests

Backend `just check-server`: 1020 passed, with ruff, ruff format and mypy clean.
Frontend `just check-web`: lint, format, typecheck, 727 tests and build all green.
Desktop: `cargo fmt --check`, `cargo clippy --locked --all-targets -D warnings`,
`cargo test --locked` (109 passed) and a full `tauri build --no-bundle` all green.
Playwright was **not** run.

`isCopyDrag()` has eleven unit tests in `dndCopyDrag.test.ts`, each playing one
engine's _behaviour_ — flags that arrive, flags that never do, a `dropEffect` that
tracks the modifier, a `dropEffect` stuck at its `effectAllowed` default — rather
than asserting one platform's answer.

Verified in Chrome against real `DragEvent`/`DataTransfer` objects (jsdom has no
`DragEvent`, so the unit tests necessarily use a stand-in): the modifier reaches a
real drag event as both `altKey` and `getModifierState('Alt')`, the verdict flips
to `COPY` when it arrives and back to `move` when it is released before the drop.
Only the gesture was synthetic. **Chrome delivering the flag means the owner's
symptom is most likely specific to the shell's WKWebView**, which is what remains
to be confirmed — the desktop shell cannot be driven from here.

A throwaway library in the scratchpad was registered to render the shell for that
check and deregistered afterwards; both preview servers were stopped.

## Merged: clip range picker and GIF export (2026-08-15)

Branch `feat/clip-range-and-gif-export` off `main` at `6523fec8`, **merged**
after an owner pass. Fourteen commits. This is plan 1 **§10 / M11**'s
GIF-snippet half, plus the range picker the range loop was moved into M11 to
become (owner, 2026-07-11).

**One thing the owner should still check:** the desktop app was not exercised
at all. The web behaviour is verified end to end, but `save_export_file` moved
from a JSON number array to a raw Tauri IPC body, and _that hop_ — the
JavaScript `invoke(cmd, arrayBuffer, {headers})` reaching Rust as
`InvokeBody::Raw` — can only run inside a real shell. Both sides are tested up
to the boundary: 108 Rust tests including the body/header extraction and its
refusal of a JSON body, and the web side asserts it hands over a `Blob`. If the
hop itself is wrong, every desktop export fails at once and visibly (the
browser download path is unaffected). Contact sheets and snapshots ride the
same seam, so they are in the same position.

**Two owner decisions shaped it.** Both mechanisms for precision, not one — a
seek-bar band with handles _and_ a magnified track — but no editable timestamp
field. And loop scope stops at the picking session; persistent range-loop replay
is a follow-up.

**A second owner pass (2026-08-15) changed four things**, all from using it:

- Dragging the _seek bar's_ handle carried an edge outside the magnified
  window, which is frozen for the length of a gesture — so the zoomed handle
  escaped the track entirely (measured ~3700 px past its end). Rendering is now
  pinned to the track's ends and the window re-fits on release.
- "Set here" reads as nothing in particular; the buttons say **Set In** and
  **Set Out**.
- Setting a beginning past the current end clamped the clip to its 0.1 s floor.
  It now **carries the whole span and keeps its length** — the length is
  already decided, the click only says where it sits. The video running out is
  the one exception, and then the named instant wins. The end does the mirror
  of this; a _drag_ still clamps, because there the other handle is the fixed
  reference being measured against.
- Playback gained a **range** mode that stops at the out-point, with **loop**
  as a modifier that turns range on with it. Modelled as one `ClipPlayMode`
  rather than two booleans, since "loop but ignore the out-point" is not a
  state that means anything. Pressing play once range has parked the playhead
  on the out-point restarts the span, or the press would do nothing visible.

**A third pass trimmed the overlay itself.** It spanned the window and stood
four rows tall, which is more of the picture than a range picker needs to
cover. Now capped at 720px and centred (at full width the controls end up
metres apart on a large display), three rows instead of four — In and Out
adjacent on the left, with the label and the actions taking the space beside
them rather than a row of their own — and the panel is more transparent
(0.66 alpha, no blur, since nothing else in the app uses `backdrop-filter`).
Checked over real video rather than the black mock frame: legible on bright
content, and on a narrow window the actions wrap to another line instead of
running past the overlay's edge.

**The shared model is the point.** `clipRange.ts` (pure arithmetic) +
`useClipRange` own the span; `useClipPlayback` consumes it for the range/loop
modes. Loop replay lands as a settings-menu toggle over the same pair, not a
second model. `useEdgeDrag` is shared by both tracks so their drag rules cannot
drift.

One rule runs through the interaction: **moving an edge shows you that edge.**
Every stepper press and handle drag scrubs the video there, which is also why
the picker is inline chrome rather than a modal — a modal covers the frame being
aimed at. Timestamps are read-only, `[`/`]` mark ends at the playhead (the keys
plan 1 §2 reserved), and the frame step uses the probed rate with the same 30 fps
fallback `frameStep` has always had.

**Server: a task, not a request.** A contact sheet seeks to sixteen keyframes
and costs the same at any length; a GIF decodes a _contiguous_ span and scales
with resolution and storage speed, so on 4K over a network mount it can outlast
the desktop shell's 30-second relay read timeout — the same wall that broke long
contact sheets before they were rewritten to seek. Hence create/poll/download,
each returning at once. Artifacts live under `{data_dir}/exports/`, not the
library cache: the parameter space is continuous, so caching them would
accumulate megabytes per marked span with no prospect of a hit. Encoding is one
ffmpeg run (`split` → `palettegen`/`paletteuse`), so the decode happens once.

**A prerequisite the plan had recorded came due.** `save_export_file` passed
bytes as a JSON number array — fine for a seam with no callers, not for a
multi-megabyte GIF. Now a raw Tauri IPC body with the name in a percent-encoded
header. Contact sheets and snapshots moved onto it too.

**Found by running it:** the export was named `X.mp4.gif` (display titles carry
the source extension), and marking an edge read `player.currentTime` — React
state fed by `timeupdate`, so it lagged the element by a render and could record
where the playhead _had been_. Both fixed, both with regression tests; the
second is why `useClipRange` takes a live `getCurrentTime`.

Tests run: **998 server** (26 new, including a real-ffmpeg case asserting an
animated GIF of the requested width), **677 web** (100 new), **120 e2e**
(9 new), **108 desktop Rust** (4 new). ruff/mypy/eslint/tsc/prettier/`npm run
build`/clippy/fmt all clean. Verified against a real backend on a scratch
library of generated videos: a 3.5 s export produced a 480×270, 12 fps,
42-frame GIF, a 4 s one a 1.5 MB GIF, the dialog's own round trip at
320px/15fps a 320×180, 75-frame file, and Original at 10 fps a 960×540, 50-frame
9 MB file measuring back at exactly `10/1` — all with the artifact dropped
after.
The out-of-bounds fix has a regression test confirmed to fail without it.

**One pre-existing e2e failure, not from this branch:** `transparently
re-attaches a fresh session when HLS segments fail` fails on the unmodified tree
at `6523fec8` too (verified by stashing). Separately, `reports real MP4 progress
and resumes on reopen` times out when the whole e2e suite runs at full worker
count; it passes alone and at `--workers=4`, so it is contention rather than a
regression — but it is a flake worth watching.

**Size and frame-rate controls followed (2026-08-15).** An options dialog on
Save GIF…, in the contact sheet's shape — a dialog rather than more controls in
the clip bar, since choosing a width does not need the frame on screen and the
bar had just been trimmed. Widths are the fixed sizes _below_ the source (320,
480, 720) followed by the source's own, so nothing on offer upscales and
nothing appears twice — a 720p source shows 320, 480 and Original rather than
Original beside a redundant 720.

**"Original" required raising the server's width cap** from plan 1 §10's 720 to
1920 (owner asked for the option, 2026-08-15). At 720 the label would have been
a lie for every 1080p source, which is the common case here. Not unbounded: a
GIF is one indexed frame per frame, and the measured 5 s 960×540 export is
**9 MB** — a thirty-second 4K one would run to hundreds. Above the ceiling the
top option takes its number rather than the word, because a 4K source at 1920
is not its original size.
The output's real pixel size is shown (`scale=W:-2`, so the height is derived
and even). **No byte-size estimate**: measured output ranged 15–31 KB/frame at
480px on the same settings, so any number would be wrong by 2× as often as not.

**Frame rate is constrained by the format, and the ladder now says so.** A GIF
stores each frame's delay as a whole number of centiseconds, so the only rates
it can represent are `100/n`. Measured off the frame control blocks of real
output rather than inferred: 5→exact, 8→7.69, 10→exact, 12→12.5, 15→**14.29**,
20→exact, 24→25, 25→exact, 30→33.33, 50→exact, 60→50.

Two corrections came out of that measurement. **15 fps plays at 14.29, not the
16.7 recorded here earlier** — that figure came from ffprobe's
`avg_frame_rate`, which is not the delay a viewer obeys. And **the fps ceiling
of 15 was a sketch in plan 1 §10, not a finding**: 20 and 25 are exact _and_
smoother, so `MAX_FPS` is now 50 (a 2cs delay; 1cs is the value historic
viewers reinterpret as 10cs).

The ladder is **5, 10, 15, 20, 25, 50** and the default is **15** — both the
owner's call (2026-08-15), after a round trip worth recording. The rates were
first cut to the exact ones only, which deleted 15; that was wrong, because 15
is the rate people actually reach for in a GIF and a 4.7% drift is invisible.
The default meanwhile went 10 → 20 → 10 → 15: 20 was an over-correction (the
question that prompted it had been about the _ceiling_, and the default
followed it up without cause), and 10 the conventional-and-exact compromise
before the owner settled it.

Rather than restore the "exact" badge whose meaning the owner had to ask about,
**the wheel prints what an inexact rate really plays at** — `15 fps / ≈14.3` —
and the summary reports the true output: `480×270 · 75 frames · 5.25 s (plays
at 14.3 fps)`. A drifting rate stretches the clip as well as slowing it, which
the old summary hid by printing the source's span.

`gifPlaybackRate` computes that as `100/round(100/fps)`, checked against
measured output at eleven rates rather than asserted.

For scale, measured at 480px over five seconds of real footage: 10 fps is
2.2 MB, 20 fps 3.9 MB (1.77x), 25 fps 4.6 MB (2.08x).
Rates far above the source's own are withheld for the same reason widths are:
measured, a 25 fps source encoded at 50 gained 50 frames and 1 KB, and a 30 fps
source at 50 gained 67% duplicates for a fifth more bytes.

**But the cut-off is 10% above the source, not at it** — because none of the
exact rates lands on 24 fps, which is the commonest source rate there is. Cut
off at the source, a 24 fps clip tops out at 20 and drops 17% of its motion;
25 fps duplicates two frames in forty-eight (4%) and is otherwise one for one.
Both measured. The tolerance lets 24 reach 25 and 48 reach 50 while still
refusing 30→50. A rung is marked `native` only when it really is the source's
rate, so a 24 or 30 fps source shows no mark — which is the honest way to say
the format cannot match it.

For the record, what the common sources get: **24 fps → 5/10/20/25**, **30 fps
→ 5/10/20/25**, **60 fps → 5/10/20/25/50**, each defaulting to 20.

**A fourth pass moved every size choice onto a wheel (2026-08-15).** A
segmented row has to fit every option side by side, which capped the ladders at
three or four rungs. `WheelPicker` is a horizontal scroll-snap strip — the
value under the centre mark is the selected one, so dragging changes it and
changing it scrolls. Snap points make "nearest to centre" exact at rest rather
than approximate, and a `settling` flag keeps the component's own centring from
being read back as a user choice. `radiogroup`/`radio` with roving focus and
arrow keys, so it is reachable without a pointer.

The ladders grew accordingly: **15 GIF widths** (was 3), **10 sheet widths**
(was 3, and the server's `SHEET_WIDTHS` enum became an 800–6144 range),
**6 frame rates** (was 4), and contact-sheet grids **4×4 through 8×8**
defaulting to 5×5 (owner, 2026-08-15 — 2×2 and 3×3 dropped as too sparse to be
a sheet, and `MAX_COLS` raised 6 → 8 for the top end). The grid's cost is one
keyframe seek per cell and nothing else, so it stays linear: measured 1.0s for
4×4 and 3.6s for 8×8 on a real file, against a 180s ffmpeg deadline. The GIF and snapshot wheels end
at the source's own width, marked `native` — with no "Original" button, which
the owner dropped as awkward once the ceiling was fixed at 1920; the native
width simply joins the ladder as an ordinary rung, so an odd source like
854×480 is still exportable at its own size.

**Snapshot gained a size, without losing its speed.** `S` and the camera button
stay one press at native resolution (owner: "for snapshot we can just use S for
original"); a new "Save Snapshot As…" on the right-click menu asks first. The
capture moved out of `ViewerShell` into `snapshotExport.ts`, and its filenames
joined the GIF's naming — `clip.mp4` produced `clip_mp4.png` before and
produces `clip.png` now, via a shared `exportFileName`.

**Known gaps / next:** persistent range-loop replay; `kind: "webp"|"mp4"`; and the desktop native-save path for a GIF has not
been exercised on a packaged build — only the browser download has, since the
Tauri shell cannot be driven here. The contact sheet still names its output
`X.mp4 — contact sheet.jpg`; left alone as pre-existing rather than widened into.

## Diagnosed: the owner's library is on SMB, so round trips are the only cost that matters (2026-08-13)

Three rounds of "still slow" were spent optimizing against synthetic local-disk
libraries. Measuring the owner's actual library settled it, and the finding
reframes every performance decision in the grouping code.

**The owner's library lives on an SMB share.** Measured against it, read-only,
with a locally-copied control:

| a trivial `SELECT` on `library.db`          | time         |
| ------------------------------------------- | ------------ |
| on its own volume (SMB)                     | **35.9 ms**  |
| the identical database copied to local disk | **0.021 ms** |

That is ~1,700x per query. A full directory walk of its 2,683 files takes 6.8 s
(2.5 ms per `stat`), against 0.036 ms per file for a library on the internal disk.

The library itself is **small** — 412 indexed files, 340 proposals, a 0.17 MB plan
payload. Every grouping operation, run against a local copy of that exact
database, is fast: generate 99 ms, convert 228 ms, Widen 42 ms. So none of the
slowness was ever about plan size, row counts, or render work.

**What it was: statement counts.** At 36 ms per round trip,

- `persist_plan`'s per-row flush plus the response's per-proposal file load =
  10,416 statements for a 3,600-suggestion plan. On SMB that is about **six
  minutes** — exactly what the owner reported. Now ~15 statements.
- a conversion read the whole plan twice and fetched each descendant's files
  separately: hundreds of statements, so tens of seconds.
- Narrow/Widen re-runs the suggester _and_ spliced with a flush per fresh row.

So the round-trip reductions committed above are the right fixes for this setup,
and their real-world effect is roughly 400x larger than the local-disk numbers
suggested. **The lesson for future work here: on this library, count statements,
not milliseconds.** `get_plan`'s docstring already said as much about NAS latency;
it should have been read as a constraint on the whole module, not one function.

Per-operation statement counts on the owner's library, after the fixes — the
number that matters, at ~36 ms each:

| operation        | statements | ~SMB  |
| ---------------- | ---------- | ----- |
| Suggest grouping | 8          | 0.3 s |
| GET one plan     | 3          | 0.1 s |
| Convert          | 11         | 0.4 s |
| Narrow/Widen     | 21         | 0.8 s |

**This is why the delta-response idea was dropped.** Returning only the changed
rows instead of the whole plan would save the response's own re-read: about three
statements, ~0.1 s per edit. That is not worth a contract change in the area where
a bug means a file lost from the plan or claimed by two bundles. The whole-plan
response is cheap now that the reads behind it are; it was never the payload.

Still outstanding:

- ~~134 plans and 7,724 proposal rows for 412 files~~ — **done**: superseded and
  cancelled plans are deleted when a new one is generated, keeping one so a client
  still holding a stale id resolves rather than 404s. Applied plans stay.
- The suggester's sidecar matching was quadratic in files per folder (fixed
  below). CPU-bound, so it did _not_ affect this library — but it would have as it
  grows, and it made Narrow/Widen quadratic too.

### Measured: the stem dial's steps are uneven, and the owner is fine with that (2026-08-15)

The owner asked whether the default stem matching starts too narrow, suggesting it
begin "one step wider". Measured on their library, that changes almost nothing:

| default                      | bundles | multi-file bundles |
| ---------------------------- | ------- | ------------------ |
| level 1 (shipped)            | 295     | 8                  |
| level 2                      | 294     | 9                  |
| level 3                      | 293     | 9                  |
| compare the first 2 segments | **276** | **26**             |
| compare the first 3 segments | 294     | 8                  |

The reason is the dial's definition: depth is `max - level + 1`, where `max` is the
segment count of the folder's _longest_ filename. One 22-segment name makes level 2
mean "compare 21 of 22 segments", so several steps in a row change nothing and then
one merges the whole folder — which is the overshoot the owner hit (they wanted
`ID-number`, got `ID`). Only a fixed _depth_ of 2 segments groups their naming
convention, and that is too aggressive to make a global default: a library named
like `The Matrix 1999` / `The Matrix Reloaded 2003` would merge them.

Offered as three options — depth-2 default, re-basing the dial on depth so each
click moves one segment, or both. **The owner chose to leave it as it is** (2026-08-15),
judging a 2-segment default unsafe. Recorded because the finding stands: the dial's
steps are unevenly spaced by design, worst in exactly the folders that need it most.
If it is revisited, re-basing on depth is cheap now — plans are cleared at startup,
so there are no stored overrides to migrate.

### Plans moved local, and the scan walks once (2026-08-14)

The page cache and the indexes took the plan write from >10 min to 4.6 s. The owner
judged 4.6 s still wrong for pressing a button and directed the storage to move,
which is ADR-0022: the three grouping tables now live in
`<data_dir>/plans/<digest>.db`, attached to every library connection as schema
`plans`. Writing a plan is 78 ms; a Narrow/Widen is 66 ms.

`ATTACH` rather than a second session, because a plan is read alongside the library
rows it describes and SQLite joins across attached databases natively — roughly
twenty-five `plan_store` call sites are unchanged. The plans file is keyed by a
digest of the library database's path and nothing else: the first version keyed it
by library id where known and by path otherwise, and a test that reopened a library
without the id found the two derivations disagreeing, which is a plan that silently
vanishes.

Two bugs the tests caught while this went in, both worth remembering:

- The migration used `INSERT OR IGNORE`, which **skips** a row violating a
  constraint rather than failing — and the next statement dropped the source table.
  It is a plain `INSERT` now, with a row-count check before the drop.
- `DirEntry.is_dir(follow_symlinks=False)` caches the _lstat_, not the stat, so
  warming `entry.stat()` in the worker thread matters: without it every file was
  still stat'ed one at a time, 2.3 s of a 3.6 s walk.

Scan, same library over the same share: **7,063 ms to 2,628 ms**, walk 6,317 ms to
1,290 ms. Three changes — one traversal instead of two (the second existed only to
count files for the progress bar), sixteen concurrent directory listings, and no
second full read of `asset_files` when nothing was dropped.

Verified end to end through the real server on the real library, which is the bar
the owner set. Update **1.6 s** warm (was minutes); opening the review pane 32 ms;
loading a 340-proposal plan 21 ms; rename 8 ms; convert to collection 76 ms;
reparent 26 ms; Narrow/Widen 217–242 ms. The one-time plan handover on first open
cost 18 s, copying 5.6 MB of plan rows off the share.

Narrow/Widen is the slowest thing left at ~230 ms, because `set_directory_stem_level`
re-runs the whole suggester (a directory's grouping is not computable in isolation)
and that read still crosses the share. Caching the suggester's input per plan would
take it to tens of milliseconds; not done, and not obviously worth the invalidation
surface.

Plan lifetime went through three versions before settling, and the owner drove the
last one. First: delete a library's plans when it is deregistered — wrong, because
remove-and-re-add is documented as reversible and a plan holds edits only the owner
could make. Second: keep plans durable and sweep unclaimed files after a fortnight —
correct but elaborate. Third, and current: **a plan lasts as long as the server that
made it**, cleared at startup. The owner judged that a restart requiring a fresh
Update is fair, and it deletes the sweep, the grace period, and any need to know which
libraries are still registered.

Worth keeping from the second version's investigation: a plans path is stable for a
plain mount point whether or not it is mounted, but **differs** when the mount point
itself is a symlink. Any future cleanup that recomputes a digest for an absent library
cannot rely on getting the same answer. And nothing depended on plans outliving a run
— applied plans are never read back, and the review pane finds its plan by
`status === 'open'`.

Not done: the library database is not vacuumed after the tables are dropped, so it
keeps the freed pages. With a 32 MiB cache and a 6 MB database they are never read,
so this is deliberate rather than pending.

### Root cause found: a 2 MiB page cache and three missing indexes (2026-08-14)

The owner pushed back on "no way around this", correctly. Bisected properly, and
the answer is small and general.

Writing 340 proposals into their 5.75 MB library on the SMB share:

| configuration                                  | insert     | whole `persist_plan` |
| ---------------------------------------------- | ---------- | -------------------- |
| as shipped                                     | **>600 s** | **>600 s**           |
| `cache_size=-32768`                            | 5,228 ms   | 14,096 ms            |
| that plus indexes on the grouping foreign keys | **236 ms** | **4,614 ms**         |

How it was found, after several wrong turns:

1. A phase-by-phase breakdown showed everything except the row write totals 1.7 s.
2. `faulthandler.dump_traceback_later` proved it was blocked in
   `sqlite3.Cursor.execute` inside SQLAlchemy's insertmanyvalues, at 0% CPU — I/O,
   not computation.
3. Hand-written SQL of the same shape ran in 342 ms, so the statement form was not
   the problem. Capturing SQLAlchemy's _exact_ statement and parameters and
   replaying them through raw `sqlite3` was still slow — so not the ORM either.
4. Bisecting the parameters: nulling `parent_proposal_id` → 394 ms; keeping it but
   setting `foreign_keys=OFF` → 449 ms. So it was foreign-key verification of the
   self-referential column, one index seek per row.
5. Those seeks should hit cache. They did not, because the default cache is 2 MiB
   against a 5.75 MB database and the inserts were evicting the very index pages
   being sought. `cache_size` fixed it; the missing child-side indexes were then
   the next cost, in the cascade delete.

**Wrong turns worth not repeating.** I claimed "journaled page I/O, no way around
it" — measured, and journal mode changes nothing here (delete/memory/off all within
100 ms of each other). I claimed statement batching was the fix twice. And one
"verified" run was against unmodified code: a `cd` failed, `&&` short-circuited the
edit, and the gates passed on the old file. Check that the edit landed before
believing the measurement.

### Earlier, superseded: writes over SMB are ~1,000x, not 36x

The 35.9 ms figure was a _read_. Measured separately on the same share, with a
throwaway database:

| on the share                                   | local  |
| ---------------------------------------------- | ------ |
| 750-row `executemany` — 100 ms                 | 0.6 ms |
| its commit — **450 ms**                        | 0.4 ms |
| eight small write+commit cycles — **2,220 ms** | 0.3 ms |

SQLite cannot host WAL on SMB (ADR-0021 detects this and heals the file back to a
rollback journal), so every transaction journals the original pages, writes, and
fsyncs. Bulk row writes are therefore hopeless there, and no amount of statement
batching changes it: running `persist_plan` against a copy of the owner's library
**placed on the share** took **420 seconds** for 340 proposals — with 8 statements.
Local: 85 ms.

That is what "Writing grouping suggestions" was stuck on. The fix is not to make
the write faster but to stop doing it: an Update that changed nothing now keeps the
open plan (420 s -> 5.8 s, the remainder being the eager read of 340 proposals).
Pruning is bounded per run for the same reason — its delete cascades, and clearing
a hundred plans at once is minutes of writes.

**So the earlier "you probably don't need a NAS server" was wrong**, and it was
wrong because it was reasoned from read latency alone. Any operation that writes a
few hundred rows is minutes on that share. The reuse path avoids the common case;
the first Update after a real change still pays it.

- **Keeping `library.db` inside the library package costs 36 ms a _read_ on SMB and
  ~300 ms a _write_,**
  which is ADR-0008's deliberate trade (the database travels with the library).
  Running a server on the NAS instead is the structural answer, and it is **not
  urgent**: after the fixes above the owner's operations are 8–21 statements, so
  0.3–0.8 s over SMB on a 412-file library. The pain was never the share, it was
  ten thousand round trips. Revisit when the library grows, or when an always-on
  server is wanted for other devices — the scan's per-file `stat` (2.5 ms over
  SMB, ~7 s for 2,683 files) is the one cost no code change improves. Docker is
  the only supported way to run the server there: the sidecar packaging is
  macOS-only and PyInstaller does not cross-compile. Development would not move
  either way — it stays native on the Mac against a local library.

## Completed on branch: making a large plan usable (2026-08-13)

Owner testing on a ~20,000-file library, commit `9253dfdb`. Reported: a conversion
took over ten seconds, creating a collection and moving it took seconds to
render, the `...` menu was slower than the glyphs it replaced, its labels were
sentence-long, and "matched" did not say what had matched.

### What was actually slow, measured rather than guessed

A synthetic library of the reported shape (folders of dated releases, each a
video plus two sidecars), with the client's server mocked so the two halves could
be separated:

| at 8,400 suggestions     | before   | after  |
| ------------------------ | -------- | ------ |
| open the dialog (client) | 2,214 ms | 747 ms |
| DOM nodes                | 222,000  | 33,600 |
| one conversion (client)  | 5,050 ms | 826 ms |

| at 2,700 suggestions, fresh session (server) | before | after  |
| -------------------------------------------- | ------ | ------ |
| convert collection to bundle                 | 307 ms | 226 ms |
| convert bundle to collection                 | 394 ms | 116 ms |
| reparent a collection                        | 253 ms | 126 ms |
| stem level change                            | 997 ms | 727 ms |

The client dominated, and by an order of magnitude. Folding _hid_ rows rather
than unmounting them, so a folded subtree was still built, reconciled and laid
out on every render — folding freed nothing, which was already recorded as a gap
here and turns out to be the whole story. With file lists closed by default,
every file in the plan was in the DOM unseen. Folding now unmounts, and a plan
over 400 suggestions opens folded, which is how a plan that size is read anyway.

On the server, `_open_proposal` checked one column via `get_plan`, whose eager
load exists so that _serializing_ a response is not N+1 — so every edit read the
whole plan twice. Removing that exposed a second fault it had been masking:
`_container_to_bundle` reads `row.files` per descendant, which was one query each
and only looked cheap because the whole plan happened to be warm.

**A correction worth keeping.** An earlier run of the same benchmark reported the
stem-level change at 13.3s → 1.8s. That was an artefact: the harness reused one
session across every operation, leaving ORM state a real request never has, which
invented an N+1 in the splice. Re-measured with a session per operation — what a
request actually gets — it is 997 ms → 727 ms. The lesson is that a benchmark
sharing a session across operations does not measure the request path.

Two regression tests, both shown to fail against the unfixed code: merging a
collection reads its bundles' files in one query (asserted on the merge itself in
a deliberately cold session, because through the endpoint the response's own
eager load hides the difference), and a long plan opens folded. The
whole-plan-read-twice fix has no honest unit test — the query _count_ is
unchanged, only the rows loaded — so it is recorded here as a measurement rather
than asserted as a green test that proves nothing.

### Round two: the plan was written a row at a time

Owner tested again: generating took "quite long" to show anything, and conversion
was still not instant. Profiling `POST /plans` found the real cost was never the
heuristic — it was **10,416 SQL statements** for a 3,605-suggestion plan, from two
independent faults in `persist_plan`:

- it flushed inside its loop, solely to learn the id it was about to need for the
  row's files. `UlidPk` defaults to a plain Python callable, so assigning `id`
  explicitly makes every primary key known before the insert and lets SQLAlchemy
  batch them (the self-referential parent FK is why it otherwise inserts one row
  at a time).
- the files were linked by `proposal_id` rather than through `row.files`, so
  serializing the response lazy-loaded each row's files: one SELECT per proposal.

Priming the collection needs `set_committed_value` **after** the flush — turning a
pending instance persistent resets that bookkeeping, so doing it earlier silently
does nothing, and plain assignment leaves an _empty_ collection unloaded so every
container still paid a query. `extend` is worse than either: it loads before
appending.

`POST /plans` at 3,605 suggestions: **4,173 ms → 1,560 ms**, 10,416 statements →
4 batched inserts plus a handful of reads. The suggester itself is ~0.7s of that
and was never the problem. The same per-row flush is gone from
`_bundle_to_container` and the stem splice; the splice keeps one flush before its
parent-link pass, because the foreign key is enforced immediately.

Server-side per edit at 3,605 suggestions is now: convert 145–317 ms, reparent
114 ms, stem level 829 ms, plus ~130 ms to serialize the response.

**Still not instant, and why.** Every edit returns the _whole_ plan — 3 MB at
3,605 suggestions — because a conversion changes the tree's shape. The client then
re-parses it and rebuilds ten O(plan) memos. That is the remaining cost and it is
structural: the next step is a delta response (`{removed_proposal_ids, proposals}`)
that the client patches into its cache, across the four mutating endpoints. Not
attempted here — it is a contract change to the area where a bug means a lost or
duplicated file, and it wants its own slice.

### The controls

The `...` menu is gone. The row's own kind glyph is the convert control, which is
one click in the place the kind is already shown rather than two clicks and a
read; the first attempt put a second folder-ish icon after the title, which
collided with the placement picker's glyph on the same row. Labels are
`Convert to collection` / `Convert to bundle`. Renaming stays a double-click.
Confidence reads `confident` / `likely` / `guess`.

## Completed on branch: the stem dial (2026-08-13)

Both halves of the task specified here on 2026-08-13, in commits `dc097d0c`
(backend) and `022c19e8` (frontend). Kept for the reasoning; the outcome is in
`CHANGELOG.md`, `docs/data-model.md`, and ADR-0009.

### The level

`StemMode` had only ever had three values (`narrow` / `balanced` / `wide`, one
commit). The owner's model was the better one — a dial you keep turning until
there is nothing left to turn — and the three stops were not points on one scale
anyway: `balanced` folded a rendition tag while `wide` switched to a separate
semantic-chunk key, so "one step wider" meant two unrelated things.

At level `L` a folder compares the first `max - L + 1` segments of every name it
holds, where `max` is the longest name there. Level 1 compares whole
rendition-folded stems and is the default — byte-identical to the old
`balanced`, so nothing regroups on upgrade — and level `max` compares first
segments alone. Level 0 is the one rung outside the scheme (the complete stem,
rendition tag included), because folding `4K [tag]` versus `720p` is not
expressible as a segment count.

**The mistake worth not repeating.** The first implementation read the level
_relatively_: drop `L - 1` trailing segments from each name. It is the obvious
design and it is broken. Two names with different segment counts then produce
keys of different lengths, which can never be equal, so nothing merges until the
top rung clamps every name to one segment and the whole folder merges at once.
The 12-and-9-segment pair in the suggester test reached "two bundles" by pairing
the _wrong_ two files, and the test passed. `_StemKey` is per folder for exactly
this reason, and the regression test asserts which files meet, not just how many
bundles result.

`_StemKey` is also now the only definition of "do these two names match?" —
`wide` used to group by a key `_owner_match_score` never saw, so addition
matching silently stayed at the balanced key. `_wide_stem_keys`,
`_semantic_segments` and the `wide`-only scoring tier are gone with it.

`max` depends on a folder's filenames, so `PlanRead.stem_levels` reports
`{level, max}` for every folder the plan's files come from — the client cannot
derive it without reimplementing the normalization. `PUT .../stem-levels` clamps
rather than refuses, since the client asks against the maximum it was last told.
`grouping_plans.stem_modes` keeps its column name (no migration chain can rename
a column) with `stem_level_overrides` mapped onto it, and stored legacy strings
are coerced on read with `wide` resolving to that folder's maximum.

### The controls

Narrow/Widen are visible on the row that speaks for the folder, with the level as
text and tooltips that say what each does to the _stem_ before what it does to
the bundles. The owner's own words are back; this branch's "Split/Merge into
more/fewer bundles" was churn.

**What the folder-header spec got wrong.** It called for re-grouping the rendered
rows by source directory, and named as "the hard part" that the tree nests by
`parent_proposal_id` instead. That framing was backwards. A collection suggestion
for a folder _already is_ that folder's header — same name, same scope, its rows
nested beneath it — so the tree already groups by folder wherever a folder has a
collection row. Re-parenting the render would have duplicated that for no gain
while breaking drop targets, tri-state selection, fold keys, sibling rollup, and
keyboard navigation, all of which are structured around the proposal tree. What
was actually wrong was only that the folder's controls were hidden in a row menu.
So the dial goes on the header row that exists, a leaf folder that is one bundle
carries its own, and `stemControlOwners` — which already answered "which row
speaks for this folder?" — needed no change.

Not done, deliberately: the destination is still per row. Two bundles from one
folder can be filed into different collections, and moving the picker onto the
header would remove that to fix repetition that is only cosmetic.

## Merged: grouping suggestion review (2026-08-10)

Branch `feat/grouping-suggestion-review` off `main` at `6523fec8` (renamed from
`feat/grouping-review-triage` once it grew past the triage slice). **Not merged, no PR.**

Nine of the ten UX items from the review of the Suggest-grouping dialog:
uncertainty surfaced and filterable, file lists closed with a contents summary,
compact placement on nested rows, row edits named rather than glyphs, runs of
identical siblings rolled up, keyboard navigation,
folded intro, fixed dialog height, reserved status line, and an Accept button
that names what it will do and what it will skip. The tenth — a two-pane
destination/source layout — is deliberately not attempted here.

A max-effort review of the branch (10 finder angles) found 15 defects, **all
fixed** in the follow-up commit, each with a regression test that fails against
the unfixed code. The two that mattered most:

- `usePopover`'s outside-click handler stopped propagation without preventing
  the default, so with any popover open a click on a _controlled_ checkbox
  unticked the DOM while React state kept the row selected — the visible ticks
  and "N bundles selected" disagreed, and Accept confirmed a bundle the owner
  had watched themselves skip. Shared hook; the fix reaches every picker.
- The Cmd/Ctrl+Enter accelerator reproduced none of the Accept button's guards,
  so it applied the plan mid-rename, with nothing selected, and on an
  already-applied plan.

Also fixed: stem actions leaking back onto read-only existing-collection rows
(the regression the previous branch closed); an unrecognised stem mode making
"Merge" split instead (moot since the dial replaced the enum, and the guard is
now structural — there is no unrecognised level); a filtered collection checkbox
that could never reach
unchecked; a rolled-up run hiding its folder's actions and being unreachable as
a drop target; the filter stranding a blank list; a run that could be expanded
but never folded back; rollup/file state keyed by ids that in-place regeneration
reissues; arrow navigation dying on any row control; Collapse all enabled but
inert on a flat plan; and a test assertion that passed against an empty DOM.

Cleanup in the same pass: the filter shares `.seg` rather than being a second
copy; ~60 lines of CSS and five icon components orphaned by the branch are
deleted; the two sibling render sites are one `ProposalRows` component; and
`ProposalNode`'s ten forwarded props are one `SharedNodeProps` object. (The row
overflow menu described here was itself removed later on the branch — see
"making a large plan usable" above.)

Known gaps, deliberately not addressed: the proposal tree is still not
virtualized, so a plan whose folders are all expanded is slow regardless of these
changes (folding now unmounts, which is what made that survivable — see above);
`LOW_CONFIDENCE = 0.75` still duplicates
the server's `_bundle_reason` policy client-side with no test binding the two,
and the reviewers' recommendation is a server-side `needs_review` flag on
`ProposalRead`; `shapeKey` still compares the human-readable `reason` string;
and `GroupingReview.tsx` remains large enough that its pure plan logic wants a
sibling module.

Then, after owner testing against the real library: the confidence tabs replaced
by a per-row confidence label (a two-tab filter can _hide_ the mislabeled row
from the view that claims to show what needs deciding), bundle↔collection
conversion restored as always-available, the shortest shared prefix as the
default bundle title, and the migration repair below. The stem dial that closed
this round is written up in its own section above.

Also fixed, live: `OperationalError: table grouping_proposals has no column named
is_collection_context`. The column reached the model and the backfill gate but
not `_ADDITIVE_CONTENT_COLUMNS`, so an existing library could not insert a
proposal at all. Two tests now bind the model to that list, and one names any
future unlisted column.

Tests run: backend 979; frontend 591 across 79 files; `library.spec.ts` 34/35 —
the failure is the `switches one addition row` flake described below, which
passes in isolation and predates this branch's review fixes. Lint, format,
typecheck and build clean on both stacks.

Known flake, since resolved: `library.spec.ts` "switches one addition row" used
to fail roughly one full-spec run in four. It asserted on a _hidden_ file list;
rewriting it for the unmounting fold made it deterministic, and the spec has since
passed 35/35 four runs running. Whether the hidden list was the cause or only
where the race surfaced is unproven.

Next recommended task: the delta response described above — it is the one
remaining lever on "instant" for an edit. Then owner testing again. If it is still slow with folders expanded, the remaining
fix is virtualizing the tree, which needs flattening the nested `ul`/`li` render
(drag targets, selection, fold keys, rollup and keyboard nav are all built on that
nesting) and is its own branch.
Then either the two-pane destination layout — whose remaining justification is
bulk placement across folders, now that folder headers carry the dial — or the
server-side `needs_review` field the reviewers recommended.

## Completed on branch: grouping selection, placement, and folding (2026-08-09)

Branch `codex/fix-grouping-selection-placement` off `main` at `7acc7bc`, open as
**PR #11**, not yet merged.

> **Review pass, 2026-08-09.** A max-effort review of this branch (10 finder
> angles, 5 adversarial verifiers, 1 gap sweep) found 11 confirmed correctness
> defects, three of them regressions against `main`. All 11 are fixed in commits
> `d7d3db4`, `219ec50`, `dc5f5aa`, and the commit adding this note; each carries
> a regression test, and the two most severe were proved to fail against the old
> code before the fix landed. One candidate — an out-of-order query-cache
> overwrite in `useReparentGroupingProposal` — was **refuted**: every reparent
> entry point is gated by the shared `busy` flag, so the race is unreachable from
> the UI.
>
> Three lower-confidence findings are **not** fixed and are follow-up work:
> `service._with_collection_context` collapses two persisted collections that
> share a name path _and_ `sort_order` onto one plan node, making the applied
> destination depend on set iteration order; the proposal tree is not virtualized
> and folding hides rather than unmounts, so Collapse all frees no work at scale;
> and `GroupingReview.tsx` is ~1700 lines and wants splitting on the seams the
> review named.
>
> Separately, and **pre-existing on `main` rather than from this branch**: real
> library content sits in two test fixtures and is published. The owner has seen
> it and deferred the purge. Note for whoever plans it that the strings are also
> in tags `v0.1.0` and `v0.1.1`, whose releases are published — so a history
> rewrite would move tags AGENTS.md says never to move once released.

Grouping review now separates **what is accepted** from **where it is filed**.
Only file-backed bundle proposals are accepted. Collection checkboxes are
tri-state bulk selectors for descendant bundles, so selecting one nested bundle
makes each ancestor indeterminate, leaves siblings unchecked, and sends only
that bundle id. Apply computes the selected bundle's full structural ancestor
path and creates or reuses only that path.

Existing collection context now carries a stable `target_collection_id`, is
labeled **Existing**, and cannot be renamed, moved, or reclassified. Matching
new suggestions reuse that exact nested collection even when another collection
has the same name elsewhere; a target removed or reparented after plan generation
conflicts before its bundle is confirmed instead of creating a top-level
lookalike. Existing libraries gain the nullable field through additive bootstrap,
including a legacy marker backfill for open plans.

New bundle and collection proposals have a keyboard-accessible placement
selector alongside drag-and-drop, including an explicit top-level destination.
Collection moves reject cycles. Grouping remains metadata-only: apply changes
bundle/collection records and never touches source files.

The placement selector now follows the Bundle Inspector's collection-picker
shape instead of flattening every destination into a repeated root-to-leaf
label. Its viewport-bounded popover renders one collection name per indented
row, folds branches independently, searches with the shared pinyin matcher, and
shows only a direct-parent hint in filtered results. Full paths remain available
to assistive technology and in tooltips, and keyboard users can move through
results or accept an exact search match with Enter.

The selector's destinations now come from the current persisted collection
query, the same source used by Bundle Inspector, rather than from the grouping
plan's speculative CONTAINER proposals. A proposal still shows its suggested
parent in the row and remains rearrangeable by drag-and-drop, but that draft
path is not a picker choice. Choosing a persisted destination sends its stable
collection id; the server resolves its current ancestor path into read-only plan
context and commits the refreshed whole plan before the client can immediately
apply it.

The follow-up review UI now starts expanded but can fold any collection's
descendant proposals or any bundle's file list. **Collapse all** and **Expand
all** sit beside selection controls. This state is view-only and content-keyed,
so selection counts and apply ids remain unchanged, proposal headings remain
drop targets, and stable in-place plan edits retain the owner's fold choices;
an explicit fresh Suggest grouping resets to expanded.

Verification: backend Ruff check/format, mypy (**167 source files**), and all
**967 pytest tests** pass. Frontend ESLint, Prettier, TypeScript, all **79 Vitest
files / 575 tests**, and the production build pass; unit coverage includes
folded selection/apply invariance plus persisted-only picker destinations,
hierarchy, folding, search, and keyboard placement. The existing large-chunk
warning remains. The complete
frontend `e2e/library.spec.ts` Playwright file passes all **35 tests**, including
per-row review folding, dragging a bundle heading while its files are folded,
and separate draft/current collection trees whose bounded panel, compact labels,
search, speculative-option exclusion, and stable-id write are verified in
Chromium. OpenAPI and generated frontend types are current. No desktop host code
changed, so Rust and packaging gates are unaffected.

## In progress: stoppable multi-file imports (2026-08-01)

Branch `codex/stoppable-import-batches` off current `main` at `c322449`. Imports
remain client-owned, sequential one-file requests rather than registry jobs:
the browser owns an `AbortController`, while the desktop shell registers a
batch-scoped cancellation token and carries Stop across IPC into the Rust file
reader feeding the current `reqwest` body. Both paths keep completed per-file
journal operations intact and stop before starting the untouched remainder.

The sidebar foot now renders every active client import beside every active
background job instead of making them compete for one slot. An import row names
the current file, shows its original batch position, uses the job-control
waiting and stopping language, and retains a disabled Stop control after the
stop request. Bundle-target imports close their destination picker once
accepted so that row remains reachable. Stopped summaries distinguish imports, skips,
ordinary failures, the interrupted request, and files never attempted; they
also state that completed imports remain individually undoable. Files completed
before a stopped bundle-target batch are still linked into that bundle.

The ADR-0013 boundary is unchanged: both write-mode gates still decide whether
the import affordance exists, every file remains its own intent-before-action
journal entry, and the server still receives bytes rather than a client-named
path. A regression test drives an actual Starlette `Request.stream()` through a
partial `http.request` followed by `http.disconnect`; `ClientDisconnect` reaches
the existing exception path, the `.part` file is removed, and the file's journal
entry becomes failed. Browser and desktop hook tests cover sequential batches,
collision resume, partial-result accounting, and stopping the request already
in flight; Rust tests cover the IPC token interrupting the streaming reader.
Sidebar tests cover running, waiting, stopping/disabled, and simultaneous import
and job rows, and Playwright verifies that a bundle destination picker yields to
the reachable sidebar row while its request is in flight.

Verification: all backend gates pass — Ruff check and
format, mypy (**167 source files**), and **960 pytest tests**. All frontend gates
pass — ESLint, Prettier, TypeScript, **78 Vitest files / 556 tests**, and the
production build (with the existing chunk-size warning). Desktop formatting,
Clippy with warnings denied, and all **104 Rust tests** pass; `npm run tauri
build` produces the macOS app and DMG. The Rust tests and packaged build needed
host execution because sandboxed socket binding and DMG tooling are unavailable.
The relevant library Playwright file passes all **33 tests**. A full Playwright
run passes **104 tests** and repeatedly fails one unrelated pre-existing HLS
session test at `e2e/player.spec.ts:2331`: the mock records one decision where
the assertion expects more than one; an isolated rerun fails identically. The
focused bundle-import Playwright regression was rerun after the final UI audit
and passes.

Next: review the focused branch and, when convenient, manually stop a large
Finder import in a packaged build over a throttled or network link. There is no
unresolved architecture decision and no PR has been opened.

## Completed: grouping conversion and storyboard connection regressions (2026-08-04)

Integrated directly into `main` at the owner's request. Both reports are
reproduced with generated fixtures; no owner library names, paths, filenames,
or screenshot contents enter the change.

**Convert then Accept crossed a transaction boundary.** The conversion endpoint
returned IDs for newly inserted child proposals while the library-session
dependency still owned the commit. On a slow library DB, a following apply
request could start from another session before that teardown finished and
correctly reject those not-yet-visible IDs as nonexistent. The endpoint also
re-read the plan through the same SQLAlchemy identity map, where an already
loaded `plan.proposals` collection could retain its pre-conversion contents.
Conversion now commits, expires that identity map and reloads the complete plan
before responding. Apply commits before returning too, so the bundle/collection
queries the client immediately invalidates observe what the result says it
accepted. A two-session regression asserts every ID in the conversion response
is durable before the endpoint returns; API and UI regressions cover immediate
selected apply and its exact request payload.

**Storyboard generation held a live SQLite result across slow external work and
commits.** `generate_for_library()` used `yield_per(20)`, then spent up to minutes
inside ffmpeg and called `JobContext.checkpoint()` before and after each file;
that checkpoint commits the same content session. Fetching the next row from an
invalidated result produces the reported SQLAlchemy `ProgrammingError` wrapping
SQLite's `Cannot operate on a closed database`. Candidate enumeration now uses
bounded 20-row keyset pages, fully buffered before any ffmpeg/checkpoint boundary,
so memory remains bounded without retaining a cursor. The regression invalidates
a result at the checkpoint and reproduces the exact exception against the old
loop.

Verification: all backend gates pass — Ruff check and format, mypy (**167 source
files**), and **963 pytest tests**. All frontend gates pass — ESLint, Prettier,
TypeScript, **79 Vitest files / 564 tests**, and the production build (with the
existing chunk-size warning). The full `e2e/library.spec.ts` Playwright file
passes all **34 tests**, including its grouping-review flows. The complete
Playwright suite passes **106 tests** and fails only the unchanged HLS session
re-attach baseline at `e2e/player.spec.ts:2331`; the mock records one playback
decision where the assertion expects a replacement. No desktop host code
changed, so the Rust/packaging gates are unaffected.

## In progress: desktop Add Library refresh recovery (2026-07-31)

Branch `codex/fix-desktop-library-refresh` off current `main` at `f12d3f9`.
Frontend-only: no host command, server contract, migration, or native Rust code
changed.

**The native mutation and the following query were one apparent operation.**
`confirmPickedLibrary(...)` could successfully register or create the library,
then `LibraryManager` awaited `libraries.refetch()` and unconditionally cleared
the confirmation. TanStack Query does not throw for a failed `refetch()` by
default; it resolves a query result with `isError`. The component never inspected
that result, so a committed registration disappeared behind the old or empty
list and the same Add control came back. The list renderer independently treated
missing query data as an empty array, making a failed initial load say “No
libraries yet.”

The states are separate now. Once native confirmation returns, registration is
recorded as committed before the list read starts. Only a successful refresh
clears that confirmation. A failed refresh says the library was added, retains
its display name, removes Add and Cancel, and offers **Retry refresh**;
retry never calls the native mutation. If the dialog is reopened while the list
query is still failed, the stale Add/Browse path remains disabled until the
separate list retry succeeds. Initial list failure has an explicit load error
and **Retry**, while “No libraries yet” is reserved for a successful empty
response.

**The bundled transport reproduction found one narrower HMR defect too.** With
no process listening on port 8000, a fresh `just bundled` activation loaded the
existing library through the local sidecar. Replacing `api/client.ts` through
Vite then reset its module-local API base. The next list request was exactly
`http://127.0.0.1:5173/api/v1/libraries`; Vite forwarded `/api` to its default
`http://localhost:8000` and logged `ECONNREFUSED`. This proves ordinary local
activation was already correct and that the base was lost specifically across
module replacement. The base now lives on the page runtime, which survives HMR
but resets with the page/process; repeating the same replacement kept the
library on the sidecar and produced no proxy request or port-8000 error.

Disproved older hypotheses: the remaining Add failure is not the already-fixed
cold-start ownership ordering race; ordinary local and remote connection
activation do set the correct API base; and the native registration itself is
not the failure represented by the cleared dialog. In the reproduced HMR case,
the first initiating failure was loss of the module-local API base, followed by
the list GET reaching Vite’s fallback. Independently, any list-read failure was
misreported because the `refetch()` result was ignored.

Regression coverage added: successful native confirmation plus list refresh
shows the library and restores the ordinary Add row; failed refresh calls native
registration once, preserves the committed state, reports the split outcome,
and exposes only Retry refresh; later retry shows the library without a second
registration; initial list failure is distinct from an empty list and retryable;
and a module reload preserves the active desktop API base. The existing
cold-start ownership and local/remote activation suites remain in the focused
gate.

Verification: the focused LibraryManager, App/App-open-folder ownership,
QueryScope, API-client, and connection suites pass (**8 files, 89 tests**).
Frontend ESLint, Prettier check, TypeScript, all **77 Vitest files / 549 tests**,
and the production Vite build pass. The two relevant Playwright files pass all
**42 browser tests**, including the cold-start assertion that no browse request
starts before ownership resolves and content appears afterward without
navigation. A live bundled run rebuilt the sidecar, proved port 8000 was closed,
captured the fallback URL before the fix, and repeated the same HMR lifecycle
without a proxy request afterward. Desktop Rust gates were not run because no
host-side code changed.

## Merged: job control (2026-07-30)

Branch `fix/job-control` off `main` at `8eac71c`, **merged as PR #5**
(`34295b3`). Everything here came out of using the app while testing the
storyboard change — including one fault an agent caused, by switching branches
under a running dev server.

**Nothing in the UI could stop a job.** The backend had cancellation end to end
— `POST /jobs/{id}/cancel` → `checkpoint()` → CANCELLED, with a test — and the
frontend never called it, so a run you no longer wanted had to be waited out or
the server killed. Every active row now carries a stop control.

**Cancelling was only as prompt as the next checkpoint**, which for a storyboard
pass over a network-mounted library is a whole file: ~30s inside one ffmpeg
call, so the button would have read as broken. `core/abort` puts a cooperative
abort signal in a context variable, the worker binds it for the life of the
handler, and `run_ffmpeg` waits in slices so it stops the process where it
stands. `OperationAborted` is deliberately not an `FfmpegError`, so a stop is
recorded as cancelled rather than as a derivative that failed. Outside a job —
HLS sessions, request-path derivatives, tests — nothing changes.

**A job whose process died stayed RUNNING forever.** Nothing reconciled those
rows: they sat in the sidebar as live work, absorbed cancels nobody was there to
observe, and did not even suppress a duplicate, since dedupe matches QUEUED. A
worker taking over the queue now closes them out as failed-interrupted — both
the moment it is knowable and unambiguous, since the registry is server-local
and its worker runs in-process, so a RUNNING row at startup cannot belong to
anything alive. Not resumed, deliberately: a rerun of any library-wide job skips
what is already current, so recovery costs only what was lost.

**Cancelling a queued job left it queued** for a worker to start later, and **a
queued row rendered the same moving bar as a running one** — which is how two
Update presses produced two indistinguishable rows. Both fixed; a job that has
been asked to stop now says so.

**One storyboard leak, same family:** an interrupted pass left its temp
directory in the cache, because cleanup lived on the failure path and a stop is
not a failure. Cleanup moved to a `finally`, and a library pass sweeps what
earlier interruptions already left behind.

**Two more the owner found by using the button** once it existed. A cancelled
job stayed on screen until a page refresh, reading as though the stop had not
taken: the server had already dropped it (cancelled is terminal, so it leaves
the active list) and the app was holding the last snapshot deliberately —
correct for a _failure_, which nobody asked for and whose row is the only
account of it, wrong for a stop someone requested. And the maintenance error
rendered at the top of the sidebar under the button that started the work, while
the job it described was reported at the bottom; it now sits with the job rows,
which is where the work reports for the same reason the rows moved there.

**Tests run:** backend `ruff`/`format`/`mypy`/`pytest`, frontend
`lint`/`format`/`typecheck`/`test`, plus browser e2e. New coverage: a worker
closing out a stranded RUNNING row while leaving terminal rows alone, a queued
cancel that never runs, a cancel stopping a 60-second external call in under
15s, `run_ffmpeg` unchanged without an abort scope, no temp directory left by a
stopped pass, the sweep, the sidebar's waiting/stopping states and stop button,
a cancelled snapshot clearing while a failed one stays, and the error rendering
inside the sidebar foot. Both UI changes were looked at in a real browser, not
only asserted — and the cancelled-row test was checked against the unfixed code
to be sure it fails there.

**Open, non-blocking:** whether an interrupted job should offer to resume rather
than just report itself interrupted — cheap for storyboards, less obvious for a
long scan. And whether a cancellation should raise a red alert at all: it
currently reports "Background job was cancelled" as an error, which is a
failure's register for something the owner asked for.

## In progress: one inspector, collection consistency, cover scope (2026-07-30)

Branch `fix/inspector-parity-and-collection-covers`, rebased onto `main` at
`34295b3` (the job-control merge). Five owner reports from using the app, three
of them about collections. **Not yet reviewed; no PR opened** (owner-triggered).

**The Bundle Inspector shown during playback was starved, not forked.** It has
always been the same `Inspector` the shell's rail renders. The shell passed
eleven handlers; `ViewerShell` passed `bundleId`. Every menu entry gated on an
optional handler was therefore absent in the viewer, and `onFlash` was missing
so a tag edit completed with nothing to report it — the owner's "unresponsive
when adding new tags". The width differed because the viewer wrapped the pane in
a rail element declaring its own `min(360px, 40vw)`, border and background.

The handlers are now `BundleInspectorActions`: one object the shell provides
once and the inspector reads from context, with `bundleId` its only prop. That
is the point of the change rather than parity today — an action added to the
interface later is supplied in one place and arrives on every surface, where two
call sites left the next one free to go missing. A surface needing an action to
_mean_ something different overrides those entries and inherits the rest.

That shared action set now includes the write-gated **Move to Trash** callback.
The bundle album already offered the journaled, recoverable deletion; the file
section inside both Bundle Inspector surfaces now offers the same action when
write mode is on and no deletion row at all while it is off. Trashed rows are
now excluded from the bundle’s active files endpoint, playback manifest and
cover fallback, so the operation removes the file from the bundle immediately.
The client also removes that row from every active bundle-file cache as soon as
the action starts, rather than exposing the journaled move and follow-up refetch
latency on a network mount; a rejected operation restores the cached rows.
Opening Trash had a separate delay: its listing statted every entry and then
recursively walked the entire trash tree for a total before returning anything.
Trash entries now carry their captured file size in the journal, legacy linked
entries fall back to database metadata, and the listing performs no filesystem
reads. Exact totals are nullable for old or directory deletions whose full size
was never recorded, keeping Empty Trash honest without blocking the rows.
The row keeps its bundle id under the trash operation: Put Back returns the
same file, metadata and order to the same bundle instead of restoring loose
bytes. Reordering the remaining visible members preserves hidden trash slots.

The **whole Bundle Inspector is also an import-and-link drop target** while
write mode is on. It shares the bundle card’s HTML file-drop behavior and the
shell’s one pending-drop path, so dropping in either place opens the same
destination picker in the bundle’s existing folder. The viewer-docked inspector
closes the viewer first, keeping the picker from opening under the overlay.

Actions that mean something different inside an open viewer are resolved
deliberately: Play steps within the playlist (falling back to the shell's
retarget when the file is not in it); Locate, Add files, Drop files, Filter by
tag and Open Collection close the viewer first, because each opens or navigates
the shell and doing that under an opaque overlay is what "nothing happened"
looks like; and flash routes to the viewer's own notice anchor, since the
shell's toast sits below the viewer's z-index. The rail element is gone —
the inspector is placed straight into the viewer's grid and takes
`--inspector-w`, so the two are the same width by construction. The viewer's
root context-menu handler also fired for right-clicks inside the rail, stacking
the playback menu on the one being asked for; it now defers to the rail.

The top bar was absolutely positioned against the whole viewer, so grid
placement did not move its Info, Bundle Inspector and Close buttons with the
media column: all three stayed over the open rail. Its right inset now follows
the same `--inspector-w`, preserving the ordinary 18 px edge inset on the media
side. A browser geometry regression fixes that boundary in place.

**Collection listings lagged their counts.** Filing a bundle in moved the count
at once and left the contents behind: the destination's _cached_ listing
rendered first, without the bundle, while the refetch was in flight. Only
previously-visited collections showed it, which is why it read as intermittent.
Measured here at ~60 ms against a local SQLite; on the owner's network-mounted
library that is the beat they described. The optimistic projection already
pruned the listings a bundle left, so the missing half — inserting into the ones
it joins — now runs off the same membership change, reusing
`countingCollectionIds` for the subtree rule. Filtered and searched listings are
skipped rather than guessed at.

**Collection covers had two independent faults.** The card latched a failed
cover image in `useState`, so the 404 answered before a thumbnail exists (or
while the collection is empty) pinned the folder glyph for the life of the
component. And membership changes never moved `updated_at`, which is the cover's
cache-busting key — so filing a bundle into an empty collection changed what its
auto cover _should_ be while the URL stayed identical and the browser served its
cached 404. Both sides of a move and their ancestors are now touched;
`invalidateCollectionCounts` refetches the collection rows as well as the counts.
The card's flex thumbnail could also collapse to the metadata footer's height,
leaving cover art as a shallow strip on a wide card. Its width is now explicit,
and flex shrinking is disabled; a browser geometry regression holds the 16:10
cover frame at the full card width.

**Bundle notes now start at one rendered text line.** Setting `rows={1}` alone
did not change the visible box because its CSS still imposed a 44 px minimum and
extra bottom padding for the resize grip. The minimum is now 34 px with ordinary
single-line padding; the existing `scrollHeight` fit still grows the box for
wrapped or multiline text. The browser test asserts the rendered height, not
only the textarea attribute. Multiple note boxes use a compact 4 px gap, also
held by rendered-geometry coverage.

**Collection pills in the Bundle Inspector navigate.** Each pill is two
independent controls: its name opens the collection, while × removes the bundle
from it. Opening clears the bundle selection and presents the collection's own
inspector; no membership write occurs. The action uses the shared inspector
context, and the docked player override closes the viewer before navigating so
the destination is not hidden behind it.

**Bundled-desktop cold start no longer strands its first content requests.**
`App` used to await authorization but fail open while the ownership query was
still pending. The workspace now mounts only after ownership settles; an
errored or malformed response still fails open to the server's authoritative
content-route gate.

That gate was necessary but did not fully fix the reported stall. A reproduced
`just bundled` start showed React StrictMode replay abort all eight initial
content requests, then WKWebView strand all eight immediate replacements before
they reached the network. Changing folders recovered only because it created a
new query key and a fresh request. The Tauri root now omits development replay,
while the browser root remains under StrictMode. A root-policy regression uses
a signal-consuming TanStack query to prove desktop starts it once without an
abort, plus a component-shape assertion that keeps StrictMode around web; the
existing unit and browser regressions keep proving that no content query starts
before ownership settles.

A later startup report exposed a separate boundary: `App` treated every
registered row as selectable even when the registry had already classified it
`unavailable`. It then issued ownership and authorization requests, mounted the
workspace after their errors failed open, and let the browser surface the
server's raw id-based availability error. Registry status now gates before all
three layers. A remembered offline choice falls back to a reachable sibling;
when every row is offline, a dedicated recovery card offers Retry and Manage
Libraries, polls every five seconds only while the app is visible and stranded,
and mounts the workspace in place if the registered root returns. It does not
search the filesystem for a moved root. Generated component and Chromium
fixtures cover fallback selection, zero pre-recovery library-scoped requests,
the checking/disabled state, and unavailable-to-available recovery without
navigation.

**Grouping review no longer waits for media probing.** The scan job already
generates and persists its grouping plan from paths and scan-classified media
kinds; ffprobe metadata was never an input. The combined Update mutation still
waited for the entire probe pass before delivering that existing plan to the UI.
Update now completes and opens review as soon as scan does, while metadata stays
visible and stoppable in the shared background-job area. Storyboards remain
ordered after a successful probe because their eligibility and sampling require
duration. A probe failure leaves grouping review usable, keeps the failed job row
as the report, and does not enqueue storyboards.

Follow-up verification: frontend lint, format, typecheck, 563 unit tests, and
production build pass. The new grouping/probe browser regression passes; the
full browser run is 106/107 because the unchanged HLS re-attach case also fails
when run from `origin/main`, so it remains outside this branch. Desktop
formatting, Clippy, 104 Rust tests, and the packaged app/DMG build pass. No
backend source or API changed in the recovery or grouping follow-up, so its gate
was not rerun. A cold `just bundled` trace for the root policy fix left the
window untouched and showed zero WebKit request aborts while the first request
set completed.

**A video's cover frame is the video's.** `set_cover_frame` also wrote
`bundle.cover_file_id`, so picking a frame silently reassigned what represented
the bundle. It now touches that file only; the bundle is touched solely when the
file already _is_ the cover, where its picture genuinely changed. That left
`AssetFile.cover_previous_file_id` — which existed only to undo the promotion —
with nothing to do, so it is removed along with its repair-time rewrite.

Gates run: `npm run lint`, `typecheck`, `format:check`, `test` (542 pass) and
`build` in `apps/web`; `ruff check`, `ruff format`, `mypy`, `pytest` (926 pass)
in `apps/server`. Browser e2e: 99 pass; the only excluded case is the recorded
pre-existing `transparently re-attaches a fresh session when HLS segments fail`,
which still fails on clean `main` and is outside this branch. The collection
cover geometry regression is included in that pass. The new write-gated trash
and inspector-drop paths also passed their focused Chromium tests. Verified by hand
in a browser against a synthetic fixture library (six generated clips, invented
names): inspector width 300 px matching `--inspector-w` with the shell's border,
background and padding; a tag created and applied from inside the player; a
single context menu on a file row; a collection created empty gaining its cover
the moment a bundle was filed in, cache key stamped at the drop; and a
previously-visited collection showing the right contents on the first frame
where it had shown the stale listing. The topbar follow-up was also checked in
the live app: the three controls ended 18 px before the 300 px rail.

Not done, and deliberately: no "Set as Bundle Cover" entry was added to the
viewer's own menu — the inspector's file list already carries that affordance
and it is now docked in the viewer, so the step is reachable. No resizer was
added inside the viewer either; the widths are shared, but changing one is done
from the shell. Playwright was not run for this branch (the checks above were
made against a live app instead).

## Merged: collection counts refresh late, or never (2026-07-30)

Branch `fix/collection-count-refresh`, rebased onto `main` at `851e7c1` (the
storyboard keyframe-sampling merge); commits `9d028ff` and `75a44a8`, **merged
as PR #4** (`8eac71c`). The section above continues this work: the counts moved
with the drop, and the listings under them did not.
Owner-reported: dragging a bundle from one collection to another
does not immediately update the count in the sidebar; after related work landed,
"visibly faster … but still not instant".

**The server was never the problem.** Measured against a live library either
side of a real drag, the subtree arithmetic and the membership were both right
and the response was prompt. What was slow was the client waiting for it:
`useBatchUpdate` invalidated `['collection-counts']` in `onSettled`, so the
numbers only moved after a round trip — which on a library whose SQLite lives on
an SMB share is a beat you can see.

**Why it had been left that way, and why that reasoning did not survive.** The
mutation deliberately skipped optimistic count math: the server counts a
collection's _subtree_, so filing a bundle into a subcollection of the one being
viewed must leave that collection's number unchanged, and a flat ±1 would be
wrong for exactly the commonest gesture. True — but it does not follow that
nothing can be computed. The client already holds the collection tree, so the
real deltas are: the collections counting a bundle are each of its memberships
plus every ancestor; diff that set before against after. A parent↔child move
leaves the shared ancestors in both sets and they do not move, with no special
case. `apps/web/src/api/counts.ts` holds the arithmetic as pure functions;
`hooks.ts` reads and writes the caches.

The arithmetic needs each moved bundle's _whole_ membership (a bundle can be in
several collections), so when any of it is uncached the counts are left to the
server rather than guessed partway — and dragging an **unselected** card, the one
gesture whose bundle no inspector has loaded, now warms that cache on
`dragstart`, capped at 50 bundles.

**Two counts that were not late but simply wrong** turned up while checking
everything else that moves a count:

- **A collection reparent never refreshed the counts at all.** Every nesting
  drag in the sidebar — the "into" drop _and_ a gap drop into another parent's
  group — goes through `useReorderCollections`, which by design invalidates
  nothing (a reorder must not re-answer its own question). But it also reparents,
  which changes what every collection above it on both sides counts. It now
  refetches the counts when a moved collection's parent actually changed, and
  still nothing when the drag only reordered. Exact deltas are not computable
  client-side: an ancestor counts _distinct_ bundles across its subtree, and the
  client holds no membership for the bundles inside the collection being moved.
- **`['collection-stats']` — the collection inspector's three figures — was
  invalidated by nothing in the entire app.** Filing a bundle into that
  collection, deleting a bundle, adding a subcollection, a scan, a grouping
  apply: none of them touched it, so the pane showed whatever it had said when it
  opened. The sidebar count and the inspector figures are the same fact at two
  altitudes and now refresh through one helper; a membership change moves both
  optimistically (subtree total takes the ancestor arithmetic, "bundles here" a
  plain ±1).

**Also made optimistic, since they are the same mechanism:** the collection
picker (`useSetBundleCollections`), the tag picker (`useSetBundleTags` — tag
counts are direct membership, so ±1), and the Uncategorized/Untagged system
views, which move when a bundle gains its first membership or loses its last.
Everything rolls back on error and is still reconciled by the existing
invalidation.

**Tests.** `apps/web/src/api/counts.test.ts` covers the arithmetic on a fixture
tree: sibling→sibling, parent→own child and back, already-a-member, a second
membership under a shared ancestor, multi-select, copy-not-move, the
Uncategorized edges, and the no-negative clamp.
`apps/web/src/api/hooks.counts.test.tsx` covers the cache behaviour: counts have
moved _while the write is still in flight_, an unknown membership moves nothing,
a rejected write puts every number back, the inspector's subtree and direct
figures move apart, and a reparenting reorder refetches while a plain reorder
does not. Full web gate green (lint, format, typecheck, 515 tests, build).

**Verified in the browser**, on the containerized dev stack against a seeded
scratch library with the batch write artificially delayed 4 s, so the optimistic
state is observable on its own: a drag into a subcollection moved the child, its
parent and Uncategorized 120 ms after the drop with the request still in flight,
and the settled state agreed; a parent→child move left the parent's number
alone; a child→parent move took the inspector from 2/2 to 1/1 mid-flight; and
nesting a 2-bundle collection under an empty one took the empty one to 2 without
a reload.

**Not done:** the paste-tags flow in `App.tsx` still updates its aggregate counts
on the round trip (it already writes the pills optimistically and fetches
memberships it lacks); no e2e test was added, the drag being covered at the hook
layer instead.

## Merged: storyboard generation was decoding everything (2026-07-30)

Branch `perf/storyboard-keyframe-sampling`, rebased onto `main` at `b97925f`
(the job-progress merge plus changelog-driven release notes). Owner question:
why does generating storyboards take so long over a library on an SMB share?

**The answer was in the filter, not in Cairndex's job logic.** Sampling used
`fps=1/n`, which gives ffmpeg no reason to seek, so every storyboard cost a
linear decode of the whole video — and on a network mount, a full read of it
too. Skipping already-generated storyboards was checked separately and works
(a completed run reported `generated: 0, skipped: 6`); the run grew because the
library grew, not because work repeated.

**Sampling now decodes keyframes only** (`-skip_frame nokey` plus a `select`
that keeps the first keyframe and then the next one at least an interval later).
Measured with the new `cairndex.devtools.benchmark_storyboards` on 5-minute 720p
fixtures of stated GOP length: **2.9×** faster on H.264 keyed every 2s
(producing the identical 150 tiles), **6.2×** keyed every 10s, **13.4×** on
HEVC. Local SSD, so that is decode only — the network read a real library adds
sits on top, and is the half that keyframe sampling also stops paying twice.

**Seek-per-cue was measured and rejected**, which is worth recording because
`contact_sheets.py` does exactly that and documents why. On a 10-minute 1080p
fixture: 4.1 s full decode, 12.0 s seeking accurately to each cue, 15.1 s
seeking to the nearest keyframe, 0.7 s for the keyframe pass. Seeking pays off
only when samples sit much further apart than keyframes — true of a contact
sheet (16–60 frames across a film), false of a storyboard (a cue every 2–30 s),
where consecutive seeks keep re-reading the same group.

**The trade, taken deliberately.** Tiles land on the keyframe at or before each
sample point, so scrubbing is only as fine as the source's GOP — a video keyed
every 10s gets a tile every 10s where it had one every 2s. Rather than let a cue
claim a time it never sampled, each cue now carries the timestamp of the frame
it holds and runs to the next sampled frame; the hover path already seeks to a
cue's own timestamp, so it lands exactly on the frame it displayed. A
single-keyframe encode still gets one full decode instead of a one-tile
storyboard, and `CAIRNDEX_STORYBOARD_SAMPLING=exact` restores full-decode
sampling per deployment. Format v3 **and** the sampling mode are in the cache
key, so old sheets are retired deliberately rather than left at a different
quality: existing libraries need one Update/storyboards run.

**One real bug the benchmark caught**, and the reason to have written it:
sampling at irregular intervals made the image muxer duplicate sheets to reach a
constant frame rate — 300 files for 30 tiles — which would have pointed every
cue past the first sheet at a copy of it. The pass now pins the sync mode, and a
test fails if a run writes more sheets than its tiles fill.

**Tests run:** `uv run ruff check`, `ruff format --check`, `mypy src packaging`,
`pytest` (902 passed). Storyboard coverage now includes keyframe cue times on a
sparse-GOP fixture, the sheet-count assertion, the single-keyframe fallback, the
`exact` setting, mode-switch cache invalidation, and unusable-sample truncation;
fixtures state their GOP explicitly, since keyframe sampling can only sample
where keyframes are. Verified beyond unit tests by building a throwaway library
of three ffmpeg-generated clips (dense GOP, 10s GOP, single keyframe) in a
scratch data dir and running the real scan → probe → storyboard path: 3
generated, a rerun skipping all 3, and every VTT checked for ascending cues,
one cue per tile, sheets that exist, and full timeline coverage.

**What a run over a network-mounted library then showed, and it matters more
than the fixture numbers.** The owner ran the regeneration the format bump
forces, over a share, and reported it still felt slow. It was: the pass now
moves bytes at the share's own read throughput — the job's effective rate
matched a direct read of the same share, measured while the two competed — so
**decode has left the critical path entirely and the wall clock is now the
transfer**. `-skip_frame nokey` stops ffmpeg _decoding_ every frame; it does not
stop the demuxer _reading_ every byte. On a local disk that read is free and the
fixture speedups are what you see; on a share it is the whole cost, and no
decode saving can go below it.

That reframes the fixture benchmark rather than contradicting it, and it is the
regime the seek-per-cue rejection above was _not_ measured in: those numbers
came from a local SSD, where re-reading a group costs nothing but decode.

**Next lever, not taken here:** read less, using the container's own keyframe
table. `media/mp4_index.py` already reads MP4 `stss` from the header, so
keyframe timestamps are knowable without a full pass, and seeking to exactly
those (one `xstack` batch per sheet, the shape prototyped and rejected for local
libraries) would move a fraction of the bytes on sources whose GOP is long
relative to the sampling interval. It also makes cue times exact by
construction, with no `showinfo` parsing. Unknown until measured: per-seek
latency over SMB at a few hundred seeks per file. Non-MP4 sources and MP4s
without a keyframe table would keep today's pass.

**Also queued, from testing this:** job control. Cancellation exists end to end
in the backend (`POST /jobs/{id}/cancel` → `checkpoint()` → `CANCELLED`) but
**nothing in the UI calls it**, so no job can be stopped from the app. In the
same area: a job whose worker dies with the server stays `RUNNING` forever —
nothing reconciles those rows at startup, they cannot be cancelled since nothing
is alive to see the flag, and they do not suppress a duplicate either, because
dedupe matches only `QUEUED`; a queued job renders with a moving bar
indistinguishable from a running one; and a killed pass leaves its `.tmp-`
directory in the storyboard cache with nothing to sweep it. One branch.

## In progress: library journal-mode lifecycle (2026-07-30)

Branch `fix/library-journal-mode-portability`, rebased onto `main` at `7276a53`.
Owner-reported production incident, fully diagnosed before implementation began:
a library became unopenable from the owner's Mac after the NAS container served
it, surfacing as HTTP 500 from `/bundles/browse` with a traceback ending at
`PRAGMA journal_mode=WAL`.

**The premise that was wrong.** `_apply_sqlite_pragmas` set four pragmas on
every connection, its docstring saying "these are per-connection in SQLite".
True of three of them; `journal_mode` is recorded in the database _file header_
and is a property of the file. So the hook was rewriting every library on every
connect — and a WAL database cannot be opened over SMB or NFS at all, not even
read-only, because WAL needs a `-shm` index that every connection memory-maps.
Setting the pragma from a machine on the share had always failed _silently_
(SQLite keeps the mode and returns it, no error), which is why nothing looked
wrong for months; the first server with local access flipped the file for good.

**What was built** (ADR-0021, owner-ratified): WAL while a server holds the
library open, converted back to a rollback journal on clean close, so a library
at rest is one portable file. The registry keeps WAL unconditionally — it never
leaves the server's disk. A filesystem that cannot host WAL never gets it, and
the pragma's return value is now read back rather than assumed. A library found
in WAL where it should not be is healed on open. An open failure is diagnosed
from outside SQLite (header bytes + filesystem kind) and raised as
`LibraryDatabaseOpenError` → 409 `library_database_unopenable`, distinguishing a
journal-mode problem from a permissions one and carrying the recovery command.

**The residual risk is real and was chosen knowingly.** An unclean stop —
`docker kill`, power loss, OOM — never reaches the conversion and leaves the
library in WAL. The owner was shown this and took it for WAL's performance while
a library is in use, so the design minimises and explains it (the legible 409,
the heal-on-open, the runbook) rather than pretending it away.

**A second, real bug was found only by deploying this, not by the test suite**:
creating a library was its own instance of the exact incident this branch
fixes. `POST /libraries/create` bootstraps `library.db` through a one-shot
engine (`create_package` → `_init_library_db`) that used to dispose itself
directly rather than through the per-library cache in `library_engine.py` —
so a library nobody had opened yet was never in the cache that
`close_library_engines()` reverts on shutdown. Deployed via
`docker-compose.prod.yml` on this Mac: created a library, ran nothing else,
`docker compose stop`, and the header byte still read WAL despite a shutdown
log with nothing but an orderly `Application shutdown complete` in it — no
lease conflict, no exception, no hint anything was wrong. Fixed with a shared
`persistence.engine.library_engine_scope` context manager that checkpoints and
reverts on exit regardless of the cache; every one-shot library-engine open in
the codebase (creation, and the three `devtools` maintenance scripts) now goes
through it. Two new tests reproduce this exactly — one bypasses
`get_library_sessionmaker` entirely (every other test in the file calls it,
which is what hid the bug from 29 passing tests), the other drives the real
`POST /libraries/create` endpoint and a clean-shutdown call with nothing in
between — and both were confirmed to fail against the pre-fix code before the
fix was restored. Then reconfirmed against a real rebuilt image: `201
Created`, header byte `1` immediately after create, `1` again after
`docker compose stop`.

**Tests run** (all from `apps/server`): `ruff check`, `ruff format --check`,
`mypy src packaging`, `pytest` — **959 passed**, 31 of them in
`tests/test_journal_mode.py`. Assertions are on the file header bytes wherever
the claim is about the file, because a `PRAGMA journal_mode` answer would pass
just as happily against a mode nobody achieved — which is the shape of both
bugs this branch found.

**Verified beyond the suite**, not just built:

- a real `create_app()` lifespan against a real library package: WAL while
  serving, `rollback` after shutdown, registry still WAL, no `-wal`/`-shm` left;
- `just docker-smoke` (Docker 29.5.3, arm64) — the production image now asserts
  the header byte after `docker stop`, not only the absence of a `-wal` file.
  Confirmed the new assertion has teeth by running it against a deliberately-WAL
  file, where it exits 1;
- a full `docker-compose.prod.yml` deploy against a scratch library on this
  Mac (not just the smoke image) — the round trip that surfaced the
  library-creation bug above, and that confirmed its fix.

Linux mount-table parsing (`/proc/self/mountinfo`) is unit-tested from a
synthetic table, including the nearest-enclosing-mount rule and `mountinfo`'s
octal-escaped spaces. macOS `statfs`/`MNT_LOCAL` was checked against a **real
SMB mount**, not only the monkeypatched seam the suite uses: the share reports
`smbfs`, `local=False`, WAL refused, while the local disk reports `apfs`,
`local=True`, WAL allowed. That is the exact discrimination the incident turned
on, so it was worth confirming on real hardware rather than a fixture. An
unidentifiable filesystem deliberately still attempts WAL and settles the
question by reading back what SQLite did.

**Not done / next:** nothing outstanding on this branch. No PR opened — that is
owner-triggered. Rebased twice as `main` moved: first onto `b97925f`
(`fix/job-progress` and `feat/release-notes-from-changelog` merging), then onto
`7276a53` (PR #6, inspector/collection/file-workflow polish, merging). Each
rebase's only real overlap was the shared `Unreleased` changelog section; the
full gate was re-run clean after both.

## In progress: Docker dev and deployment (2026-07-28)

Branch `chore/docker-dev-and-deploy`, rebased onto `main` at `9c3a607`
(2026-07-30; it was written before the repository was recreated, so its original
base SHA no longer exists). Owner-requested:
make Docker the real path for regular use (a Linux NAS) while staying usable on
an Apple Silicon Mac for testing, and make iterating inside it fast enough to be
a genuine second option beside the native `just dev` loop.

**What was actually wrong, measured rather than assumed.** The Docker files were
last touched 2026-06-25/30 and predate write mode, HLS, device pairing, and the
ownership lease. The production image turned out to be in **better** shape than
its age suggested — built, started, served the SPA, created a library on a
mounted volume, scanned, and generated a cover, all under a read-only root
filesystem as the non-root user, and released its lease cleanly on `docker stop`
(~0.5 s). The **dev stack** was the broken half:

- **No ffmpeg.** `python:3.12-slim` ships none and the Dockerfile installed
  none, so the container started and then failed at the first scan — which is
  the first thing anyone does. This was the difference between "stale" and
  "unusable".
- **No library mount**, so there was nothing to point the app at at all.
- **No data volume**, so `registry.db` — and every registered library — was lost
  on each rebuild.
- **`--reload` watched the whole bind-mount**, `.venv` and `var/` included.

And one thing that was misleading rather than broken: the production entrypoint
ran `alembic upgrade head` against an empty `alembic/versions/`. It exits 0 and
does nothing — the real mechanism is `create_all` plus additive patching on open
— but it printed a line claiming migrations had been applied, which is exactly
the sort of thing an operator would later build a procedure around.

**Why CI never caught any of it:** the Docker job only ran `docker compose build`
and `docker build`. Both passed throughout. `infra/docker/smoke.sh` now starts
the production image and exercises the parts that actually rot — startup under
the read-only rootfs, the non-root user writing its volumes, ffprobe/ffmpeg in a
real scan (asserted via `has_cover`, which is what distinguishes a working media
pipeline from a working web layer), and a graceful shutdown releasing the lease
and folding the WAL back in. It runs in CI and as `just docker-smoke`.

**The dev library needed its own seeder.** The obvious candidate,
`devtools.synthetic_library`, writes database rows for files that never touch
disk — correct for benchmarking query plans at 100k bundles, useless as
something to develop against, since every file reads as missing and no
thumbnail or playback path runs. Confirmed by seeding one and finding an empty
directory beside a populated `library.db`. `infra/docker/dev-library.sh`
generates fourteen real files instead (2-second clips, JPEG covers, subtitles,
arranged into a multi-part film, an episodic set, and loose media), using
ffmpeg from a container so no local ffmpeg is needed.

**One collision worth recording**, because it is not obvious and it bit during
this work: one `.env` now serves both stacks, and the first draft had the dev
compose read `CAIRNDEX_MACHINE_NAME`. The production stack sets that key, so the
dev container introduced itself to the lease as `nas`. The dev stack reads
`CAIRNDEX_DEV_*` keys throughout for exactly this reason. The related hazard —
the dev container and the native `just dev` server sharing `apps/server/var` and
therefore contending for the same libraries' leases — is why the dev stack has
its own data volume.

**Verified on this machine** (Docker 29.5.3, arm64), not just built:

- production image: builds, serves, scans, releases its lease — `just docker-smoke`;
- entrypoint preflight: exits 1 with a legible message on an unwritable
  `/data` (checked via a read-only mount, since macOS bind mounts remap
  ownership and a permissions-based test passes spuriously there), warns and
  continues on a read-only library mount;
- dev stack: ffmpeg present, library created on the host mount, scan produced a
  bundle with a cover, backend restarted on a source edit, and Vite reported
  `hmr update /src/index.css` — with the app rendering correctly in a browser
  against the containerized backend.

**And what verifying on a Mac could not tell us** (2026-07-30, first CI run on
Linux). The smoke test failed on `ubuntu-latest` at its last assertion, reading
the ownership lease from the host after the container stopped:
`PermissionError: … /.cairndex/locks/active-owner.json`. The image was fine —
_the test_ was macOS-shaped. A Linux bind mount preserves real uids, so
everything the container writes into the library is owned on the host by its uid
10001, and the lease is mode `0600`; Docker Desktop remaps ownership to the
invoking user, so the host-side reads passed locally and the cleanup `rm -rf`
worked. This is the same trap already recorded two bullets up for the entrypoint
preflight, applied to the harness rather than the thing under test — knowing
about it in one place did not make the other obvious. The post-stop checks and
the cleanup now go through a root container, so they mean the same thing on both
platforms, and `docs/deployment.md` states the ownership consequence, which
affects host-side backups on a NAS.

**CI is green on the whole matrix** (2026-07-30, dispatched by hand
— note that `ci.yml` runs on push only for `main`, so a branch push starts
nothing). The Docker job reaches `SMOKE OK` on `ubuntu-latest`, which is the
deployment's own architecture and OS: the image starts under the read-only root
filesystem as its non-root user, serves the SPA, has ffmpeg and ffprobe, creates
a library on a bind mount, scans a video into a bundle with a cover, and releases
its lease on a graceful stop with the WAL checkpointed. That is the closest thing
to the NAS obtainable without one.

**Registry publishing, added on owner request (2026-07-30).** The original branch
assumed the server would build from a checkout. The owner asked instead for the
path other self-hosted projects use — publish an image, ship a compose file —
so `.github/workflows/publish-image.yml` pushes `ghcr.io/allpan3/cairndex` and
`deploy/` holds what a NAS actually needs (compose file, env sample, runbook).
Three decisions worth keeping:

- **Publication is never automatic from `main`** — a version tag or a manual
  dispatch, mirroring `release.yml`'s draft release. A registry has no draft
  state, so the trigger is where that judgement has to live.
- **The image is smoke-tested before the push, not after.** Built to the
  runner's daemon, run through `smoke.sh`, then pushed with the layer cache
  reused. Test-after would leave a broken image pullable in the gap with
  `:latest` already moved — and this branch exists because a build-only gate
  stayed green for a month.
- **amd64 only.** arm64 would be an emulated build of the whole Node + Python
  stack every release, serving nobody, and it could not go through the smoke
  gate anyway (`load: true` takes one platform), so it would publish untested.

**Not done, deliberately.** The amd64 cross-build (`just docker-build-nas`) is
written and documented but **has not been run against a real NAS** — there is no
amd64 host here to load the image onto, and an emulated build proving it
compiles is not the same as proving it runs. It also matters less now that the
NAS pulls a published image rather than building one. That, plus the deployment
itself, is what this branch leaves to the owner.

**Mount naming, settled on owner challenge (2026-07-30).** The owner, mid-setup
on the NAS, pushed back on `/storage/media`: the mount can hold several
libraries, so "media" names the wrong thing. They proposed `/mount`; that names
the mechanism rather than the contents, and everything in a container arrives by
mounting. It is `/libraries` now, with one mount per share beneath it, and
`CAIRNDEX_LIBRARY_PATH` on the host side. The codebase had already settled the
vocabulary — the entrypoint has called it `CAIRNDEX_LIBRARY_MOUNT` all along —
so only the path string disagreed.

The reason mounts are _children_ of `/libraries` rather than the root itself is
worth keeping: the registry records each library under the path the container
saw at registration, so re-pathing a mount orphans everything inside it. A
deployment that starts with one share must be able to gain a second without
moving the first. The entrypoint's preflight had to change with it — testing the
root would warn on every start, since the root is an image directory and the
container filesystem is read-only. It now warns when nothing is mounted (the
first-run mistake) and checks each mount separately; all four branches were
exercised directly.

Cheap to do only because nothing was deployed yet: `/storage/media` appeared in
no server or web code, purely in compose files, the smoke test, the entrypoint
default and docs.

That "nothing was deployed" was not quite true, and the owner found the hole by
opening the dev stack: its registry lives in a volume that survives rebuilds, so
it still held a library at `/storage/media` and the app reported it unavailable.
The reasoning about re-pathing was written into the docs for other people's
deployments in the same commit that broke a running one here — the failure was
applying it outward and not to the machine in front of me. Recovery is what the
docs already said: the library package is path-independent, so deregistering the
orphan and registering the new path restored it whole. CHANGELOG now carries the
upgrade note. ADR-0005 mentions the old path once and was deliberately left alone —
it records what was decided then.

**Verified at the branch tip** (2026-07-30): CI green on all seven
jobs, dispatched by hand. The Docker job reaches `SMOKE OK` including the new
`runs as an arbitrary uid` step, so the image is proven to start under a foreign
uid with a bind-mounted `/data` and write a package its invoker can read. The
containerized dev stack was run end to end on the Mac after the rename —
registered the library at `/libraries/main`, scanned it into bundles with
covers (so ffmpeg and ffprobe work in the dev image), confirmed the backend
reloads on a source edit, and stopped with `down` so the lease was released.

**And it is deployed.** The owner has the production image running on their NAS
under a `user:` override with a bind-mounted `/data` — which demonstrated the
arbitrary-uid path in real use before CI had a test for it. Scan, probe and
storyboard jobs all ran against a real library.

**Untested here: the publish workflow.** It parses and its actions are pinned,
but it has never run — dispatching it publishes a real package under the owner's
account, and the first push creates a **private** package that needs its
visibility changed by hand before a server can pull without credentials.

## Merged: half-star ratings (2026-07-30)

**Owner test, 2026-07-30 — a half star could not be set in the desktop shell.**
Clicking a star did nothing at all. `setPointerCapture` retargets _every_ later
event of the gesture to the capturing element, the click included, so taking it on
`pointerdown` meant the half button's own `onClick` could never fire — picking had
to be reconstructed from the release and the click swallowed to stop it
double-firing. Chromium happens to make that work; the shell did not.

Capture is now taken on the first move that changes value, the moment the gesture
is a sweep and the only thing that needs it. A press-and-release never captures, so
its click reaches the button, and a `<button>` click is the portable path. A second
defect surfaced while measuring: `suppressClick` could be left set (a sweep
released outside the row dispatches no trailing click to consume it) and then
silently swallowed the next pick for good; it is cleared when a fresh gesture
starts.

Verified with a real mouse against the server rather than the optimistic UI — a
click on "3½ stars" stores 3.5, a sweep from "1 star" to "4½ stars" stores 4.5.
**Not verified on WebKit**, which cannot be driven from here; the fix removes the
dependency on capture semantics rather than patching a quirk, which is the reason
to expect it to hold there.

Branch `feat/half-star-ratings`, off `main` at `708d788`. Owner-requested:
ratings go to half-star granularity.

**The design decision worth recording.** A rating is stored as a **number of
stars** (`3.5`), not a count of half-star units (`7`). The obvious alternative —
rescaling the column to 0–10 — would have required rewriting stored values _and_
every rating literal inside saved Smart Collections' `filter_json`, plus
rebuilding `asset_bundles` to widen its `CHECK (rating >= 0 AND rating <= 5)`,
because SQLite cannot alter a constraint in place and there is no migration
chain here (library DBs are bootstrapped by `create_all` and patched additively
on open). Storing stars needs none of that: the range CHECK still holds, whole
stars keep their meaning, saved filters keep theirs, and libraries move freely
between this version and the previous one in both directions.

It works because SQLite is dynamically typed: on a pre-half-star library the
column is declared `INTEGER`, and INTEGER affinity narrows a REAL only when the
conversion is lossless — so `3.5` stores as REAL, `4.0` as INTEGER `4`, and the
two storage classes compare, sort, and group numerically. Half steps are exact
in binary floating point, so equality never misses. `tests/test_rating_scale.py`
pins this against the _old_ DDL rather than the current model, since the current
model is not what an existing library has.

Two consequences that needed handling rather than assuming:

- **Facet keys are formatted, not stringified** (`domain.rating.rating_facet_key`),
  because the same column returns an int for `4` and a float for `3.5`. Whole
  stars keep the `"4"` key clients already used.
- **The step is enforced above the database** (bundle service + write schemas),
  since an existing CHECK covers only the range. `3.3` is a 422.

**UI.** One half-star primitive in `Stars.tsx` serves all four surfaces; the
inspector's editor moved there from `Inspector.tsx` so the geometry exists once.
A star is a muted ★ with a gold ★ clipped over it to 0/50/100% — the same glyph
in both layers, so the clip lands on the true midpoint in any font, which an
outline-☆ base would not guarantee. Two transparent half-width buttons per star,
exposed as ten radios (`½ stars` … `5 stars`). The filter popover's per-star
count now follows the hovered half, so it always answers "how many would
clicking here match?" — with nothing hovered it shows the whole-star count, which
is what it showed before.

**Usability round (owner feedback, 2026-07-29).** "Does not seem to work" was
most likely a stale build — this branch is unmerged, so a dev server or desktop
app running `main` still shows whole stars; re-verified here with _coordinate_
clicks against a real backend (left half of star 4 → PATCH stored `3.5`).
Reworked regardless: glyphs enlarged (20→26px popover, 17→22px inspector) with
tighter spacing; **drag-to-rate** (press anywhere on the row, sweep, commit on
release — pointer capture keeps the sweep alive outside the row, and the
synthetic click after a gesture is swallowed so a drag ending on a half button
does not double-fire or toggle-clear); and a reserved-width text hint names the
hovered/swept value ("3½ stars"). A sweep ending on the current value writes
nothing; only a click on the current value clears. Verified in-browser: click →
3.5, drag star 1→4½ → 4.5 stored, hint visible while hovering.

**Gates run:** backend `ruff format --check`, `ruff check`, `mypy`, `pytest`
(867 passed); web `lint`, `format:check`, `typecheck`, `test` (472 passed),
`build`; rating e2e specs (16 passed). Verified visually in a real browser at 4×
scale: the half fill and the hover-swapped facet count both behave.

**One pre-existing failure, not from this branch.** The e2e test
`transparently re-attaches a fresh session when HLS segments fail`
(`e2e/player.spec.ts:2230`) fails on `main` too — confirmed against a clean
worktree at `7b4bded`, in isolation as well as in the full suite, so it is
neither flake nor cross-test interference. Only the initial playback decision is
recorded where the test expects a re-attach. Untouched here; it belongs to the
ADR-0014 HLS session path.

## Merged: grouping review round trips (2026-07-30)

Branch `perf/grouping-plan-round-trips`, off `main` at `d913a62`, merged
fast-forward. Owner report:
pressing the bundle/collection conversion on one folder froze the panel for 30
seconds. **Not reproduced at that magnitude** — see the honesty note below — but
profiling found four query patterns that scale with plan size, and removing them
made the operation 13× faster at 3,000 files.

Measured through the HTTP API on a generated library of 3,030 files in ten folders
(3,041 proposals):

| Operation                   | Before                            | After               |
| --------------------------- | --------------------------------- | ------------------- |
| `GET /plans` (dialog opens) | read every proposal of every plan | **3 ms**            |
| `GET /plans/{id}`           | —                                 | **63 ms** (0.97 MB) |
| Convert bundle → collection | 0.70 s                            | **0.06 s**          |
| Convert collection → bundle | ~1.0 s                            | **0.47 s**          |

Four causes, all the same shape — work proportional to the plan, one round trip at
a time:

1. `get_plan` returned the ORM object and let serialization walk
   `proposal.files` lazily: **one query per suggestion**. Now one `selectinload`
   chain, three queries at any size.
2. `_summary` called `len(plan.proposals)`, lazily loading every proposal of every
   plan to produce a handful of integers. Now one grouped `COUNT`.
3. `_proposal_observations` did `session.get(AssetFile, …)` per file — 300 round
   trips for a folder of 300 images. Now one `IN` query.
4. `_container_to_bundle` called that helper once _per descendant_, and both
   conversion directions scanned the group linearly per file to find a path
   (quadratic in group size). Now one resolve for all descendants, and a dict.

The regression guard asserts **round trips, not seconds**: a plan read must stay
under 8 queries for 12+ proposals, and the plans list under 4. It was confirmed to
fail with the eager loads reverted (14 queries for 12 proposals). A timing
assertion would be flaky and would not describe the defect; the query count is
exactly what scales.

**Honesty note on the numbers.** An earlier pass reported 9–14 s for trivial
interactions. That was a measurement error: the clock was read in a separate
browser call from the click, so the tool round trip was counted as app time.
Measured inside one call, ticking a checkbox on a 2,738-row panel is 90 ms and a
conversion was ~1.0 s end to end (0.8 s of it server-side). Client-side rendering
was never the problem, and StrictMode/dev-mode was not either — the production
bundle measured the same.

**So the 30 s is still unexplained** by anything reproducible here. The remaining
candidate is scale on network storage: the owner's real library is a NAS mount
(`/Volumes/media`), and [plan 5](plans/05-network-library-latency.md) already
records ~500 ms for a NAS-mounted inspector read. At that per-round-trip cost the
_thousands_ of round trips removed above are exactly the shape of a 30-second
stall. `apps/web/vite.config.ts` gained a `preview` proxy so the production bundle
can be measured against a local backend without packaging the desktop app, which
is how the dev-versus-production question got settled.

**Gates:** backend `ruff format --check`, `ruff check`, `mypy src packaging`,
`pytest` (867 passed, +1); web `lint`, `format:check`, `typecheck`, `test` (476
passed), `build`; `just api` regenerated (one docstring line). No client behaviour
changed, so the browser e2e suite is unaffected.

**Still to do if this is not enough:** the collapse direction is 0.47 s at 3,000
files because it issues one ORM `DELETE` per descendant. Bulk-deleting would need
care with the `delete-orphan` cascade, so it is left until there is evidence it
matters.

## Merged: drop destination, rename and toasts (2026-07-30)

Branch `fix/drop-destination-rename-and-toasts`, off `main` at `3743931`, merged
fast-forward (no PR; the repository was recreated the same day, so it has none). Five
owner-reported faults, found by using the app after PR #40 landed. Two are
behaviour bugs with a data or filesystem edge, three are interaction faults; one
latent bug turned up while tracing another.

**1. A renamed file kept its old name inside its bundle.** Reported as "renamed
in file browser, but going back to bundle browser the file name is still old",
then reported **still wrong** after the first fix, naming a specific
`SET-0251.webp`. The second report was right, and the first fix was incomplete:
`display_title` — the field every bundle surface renders (`Inspector`,
`BundleAlbum`, the viewer's file list) — is left behind by **three** different
paths that repoint a row, and only one had been fixed.

| Path                                      | When it runs                                        | First fix |
| ----------------------------------------- | --------------------------------------------------- | --------- |
| `file_ops.operations.repoint_linked_rows` | a rename or move Cairndex performs                  | covered   |
| `scanning.scanner` move-repair pass       | a rename made **outside** Cairndex, found by a scan | missed    |
| `scanning.repair.repair_file`             | a missing file the owner repairs by hand            | missed    |

The rule now lives once, in `domain.file_names.display_title_after_move`, and all
three call it: the shown name follows the file **only while it still is the old
basename**, since it is owner-editable via `PATCH …/files/{file_id}` and a chosen
title is not the filename's to overwrite. `original_filename` never moves in the
first path — it records the name at import — though the scanner's repair pass has
always updated it, which is left as it was.

Lesson worth keeping: the first fix was made at the one call site the reported
symptom pointed at, without asking what _else_ writes that column. `grep` for
every writer of the field, not for the path in the report.

**Then the owner reported it a third time, with screenshots** — one file, 442 KB,
showing as `dist_44921set07pl.webp` in the bundle rail and `SET-025.webp` in the
File Browser. Two things were true at once: the fixes were on an unmerged branch
they were not running, _and_ a scan-time heal added in round two deliberately
skipped their case. Once the scanner's repair path has left a title behind,
`original_filename` is already the new name, which makes the row
indistinguishable from a deliberately chosen title — so no heuristic can safely
correct it.

**So the shown name is now derived, not stored.** `FileRead` computes it from
`relative_path` (beside the existing `derive_supported` validator), and the
playback manifest does the same. That removes the class of bug rather than fixing
it once per writer: no path can leave the name behind, rows that are already
stale read correctly with no scan or repair step, and nothing has to guess which
stored titles are leftovers. The heal was deleted — it rewrote data on a guess and
now earns nothing.

The column stays, and the three repoint paths still keep it in step, because the
FTS index reads it (`search/index.py` indexes
`display_title || original_filename || relative_path`) — a stale copy there is
harmless and even helps, since it finds a file by the name it used to have.
Nothing renders it. A real "call this file something else" feature would add its
own nullable override and be preferred in the same validator; that is the
distinction the current column cannot make, since it cannot tell a chosen title
from a filename it happens to equal.

Verified live on the exact un-healable shape: a row whose stored name was
`dist_44921set07pl.webp` while `original_filename` had already moved on served its
real filename through the running server. An API-level test pins it by leaving a
row deliberately stale and asserting the listing still reads correctly; it fails
with the validator removed.

**2. A drop onto a bundle landed in the library root.** `dropFilesOnBundle`
passed `destDir: ''`, so the copy was linked into the bundle correctly but filed
nowhere near the bundle's own files. It now asks: `DirectoryPicker` gained
`startIn`, `heading` and `confirmLabel`, and a new `BundleDropDestination` opens
it in the folder the bundle's first file lives in. It renders only once the
bundle's files are known, so the picker never opens at the root and then jumps.

**3. Double-clicking an image did not close the viewer.** The mechanism was not
what the code read like. `ImageStage` calls `setPointerCapture` on pointerdown to
pan, and **capture retargets the later click and dblclick to the capturing
element** — so a double-click on the picture arrived at `.mv-stage` with the
_stage div_ as its target, which `isStageSurface` did not accept (it accepted
`IMG` and `mv-video-stage`). The close was skipped and `onDoubleClick={cycleFit}`
ran instead: it zoomed and stayed open. Verified in a browser by logging event
targets — `mousedown` on `mv-image`, `click` and `dblclick` on `mv-image-stage`.
`mv-image-stage` is now a stage surface, the stage's own double-click handler is
gone, and cycling fit moved to the zoom readout, which is now a button (so
`nextFitMode` keeps a production caller; `0`/`1`/`+`/`-` and the wheel are
unchanged).

**A latent bug found in the same trace:** that capture also swallowed clicks on
the overlay controls, so **the image background toggle did nothing at all** —
`mousedown` reached the button but the `click` was retargeted to the stage, so the
button's handler never ran. Presses that start inside `.mv-image-tools` no longer
capture. Fixed here because it is the same retargeting, and because making a
stage double-click close the viewer would otherwise have made a double-click on
those buttons close it too.

**4. The viewer's two notices sat in different places.** `.mv-export-notice` was
at `bottom: 96px` with its own shape (16px radius, no border, 13px) while
`.mv-resume` sat at `calc(var(--mv-seek-top) + 8px)` with a bordered 7px frame —
despite a comment claiming it mirrored the resume notice's placement. A single
`.mv-toasts` column now anchors both and they share one `.mv-toast` frame,
stacking with the export notice above. The idle fade still applies to the resume
notice only, so an export in progress stays visible.

**5. A rename box could select the extension.** Both rename inputs already
selected the stem on focus, and a genuine double-click in the in-app Chromium
lands on the stem — measured: `selected: "Alpha.Show.S01.cover"` of
`Alpha.Show.S01.cover.jpg`. **So this does not reproduce in a browser**, and the
report is almost certainly the desktop shell: WebKit can settle its own
double-click selection on the newly focused input _after_ focus, overriding the
programmatic one — the same engine difference that already forced the
`caretRangeFromPoint` fallback in the grouping dialog. The selection is now
re-asserted on the next animation frame, which lands after either ordering, via a
shared `renameSelection` helper used by both inputs. **Unverified on WebKit**: it
cannot be driven from here, so this is a reasoned fix rather than a reproduced
one.

**Gates run:** backend `ruff format --check`, `ruff check`, `mypy src packaging`,
`pytest` (866 passed, +6); web `lint`, `format:check`, `typecheck`, `test` (476
passed, +7), `build`; `test:e2e:frontend` (93 passed, +2, and the same 1
pre-existing HLS re-attach failure recorded under PR #40 — it fails on clean
`main` and is untouched here). Desktop gates not run locally: no Rust or
`apps/desktop` file changed.

Each fix has a test that was **confirmed to fail without it**: the derived shown
name (an API listing left deliberately stale), the `display_title` carry in all
three repoint paths, the pointer-capture guard, `isStageSurface` accepting the image stage, the toast
column (measured in Playwright — same centre axis, 8px stack gap), the next-frame
selection re-assert, and the drop picker's default folder. Three further tests pin
boundaries rather than a bug: a chosen title survives a Cairndex rename and a
scan-found rename, and a directory rename does not touch the titles beneath it.

**Verified against a live backend** on a generated library (`Studios/Alpha` with
two parts, a cover and a subtitle; `Studios/Beta`; `Photos`): renaming through the
API and reading both surfaces showed `SecondPart.mp4` in the bundle inspector and
the File Browser together, with `original_filename` still
`Alpha.Show.S01.part2.mp4`.

## Merged: grouping review state and collection conversion (PR #40, 2026-07-29)

Branch `fix/grouping-review-state-and-collection-conversion`, off `main` at
`7b4bded`, merged as PR #40. It started as the two owner-reported problems below
and grew to ten across eight feedback rounds. Before merge the branch's ten
commits were restructured into four, squashing only those that superseded an
earlier commit on the same branch; each of the four lands on a tree that existed
as a real commit before, so `git bisect` still works.

**1. Narrow/Widen discarded the review state.** Reported as "it seems like it
refreshes the page… it forgets my selections and reselects everything" — and on
the second pass the owner confirmed the deeper version: it also reverted
bundle↔collection conversions, "to me this is just a persistent state so long
as the grouping window is open". Both had one cause: `setStemMode` called the
same full-regeneration path as Suggest grouping, `generate_plan` superseded the
open plan and wrote entirely new rows, and everything keyed to the old rows —
the client's id-based selection _and every server-side owner edit_ — was lost.

Fixed structurally rather than by carry-forward matching:
`PUT /plans/{id}/stem-modes` re-suggests **one directory in place**. The
suggester still runs over the whole library (a directory's grouping is not
computable in isolation), but only its output for that directory is spliced
into the open plan. Rows outside the directory are never touched, so renames,
destination switches, drag edits, conversions, and checkboxes survive because
nothing happened to them — there is no cross-plan identity matching to get
wrong. Three splice subtleties worth remembering: files the owner dragged _out_
of the directory are not re-proposed (a fresh row claiming a file another row
still holds would bundle it twice); subdirectory bundles hanging under a
replaced container re-link to its successor; and a conversion made _inside_ the
adjusted directory is replaced — that is the folder the owner just asked to
redo. An explicit **Suggest grouping** still resets everything; that is a fresh
start, not an adjustment.

Client-side, deselection is additionally keyed by _content_ (`proposalKey`: a
bundle is its sorted file-id set plus addition target, a collection its
directory) rather than by row id — a second line of defense now that ids are
mostly stable, and the thing that keeps behavior sane around conversions.

The considered-and-rejected alternative, for the record: keep full regeneration
and re-apply owner edits onto the fresh plan by content matching. Rejected
because it must answer "which new row is the old row?" for every edit type
separately, and has no good answer for conversions (a converted container's
children exist in no fresh plan).

**2. No way to say "this folder is a collection, not a bundle".** The real gap
was narrower than "the suggester guessed wrong": `_bundle_groups` short-circuits
on `_is_multipart` **ahead of the stem-mode check**, so a folder whose files
carry part markers (`Trip.part1.mp4`, …) is one bundle at _every_ sensitivity —
Narrow cannot split it. That is precisely the folder an owner wants to override,
and there was no control for it.

New `PUT …/proposals/{id}/kind` converts in both directions and returns the whole
plan, since a conversion adds or removes sibling rows. Bundle → collection splits
via a new `suggester.split_for_collection` (one bundle per video, sidecars
following their own video by stem — reusing `_bundle_groups` would have returned
the input unchanged for the multipart case). Collection → bundle collapses every
descendant back, so the override is reversible. Additions are refused in both
directions: their files join a bundle that already exists.

**Owner feedback rounds (2026-07-29), all applied.** First round: the conversion
control became a compact split/merge icon button (matching the destination
toggle) instead of "To collection"/"To bundle" text; Narrow/Widen became
inward/outward chevron icon buttons; the "single file on its own" and
"Split/Merged because you…" reason texts went (the first restated the visible
row, the second explained the owner's own action back to them); and the in-place
stem-modes endpoint above replaced full regeneration.

Second round, on the review dialog's density and vocabulary:

- **The mode word between the chevrons is gone.** The tooltips name the current
  mode instead, and the buttons already disable at the ends of the scale.
- **Collection rows carry no reason.** Three `_container_proposal` call sites
  had each grown their own phrasing for the same fact — "holds 2 sub-item(s)",
  "3 unrelated files", "2 filename-matched bundle(s) from 4 files" — so
  identical-looking rows read differently depending on which branch produced
  them, which is the inconsistency the owner spotted. Bundle reasons stay:
  "3 parts of one video" says something the row does not.
- **The intro is a one-line lead plus three short points**, down from a
  nine-line paragraph that documented every affordance above the thing the owner
  opened the dialog to read. Each control carries its own tooltip now, so only
  the non-obvious remains: scope, what Accept does, and the disk guarantee.
- **File rows show the media kind, not the guessed role.** They read
  `video part` / `alt version` / `cover` / `derivative` — the suggester's
  filename guesses, which `lib/format.ts` had already decided not to surface in
  the inspector for exactly this reason ("showing a guess as a label invited it
  to be read as a fact"). The review dialog now routes through `formatFileRole`
  and speaks the same video / image / subtitle vocabulary.

**Fourth round — presentation, plus one substantive naming fix.**

- **Bundle titles now come from the shared filename part** (`_shared_stem_title`).
  `_bundle_proposal` used `_stem(files[0])`, so a prefix-matched group of four was
  titled after one member — with that member's tail attached, which read as a
  claim about the whole bundle. Computed on the _raw_ stems so the owner's
  delimiters and casing survive, then trimmed back to a delimiter so it never
  ends mid-token (a pair of dates yields `…19.12`, not `…19.12.2`). Multipart
  gains too: `Trip.part1` → `Trip`. Folder-owning bundles and single subjects are
  unchanged, which is what the `videos if len(videos) > 1 else …` guard protects.
- **Panel widened to 1100px** and the wrap misalignment fixed: `.grp-row` was
  `align-items: center`, so a wrapped row floated its checkbox, handle and glyph
  to the vertical middle, detached from the title. Now `flex-start` with 1–2px
  offsets to centre each in the title's 18px line box, and `.grp-row__content`
  aligns to `baseline` so a wrapped second line lines up with its own text.
- **Narrow/Widen tooltips rewritten** to name the folder and drop the "stem
  matching" jargon. The owner asked what the control applies to — bundles or
  collections — and the honest answer is _neither_: it belongs to a **folder**,
  one pair per folder (`stemControlOwners`), attached to whichever row speaks for
  it. That is a collection row when the folder became a collection and a bundle
  row when it became one bundle, which is exactly why it looked like two
  different controls. The aria-labels are unchanged, so the tests still pin them.

**Eighth round.** A tooltip could stick on screen: `TipButton` hid only on
`mouseleave` / `blur` / scroll, and clicking a control is precisely the case where
the pointer never leaves it — the _row_ moves instead. So the portal kept its
stale coordinates while the button's label flipped underneath. Fixed twice over:
dismiss on activation, and store the tip text alongside the position so a
placement computed for a label that has since changed is not rendered. The second
guard is derived during render rather than cleared in an effect, which the
`react-hooks/set-state-in-effect` rule (rightly) rejected as a cascading render.
Both guards have tests; the click one was confirmed to fail without the fix, and
the behaviour was re-checked in a real browser with an actual hover-then-click,
which is the gesture jsdom cannot reproduce.

**Seventh round**, mostly presentation with one behaviour change.

- **Caret on double-click.** `ProposalTitleEditor` called `select()`; it now takes
  a character offset from `caretPositionFromPoint` (with the WebKit
  `caretRangeFromPoint` fallback, which the desktop shell needs) captured on the
  dblclick and applied via `setSelectionRange`. Captured into a ref, because
  re-reading it would yank the caret back mid-edit. Keyboard entry passes `null`
  and lands at the end.
- **Single-subject conversion allowed again, bounded differently.** The previous
  rule ("refuse unless it divides into 2+") left rows with no path to becoming a
  collection, which the owner wanted. The bound is now _positional_: refuse only
  when the row already sits in a collection for its own directory
  (`_sits_in_a_collection_for_its_own_folder`). That still terminates, because the
  child a conversion creates always lands in exactly that position — and it no
  longer blocks the legitimate case.
- **Neutral kind icons.** 🎬 → `IconLayers`, 📁 → `IconFolder`, and the clapper
  dropped from the "Add to …" title. A bundle is not necessarily a video, and the
  clapper asserted otherwise.
- **Alignment made deterministic instead of tuned.** Fixed `--grp-check` /
  `--grp-icon` / `--grp-lead-gap` custom properties give a known leading width, so
  the checkbox centres in the title's 18px line box by calculation rather than a magic 2px,
  `.grp-files` indents by `calc(var(--grp-lead) - 4px - 1px)` (padding and border
  accounted for), and the icon buttons take `align-self: center` at 18px tall.
  Verified in-browser: file indent and every icon button measure **0px** offset
  from the title, and checkbox/icon/title share one mid-Y.

**Sixth round.** The ⠿ drag handles are removed: the file `<li>` already carried
`draggable` + `onDragStart` itself, so its handle had been decoration for a while;
the bundle row gained the same and both handles went. `draggable` is suppressed
while a row's title is being renamed, because `draggable` on an ancestor hijacks
text selection inside the edit box. Four unit tests and two e2e locators targeted
the handles by `aria-label` and now target the rows (`fileRow` / `bundleRow`
helpers).

**Fifth round.**

- **Additions now nest where the bundle they join lives.** Took two passes, and
  the second is the one that mattered — worth recording because the first looked
  sufficient and was not.

  Pass one: `_addition_proposal` hardcoded `parent_directory=None`, so an
  "Add to …" row always sat at the top level. Fixed by resolving the nearest
  enclosing proposed-collection folder (`_enclosing_container`), which required
  building additions _after_ `_classify`, since the set of proposed collections
  is its output.

  Pass two, after the owner reported it unchanged: the folder is not enough.
  `grouping/service.py` is a second placement layer that nests suggestions under
  _existing_ collections, and it had two faults. Its `_proposal_collection`
  docstring promised "prefer the target bundle's membership, then a matching
  directory hierarchy", but the sort key re-ranked membership candidates by
  whether the collection's name path also prefixed the proposal's directory — so
  a shallow collection outranked the bundle's real one whenever the deeper name
  did not happen to match a folder. And `_with_collection_context` skipped any
  proposal that already had a parent, which pass one had just given every
  addition. Membership is now ranked by depth alone and outranks a folder-derived
  parent. In the reported layout the folder-derived parent really is the
  _grandparent_: once the folder's remaining fresh files form one bundle they own
  that folder, so no collection is proposed for it and walking up lands on
  `Studios`. Both failure modes have tests that were confirmed to fail without
  the fix.

- **Tooltips no longer clip.** `.tip::after` is absolutely positioned inside
  `.grp-body { overflow: auto }`, so the dialog's own scroll container cut it
  off — worst for these controls, whose tooltips are the dialog's longest text.
  A local `TipButton` portals the tooltip to `document.body` at
  `position: fixed`, right-aligned via `right` so the width never needs
  measuring, clamped into the viewport, and flipped below the control when there
  is no room above. Hover handlers live on a wrapper rather than the button
  because a _disabled_ button fires no mouse events, and Narrow/Widen disable at
  the ends of their scale — precisely when the tooltip is wanted. `data-tip`
  stays on the button, which is what two existing tests read. Deliberately scoped
  to this dialog rather than replacing `.tip` app-wide.
- **Drag-handle gap tightened**: the handle's box was 18px around a ~8px glyph,
  which read as a gap before the title. Now 12px, with the bundle row's gaps at
  2px.

**A third round found the nesting bug.** Owner screenshot: five collections deep,
each named `StudioBeta.E003.Lead`, each holding one bundle of the same name. Cause
was in `split_for_collection`'s `len(videos) < 2` branch, which returned one group
_per file_. For a one-file bundle that is a single group, so converting wrapped it
in a collection of one identical bundle — and the child was convertible in turn,
so every click added a layer. It was also wrong for one video plus sidecars: it
would have put a subtitle in a bundle of its own.

Split into the two cases it was conflating. **No videos** divides per file (a
photo dump — the one place per-file is right). **Exactly one video** is one
subject however many sidecars it has, so it returns a single group. And
`_bundle_to_container` now refuses any split of fewer than two groups: a
collection of one identical bundle adds no structure. The client hides the
control on such a row (`canBecomeCollection`, mirroring the server, which stays
the authority), so the refusal is a backstop rather than the normal path.

Verified against the reported shape: converting `Western/StudioBeta.E003.Lead`
(one video) returns 422 "holds a single item, so there is nothing to divide";
merging a two-video folder and dividing it again round-trips 200/200.

**And one bug the first symptom was hiding.** The owner reported that a
collection turned into a bundle "gets widening and narrowing buttons, and when
you change it back they stay". Reproduced, then traced: `bundleDirectories` read
`proposal.directory`, but merging a collection whose bundles live in subfolders
(`Show/A`, `Show/B`) leaves one row whose `directory` is the _parent_ `Show` — a
folder with no direct media. So the row was offered a stem control, and
**using it deleted the row while the suggester produced nothing for `Show`, so
both files dropped out of the plan entirely** (verified against the API: rows
went to `[]`, files unproposed). Two fixes: the client derives a row's folders
from its _files' paths_, so a cross-folder row gets no control; and the server
refuses any splice that would drop a file rather than performing it — the
general invariant, which is what caught that the first guard ("refuse when the
directory yields nothing") was too narrow, since the suggester _does_ still
propose a bare container for `Show`.

**Gates run** (final, at merge): backend `ruff format --check`, `ruff check`,
`mypy src packaging`, `pytest` (860 passed); web `lint`, `format:check`,
`typecheck`, `test` (469 passed), `build`; `test:e2e:frontend` (91 passed, 1
failed). That failure is `transparently re-attaches a fresh session when HLS
segments fail` (`e2e/player.spec.ts:2230`), which fails on clean `main` at
`7b4bded` too — verified in isolation as well as in the full suite, so neither
flake nor cross-test interference; it belongs to the ADR-0014 HLS session path
and is untouched here. Desktop gates were not run locally, no Rust or
`apps/desktop` file having changed; all seven CI jobs passed on the merged head.
Two existing tests needed correcting rather than the code: one asserted
a container reason that is now deliberately absent, and one stem-control fixture
had file paths that disagreed with its own `directory` — which the new
file-derived rule correctly reads as a hand-merged row.

**Verified in a browser against a real backend**, on a library seeded with
`Trip/` (three parts + three subtitles), `Duo/` (two subjects Widen merges),
and `Solo/`: unchecked `Solo`, converted `Trip` to a collection via the icon
button, then clicked Widen on `Duo` — `Duo` regenerated into one wide bundle
while `Solo` stayed unchecked and `Trip` stayed a converted collection with its
three children. Earlier round additionally verified apply end-to-end
(_3 bundles, 1 collection, 3 subtitles linked_) and the reverse conversion.

## Shipped: v0.1.0, the first public release (2026-07-28)

**Published** (release withdrawn in the 2026-08-09 recreation) at
11:12 UTC. Tag `v0.1.0` → `0821890`; assets are `Cairndex_0.1.0_aarch64.dmg`
(95.4 MB), its `.sha256`, and `THIRD-PARTY-NOTICES.md`, which has to travel with
the artifact because the bundle carries a GPL ffmpeg.

**Both owner-only verifications are now done**, on a real downloaded build
rather than a local one — which is the whole reason D7 deferred them rather than
claiming them:

- **Gatekeeper first launch.** The ad-hoc signature means macOS refuses the
  first open; the README's System Settings → Privacy & Security → Open Anyway
  path works, and it repeats per update until the updater lands.
- **Drag-out to Finder**, exercised from a **network (SMB) library** — which
  incidentally proved the path-resolution-off-the-IPC-thread design, since
  canonicalizing an offline mount is exactly what would otherwise stall the UI.
  It copies rather than moves. That is by design and not an artefact of the
  share: the shell puts paths on the pasteboard and its drop callback only emits
  `DRAG_ENDED_EVENT` — nothing removes the source — because a move would take a
  file out of a library with no journal entry and no undo, which ADR-0013
  forbids outside a write-mode operation.

**A warning worth not acting on yet.** The release run annotated that Node 20
actions (`checkout@v4`, `setup-node@v4`, `cache@v4`, `upload-artifact@v4`,
`setup-uv`) are being forced onto Node 24. The run was green and the artifact is
unaffected; it is repo-wide rather than release-specific (9 × `checkout@v4`
across the workflows), and bumping major action versions immediately before a
publish would have changed the build for no gain. It is now the cheapest thing
on the post-release list.

## Release prep: v0.1.0 is one tag away (2026-07-28)

Branch `docs/prep-v0.1.0`, off `main` at `58c3d22`. No code — the changelog cut
and two milestone rows that had gone stale.

**Nothing is published today.** The release workflow ran green for `v0.1.0` on
2026-07-23, but there are no tags and no releases on the remote (checked against
the API, not the local clone) — that run's tag and draft were cleaned up. So the
pipeline is proven and the artifact is not. The version strings in
`tauri.conf.json`, both `package.json`s and `pyproject.toml` already read
`0.1.0`, so the tag is the only remaining action.

**The changelog is cut.** Everything the repo has ever shipped sat under
`## [Unreleased]`, which is what its own preamble said would happen until the
first tag. That became `## [0.1.0] — 2026-07-28` with a fresh empty `Unreleased`
above it, and the version note now claims semver from 0.1.0 onward. A short
orientation section was added at the top of 0.1.0 — what the product is, the
highlights, and the known limits (Apple Silicon only, the ad-hoc signature's
first-launch approval, one machine per library) — because a first release whose
changelog is 2,700 lines of accumulated history needs an entry point. The history
below it was left in the order it was written; consolidating the ~25
`### Added`/`### Changed`/`### Fixed` groups into one of each would flatten a
chronology that currently reads as the build order, and is a judgement call
rather than a mechanical tidy.

**Two stale rows.** Plan 4 **W6** shipped as PR #33 but its milestone row was
never ticked; it now records what landed (EXDEV copy-then-delete with a marker
file as explicit evidence, case-only renames, trash retention, the
multi-filesystem deployment note, bundle delete-with-files, and the importer's
library-id hardening) and what deliberately did not (journal history UI as
feature-sized; the bulk-ops perf pass, which needs a representative large library
the owner has to point at). Plan 1 **M11** read "deferred to future", but PR #34
shipped its contact-sheet half; the row now marks it part-shipped and notes the
consequence — **plan 4 W2** (save exports into the library) waited on M11 and is
now a slice rather than a blocked item, since the export seam and one real export
both exist.

**Also corrected while checking.** The plan index still said "plans 2 and 4 have
not started" and counted "four major initiatives" (there are five, and plan 4 is
done bar W2); its phase **H** still read "(next)" though write mode closed with
W6, so H is ticked and a new **H2 — publish v0.1.0** sits between it and the
Android client, which is the real next step. And the release runbook's review
step still expected "both DMGs", written before Intel was dropped from the
matrix (2026-07-23) — it now expects one of each artifact and says what
restoring Intel would change.

**Still owner-only, unchanged:** a pass on a genuinely downloaded build (deferred
from D7 to after write mode — that is now) and the native Finder drag gesture on
a packaged build.

## Deferred: plan 5 — network-library latency (2026-07-28)

Owner-reported: selecting a bundle on the NAS library leaves the inspector on
`Loading…` for ~500 ms, degrading past a second under rapid clicking, where
Eagle is instant on the same disk. **Deferred post-v0.1.0**; written up as
[plan 5](plans/05-network-library-latency.md) so the diagnosis is not re-derived.

The cause is architectural, not a defect. `library.db` lives inside the library
package on SMB (ADR-0008 portability); `registry.db` is on local disk. Same file
and pragmas, benchmarked in both places: reads 5.53 ms vs 0.00 ms, **writes
37.96 ms vs 0.01 ms** (~3800×). Browsing writes — cursors, missing-file
reconciliation, and a commit on every `LibrarySession` request — and WAL's
`-shm` is unsupported on network filesystems, so it degrades instead of
plateauing. A `/health` control probe held at 5 ms while bundle reads hit
1331 ms on the same connection, which is what ruled out transport and threadpool
queueing.

Two things worth carrying forward. **ADR-0013 write mode does not help**: it
gates _media_ operations, while these are _metadata_ writes it neither gates nor
could. And the owner's framing — **Theater Mode** (watching; nothing written)
vs **Management Mode** (organizing) — is a second axis orthogonal to write mode,
with one tension to resolve first: watching is precisely when playback progress
wants writing.

## Merged: PR #35 — HEVC `hev1` sources never played (2026-07-28)

**[PR #35](https://github.com/allpan3/Cairndex/pull/35) merged** to `main` as
`fcca119` on 2026-07-28; branch deleted. All seven CI jobs green, squashed to one
commit off `main` at `986320d`.

Owner reported one video in `lex` failing with the viewer's "Playback
interrupted" card, retry never helping, and the same file having played before.

**Cause.** MP4 carries HEVC under one of two four-character labels. `hvc1` keeps
the decoder parameter sets in the container header; `hev1` permits them in-band
and permits them to change. AVFoundation — Safari, and therefore the desktop
shell's WKWebView — plays only `hvc1`. Measured directly on the reported file
against a sibling that differs in nothing else:

    clip_hvc1.mp4 → isPlayable=true   subtype=hvc1  hwDecode=true
    clip_hev1.mp4 → isPlayable=false  subtype=hev1  hwDecode=false

Both labels normalized to `hevc` in `media/playback.py`, and the probe never
recorded the label at all, so the two files were indistinguishable to
`decide_playback`. On the client, `caps.ts` advertised `hevc` when _either_
label probed supported, and its `supported()` OR-ed `canPlayType` with
`MediaSource.isTypeSupported` — and WebKit returns `isTypeSupported: true` for
`hev1` while `canPlayType` returns `""`. So an MSE-only capability vouched for
progressive playback, the decision came back `direct`, and the raw `hev1` file
went to a video element that could not decode it.

The "used to play" is consistent: direct play never worked, but anything that
forces a session — a quality below source, subtitle burn-in, a non-default audio
track — routes to HLS, where MSE does accept `hev1`.

**Fix.** `PROBE_VERSION` 3 records `video_codec_tag` (the bump is what re-probes
existing rows). `CapabilityProfile` gains `video_codec_tags`, parsed out of the
same wire list so the API shape is unchanged. A discriminating label the client
did not confirm forces `remux`, not `transcode` — the coded video is fine, only
mislabelled — and the remux path adds `-tag:v hvc1` so the copy comes out with a
label Apple accepts. Codec tags are probed with `canPlayType` alone. The same
check reaches `canDirectPlayVideo`, so hover previews fall back to the
storyboard. Rows without a label stay optimistic, so nothing regresses before a
re-probe.

**Tests.** 831 server, 445 web, ruff/mypy/eslint/tsc/prettier clean. New
coverage: the decision matrix for both labels and for missing/meaningless ones,
the remux relabel (and that it does not touch H.264 or the transcode path), the
probe field, the WebKit `canPlayType`/`isTypeSupported` asymmetry, and the hover
fallback.

**Verified end to end** against the running desktop app on 2026-07-27, after a
sidecar rebuild and a re-probe of `lex` (68 files). The bump alone does not
re-probe: `_is_current_probe_metadata` only invalidates the rows, and a PROBE
job still has to run — sidebar "⟳ Update" or Jobs → "Collect metadata". Until it
does, the tag stays null and the decision stays optimistic, which looks exactly
like the fix not working.

    re-probe        → probe_version 3, reported file tagged hev1, sibling hvc1
    decision (hev1) → remux "hev1 codec tag is not in client capabilities"
    decision (hvc1) → direct  (unchanged — no regression)
    live session    → segments tagged hvc1; AVFoundation isPlayable=true,
                      hwDecode=true

`lex` holds 8 HEVC files: 7 `hvc1` and this single `hev1`.

**`just check-web` was not type-checking anything.** CI failed on three type
errors in test files that the new required field exposed, while the local gate
had been green. The recipe ran `npx tsc --noEmit`, but the root `tsconfig.json`
is solution-style — `"files": []` plus project references — so that command
checks no files and exits 0. It now runs `npm run typecheck` (`tsc -b`), which
follows the references and matches what `npm run build`, and therefore CI and
the Docker image, actually enforce. Worth knowing for any future change that
widens a shared type: the local gate could not have caught it.

## Merged: PR #34 — UI refinements, eight owner rounds (2026-07-28)

**[PR #34](https://github.com/allpan3/Cairndex/pull/34) merged** to `main` as
`7259aad` on 2026-07-28; branch deleted. All seven CI jobs green, and `main`
re-verified after the merge: full gate plus **92/92** browser e2e — the suite had
been red on `main` before this. It went in
squashed to four commits by subsystem (server / desktop / web / docs), off `main`
at `b2c2814`. A whole-branch review pass before the PR caught three things no
single round would have: the tag delete skipped its own confirmation when the
impact lookup failed (an unknown cost is a reason to _ask_), the filename scan
was O(files²) and unmemoized in a component that re-renders on every drag move,
and `--mv-controls-h` had gone circular. Browser e2e is **92/92**.

CI then failed on two things the local run had not. One was a **real bug this
branch introduced**: the Back/Forward control shares the toolbar's leading slot
with the File Browser's breadcrumb, and once the trail stopped fitting,
`overflow: hidden` left the leading crumbs with boxes outside the visible area —
painted nowhere, still hit-testing to the toolbar — so the library-root crumb
could not be clicked. Reproduced at 1180px; CI's wider fonts reach it sooner,
which is the whole reason only CI saw it. The trail scrolls now, right-aligned
by an auto margin rather than `justify-content: flex-end` (start-overflow is
unreachable by scrolling under `flex-end`, so scrolling alone did not fix it),
and that spec runs at the reproducing width so the default viewport cannot hide
it again.

The other was `manual-bundling`'s drag-to-select, which had been red on `main`
too: it asserted that a click on empty space clears the selection _while a
context menu is open_, which this branch deliberately changed — dismissing a
menu now leaves the selection alone. The spec dismisses first, checks the
selection survived, then clears it. The owner's
refinement list, each its own commit: (1) viewer topbar clears the traffic
lights in the shell; (2) Back/Forward history over views/collections/bundles/
File Browser paths; (3) album tiles gain Remove from Bundle + write-gated Move
to Trash (answering: no, file deletion was not reachable there); (4) the
viewer's info panel is a persisted sidebar listing the playlist, click to jump;
(5) the viewer owns its right-click menu (native video menu suppressed; text
inputs keep theirs); (6) **contact sheets** — server-cut frame grid (ffmpeg fps
sampling + tile, cached by grid shape + fingerprint, bounded params), header
composed client-side on canvas, saved through the export seam; (7) configurable
default export destination (desktop; shell-stored, only ever set from the OS
folder picker; keep-both naming; snapshot now routes through it); (8) a Random
system view — pure-SQL seeded permutation ((rowid × Knuth-mixed seed) mod
prime; the unmixed first cut didn't shuffle small libraries at all — a test
caught it), toolbar Shuffle button, manual reorder + Clean Up disabled there;
(9) `/` nests when creating tags, per-parent case-insensitive reuse; (10)
player keys remapped (,/. frames; z/x/c speed; subtitles → v) with the keymap
table and shortcut reference following; (11) a speed-reset control while off
1×; (12) OS file drops can never navigate the webview again (window-level net +
synchronous handled-flag), and dropping on a bundle card imports + links into
that bundle under write mode.

One regression caught by the e2e run and fixed in the last commit: with the new
context menu open, Escape closed the menu _and_ the viewer.

### Round 8 follow-up (2026-07-27)

**Sibling filenames collapse what they share, not what differs.** The inspector's
rows end-truncated, which is exactly where sibling files differ; the owner ruled
out middle-ellipsis as inelegant (it cuts every name in the same arbitrary
place). `distinctNames.collapsePrefixLengths` computes, per name, the longest
prefix shared with the sibling it most resembles, snapped to a word boundary and
thresholded; the row renders it as a dimmed, shrink-first span with the distinct
tail keeping full width and brightness. Deliberately per-name rather than
list-wide so one unrelated file (a poster) cannot stop its siblings collapsing.
The helper is reusable — the viewer playlist and the album rows share this
disease and can adopt it later.

**The tag chords are optimistic now.** Copy reads the active bundle's tags from
the query cache (the pills on screen _are_ that cache) instead of fetching;
paste shows the toast and updates the pills at the keystroke and lets the PUTs
catch up, cancelling in-flight refetches before the optimistic write and rolling
back to the server's truth on failure — the same shape as `useSetBundleTags`.
Previously the toast waited on fetch+PUT and the pills on a refetch: two visibly
separate one-second stalls.

**Zoom now drives the surfaces round 8 handed to the shell's layout control.**
Album tiles scale on the bundle-card ramp; album rows and collection rows follow
`listRowHeight`, published as CSS variables the way the file table does it. The
file table had scoped its row-height rule to itself, which is why the album's
identical rows ignored the slider.

**"This library is open on AP3-M5Pro", diagnosed.** The lease on
`/Volumes/media/library` was held by the _repo dev backend_ used for verification —
its `server_uuid` matches `apps/server/var/registry.db`'s identity, not the
desktop sidecar's — acquired 07:29:30 local, last heartbeat 07:30:09, holder
killed rather than shut down. A dead holder cannot release, so the lease reads
as live for `lease_ttl` (300s) after its last heartbeat; the owner hit the
dialog inside that window. Recovery needs nothing manual: past the TTL the
notice becomes "This library was left open elsewhere" with **Serve here
anyway**. Operational rule recorded: verification dev servers are stopped when
verification ends, and only the Demo library is used.

### Owner review round 8 (2026-07-27)

Six items, one theme: the shell already has a layout control, so nothing else
should grow its own.

- **The toolbar's layout drives all three surfaces.** Collections render as rows
  in list layout — the same `CollectionCard` laid flat by a CSS variant, so
  selection, drag/drop seams and the context menu are untouched. Grid and
  justified keep the cards (a folder has no aspect ratio to justify). The
  in-bundle album follows the same pref and loses the private seg from round 5.
- **Pasting tags is live.** The chord paste invalidated `['bundles']`/`['tags']`
  but the pill lists read `['bundle-tags', id]` — nothing the paste touched.
- **Filtering from a pill reveals the filter row.** `filtersOpen` initialized
  from `filtersActive` but never reacted to it, so a filter arriving from the
  pill menu left active filters with no visible controls.
- **Pills read as controls**: `cursor: default`, no text selection, and a quiet
  white glow on hover — an accent fill read as "selected", which is what the
  owner meant by "not blue".
- **The copy/paste chords are desktop-only** at the owner's call: in a browser
  tab Shift-Cmd-C is Chrome's Inspect Element, and having one of a pair is worse
  than having neither. The gate is `isDesktopHost()` at the top of the handler.

Verified live in the web UI: list layout showing four collection rows above the
bundle table; the album following the top control both ways with its inner seg
gone; the pill's cursor and hover rule; "Filter Items with zflow" revealing the
filter bar with the Tags chip at 1 and the listing at one item; and the synthetic
chord that fired "Copied 1 tag." in round 7 now doing nothing in the browser.

### Owner review round 7 (2026-07-27)

Six items, and one root cause behind two of them.

**`window.prompt` and `window.confirm` do nothing in Tauri's webview.** A prompt
returns null and the caller quietly no-ops; a confirm never asks. That is the
whole of "rename tag does not work in the desktop app" and "deleting a tag gives
no warning at all" — and it is why neither looked like the same bug, since both
behaved correctly in a browser. `PromptDialog`/`ConfirmDialog` replace them, and
there are no `window.prompt`/`confirm`/`alert` calls left in the app: tag delete
(with its impact counts), tag rename, missing-file relink, and smart-collection
delete all render the question now.

The rest:

- **The per-file "×" is gone** from the inspector's rows. Removing from a bundle
  is on the row's own menu with everything else; the button was the one thing
  there you could hit by accident.
- **Filtering from a tag pill takes that one tag.** It took every tag on the
  bundle, which described the bundle rather than anything worth browsing — and
  with no way to select several pills, the multi-tag case could never be asked
  for deliberately.
- **Shift-Cmd-C / Shift-Cmd-V** copy and paste tags across a bundle selection.
  Paste is a union, and skips bundles that would gain nothing rather than bumping
  their version for no change. Both chords are handled _before_ the
  don't-hijack-typing guard, because clicking a card can leave focus on an input,
  which swallowed them.

Verified live: the delete dialog naming the child count and cascading on confirm;
an unused tag deleting with no prompt at all; rename through the dialog changing
the pill; no native dialog reached in any of it (`window.confirm`/`prompt` were
stubbed to record calls and recorded none). Paste verified with a real key press:
a bundle carrying two tags gained the copied one and kept both of its own.

**One caveat worth knowing.** In a Chrome tab, Shift-Cmd-C is the browser's
Inspect Element shortcut; the page sees the event but it does not reach the app's
handler. Shift-Cmd-V has no such conflict and works in both. The desktop shell
binds neither, so both work there — which is where the owner asked for them.

### Owner review round 6 (2026-07-27)

Seven items. Two needed measuring before they could be fixed.

**The contact sheet's tail.** Cells were taken from the _leading edge_ of their
slice, so the last slice was never sampled, and the edge trim was a flat 4% of
duration. Stacked, on a one-hour video:

|                | before             | after                   |
| -------------- | ------------------ | ----------------------- |
| first cell     | 144.0s             | 117.2s                  |
| last cell      | 3249.0s            | 3482.8s                 |
| unsampled tail | **351s (5.8 min)** | 117s, equal to the head |

Cells now come from the middle of their slice, and the trim is capped at five
seconds. What is left over at each end is the same half-slice, so the sampling
is symmetric rather than systematically missing the end.

**The resume toast.** It had moved — to 6px above the control _bar_. But the bar
is a button row above a seek track, so that left it 52px from the playhead it
refers to, which is the gap the owner kept seeing. The bar now measures where
its track starts and publishes `--mv-seek-top`; the toast sits 8px above that.
Measured rather than assumed, so it holds wherever the row wraps or the font
differs — the previous 70px literal happened to be right on this display and
would not have been on another.

The rest:

- **The context menu owns its dismissal**, the same capture-phase rule the
  pickers follow. Clicking the sidebar left it open; clicking the shell cleared
  the bundle selection underneath it.
- **A tag pill has a menu**: filter by the assigned tags, rename, copy, paste,
  remove from this bundle. The clipboard is module-scoped so it survives
  switching bundles, which is the point of copying.
- **Deleting a parent tag** is allowed now. It was refused outright, which read
  as broken rather than guarded. `DELETE …/tags/{id}?cascade=true` takes the
  subtree; the plain delete still refuses, and a new `…/delete-impact` gives the
  prompt its numbers so it cannot understate a subtree the page has not loaded.
- **Deleting a tag that is in use prompts** with how many bundles lose it. A tag
  on nothing, with no children, deletes without one.
- **The contact sheet header prints the encoding** — `h264 / aac` for the demo
  4K file.

Verified live: cascade delete refused without the flag and accepted with it
against the running server; the pill menu showing all five rows with Paste
correctly disabled until something is copied; the menu closing from sidebar,
grid and inspector with the selection intact in all three; the toast 8px above
the seek track; and a generated sheet reading
`360 MB · 2:00 · 3840×2160 · 30 fps · h264 / aac`.

### Owner review round 5 (2026-07-27)

Eight items. Two were the same undefined CSS variable.

- **`--panel` is not a variable this stylesheet defines.** Both the context
  submenu and the viewer's docked inspector rail used it, so both rendered with
  no background — the submenu showed the page through it (what the owner saw as
  "half transparent"), and the rail got away with it only because the viewer
  sits on near-black.
- **The collection picker never had Enter wired**, and had no highlight either,
  so nothing looked selected and Enter did nothing. It now follows the tag
  picker's rule, decided once and rendered from the same value. Both pickers
  clear their search on close.
- **The resume toast** is anchored to the control bar's height rather than a
  literal near it. At 64px its bottom edge was 6px _inside_ the bar — which is
  what "it didn't move" looked like. One `--mv-controls-h`, used by both.
- **One file menu, one file inspector.** `bundleFileMenu` replaces the two menus
  the album grid and the inspector's file list had grown for the same file;
  `fileFacts` normalizes `FileBrowserEntry` and `FileRead` so `FileInspector`
  serves both surfaces instead of a second copy being written.
- **The in-bundle view behaves like the File Browser**: grid/list switch with
  the same control and rows, and selecting one file puts its details in the rail.
  No breadcrumb — a bundle has no parent directories. **Path is now a row** in
  that pane; it was deliberately omitted when the pane only described the File
  Browser, where the tree already says where you are, but inside a bundle the
  files can come from anywhere and that is the thing worth reading.
- **The contact sheet's grid and width are chosen in a dialog**, which also
  prints the resulting cell size — neither number means much alone, and a 6×6 at
  1600 has smaller frames than a 4×4 at the same width. Width presets are 1600,
  2048, and 2560 px, with 2048 selected by default.
- **The submenu machinery came back out.** Its only caller was the grid list,
  now a dialog. The cut-off it suffered at the window edge is moot, and an
  unexercised code path is worth less than the lines it costs.

Verified live in the web UI against the demo library: both pickers highlighting
and accepting on Enter and presenting an empty field on reopen; the album's
grid/list switch with four files; the rail showing `deep_ocean.mp4` with
dimensions, duration, frame rate and its full path; the contact-sheet dialog
offering three grids and three widths over an opaque panel.

### Owner review round 4 (2026-07-27)

Nine items. The one that needed diagnosis was the contact-sheet 502.

**It was a timeout, and the shape of the cost was the bug.** Sampling with
`fps=1/n` makes ffmpeg decode every frame between the first sample and the last,
so generation scaled with the video's _duration_, not the number of cells:

| video        | decode-and-sample | seek per frame         |
| ------------ | ----------------- | ---------------------- |
| 2-minute 4K  | 3.9s              | 0.9s                   |
| 12-minute 4K | 24.3s             | 2.1s (4×4), 6.1s (6×6) |

The desktop relay gives up at 30s. That explains the whole report exactly:
a long video fails, a second attempt sometimes succeeds because the abandoned
first one still filled the cache, and a longer video fails every time. Frames
now come from one input per cell with `-ss` before `-i` and `-noaccurate_seek`,
so ffmpeg jumps to the nearest keyframe and stops there. A sheet wants a
representative frame, not a precise one.

The owner proposed reusing the storyboard sheets instead. Recorded as
**considered and declined**: it helps only where a storyboard already exists,
and its 320px tiles fall below the cell size of a wide grid. The cost was never
where the frames came from — it was decoding everything between them.

The rest:

- **Contact sheets are reachable from every video** — File Browser, album grid,
  inspector file list — through a shared `contactSheetExport`, with a grid
  submenu (4×4/5×5/6×6). That meant teaching `ContextMenu` about submenus: a row
  now has either an action or children.
- **Per-cell timestamps and fps in the header.** The server reports the sampled
  instants in `X-Contact-Sheet-Times`; the client labels from those rather than
  reimplementing the sampling rule. Each cell carries its own gutter so the
  sheet divides into equal cells, which is what makes the labelling a plain
  division.
- **Progress.** Generation is seconds, so it reports through the shell's toast,
  which now holds any message ending in an ellipsis until a result replaces it.
- **Double-click closes the viewer; Escape closes it from fullscreen too** —
  previously two presses. Fullscreen is still dropped first so closing cannot
  strand the shell there.
- **"Next" stops at the media's edge** when the inspector is docked, and the
  resume toast sits beside the seek bar it refers to.
- **Escape dismisses a picker**, stopping there rather than also closing what is
  behind it. The active row is a filled pill; the search box no longer
  highlights itself.
- **A collection's description sits under its title.**

Verified live against the demo library: a 5×5 sheet built from the inspector's
file list, header reading `360 MB · 2:00 · 3840×2160 · 30 fps`, cells labelled
0:04 through 1:50; the "next" arrow ending at 904px against a rail starting at
920px; Escape and double-click each closing the viewer; Escape closing the
picker with the bundle still selected.

### Owner review round 3 (2026-07-27)

Five items. Two were the same requirement misread twice more.

- **Two panels, not one.** Round 2 folded the bundle inspector _into_ the info
  panel; the owner wanted them separate. The `i` button is the media's own
  information again — type, size, dimensions, duration, subtitles, playlist —
  and a sidebar toggle docks the main shell's `Inspector` as a right rail. Both
  open at once; the stage narrows instead of being covered.
- **Click-away, third attempt.** Round 2 stopped the click, which is too late:
  `useMarqueeSelect` clears on mousedown and mouseup. `usePopover` now consumes
  the whole dismissing gesture in the capture phase. Verified live from the
  grid, the inspector cover, a textarea and a field label — picker closed,
  bundle still selected, in all four.
- **Contact sheets in the shell.** Not a stale sidecar: `contact-sheet` was
  missing from the Tauri media proxy's read-only allowlist, so the shell
  refused the request before the server saw it. Proven by running the bundled
  sidecar directly and finding the route present in its own OpenAPI.
- **The tag picker marks what Enter will take** — single match, exact name, or
  the create row — computed once and rendered from the same value.

#### Video performance audit

The owner reported seeking a 4K file feeling slower. The media pipeline
measured clean end to end, so the cost was in the app and in how the app is
being run:

| layer                 | measured                                  | verdict |
| --------------------- | ----------------------------------------- | ------- |
| server range response | 2–6 ms TTFB                               | fine    |
| Tauri media proxy     | 453 MB/s, flat across 24 abandoned ranges | fine    |
| playback decision     | `direct`, no transcode                    | fine    |
| the file itself       | faststart `moov`, keyframe every 0.4 s    | fine    |
| element seek (Chrome) | 7–26 ms                                   | fine    |

Two hypotheses were checked and **disconfirmed**, recorded so they are not
re-opened: the media proxy does not degrade when a client abandons range
requests, and Starlette's `FileResponse` does _not_ keep draining a file after
the client disconnects — instrumented at 2.2 MiB read from a 256 MiB file, not
the whole thing, despite the range loop having no disconnect check.

What was real, and fixed:

- **Unthrottled keyboard seeking.** Auto-repeat fires ~30 keydowns a second and
  each wrote `currentTime`, aborting the in-flight byte range. Relative seeks
  accumulate and commit through the drag path's 150 ms throttle; a held key
  still travels the same distance.
- **Library-wide work per playback frame.** `TagEditor` and `CollectionPicker`
  built their row trees in the render body whether open or not — every tag and
  collection, sorted — and the newly docked inspector put that inside a subtree
  re-rendering several times a second. Both build only while open; `Inspector`
  is memoized; `buffered` keeps its array identity when the ranges have not
  moved, which is what lets the bail-out fire.
- **A frozen scrub preview and layout thrash.** The tooltip that covers for the
  throttle never moved during a drag, and the seek bar re-read the track rect on
  every pointer move.
- **Three routes still pinned a DB connection while streaming.** `/file`,
  `/file/preview` and a collection's `/thumbnail` used the yield dependency the
  streaming routes were moved off when drag-seek pool exhaustion was diagnosed.
  `/file` is how an unindexed File Browser video plays, so seeking one
  reproduced that bug in full.

**The measurement setup was itself a finding.** `just bundled` and `just
desktop` both run `tauri dev`, which serves the web app from Vite — React's
development build, unbundled modules, StrictMode double-rendering every
component. The sidecar is the shipped one; the frontend never was. `just
release` was added to run the optimized build, and `bundled`'s comment no
longer calls itself "the shipped path". Any judgement about speed should come
from `just release`.

### Owner review round 2 (2026-07-27)

Eleven follow-ups, all in this branch. The two that were real regressions from
round 1:

- **Videos were slower to start.** The File Browser asked for every row's
  thumbnail at mount; with no virtualization that saturated the browser's
  per-origin connections, and everything sharing them queued behind frame
  extractions nobody was looking at. Thumbnails now load on visibility via an
  IntersectionObserver — not `loading="lazy"`, which round 1 already established
  never fires inside the listing's own scroll container.
- **Dismissing the new right-click menu paused the video**: the menu closes on
  mousedown, so the matching click reached the stage. The shell records the
  dismissal in the capture phase and swallows that click.

The rest: the topbar clearance was too deep and shouldn't apply in fullscreen;
the viewer had no drag region, so the window could not be moved while media was
open; the settings menu's cover group moved to the right-click menu (**and
"reset cover to default" had to be re-homed there — removing the group left it
unreachable**, caught by the fullstack cover specs); Settings → Exports used
class names that do not exist and was rebuilt on the markup the other settings
pages use; the contact-sheet 404 now explains itself (it means a server
predating the feature — the route, its OpenAPI entry and a live run all check
out).

Tag picker: Enter accepts the single match or creates what was typed, the field
clears and the picker stays open, and the dismissing click is stopped in the
capture phase so clicking away no longer clears the bundle selection underneath.
Tagging is optimistic and stopped force-refetching the whole grid.

**The info sidebar was the misread.** Round 1 built a read-only metadata echo;
the owner wanted _the_ inspector — tags, collections, rating, notes — while
media plays. It now embeds the real component, with its pickers portalled above
the viewer. A collection's description was the same shape of problem: the field
and API already existed, but navigating into a collection from the sidebar left
the inspector empty, so it only appeared when a collection _card_ was selected.

Verified live against the Demo library: inspector embedded and editable during
playback, collection description reachable from the sidebar, picker click-away
keeping the selection, and Enter creating `probe/nested` as a hierarchy (the
probe tags were deleted afterwards — the Demo library is back to no tags).

Also this session, directly on main: the stale W6 STATUS heading fixed, and CI
repaired — PR #33's dialog change gated the delete-files checkbox on write
mode, and library.spec still expected it unconditionally (the full e2e suite
had last run before that change; only the file-browser/player specs ran after).

Gates: backend 815 (+8: contact sheets ×5, random view ×3), web 435 unit /
93 e2e, Rust 102, all static checks clean, OpenAPI + schema.d.ts regenerated.
Live-verified against the running Demo library: nav history round trip, info
sidebar jump, context menus (video and image shapes), Random shuffle +
reshuffle, contact sheet end-to-end ("Building…" → "saved", 1286×726 4×4
JPEG), drop net + guidance flash. Not verifiable here: the desktop-only pieces
(export folder picker, drop-on-bundle with write mode, titlebar clearance) are
covered by Rust tests/typechecking and need an owner pass in the shell.

## Merged: plan 4 W6 — write-mode hardening (2026-07-26, PR #33)

Branch `fix/write-mode-hardening`, rebased onto `main` at `90a71d4`. W6 is the last
unblocked write-mode slice (W2 still waits on plan 1 M11, which is in the future
bucket), and it is a bag of independent items rather than one change. **The
correctness and safety items are done; three feature-sized ones are deliberately
not, and are listed with reasons below.** Landed:

**The desktop importer's library id (the PR #30 review's hardening note).** It
reached the upload URL through `format!` into a string that was then parsed, so an
id carrying `..`, `?`, `#` or an extra `/` restructured the URL. The reason it was
reachable at all: `media_proxy::target_for` accepts _any_ non-empty id — it
consults the id only to decide whether to attach the bearer token — so nothing
upstream constrained the value. With `server_scoped_token` set the token is
attached regardless, which made the worst case an authenticated POST carrying the
file's bytes aimed at an arbitrary path on the local server. Now the path is built
with `path_segments_mut` (which percent-encodes each segment) and the id is
shape-checked in one shared place: `mappings::validate_library_id` had only
rejected the empty string, so the mapping lookups were equally unguarded. Server
ids are ULIDs, so the accepted charset (`[A-Za-z0-9_-]`) is comfortably
permissive. Rust **101 passed** (+3: a real ULID through a trailing-slash base, a
table of seven hostile ids, and the charset itself).

**EXDEV — cross-device moves** (owner approved the copy-then-delete approach).
`os.rename` cannot cross a filesystem boundary, and a library root can easily span
one. All four relocating operations — rename, move, trash, restore — now funnel
through one `file_ops/fsmove.py`, which keeps the existing case-only-rename
handling and adds the fallback.

The ordering is the safety property: copy to a hidden staging name **beside the
destination** (so the commit is a same-filesystem, atomic rename), flush, commit,
and only then remove the original. Every interruption leaves the bytes readable at
one path or both — never neither. The commit also refuses an occupied destination
outright, where `os.rename` would have clobbered it silently.

**The crash window needed the reconciler to learn a new state.** Between commit
and removal both copies exist — something a plain rename can never produce, so the
reconciler had been calling it undecidable and failing the operation. It now
finishes the metadata at the destination and records the leftover original in
`leftover_source_paths` **rather than deleting it**: automatic recovery destroying
original media is exactly what ADR-0013 forbids, so the duplicate is the owner's to
remove through the ordinary journaled trash once they can see it.

**The evidence is an explicit marker file, not inference.** The first cut compared
size and mtime, which would have called two same-sized files written moments apart
a copy — and that guess repoints an owner's metadata onto the wrong file. It also
silently broke the existing "refuses to guess when both paths exist" test, which is
how it was caught. A marker written across exactly that window settles it, mirroring
how an interrupted import is identified by its leftover staging file; without one,
the both-present case stays as ambiguous as it always was, which a test now pins.

Known costs, recorded rather than solved: a cross-device move takes as long as the
bytes take and needs room for a second copy while it runs, and moves are still
synchronous (the `file_ops_batch` job is a separate W6 item). Directory trees are
copied recursively with the same commit ordering, but their per-file durability
flush is skipped as disproportionate — a power loss mid-tree leaves the source
intact and an inert hidden staging directory.

Backend **795 passed** (+10: the fallback for files and directories, staging
cleanup, the refusal to overwrite, the source surviving a failed copy, both
reconciler branches, and trash/restore across a boundary).

**Also already done, found while surveying:** case-only renames on
case-insensitive filesystems were already handled; that logic moved into `fsmove`
unchanged.

**Bundle "delete with files"** (the smallest remaining W4 piece). The Delete
dialog's checkbox had been inert since it was added — `App` took the flag and
dropped it under a "not wired yet" comment, so the dialog asked a question and
then ignored the answer. A write-gated `POST /bundles/{id}/delete-with-files`
trashes the bundle's files and then removes it: trash-first like every other
deletion, so it is undoable and the files stay listed until the trash is emptied.

A separate route rather than a flag on `DELETE`, because the two have different
gates — dissolving a grouping is metadata-only and must stay available on a
read-only library, while deleting files is a guarded write it has to refuse.
An empty bundle returns `null`: there was no file operation, so there is nothing
to undo and nothing worth inventing.

Opening the real dialog caught what reading it had not: with the checkbox now
live, its opening line still promised the files "always stay on disk" and its
Unbundled clause described a fallback that no longer applied. Both now follow the
checkbox, and the checkbox itself appears only where write mode allows it.

**Trash retention.** `CAIRNDEX_TRASH_RETENTION_DAYS` empties expired trash when a
library opens, reusing the `older_than_days` path that already existed and was
already tested. Off by default and deliberately so — the trash is what makes
deleting recoverable — with its own session and `try/except` so a failed sweep
never costs the reconciliation that ran before it.

**Deployment/backup docs.** The retention variable, and a new section on libraries
that span more than one filesystem: what the EXDEV fallback costs (a move becomes
a copy, so it needs time and room for a second copy) and what an interrupted one
leaves (a duplicate, never a hole).

Backend **801 passed**, web **427 passed**, Rust **101 passed**; OpenAPI and
`schema.d.ts` regenerated for the new route.

### Deliberately not done, and why

These are feature-sized rather than hardening, and each is its own reviewable
slice. W6 is proposed as closed without them; reopen or re-file as preferred.

- **Drag-move onto a directory row.** The capability exists via the Move to…
  dialog; this is a second _gesture_ for it, threaded through the File Browser's
  marquee and native drag-_out_ system. W3 already called it a slice of its own
  and nothing since has made it smaller.
- **`file_ops_batch` job + the multi-item plan/preview endpoint.** Both are about
  making bulk moves asynchronous and previewable. Worth more now than when W3
  deferred them, because a cross-device move is a copy and can be genuinely long —
  but that is an argument for designing them against the new cost, not for
  bolting them on at the end of this branch.
- **Journal history UI.** A read-only view over `file_operations`, which the API
  already exposes. Straightforward, but it is a new surface with its own layout
  and empty/error states, not a hardening fix.

Two smaller ones judged **not worth doing**, rather than merely deferred:

- **Auto-suffixing within a move batch.** Two selected items that would land on the
  same name are refused up front. That was a deliberate narrowing — the one
  outcome the never-overwrite rule forbids — and silently renaming one of the
  owner's files to resolve a collision they did not know they had created is worse
  than the refusal. Left as an owner call.
- **The two move-undo manual-recovery cases** from the W3 review. Both leave the
  affected file visible and restorable in the Trash; neither loses data. The fix
  is bookkeeping to re-associate a `replaced_operation_id` written at `finish`,
  which would mean journaling it earlier — a change to the crash-recovery contract
  for a case whose current outcome is "recoverable, manually".

A **perf pass on bulk ops** was not run: it needs a representative large library,
which is the owner's to point at (AGENTS.md asks for recorded baselines rather
than claims).

## Merged: collection-creation affordances (2026-07-26)

Branch `fix/collection-creation-affordances`, fast-forwarded into `main` at
`90a71d4` at the owner's request (no PR).
Owner-reported: there was no way to add a collection from the grid or the shell
menu, no way to add a subcollection by right-clicking one, and the sidebar's **+**
created inside the currently open collection rather than at the top level.

**The + was the actual bug.** It inferred its parent from `selection.collectionId`,
so one button did two different things depending on what happened to be open — and
while browsing a collection there was _no_ way to ask for a top-level one. It is
now unconditionally top level, and nesting became its own gesture: **right-click a
collection → New Subcollection**. "New Collection" was added to the Collections
heading and its section run-out, both main-grid sections, and the native
**File → New Collection** (`CmdOrCtrl+Shift+N`, free — the keymap test pins that
accelerators are never reused). All routes end in the same inline rename box.

**Owner correction, second pass.** The grid's menu first created at the top level,
on the reasoning that the grid has no notion of "here" in the collection tree. It
does: the level being _looked at_. It now creates under `selection.collectionId`
and labels itself "New Subcollection" inside a collection, matching the section
heading, which reads "Subcollections" there. It also had to go on **both** grid
sections — a collection with no subcollections yet renders no collections section,
so the contents section is the only target that always exists. Two further
consequences of "it must end in the rename box": creating now unfolds the sidebar's
Collections section (a folded one hid the new row, leaving a collection named "New
Collection" and nowhere visible to name it), and the ancestor-expansion that
already existed matters more, since a grid-raised request can nest arbitrarily
deep. The native File menu deliberately stays top level, like the **+**: a global
command that silently nested would be a surprise.

**The shape worth remembering:** the sidebar keeps owning the create flow, because
the new row's inline rename (`editingId`) and ancestor expansion are its state.
Outside callers therefore raise a `newCollectionRequest` prop that the sidebar
consumes, mirroring how App delivers `deepLink`. It is consumed **by request
identity**, not by trusting the caller's clear callback: `createCollectionUnder`
changes identity whenever the collection list refetches — which creating one
causes — so a caller wired without the clear would otherwise have created in a
loop.

**One thing the live check caught.** The first draft hung the blank-space menu on
the whole `<aside>`, guarded only by "not a row or button". Probing the real DOM
showed the first matching blank point was the **app title** — right-clicking the
Cairndex wordmark would have offered to make a collection. Scoped to the
collections `.sidebar__section` instead, and verified in the running app that the
brand, the library selector and the jobs strip raise nothing while the heading,
the section, a collection row and the grid all raise the right menus.

**Tests:** web **427 passed** (+9 in a new `Sidebar.collections.test.tsx`: the +
at top level with a collection open, the subcollection menu, the heading menu, the
external request, single consumption under a refetch, per-parent name collision,
unfolding a folded section, and the rename box opening for both a click-raised and
a request-raised create — the last two needed a harness whose collection list
actually grows, since a mock that only answers `onSuccess` can assert a payload but
never shows what the user sees next). Rust **98 passed** — the shell builds its menu from `keymap.json`, so
the new item needed no Rust change beyond staying inside the existing contract.
Verified live against the running dev server (menus only; no collections were
created in the owner's real library).

**Not done:** the desktop **File → New Collection** item cannot be exercised in a
browser, so it is covered by the keymap contract test rather than end-to-end.

## Merged: one media viewer shell for both browsing surfaces (2026-07-26)

Branch `feat/file-browser-app-player`, off `main` at `1f8b147`. Owner-reported:
playing a video from the File Browser did not use the app's player. It didn't —
the File Browser had kept its own path-based lightbox (`FileEntryViewer`) with a
bare `<video controls>` since plan 1 M2, a deferral recorded in this file at the
time and now closed.

**Why it wasn't a small fix.** The player stack is addressed by
`file_id`/`bundle_id` — playback manifest, decision/session, storyboard,
progress, subtitles — while the File Browser addresses entries by
library-relative path, and an entry need not be indexed at all. The two surfaces
have genuinely different identity models, so routing one into the other's viewer
would have meant either faking an `AssetFile` row for a bare path or letting the
File Browser inherit a bundle's playlist.

**What landed:**

- `viewer/viewerItem.ts` — `ViewerItem`, the normalized shape a `FileRead` and a
  `FileBrowserEntry` both map into, with the fields a bare path genuinely lacks
  (`fileId`, `bundleId`, `coverTime`, `canSetCover`) explicitly null rather than
  invented. This is the seam; nothing downstream asks where an item came from.
- `viewer/ViewerShell.tsx` — the chrome, playback engine, stages, control bar,
  info panel, shortcuts and recovery budgets, extracted from `MediaViewer`
  unchanged in behavior. `MediaViewer` and `FileEntryViewer` are now thin
  containers over it, differing only in where the playlist and the playback entry
  come from.
- `useHlsSession` gained a **native-only mode**: `fileId: null` with a
  `directStreamUrl` plays the bytes without a decision round-trip, because an
  unindexed path has no row to remux/transcode against. Its freshness check moved
  from `fileId` to `fileId ?? directStreamUrl` — every unindexed path shares a
  null id, so keying on it alone carried one file's playhead into the next.
- `ImageStage` takes tier sources instead of a `FileRead`, so File Browser images
  get zoom/pan too. Their tiers start at `preview1600` (a File Browser row has no
  cover thumbnail to borrow).
- `ControlBar`/`SettingsMenu` take an optional cover group; an unindexed path
  hides it rather than offering a cover it cannot set.
- The dead `.viewer__*` lightbox CSS is gone.

**Deliberately kept:** the File Browser still owns its playlist, so stepping
walks the folder's openable files in listing order — opening a file that happens
to belong to a bundle does not switch the playlist to that bundle. Arrow keys
seek, as they do in the bundle viewer; file stepping is the chevrons and
`Cmd/Ctrl+[`/`]`.

**Degradation for an unindexed path**, all for want of a file row: no subtitles,
storyboard, chapters, or saved position, and no server-side remux/transcode, so
an undecodable codec fails as it did before. A _linked_ entry resolves its real
manifest row and behaves exactly like opening it from its bundle, resume
included; if the manifest has no row for it (never probed), it falls back to the
direct path entry rather than hanging on "Preparing playback…".

**Tests run:** frontend `npm run lint`, `format:check`, `typecheck`, `test`
(57 files, 418 tests), `build`; full Playwright suite (92 passed, including the
`@fullstack` backend-backed player specs). New coverage: `viewerItem.test.ts`
(adapter identity, tier lists, type-label fallback), three `useHlsSession` tests
for native-only mode and the playhead-carry bug, and two `player.spec.ts` e2e
tests — a linked File Browser video reaching the real pipeline with no native
`controls` attribute and arrow-seek, and an unindexed one playing from
`/file?path=` with **zero** decision/session requests and folder-scoped stepping.

**No backend or API change**, so OpenAPI and `schema.d.ts` were not regenerated.

**Review catch before merge:** the extracted Stage had dropped the old
lightbox's audio branch — the server marks audio openable, so a File Browser
`.mp3` would have hit the fallback card. Restored as the native audio element,
with its errors routed straight to the failed card (audio has no
decision/session pipeline, so the video recovery budget would have swallowed
them). Pinned by the file-browser e2e spec with a generated WAV.

**Verified:** owner tested the branch hands-on and reported no issues; full
frontend gate and Playwright suite (92) green.

## Merged: post-merge interaction fixes (2026-07-26)

Branch `fix/post-merge-fixes`, 11 commits, merged as PR #31 (`1f8b147`). Owner
testing of the merged build produced several rounds of drag-and-drop, selection
and layout fixes; the branch history was squashed from 37 commits to 11 coherent
ones (same tree) before review. The findings worth carrying forward:

**`tsc --noEmit` checks nothing in this repo.** The root `tsconfig.json` is
`files: []` with project references, so bare `tsc` silently no-ops. The gate is
`npm run typecheck` (`tsc -b`), which is what `just check-web` runs — an agent
reaching for `npx tsc --noEmit` will get a clean result from an empty check, and
did, for a whole session. Two latent runtime crashes reached the branch that way.
Related: annotating a callback parameter inside `useMutation` collapses TanStack's
generic inference and makes `mutate` accept anything, so a call site on a retired
contract still type-checks.

**Drag-and-drop has a settled model now; keep to it.** A drop resolves to a
_destination_ — the item a block lands in front of, the end of a group, or "nest
into this one" — and that single value paints the seam and commits the move, so
the two cannot disagree. The container owns the gesture; cards and rows carry
only dragstart/dragend. The dragged payload lives in a synchronous store
(`dnd.ts`), never React state, because a fast drag delivers its drop before a
render. The server takes moves, not orders, and answers with the resulting order,
which the client applies without refetching. Manual order is directionless.
Reordering never bumps `updated_at`. Most of the bug reports on this branch were
some version of violating one of those.

**Tauri's `dragDropEnabled` is a whole-pipeline switch, not a feature toggle.**
With it `true` (the default), tauri-runtime-wry answers _every_ drag event as
handled, which wry reports to WKWebView as "block the OS default" — and that
takes the page's own HTML5 drag events with it. Internal drag-and-drop had
therefore never worked in the desktop shell; it works in a browser, which is why
it looked like a styling problem for so long. It is now `false` in
`tauri.conf.json`. The consequence: OS drops arrive as ordinary HTML5 `File`
drops through the browser import path, so the shell's byte-level import progress
and its deterministic self-drop detection are bypassed. The native plumbing is
left in place, unused, pending a decision — either keep `false` and delete it, or
restore it behind a narrower per-event answer.

**A Tauri capability denial is silent, and looks exactly like a UI bug.** The
merged title bar's drag regions were correct in the DOM and still did nothing:
`capabilities/default.json` had never granted `core:window:allow-start-dragging`,
so the drag script's `invoke` was refused by the permission layer with no
console error and no visible failure. The file's own description already warned
that `core:window:default` grants only getters — every mutating window command
must be listed. When a shell-only interaction does nothing at all, check the
capability before the code.

**WebKit and Chromium disagree about drag and selection enough that a browser
check is not a desktop check.** Three separate fixes passed in the preview pane
and failed in the shell: an app-wide `user-select: none` silently prevented every
`dragstart` (WebKit refuses to start a drag inside an unselectable subtree);
negative `setDragImage` offsets are clamped, so the drag pill's offset has to be
baked into the image as transparent padding; and a cover image is both a native
drag source and a **Live Text** surface, so it stole the gestures aimed at the
card behind it. Anything touching drag or selection needs a desktop pass.

## Rebuilt: drag-reorder's underlying model (2026-07-25)

After ~10 rounds of symptom fixes, the owner (rightly) called for a rethink. The
stable design that came out, for future reference:

- **The request carries the move, not an order**: `(moved_ids, before_id)`;
  the server resolves it against the whole scope and **returns the resulting
  order**, which the client applies directly. Nothing refetches after a reorder
  — a refetch is a second answer to a settled question, and any disagreement
  paints as a phantom second move.
- **Manual order is directionless.** `manual desc` gave one arrangement two
  coordinate systems; every translation between them was a bug. The client
  coerces manual to ascending and hides the direction toggle.
- **One gap computation** (`computeGap` in Browser.tsx) feeds both the
  insertion indicator and the drop commit; cards have no reorder handlers.
  Indicator == outcome by construction.
- **Reordering preserves `updated_at`** (`_write_manual_order` diffs and
  carries the timestamp forward past the `onupdate` default) — a drag must not
  mark every bundle in the library modified.
- Reorder mutations are serialized (`scope: {id}`), so overlapping drags apply
  in commit order.

## Fixed: a non-empty trash vanished from the UI with write mode off (2026-07-24)

The final owner review of PR #30 (whole-track pass: the move-undo fix verified,
the desktop importer's drop-allowlist and token scoping reviewed, all three
suites re-run clean) found one inconsistency worth fixing before merge: **the
sidebar's Trash entry rendered only while write mode was on**, while the server
deliberately keeps `GET /file-ops/trash` readable without it — its docstring
names hiding the trash as exactly the wrong outcome, because files an owner
deleted must never _look_ permanently gone. Delete files, flip write mode off
(or have the deployment flip it), and the Trash view disappeared with the files
still in it.

Now the entry shows when write mode is on **or the trash holds anything** (a
cheap peek query that runs only with write mode off, kept fresh by the same
invalidation as every file operation), and `TrashView` goes read-only without
write mode: contents and original paths visible, a note explaining why, Put
back and Empty Trash present but disabled — a control that disappears reads as
a file that cannot come back. A library that never deleted anything still shows
no entry. Verified end-to-end against a live dev server (trash a file, disable
write mode, observe the entry, the note, and both buttons disabled). Web **372
passed** (+3: the App-level visibility policy both ways, and the read-only
view). The review's two hardening notes — the importer's unescaped `library_id`
interpolation and the duplicate-basename progress-list nit — are W6.

## Fixed: move-undo could silently overwrite a newcomer (2026-07-23)

An owner review of W3 found one real bug in the move-undo path, and confirmed
the three earlier fixes generalized correctly to move (the `skipped` guard and
`_ensure_replacement_restorable` both run for `MOVE` before anything touches the
disk).

**The bug: undoing a move silently overwrote whatever now sat at the vacated
path.** The `MOVE` branch of `undo` called `_rename_on_disk(destination, source)`
with no occupancy check on the source, and POSIX `rename` clobbers its target
silently. Reproduced: move `a.mkv` into `sub/`, drop a _new_ `a.mkv` at the root
(an import, a Finder copy, a re-download), press Undo — the undo succeeded and the
newcomer's bytes were gone, not trashed, not journaled, not errored. It was the
only data-destroying path in write mode that is not Empty Trash, and it was a
toast-button away. Every neighboring inverse already guards against exactly this:
undo-of-rename answers 409 through the collision policy, and `restore` runs
`_ensure_restorable` first. Move was the one that skipped it.

The fix mirrors `_ensure_restorable`: a new `_ensure_move_reversible` checks every
entry's source path — against both the filesystem and the linked rows — before
moving anything, and refuses the whole undo with a clear message naming the
occupied path. All-or-nothing, up front, like restore. It also absorbs the
metadata echo the review noted (a linked newcomer would have hit the unique
constraint _after_ the bytes were destroyed) and most of the mid-undo `OSError`
window (the occupied-source case was its main non-error trigger). Backend
**766 passed** (+3 regression tests, each confirmed to fail against the old code).

**Two non-blocking observations from the same review are left as known
limitations**, both manual-recovery and neither data-losing: (1) a Replace entry
whose _own_ rename then fails leaves its displaced file in the trash as its own
operation — visible and restorable there — but the failed entry drops out of the
move payload, so undo will not bring it back automatically; (2) a crash mid-batch
loses the `replaced_operation_id` association for the same reason (it is written
at `finish`), so a reconciled replacing-move has the same manual-recovery story.
Both are W6 alongside the move batch job.

## Implemented: plan 4 W3 — move (2026-07-23)

Same branch. Move turned out **smaller than the plan sketched**, because W1's
rename and W4's trash had already built its machinery: a move is a rename that
changes the parent instead of the name, so it reuses `_rename_on_disk`,
`repoint_linked_rows`, the collision policies, and trash-then-write Replace
almost wholesale.

**Server.** `operations.move` takes a list of paths and one destination
directory and records the whole selection as **one journal `MOVE` operation
with one undo**. The shape that mattered:

- **Collisions are resolved before the disk is touched.** A `fail` answer moves
  nothing and returns the same 409 `path_conflict` rename does, so the client
  can ask; `skip`/`suffix`/`replace` settle per entry. Replace files its
  displaced file as its own trash operation, recorded _per moved entry_ (a
  batch can displace more than one), which is why undo restores every one of
  them and refuses up front if any was already emptied.
- **A per-file `OSError` is tolerated like a partly-failed delete** — the
  entries that moved are recorded, the rest reported in `failed_paths` — and for
  the same reason: failing the whole operation would point already-moved files
  at paths that no longer hold them, and the reconciler only inspects `pending`
  rows so nothing would notice.
- **Two selected items that would share a destination name are refused** before
  anything moves, rather than allowed to clobber on disk — the one outcome the
  "never overwrite original media" rule forbids. (Auto-suffixing within a batch
  is a W6 refinement.)
- **Reconcile and undo both walk the entries.** Reconcile completes whatever
  actually reached the disk (partial, like a delete); undo moves each entry back
  in reverse — a directory before anything that rode out inside it — and
  restores any displaced file once its path is free again. A directory refuses
  to move into its own subtree.

**Web.** A **Move to… destination picker** (`DirectoryPicker`) reached from the
context menu on files, directories, and multi-selections. It navigates the
library's own directory tree one level at a time — a breadcrumb plus the
subfolders at each level — so the destination is always a real, in-root folder
the owner can see rather than a typed path. The folders being moved are removed
from the tree, because a folder cannot be moved into itself. A collision raises
the shared Replace / Skip / Keep both prompt, applied to the whole batch (the
Eagle/Finder "apply to all") and re-issued in one call. Verified against a real
dev server: the picker renders, the breadcrumb descends the tree, and the moved
folder is correctly excluded from it.

**Deferred, and the one piece of W3 that did not land: drag-move onto a
directory row.** The File Browser's drag system is already intricate — a
rubber-band marquee interleaved with native file-promise drag-_out_ to the OS —
and wiring an internal drag-_move_ target correctly alongside it is a slice of
its own. The dialog delivers the capability; drag is a second gesture for the
same thing, and folding it into the existing DnD deserves its own change rather
than riding on this one. Also not built here, and consistent with how W4/W5
shipped: the multi-item plan/preview endpoint (§4) and the `file_ops_batch`
job for bulk moves (§3.4) — moves run synchronously like trash and import, and
collisions surface as a 409 rather than a preview step. Both are W6.

**Tests.** Backend **763 passed** (+20: move round-trips, directory-subtree
moves, the collision policies, batch undo, the partial-failure and
same-name-clobber guards, reconcile partial/never-happened, plus three API-level
move tests). Web **369 passed** (+4 move-flow component tests). All static gates
clean; OpenAPI and `schema.d.ts` regenerated for `POST /file-ops/move`.

## Fixed: three write-mode review findings (2026-07-23)

An owner review of W4/W5 found three real bugs, all mine, none covered by the
743 tests that were passing. Each now has a regression test that was confirmed
to fail against the old code before the fix went in.

**1. A partly failed delete stranded files invisibly.** When an `OSError` hit
partway through a multi-path delete, `journal.fail` rolled the row updates back
and marked the operation failed — while the entries moved _before_ the failure
were already inside `.cairndex/trash/{op_id}/`. The trash listing only shows
`done` operations, restore refuses a failed one, and Empty Trash never prunes
it: the files were gone from their original path and reachable by nothing.

That is precisely the state `_settle_trash` was written to prevent, and the
lesson is the interesting part: **the reconciler only ever inspects `pending`
rows**, so it could not have caught this. The crash-shaped version of the bug
was handled; the mid-request version recreated it three lines away. `trash_paths`
now does what the reconciler does — completes for what moved, reports the rest
in a new `failed_paths` field, and only fails outright when nothing moved at all.
Real trigger: a multi-select delete where one item hits a permissions error on an
SMB/NAS mount.

**2. Undoing a _skipped_ import trashed the innocent file.** A skipped import
finishes `done` with its destination pointing at the file that was already
there — the one it deliberately did not overwrite. Undo saw a file at the
destination and moved it to the trash. Undo now refuses a skipped operation,
and the same guard covers a skipped rename, whose no-op journal row now records
`skipped` for consistency.

**3. Undo of a Replace after Empty Trash half-executed.** The inverse rename ran
first, _then_ the restore raised 409 because the trash op had been emptied — so
`mark_undone` never ran: the file was renamed back on disk while the journal
still advertised the operation as undoable, and a second attempt 404'd on the
now-missing source. Both undo paths (rename and import) now check the replaced
operation's status **before touching the disk** and refuse with a clear reason.
The choice was refuse-entirely over proceed-partially: a half-undo with no way
to finish is worse than a clear no.

**Also fixed, from the same review's non-blocking observation:** a crash mid-
upload for a Replace import was reconciled as `done` because its destination
existed — that being the _old_ file, still in place. The staging `.part` file is
the evidence that settles it, and reconciliation already runs before the sweep
that removes it, so it was there to be read all along.

Verified against a real dev server as well as in tests: a delete where the
second path is unwritable now leaves the first in the Trash view and restorable,
and both undo refusals leave the files exactly where they were.

Backend **743 passed** (+7), web **365 passed** (+1, the partial-failure
message), all static gates clean, OpenAPI and `schema.d.ts` regenerated for the
new `failed_paths` field.

## Implemented: plan 4 W5 desktop bridge — Finder drag-in (2026-07-23)

Same branch. The thing write mode was built for: dragging media from Finder onto
the app copies it in.

**Why it needed Rust at all.** Tauri's `dragDropEnabled` intercepts an OS drop
_before_ the webview sees it, so the browser-side upload flow never fires in the
shell — the drop arrives as absolute paths, and a webview cannot turn an
absolute path into a readable `File`. `importer.rs` streams the file to the
import endpoint from a file handle, so a 60 GB video costs constant memory on
both ends.

**The security shape is the part worth reviewing.** A command that reads a
caller-named path and posts its contents to a server is a materially bigger
capability than anything the shell had before — `reverse_map_paths` already
accepts absolute paths from the web layer, but statting a path leaks its
existence while uploading one leaks its contents. Two rules bound it:

1. **Only paths the user actually dropped.** The shell records each drop's paths
   from the _window event_ — its own observation, not the webview's report — and
   refuses to upload anything it has not seen. Comparison is canonicalized, so a
   symlink cannot smuggle a different file past a matching string, and each drop
   replaces the last rather than accumulating a growing allowlist.
2. **The destination is not the caller's to choose.** Server URL and bearer come
   from the media proxy's own configuration via a shared `target_for`, which
   applies the _same_ per-library token scoping the media relay does — shared
   rather than re-derived so the rule cannot be changed in one place and
   forgotten in the other.

**The drop keeps every rule the browser path has**: one file at a time, a
collision asks with the full Replace / Keep both prompt, the answer applies only
to the file it was about, and each import is undoable on its own. Files already
inside the library still link in place, so a mixed drop does the right thing
with both halves. Where they land: the folder on screen when the Files surface
is open, the library root otherwise.

Verification: desktop `cargo fmt --check`, Clippy `-D warnings`, **91 unit
tests** (+5: only-dropped-paths, drop replacement, a non-existent path, and the
import URL preserving a base path and defaulting to `fail`), and a release
`npm run tauri build` producing `Cairndex.app` and its DMG. Web Prettier,
ESLint, `tsc -b`, full Vitest (**364 passed**, +8 covering the sequential loop,
a mid-batch collision resuming with the answer scoped to one file, dismissal,
the Tauri error shape, and the destination folder), the Vite build.

**Still needs the owner: the native drag gesture on a packaged build.** Same
limitation as plan 3 D4 — a real Finder drag cannot be driven from here. The
command underneath it is unit-tested and the app builds; what is unverified is
the gesture.

**Two stale claims corrected in the same change**, because they became untrue
here rather than gradually: `docs/architecture.md` and `docs/deployment.md` both
still said the app never moves, renames, deletes or rewrites source files.

## Implemented (partly): plan 4 W5 — importing external files (2026-07-23)

Same branch. The only path by which bytes from outside a library ever enter it.

**Two deviations from plan 4 §6, both deliberate.**

1. **Raw body, not multipart.** The caller already holds a `File` (browser) or
   an open file handle (shell); both stream as a request body with no encoding
   step, and it keeps `python-multipart` out of the dependency list for a
   request that is ~100% payload. Metadata rides in the query string.
2. **One file per request.** A twelve-file drop is twelve imports. That is what
   makes per-file progress, per-file collision answers and per-file undo
   possible; batching would have made all three worse in exchange for a round
   trip.

**Nothing is held in memory.** The body is written in 1 MB chunks to
`.cairndex/tmp/{op_id}.part` — inside the package, so it is on the _same
filesystem as the destination_ and the final step is a rename rather than a
second full copy. Verified with a 3 MB file: byte-identical sha256, empty
staging directory afterwards. The size limit is enforced _while streaming_
rather than from a `Content-Length`, because trusting the client about the
number you are limiting is not a limit.

**Failure paths are the interesting part**, and all leave nothing behind: an
over-limit upload, an empty body, a destination that stops being valid mid-flight
— each discards the partial file and records a `failed` journal row. A crash
leaves a `.part` that the next library open sweeps, next to the journal
reconciler. Undo of an import moves the file to the **trash**, not an unlink, so
undo is never the one action in the app that destroys something.

**The collision prompt is finally complete**, which is what the W4-before-W5
reorder bought: import can offer Replace, and it means trash-then-write.
A collision mid-batch asks and then resumes the remainder, with the answer
applied only to the file it was about — a later collision still asks.

**What is missing, and it is the owner's driving use case: the desktop drag-in.**
`onCopyIntoLibrary` is still unwired, so dragging from Finder onto the packaged
app still shows the "move these into its folder first" explanation. The reason
is structural rather than an oversight: Tauri's `dragDropEnabled` intercepts an
OS drop **before** the webview sees it, so the browser drop handler built here
never fires in the shell; the drop arrives as absolute paths, and the web layer
cannot read those paths by design (plan 3 §5). Closing it needs a Rust command
that streams a local file to the import endpoint using the shell's existing
server URL and bearer credential — `media_proxy.rs` already holds both, so the
pieces exist. **This should be the next task in the track.**

Verification: backend Ruff, `ruff format --check`, mypy, full pytest
(**736 passed**, +18: chunked streaming, subfolder targeting, the gate, five
unsafe-destination rejections, collision-before-upload, Replace-into-trash,
skip, linking, undo-to-trash, the empty body, the streaming size limit, and the
staging sweep). Web Prettier, ESLint, `tsc -b`, full Vitest (**356 passed**,
+4: destination is the browsed folder, sequential uploads, a mid-batch collision
resuming, and a read-only library having no way in), the Vite build.
Manually verified against a real dev server: a 3 MB import byte-for-byte, the
`Add Files…` picker path end to end with its toast and Undo, and undo landing
the file in the trash. Scratch library removed.

## Implemented: plan 4 W4 — trash-first deletion and Replace (2026-07-23)

Same branch. **Moved ahead of W5 at the owner's request** after W1 surfaced the
dependency: Replace is defined as trash-then-write, so import could not offer
the full Eagle/Finder prompt until the trash existed. It does now.

**Deletion is a rename, not an unlink.** Entries move to
`.cairndex/trash/{op_id}/files/<original path>`. That layout is doing three
jobs: same filesystem means the move is instant and atomic whatever the file's
size; inside `.cairndex/` means it is already invisible to scanning and travels
with the library (ADR-0008); one directory per operation means a deleted folder
restores as a folder, without reconstructing its shape from a manifest.

**Restoring is lossless because nothing was ever recreated.** The `AssetFile`
row is kept and flipped to a new `trashed` availability, so the id — and with
it the bundle membership, cover, subtitle links and cache identity — is the
same row coming back.

**Three decisions worth carrying into W3/W5.**

1. **A trashed row's `relative_path` moves _into_ the trash**, rather than
   staying at the original path. `relative_path` means "where the bytes are",
   and after a delete they really are in there. The consequence that matters:
   the original path stops being occupied, so something else can take it —
   which is exactly what Replace needs, and what the uniqueness constraint
   would otherwise have blocked.
2. **`trashed` is deliberately not `missing`.** Missing means "we do not know
   where this went" and belongs to the repair machinery; trashed means "we put
   it there". The scanner's missing sweep skips trashed rows — without that, the
   first scan after any deletion would empty the Trash view into Missing Files
   and make every restore look like a repair.
3. **A Replace files its displaced file as an ordinary `trash` operation of its
   own**, and the rename records `replaced_operation_id`. The first attempt
   recorded it as a footnote inside the rename's payload, and the Trash view
   could not see it — a file the UI called permanently gone while it sat
   recoverable on disk. Making it a real deletion fixed the listing, restore,
   and Empty Trash in one change instead of three.

**The reconciler now settles a deletion partially**, and it is the only
operation that does. A crash halfway through a multi-path delete leaves some
entries in the trash; failing the whole operation would leave them there with
nothing listing them — invisible and unrestorable. So whatever reached the trash
is recorded and the deletion completes; what did not move is simply still in
place.

**Empty Trash is the one action in write mode with no way back**, and the UI
says so in those words, with the amount of space it will reclaim. There is no
automatic expiry; retention (`older_than_days`) exists in the service and is not
yet wired to a schedule.

Verification: backend Ruff, `ruff format --check`, mypy, full pytest
(**718 passed**, +22 covering the trash round trip with cover survival,
directory subtree deletion as one operation, nested-path de-duplication,
whole-or-nothing restore refusal, restore into a folder that no longer exists,
Empty Trash deleting rows and bytes, retention, the scanner's trashed skip,
Replace's trash-then-write, undoing a Replace restoring both files, and two
interrupted-deletion reconciliation cases). Web Prettier, ESLint, `tsc -b`, full
Vitest (**352 passed**, +10), the Vite build.

**Manually verified end to end** against a real dev server and a scratch
library: delete a linked file (the confirmation names the bundle impact), the
Trash view listing it with its original path, Put back restoring it, Replace
displacing the old file into the trash while the new bytes take the path,
undoing that Replace bringing **both** files back, and — the one that would have
been silent — a full scan after a deletion reporting `missing: 0` rather than
sweeping the trashed file into Missing Files. Scratch library deregistered and
deleted afterwards.

**Not included, and the smallest thing left in W4:** the bundle-level "Delete
bundle and trash its N files" action. It is a Bundle Browser affordance rather
than a trash mechanism — everything it needs now exists server-side.

## Implemented: plan 4 W1 — the journal, rename and New Folder (2026-07-23)

Same branch as W0. The first operations that actually touch files, and the
machinery that makes them safe to have.

**The invariant W1 exists to deliver:** a rename performed _by_ Cairndex needs
no repair, ever. The `os.rename` and the `AssetFile.relative_path` update happen
in one operation, so `AssetFile.id` is preserved by construction and bundle
membership, covers, subtitle links, notes, ratings and cache identity survive
without anything having to infer what happened. ADR-0006's moved-file repair
stays underneath as the backstop for changes made _outside_ the app.

**The journal is intent-before-action.** A `pending` row in `library.db` is
committed _before_ the filesystem is touched; the content rows and the `done`
status then land in one transaction. A crash in between leaves a `pending` row
that the reconciler settles on next library open by reading the filesystem —
source gone + destination present means finish the metadata side, the reverse
means it never happened, and **anything else is left alone and marked failed**
rather than guessed at. The reconciler never raises: a library that cannot be
reconciled must still open, or a recoverable disagreement becomes a lost
library.

**Two narrowings against the plan, both deliberate.**

1. **`replace` is not in the collision enum.** ADR-0013 defines it as journaled
   trash-then-write, precisely so Replace is never a byte-level overwrite. The
   trash is W4. Implementing the word before the mechanism would ship the one
   collision answer with no way back, so W1 offers `fail | skip | suffix` and
   the dialog says Keep both / Cancel. Adding the member later is additive for
   every client. **This has a sequencing consequence for W5** (import, which the
   owner put next, ahead of W4): it will meet the same wall. Either import
   offers the two safe answers, or W4 moves ahead of it — a decision worth
   making at the start of W5, not in the dialog.
2. **The validator refuses more than the ADR listed:** `.cairndex/` from both
   directions (a rename in there would corrupt the library through an
   ordinary-looking operation), dot-leading names (File Browser hides them, so
   creating one looks exactly like the operation failing), and trailing-dot
   names (POSIX keeps them, Windows and some SMB servers silently drop them, so
   one file ends up answering to two names that disagree).

**Undo is the journal's, not the UI's.** Each completed operation's toast
carries the inverse the journal recorded; applying it flips the row to `undone`
rather than deleting it, and the inverse rename does _not_ leave a second entry
pretending to be a user action. A `mkdir` undo refuses a folder that is no
longer empty — at that point removing it would be a delete, not an undo.

Verification: backend Ruff, `ruff format --check`, mypy, full pytest
(**696 passed**, +55 across `test_file_ops.py` and `test_file_ops_api.py`:
validator rejections on both source and destination, `.cairndex` and
symlink-escape refusals, directory-subtree renames matched on segments, cover
and membership survival, all three collision policies, the linked-row conflict
caught _before_ the file moves, an OS-level failure journaled as failed, undo
round trips, and four crash-recovery cases including the ambiguous one).
Web Prettier, ESLint, `tsc -b`, full Vitest (**342 passed**, +8), the Vite
build. OpenAPI and `schema.d.ts` regenerated.

**Manually verified against a real dev server and a scratch library**, because
this is the milestone where tests alone are not enough: rename through the
context menu (inline editor opens with the stem selected, not the extension),
the listing refreshing, the Undo toast reversing it on disk _and_ flipping the
journal row to `undone`, the collision dialog appearing with both files
untouched, New Folder creating a real directory — and, last, a planted
interrupted operation (filesystem half done, `pending` row committed, metadata
half missing) being reconciled to `done` on the next server start. Scratch
library deregistered and deleted afterwards.

One thing worth recording for whoever automates this next: driving the inline
editor needed a dispatched `keydown`, because the automation harness's synthetic
Return did not reach React's synthetic event as `Enter`. That is a harness
quirk, not an app defect — the same interaction works from a real keyboard and
is covered by the Vitest suite.

## Implemented: plan 4 W0 — the write-mode gate (2026-07-23)

Branch `feat/write-mode-w0-gate`, based on `main` at `7cf32ec`. Not merged; no
PR opened (owner-triggered). Three commits: the D7/phase-H docs already in the
working tree, the server gate, then the web toggle, with this documentation
slice on top.

**What landed is a refusal, not a capability.** Nothing in Cairndex writes to a
library yet. W0 exists so that the answer is already _no_ before there is
anything to say no to — every W1+ endpoint declares one dependency and inherits
a structured `403 write_mode_disabled` it cannot forget to check.

**Two switches, answering to two different people.** `CAIRNDEX_WRITE_MODE`
(`allowed` | `disabled`) belongs to whoever runs the server and can force every
library read-only. `registered_libraries.write_mode_enabled` belongs to the
owner, defaults off, and lives in the **registry** rather than the portable
manifest — so a library copied to another machine arrives read-only instead of
carrying permission with it (ADR-0013 §1, ADR-0008 portability). The refusal
names which gate said no, in `details.reason`, because the two have different
fixes and one of them may not be the user's to apply.

**One clarification against the plan, worth recording.** ADR-0013 says enabling
requires an unlocked session _and_ re-prompts for the passphrase. Implemented
literally, a locked library would cost two passphrase prompts to enable — one to
unlock, one to re-auth — for no security gain. So a correct passphrase presented
to `PUT /write-mode` authorizes that request **by itself**. It authorizes the one
request and not the session: the library stays locked for content afterwards,
which a test asserts. Disabling never asks for anything, deliberately — a
forgotten passphrase must not be able to strand a library in a writable state.

**The manifest still reads as protected when it is unreadable** (`is_protected`
fails closed), which means a library with a corrupt manifest cannot have write
mode turned on at all. That is the right failure: the one library whose auth
state we cannot determine is the last one that should gain the ability to move
files.

Verification at this commit: backend Ruff, `ruff format --check`, mypy, full
pytest (**641 passed**, +13 new write-mode cases covering both gates, the
passphrase re-auth and its generic 401, the locked-library single-prompt path,
the corrupt-manifest refusal, and a pre-ADR-0013 registry gaining the column
additively and defaulting to off); web Prettier, ESLint, `tsc -b`, full Vitest
(**334 passed**, +5 Library Manager cases), the Vite build, and the browser-only
Playwright partition (**87 passed**). OpenAPI and `schema.d.ts` regenerated. The
desktop gates were not run and did not need to be: no Rust changed, and the
toggle lives in the shared `apps/web` build the shell already hosts. Manually verified against a real dev server and a
scratch library: the toggle, its explanation step, the accent-on state, and the
flag surviving in the registry — then turned back off and the scratch library
deregistered.

**Next: W1** — the `file_operations` journal, the path validator, collision
policies, the reconciler on library open, and File Browser inline rename + New
Folder with an Undo toast. W5 (import external, the Finder drag-in driver)
follows W1.

## Closed: plan 3 D7 — first public release (2026-07-23)

Closed on the owner's instruction, with one item carried rather than claimed.

**What D7 delivered.** A pinned static ffmpeg for both macOS architectures,
chosen by verification rather than reputation — the licensing check disqualified
the obvious candidate. A tag-triggered release workflow that drafts a release
with a DMG, its checksum and the GPL notices, **proven by a real `v0.1.0` run
that went green on both architectures**. A README install section covering the
Open Anyway first launch, including that it repeats on every update. A GPL
written source offer whose configure lines and component versions are committed
rather than linked, so the three-year term does not depend on a third-party
host.

**Two defects that only building it could have found**, both fixed:

- The app bundle shipped an **invalid** signature — a signed executable with no
  `_CodeSignature` resource seal, which macOS rejects harder than an unsigned
  one. Invisible locally, because Gatekeeper only assesses quarantined apps.
- The HEIC dependency linked a **GPL x265 encoder** into the sidecar process for
  a codec path Cairndex never calls. Swapped to decode-only `pi-heif`, with a
  spec exclude and a build gate so it cannot return.

**Deferred behind write mode (owner, 2026-07-23):** an owner pass on a genuinely
downloaded build. Everything short of a browser round trip is verified — the
published artifact was downloaded, its checksum matched, the DMG mounted, and a
quarantined copy produced the expected Gatekeeper block and refused to launch.
The `v0.1.0` tag and draft release were deleted after the pipeline was proven;
re-tagging is a two-minute job whenever a real release is wanted, and
`docs/deployment.md` carries the runbook.

**Next recommended task: plan 4 W0** — the write-mode gate. Registry flag, env
master switch, structured 403, Library Manager toggle with re-auth when a
passphrase is set, and the AGENTS.md/CLAUDE.md safety-wording amendments that
[ADR-0013](adr/0013-library-write-mode.md) requires. It is the milestone that
makes every later write operation refusable by default, so it lands before any
of them.

## Done: CI cost reduction (2026-07-23)

Merged to `main` directly at the owner's request. Prompted by the Actions budget
being ~90% consumed for the month, and driven by measurement rather than
instinct — the intuitive suspect (the release workflow) turned out to be 10% of
the bill.

**Where the minutes actually went**, 30 days to 2026-07-23, computed from job
timestamps because the per-run billing endpoint reports zeroes:

|                                  | billable min | share |
| -------------------------------- | -----------: | ----: |
| `CI / Desktop shell (macOS)`     |        1,570 |   58% |
| all other CI jobs combined       |          860 |   32% |
| `Release` (one-off, both arches) |          261 |   10% |
| **total**                        |    **2,691** |       |

One job was 58% of everything, because the repository is private and macOS bills
at **10×**. Two facts made it worse: roughly **half of this repository's commits
touch only documentation** (12 of the last 25), and CI ran on both
`pull_request` _and_ the `push` that merged it — so a green PR's macOS build was
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

## Historical detail: plan 3 D7 — first public release (2026-07-22 → 2026-07-23)

Branch `feat/d7-first-public-release`, based on `main` at `94291e0`. Pushed and
merged through a PR at the owner's request (2026-07-23), after two review
rounds on the branch — the last engineering commit is `5e95d5d` (workflow
hardening).

_This section is the working record of the branch, kept for the reasoning in it.
D7 is closed; the summary is at the top of this file. Two things it describes as
open were resolved after it was written: the release workflow was run for real
at `v0.1.0`, and the `pillow-heif` licensing question was investigated and
settled by swapping to `pi-heif`._

**The blocker is resolved: ffmpeg is pinned.** Both macOS architectures now pin
FFmpeg 8.1.2 from the Martin Riedl build server. The choice was made by
verification rather than by reputation, and the check that decided it was
licensing, not staticness: the obvious candidate — `eugeneware/ffmpeg-static`,
static, current, widely used — carries `--enable-nonfree` and therefore **may
not be redistributed at all**, which is fatal for a milestone whose entire point
is publishing binaries. The same builder's _Linux_ artifacts fail the same way
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
rejects that as _malformed_ — "code has no resources but signature indicates
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

1. _The README promised updates would skip the Gatekeeper walk._ They will not.
   There is no updater, so an update is a fresh quarantined download, and an
   ad-hoc signature has no stable identity for macOS to carry the approval
   across — the CDHash changes every build. The section now says the step
   repeats per version, and ADR-0019 §4 carries the same amendment, since
   "cost paid on every release" is a materially different trade from "cost paid
   once" for the Developer ID decision.
2. _The smoke test could pass while proving the opposite._ It set
   `CAIRNDEX_FFMPEG_PATH` and trusted the sidecar to honour it, but
   `media/tool_paths.py` falls back to PATH discovery when a configured binary
   is not executable — correct for the app, wrong for the one run that exists to
   prove the bundled binary works. On this machine (Homebrew ffmpeg on PATH) a
   lost execute bit would have passed. It now refuses a non-executable bundled
   binary, and a bundle staging one media tool without the other.
3. _The GPL offer leaned on a third-party server and covered one architecture._
   Both `versions.txt` files are committed under `packaging/ffmpeg-build-info/`
   and referenced from the manifest; the notices file no longer presents the
   arm64 configure line as if it were both.
4. _`packaging/` was outside every typing gate_, because the gate named `src` —
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
the bundle. The packaged smoke test passes against the _bundled_ ffmpeg — and
that was proven rather than assumed by sabotaging the bundled binary and
confirming the smoke test fails (it did, though only with a raw traceback; it
now reports the failure in its own words).

**The release pipeline exists, and both architectures are built and verified.**
`.github/workflows/release.yml` triggers on a `v*` tag or manual dispatch,
builds each architecture on its own native runner, smoke-tests each packaged
sidecar against its bundled ffmpeg, and drafts a release carrying both DMGs, a
`.sha256` beside each, and `THIRD-PARTY-NOTICES.md`. Publishing stays a human
decision.

_Native jobs rather than cross-compilation, and this is not a preference._ The
Rust half cross-compiles fine with `--target`; the sidecar does not, because
PyInstaller freezes the interpreter that runs it and has no cross-compile mode.
So the matrix pins `uv sync --python cpython-3.12-macos-<arch>-none` — that line
is what decides the sidecar's architecture. `--platform` selects which checksum
pin to verify against and _cannot_ change what was frozen, which is a trap worth
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
points at `7a56cbe` (the D7 merge), and matches the `0.1.0` in
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

The procedure is now a runbook in `docs/deployment.md` (_Cutting a release_):
pre-tag version bumps, tagging, watching, reviewing the draft, publishing, and
backing out. `AGENTS.md` gains the matching rule — releasing is owner-triggered
like opening a PR, and a tag with a published release must never be moved.

**Done: no GPL library is linked into the app any more** (2026-07-23). The last
open D7 item turned out worse than flagged and then resolved cleanly.
`pillow-heif`'s wheel bundles libheif (LGPL-3.0+), libde265 (LGPL-3.0+) **and
libx265 (GPL-2.0+)**, and libheif names x265 in a load command rather than a
lazy `dlopen` — so importing it pulled GPL code into the sidecar process. Its
`BSD-3-Clause` declaration alongside a **GPLv2** classifier is not a metadata
error, as an earlier note here guessed: the maintainer is describing the wheel
accurately, and the decode-only sibling publishes **LGPLv3** for the same
reason.

Cairndex only ever decodes HEIC, so that encoder was 8.6 MB of copyleft
obligation buying nothing. The runtime dependency is now **`pi-heif` 1.4.0** —
same maintainer, same codebase, decode-only. Verified as a drop-in before
switching: identical `register_heif_opener` symbol, decoded the HEIC fixture and
re-encoded to WebP exactly as `previews.py` does, and `save(..., "HEIF")`
correctly fails.

`pillow-heif` stays as a **dev-only** dependency because writing the smoke
test's HEIC fixture needs an encoder — and "dev-only" is enforced rather than
intended: the PyInstaller spec excludes the package, and `build_sidecar.py`
fails the build if `libx265` appears anywhere in a bundle. That second gate
exists because an exclude only covers the package it names; a future dependency
vendoring the same encoder elsewhere would sail past it. Both are covered by
tests, and the gate was confirmed to fire against a planted file.

Result: the shipped app carries libheif + libde265 (both LGPL, ordinary §4
case), no x265, and dropped from 213 MB to **196 MB**. HEIC previews verified
end to end through the repacked sidecar.

**Next**, in order:

1. **An owner pass on a genuinely downloaded build**, which needs a release to
   exist. The `xattr` reproduction is faithful to the quarantine bit and the
   published artifact was verified after a real `gh release download`, but a
   browser round trip is the last unobserved step. Worth a fresh `v0.1.0` now
   that the repository is public and the licensing question is closed.

After that, D7 closes and the build order moves to **phase H — plan 4 library
write mode**, W0 → W1 → W5.

Unchanged and still open from D6: the lease redirect landing on the target
server's first library, and `localStorage` being undefined in jsdom.

## Implemented: unified library add/remove flow (2026-07-22)

Branch `feat/unified-library-manager`, based on `main` at `9005400`. PR opened at
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
picker on purpose: the dialog lists a _server's_ libraries and first run has no
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
   library switch instead, so removing the _active_ library had to clear it
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

- Reverted the off-screen priming workaround (`9f9cbc6`): it raced WebKit's
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
   _failed_ activation left them pointed at the dead server just probed.
   Confirmed with a test against the real `verifyServer` + `api/client` before
   fixing: three scenarios, three failures. Fixed by making the base an
   explicit activation **commit** step for both kinds, making `verifyServer` a
   pure probe (it asks the candidate URL directly), and teaching `restore` to
   re-point a _local_ previous connection (the old `!previous?.serverUrl` guard
   skipped it — the one compensation path could not compensate for local).
   `connections.apiBase.test.ts` pins all five outcomes; deleting the commit
   step fails three of them.

   Why every earlier gate missed it: the connections suite mocks `verifyServer`
   wholesale and the app suites mock the platform fetch, so activation
   _ordering_ was proven while nothing observed where a request would land —
   the milestone's model-not-exercise failure mode, seventh instance. The owner
   acceptance pass missed it because its scenarios ran with the main server
   also serving the test folder, which masks the wrong base.

2. **P2 — a heartbeat _read_ blip surrendered the lease while a _write_ blip
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
used `??=`, freezing the _first_ render's closure, so the handler under test saw
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
  inert under test and _every_ persisted UI preference is unverified. Pre-existing
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
abort`. That is CPython's _"could not acquire lock for `<_io.BufferedReader
name='<stdin>'>` at interpreter shutdown, possibly due to daemon threads"_, and
the cause was mine: `watch_parent` blocked a daemon thread inside
`sys.stdin.buffer.read()`, holding the BufferedReader's lock, so an interpreter
finalization from any _other_ cause could not close stdin.

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
_every_ build, including valid ones. My earlier "verification" ran the script
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
`takeover.running` already true, and taking over a live lease is refused with 422. All passed.

_(The two paragraphs below were written on 2026-07-20 and are now answered by the
owner acceptance pass at the top of this file. Kept because what they predicted —
that the untested half was where the defects would be — turned out to be exactly
right, four times over.)_

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
- The smoke test drives the _packaged binary over HTTP_ through library creation
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
_(Resolved 2026-07-22 in D7 — see the entry at the top of this file. Both macOS
architectures are pinned; `--skip-ffmpeg` is now the Linux-only path.)_

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
  _tests_ stay runnable without Python; CI's macOS job sets it, which is what
  turns it from a no-op into a real check. **Compilation is a different matter —
  see the review round below.**
- A release `tauri build` produced `Cairndex.app` (**88 MB**) with the sidecar at
  `Contents/Resources/cairndex-sidecar/cairndex-sidecar` — exactly where
  `binary_path()` looks — and **the staged copy was launched from inside the
  `.app`** and served health 200 and an authenticated request 200.

Known gaps: no UI consumes the commands yet (D6.4/D6.5), and the app still has
no way to _open a local folder_ — that is the next slice. The bundled build
carries no ffmpeg until the manifest is pinned, so a packaged sidecar currently
falls back to a system ffmpeg.

### Review round — a CI break I would have shipped, and a start race

An external review of D6.2/D6.3 found one P1, one P2, and three smaller items.
All confirmed by reproduction before fixing, and all applied.

- **P1 — the desktop crate stopped compiling without the sidecar bundle.**
  `tauri-build` copies `bundle.resources` at _compile_ time, not bundle time, so
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
  terminate the first child _after_ its caller had already been given that
  sidecar's URL and token. The comment asserting "`start_local_server`
  guarantees the slot is empty" named exactly the guarantee concurrency breaks.
  Not theoretical: React StrictMode double-invoking a mount effect is the normal
  way a UI produces those two calls, and D6.4 is about to add one. Fixed with a
  dedicated `startup` mutex held across check-launch-insert; the fast path in
  the command was _removed_, because checking outside the lock is what created
  the race. A new test runs two threads against the real bundle and asserts both
  get the same server _and_ that it is still alive; removing the lock fails it.
- **P3 — `SO_REUSEADDR` on the sidecar's listening socket.** Pointless here (we
  bind `:0` and never rebind a specific port) and actively harmful on Windows,
  where it lets a different socket bind a port already in use and steal
  connections — a hijack primitive against a token-gated loopback server.
  Removed. Worth noting the shutdown design is justified by Windows portability,
  so a Windows-unsafe option had no business sitting next to it.
- **P3 — a non-ASCII bearer produced a 500 instead of a 401.**
  `secrets.compare_digest` raises `TypeError` on non-ASCII _strings_. Now
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
_already_ folds the WAL in and removes `-wal`/`-shm`, and a normal interpreter
exit does too because CPython closes the connections during teardown. So the
"clean close" half was mostly working by accident. The two real gaps were that
**library engines were never disposed on shutdown at all** (`main.py` disposed
the worker and HLS sessions but not the per-library engines), and that a _running_
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
  _before_ releasing the leases, so each library is a single consistent file
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

Branch `feat/library-ownership-lease` from `main` at `d953d95`. This is build-order
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
  A lease we cannot parse is deliberately _not_ folded into released: "we could
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
  A foreign `server_uuid`, _or our own under a nonce we did not write_ (a sync
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
  gate on purpose: it is what a client calls _because_ a mount was refused.
  `POST .../ownership/takeover` returns 202 and runs the observation window on a
  background thread, since the window outlasts a heartbeat period and no HTTP
  request should be held open for minutes. Taking over a _live_ lease is refused
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
  every request to _every_ library — for its full duration. Acquisition is now
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
  `processed`/`total`/`phase`, so a persistent indicator sourced from _that_
  (rather than from local mutation state) would survive reloads, show other
  clients' work, and give the D5b dock badge something meaningful to reflect. Needs
  an idle strategy — poll while work is active, stop when idle — so it does not
  wake the server forever. Owner-reported 2026-07-20.
- **`execute_job` holds the registry session open for the whole job.**
  `apps/server/src/cairndex/jobs/worker.py` wraps the entire handler run in one
  `with registry_factory() as reg:`, so a long job keeps a SQLite connection
  checked out for its full duration — 442 s in the one observed case. That job
  failed with `Cannot operate on a closed database` _after_ completing all its work
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
  network filesystem. `3444c76` added `_sqlite_filesystem_identity` at 10:37 Z,
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
  An unsigned DMG on another Mac still needs System Settings → _Open Anyway_, and
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
  the one the reviewer identified: if the intended copy is _running_ and a
  different copy is launched for the link, single-instance forwards only **argv**,
  while macOS delivers the URL by **Apple Event** — so the link parks in a process
  that immediately exits and is silently lost.

  Investigating this found something beyond the report: **the DMG build alone
  already creates a second registrant.** `bundle_dmg.sh` stages the app on a
  temporary `/Volumes/dmg.XXXXXX` volume, and that claim survives the volume. On
  this machine, after one DMG build and _no_ installation, two paths claimed the
  scheme — the build directory and `/Volumes/dmg.f9FEwK/Cairndex.app`, a mount
  point that no longer exists. This **supersedes the D5b receipt's claim** that
  LaunchServices reported exactly one claimant; that was true when written but is
  not a property the system maintains, and the D5b entry now says so. Documented
  in `docs/deployment.md` with the real inspection command and its actual output,
  plus cleanup steps, and added to the owner checklist as item 5 — deep-link
  testing against the wrong copy proves nothing.

- **Nit — the DMG-signing claim was too confident.** "Tauri signs the app and the
  DMG" was asserted, but whether the bundler codesigns the DMG _container_ rather
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
that a _mounted_ DMG is itself a claimant, and warn that every `tauri build`
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
`7482cdd`.

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
  _before_ the deep-link plugin). The SPA subscribes **before** draining, so a
  link arriving in between is not lost, and de-duplicates by identity, so a
  cold-start link that also arrives as an event opens once rather than twice.
  **Decision:** a link naming a library this server does not have is reported
  rather than opened in the active library — silently doing the latter could show
  a different bundle than the link meant. Over-deep paths are rejected rather than
  truncated, for the same reason.
- **Job notifications and dock badge.** Rides on the job snapshots the sidebar
  progress bar already polls, so no new polling. **Decision:** the unit is a
  _run_, not a job — `Update library` chains scan → probe → storyboards, so
  per-job notification would fire three times for one user action; a run ends only
  after activity has been absent for a settle window, since that chain briefly
  reports no active job between stages. A notification fires only when the run
  exceeded the length threshold **and** the window is unfocused (announcing a job
  to someone watching its progress bar is noise). Duration uses the server's
  `started_at`, so a run queued behind another job is measured by when it actually
  ran. A cancelled job is a deliberate user action and is not reported as a
  failure. Permission is requested when a run _starts_, so the system prompt
  appears while the user is present and has just asked for the work. The browser
  build stays inert deliberately: a web page prompting for notifications is the
  pattern users distrust.
- **Export save seam (M11 hook only, no export UI).** `save_export_file` takes
  bytes plus a suggested file _name_; the destination comes solely from the native
  save dialog, and any path structure in the suggestion is stripped first —
  mirroring the D3 rule that no client-supplied absolute path is trusted. Sized
  for plan 1 §10's small artifacts (a capped GIF, one contact sheet), not
  streaming media. `canSaveExports` lets M11's dialog choose between a native
  Save As… and an ordinary browser download.

### Review round — capability gap and a cold-start race

An external review found two P1s, both in exactly the places this receipt had
admitted were not runtime-verified. Applied, with the P3s and nits.

- **P1 — the dock badge was capability-blocked and failing silently.**
  `core:window:default` grants only _getter_ commands, so `setBadgeCount` needed
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
   and if a _different_ copy is launched while the intended one runs, the link is
   silently lost, because single-instance forwards only argv while macOS delivers
   the URL by Apple Event. `docs/deployment.md` has the inspection and cleanup
   commands.

Next recommended task: **Plan 3 D5c — Developer ID signing and notarization
pipeline** (needs the owner's paid Apple Developer Program enrollment; see the
D5a receipt).

## Completed: Plan 3 D5a — menus, shortcuts, window state, viewer fullscreen

Branch `codex/plan3-d5a-menus-shortcuts` from `main` at `1a39ff0`. The owner
split D5 into three slices on 2026-07-19 (D5a menus/shortcuts/window, D5b deep
links/notifications/export seam, D5c signing), **deferred the updater**, and
asked for left-click play/pause. This receipt covers D5a.

Implementation:

- **One keymap table, not two.** `apps/web/src/platform/keymap.json` is the
  single source of truth for the native menu bar. The shell embeds it with
  `include_str!` and _builds_ the menu from it (`src-tauri/src/keymap.rs`), so a
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
  (the `player` object exists for images; only its use as a _controller_ is
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

Branch `codex/plan3-d4-drag`; tip `34a3e63` (docs receipt follows). A second
external review of the D4 hardening produced two unifying data-model changes,
one more P0, and P1/P2 items — all applied.

- **Per-reason skip reporting (change A, findings 1–3, 5).** `resolve_or_stage_paths`
  now _skips_ a confirmed-bundle member instead of raising mid-loop (a folder of
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

Verification at `34a3e63`: desktop `cargo fmt --check`, Clippy `-D warnings`,
**33 unit tests** (categorized reverse-map + echoed-absolutes cases); backend
Ruff, `ruff format --check`, mypy, full pytest (**452 passed**, +confirmed-skip,
per-reason, and preview==apply cases); web Prettier, ESLint, `tsc -b`, full
Vitest (**183 passed**, +dragGuard id/grace/timeout, categorized routing,
self-drag, empty-preview, isMultiSelection cases), the Vite build, and the
browser-only Playwright partition (**72 passed**, with the suggest-bundle fixture
made realistic). Release `tauri build` produced `Cairndex.app`. The native drag
gesture itself still needs the owner's manual pass on a packaged build.

## Completed: Plan 3 D4 review pass — drag hardening

Branch `codex/plan3-d4-drag` continues below the D4 receipt; tips `8cb2249`
(the fixes) then `0121468` (a guard self-clearing follow-up and a comment). An
external code review of D4 produced three P0s, seven P1s, and two P2 cleanups —
all applied. (The gate counts below are from the `8cb2249` full-suite run; the
`0121468` follow-up re-ran only the platform Vitest. A second review round then
carried this further — see the round-2 receipt above.)

- **Drag-in batch tolerance (P0-1).** A dropped directory or a non-media sidecar
  no longer poisons the fast-add batch. `relative_within_root` maps only regular
  files (directories count outside), and the server's `resolve_or_stage_paths`
  now skips and _reports_ non-linkable paths instead of raising. The additive
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
  remainder of _every_ drop, mixed or all-outside.
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

Branch `codex/plan3-d4-drag` from `main` at `c5a381b`; tip `b492e43`. Delivers
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

Branch `codex/plan3-d3-path-mappings` from `main` at `5da047f`.

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

Branch `feat/desktop-platform-auth` from `main` at `f16a361`. The first D2
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

Branch `feat/desktop-shell` from `origin/main` at `1098882`; reviewed and tested
implementation tip `a5a5d37`; first fully green PR #15 tip `aabc8b1`.

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
- PR #15 ran all six CI jobs green on `aabc8b1`: macOS desktop Clippy/tests/build
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

Branch `feat/device-pairing` (off `main` at `1ef3c35`, after M12 merged as
#12). Implementation commits: `3df883d` (`feat: add device pairing and bearer
auth`), `d0c9d90` (`feat: add Settings Devices page`), and tested implementation
tip `9c28594` (`fix: block offline library pairing bypass`). Review hardening and
its final full-gate evidence are recorded in `e6411cc` (`fix: harden device
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
coarser leading subject prefix. The screenshot case with two long `Nora Vance`
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

Branch `feat/hover-preview` (off `main` at `4a5ab3b`, after M9 merged as #11).
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

Merged to `main` as #11 at `4a5ab3b`. The review history includes implementation
commit `4808f4a` (`fix: address M9 player polish review findings`), the
collection-cover fix `38ea3f9`, speed/seek Settings refactors `80a9619` +
`74bf974`, source-aware Resolution submenu `f20f09a`, and the UI polish series
`787f5f3` → `de47b94`.

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
fallback. range loop/GIF range selection, video adjustments, slideshow, and
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

**M9 recomposed + M12 added (owner, 2026-07-11):** range loop moved to M11
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
- File Browser still used `FileEntryViewer` with path-based URLs and native
  browser controls at the time of this merge, sharing only the fallback card
  component. **Resolved later** — see _Merged: one media viewer shell for both
  browsing surfaces_ below, which retired that split.
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
  simultaneous subtitles, subtitle styling, range loop, snapshot capture,
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
5. open review so the user can accept selected grouping proposals;
6. collect technical metadata in the background, then generate storyboards.

Applying a grouping plan is the only operation that confirms scan-staged
bundles, creates suggested logical collections, assigns roles, selects
cover/primary files, links external subtitles, or adds newly discovered files to
an existing confirmed bundle. It never moves, renames, deletes, or rewrites
original files.

## Current implementation notes

- **Primary maintenance flow:** **Update** is the main sidebar action. It runs
  scan + grouping-plan generation, opens review, then hands probe and storyboard
  generation to the background-job area. The overflow menu keeps scan-only,
  probe-only, and review-only actions for exception cases.
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
- File Browser is read-only. _(Superseded in part, 2026-07-23: plan 4 **W0**
  landed the write-mode gate, so a library can now be **given** permission to be
  written to — but no operation exists that uses it yet, so the File Browser
  itself is unchanged. The desktop/host-handoff path is in
  `docs/plans/03-macos-desktop-app.md`, ADR-0012 accepted; reveal /
  open-with-default-app remain unimplemented.)_
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
- Native/desktop host integration design for `open with default app` and reveal
  in file manager. _(File Browser write mode is no longer unresolved: ADR-0013
  settled the design and plan 4 W0 shipped its gate.)_
- Cache policy for future large transcodes: portable inside-library cache vs.
  server-local cache.
