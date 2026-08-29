# ADR-0024: Directory groups — a folder of files as one row

- Status: **superseded** by [plan 6 — a folder as a bundle member](../plans/06-folder-as-bundle-member.md)
  (2026-07-28), before any of it shipped. Kept for its analysis, not as a
  decision to follow.
- Date: 2026-07-28
- Branch/PR: `feat/directory-groups`

> **Why it was reopened.** This ADR landed on *explicit, user-chosen* directory
> groups after two automatic rules failed (§3). The owner rejected it on a better
> ground than either: there was no answer to "where in the UI do I create a
> group?" that did not invent a new noun — a group that is neither bundle, nor
> collection, nor folder, with its own rules and gestures. The accepted design
> makes a **folder itself** the bundle member, and puts the decision in the
> grouping-suggestion dialog, where the user already confirms what a bundle is.
>
> **One argument in this file is wrong.** The Context section rejects "a folder
> becomes a bundle member" as colliding with `product-brief.md:67/124`. Those
> lines forbid bundle *identity* depending on a folder, not a bundle
> *containing* one, and that misreading pushed two rounds of design away from the
> simplest answer. It is left in place, marked, rather than edited away.
>
> What remains true and is why this file survives: no heuristic can tell an album
> from a movie folder (§3), and a group's *contents* never need storing because
> `directory_path` already answers it (§1).

## Context

The owner's case, stated 2026-07-28:

> In the filesystem my expectation is to have a folder that contains a lot of
> files, e.g. a photo album. I want **every item in the folder to be in a
> bundle** (along with other files not in the folder). Clearly, it won't be
> manageable if the 1000 photos show up individually (e.g., all show up in the
> group suggestion dialog, and in the bundle inspector). So I would like these
> photos to show up as a "group".

Two readings were considered. The first — "a folder becomes a bundle *member*
in its own right" — is what an earlier discussion assumed, and was rejected here
as colliding with the product brief. **That rejection was wrong** (see the note
at the top); the lines quoted forbid bundle *identity* depending on a folder,
not a bundle containing one. The original reasoning, preserved:

> A bundle does not require a canonical physical folder and may contain files
> from different directories. (`product-brief.md:67`)
>
> Do not make bundle identity or collection membership depend on a bundle-root
> directory. (`product-brief.md:124`)

The owner's own wording rules it out anyway: *every item in the folder* is to be
in the bundle. Membership stays per-file. What is being asked for is that a set
of files which happen to share a directory be **presented and manipulated as one
unit**. That is a presentation concern with a durable key, not a new kind of
member.

The owner delegated the structural decision ("I am fine with model changes, so
you can make the call").

## Decision

**The set of grouped directories is stored; a group's contents are derived.**
Which folders are groups is a user decision and cannot be inferred (§3); *what
is in* a group is `directory_path` and needs no storage at all (§1). No new
entity — a bundle records a list of directory paths.

1. **The group key is `AssetFile.directory_path`.** The column already exists,
   is indexed, and is kept in step with `relative_path` by a `@validates` hook
   on the model, so it is correct after any rename, move, or ADR-0006 repair
   without a single line of new maintenance. It is already populated in real
   libraries.

2. **Every file remains a first-class `AssetFile`.** Rating, tagging, cover
   selection, playback, contact sheets, reordering, and trash keep working on
   individual files inside a group, unchanged. This is what the owner asked for
   ("every item in the folder to be in a bundle") and it is what a stored
   folder-member would have put at risk.

3. **Which folders are groups is the user's call, not a heuristic's.** Two rules
   were written and the owner broke both on sight:

   | rule | broken by |
   | --- | --- |
   | many files in one folder | a movie folder — film, subtitles, poster, cover: four files, one directory, not a group |
   | many files of one *kind* in one folder | an album is often short videos **and** images together (screen captures, contact sheets) — mixed kinds, still one album |

   These two cases are indistinguishable by file properties, because the
   difference is not in the files. It is what the folder *means*, and only the
   person who filed it there knows. The owner said as much before either rule
   was written: "I don't want the grouping to always happen automatically."

   So grouping is **explicit**. A bundle records which of its directories are
   groups; nothing collapses on its own. The heuristic is demoted to what it can
   honestly do — count files and *offer*. A movie folder appearing as a
   suggestion is harmless: the offer is declined once and costs nothing, where a
   wrong automatic collapse hides the bundle's content.

4. **A group holds every file in its directory**, whatever kind. This is what
   makes the mixed-media album work, and it follows from §3: once the user has
   said "this folder is an album", there is no reason to second-guess which of
   its files belong.

5. **Ordering treats a group as one position.** A group sorts by its members'
   minimum `sequence`, so a folder occupies a single slot among the bundle's
   other files, and its contents order among themselves inside it.

## Why the split, rather than all of one

Storing the *contents* would be a second source of truth about something the
filesystem already answers, and every divergence would be a bug to detect and
repair: a file moved out of the folder, a folder renamed, a group whose members
no longer share a directory. The `relative_path` validator means the derived
answer cannot drift — a group's contents *are* its directory, by construction.

Storing the *choice* is unavoidable, and two rejected rules are the evidence
(§3). A preference this cannot be inferred from data has to be recorded
somewhere, and the only honest place is next to the bundle it describes.

The stored half is deliberately the smallest thing that works: a list of
directory paths, not a group entity with its own identity, title, or membership.
If manual grouping of files that do **not** share a directory is ever wanted,
that is a genuinely new capability and can add an entity then, with this one
staying as the default.

## Consequences

- Existing libraries are unaffected: no bundle has grouped directories, so every
  file list renders exactly as it does today until the user groups something.
- Two surfaces must apply the same derivation or they will disagree about what a
  group is: the bundle inspector's file list, and the grouping-suggestion dialog
  (whose `GroupingProposal` already carries a `directory` field). The derivation
  therefore lives in one shared module, not in either component.
- The suggestion threshold is a UX constant, not an invariant. It decides only
  when the app offers, never what it does.
- A stored directory path can go stale if the folder is renamed outside the app.
  The failure is benign — the group stops matching and its files reappear
  individually — and write-mode renames go through the app, which can move the
  entry with them. Deliberately not defended further: the alternative is
  reconciliation machinery for a display preference.
- A group cannot be named independently of its folder, and cannot hold a subset
  of a directory. Both follow from §4 and match the owner's model, which is
  explicitly the filesystem folder.
