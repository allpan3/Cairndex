# Manual replica Update

New format-three synthetic packages advertise `discovery_version: 1`. **Update**
starts a private, cancellable job against the serving device's library root. Normal
metadata exchange remains automatic. Formats one and two retain their existing
capabilities; real-library conversion remains unavailable.

## Review and identity

Update observes existing paths, repairs unambiguous external moves and proposes
new files using the existing grouping rules. Pending files and grouping suggestions
remain private until **Prepare grouping review** and **Accept reviewed changes**.
Review can change title, destination, selection and order. Additions append to a
confirmed bundle without regrouping its existing members or replacing its cover.
Unambiguous video/subtitle additions create authored subtitle links. Collection
creation and directory-container grouping are outside this bounded review.

A successful automatic repair preserves the file ID, bundle membership, notes,
tags, moments, covers and subtitle relationships. It requires the original path to
be absent, unique matching evidence in both directions and an earlier local
observation of that same original catalog path. Receiving a peer's moved path
cannot authorize moving it back to an older local folder. Copies with a surviving
original are new files. Multiple matches, sample-only matches across different
physical files and identities with no prior local observation require explicit
review. Sample-only review states that complete equality is unproven.

Different evidence at a cataloged path requires an explicit replacement choice.
Competing accepted replacements expose **Review content identity** in the file
editor, with both retained evidence alternatives.
Detected replacement bytes cannot inherit that identity's playback state before
review. Local absence, incomplete reads and unavailable roots never delete shared
catalog entries. No discovery operation renames, moves, overwrites or deletes media.

## Evidence and limits

A file read touches at most three 64 KiB regions. Files up to 192 KiB receive a
complete SHA-256; larger files receive `sample-sha256-v1`. Samples cannot detect
changes outside those regions or prove equality of independent large copies.
Automatic sampled repair also requires the earlier local device/inode identity.
Generation-bound local resume follows a verified repair; a manual sample-only
identity assignment does not transfer old progress to a different physical file.

Complete small-file identities derive from library/epoch, path and evidence, so
independent identical discoveries share a file ID. Large-file IDs are random and
persist in a private path/evidence mapping. Independent large discoveries and
same-path different contents retain explicit causal identity conflicts with a
valid local display. Group IDs derive from selected file IDs. Initial group/file
timestamps use the earliest selected source modification time: preserved copied
mtimes converge, while different mtimes can produce ordinary timestamp conflicts.
Timestamps never establish ancestry or authorize a move.

Enumeration yields every 32 entries, including ignored hidden/symlink entries.
The worker processes known paths and repair candidates in batches of 32, and
proposes at most 128 new files from one directory at a time. Suggestions consult
existing members only when the directory has at most 128 cataloged files. Larger
directories may require manual destination selection or several reviews. This is
bounded discovery correctness, without a large-library performance claim or a
File Browser pagination redesign. No continuous watcher or provider hydration API
is included.

## Private work and recovery

Progress, errors, observations, missing-file candidates, grouping drafts, identity
mappings and exact prepared reviews live in the private DB. Completed scans
supersede obsolete suggestions while retaining their bodies and saved drafts.
Cancelled or failed work retains already committed repairs. A failed or cancelled
walk cannot publish a repair; a restarted walk discards its partial observations.

Preparation captures source generations and causal bases. Acceptance revalidates
sources and commits authored changes and the private receipt atomically. An exact
retry retains its original preview and never silently takes newer bases. Competing
offline choices become catalog conflicts; a competing grouping received before
acceptance can instead fail safely while retaining the full private preview.
Closing/reopening review, switching libraries or refreshing the catalog preserves
private drafts. Invalid browser draft bytes are retained with a visible error.

[Private recovery](replica-recovery.md) includes every discovery table and validates
candidate shapes, identities, causal references and acceptance receipts. Restored
observations require local revalidation. **Saved discovery reviews** retains the
original selection and preview. **Revalidate saved review** checks that exact intent
without submitting it. Changed source generations require Update and a fresh
review; unchanged sources can be explicitly accepted after revalidation. Nothing
recovered applies itself.

## API

All routes are under `/api/v1/libraries/{id}/replica/discovery`:

| Route | Behavior |
| --- | --- |
| `GET /status` | Latest private job state, phase, observed/repaired counts and error |
| `POST /runs` | Enqueue with a stable operation ID; repeated active requests reuse the run |
| `DELETE /runs/{id}` | Cancel future worker steps |
| `GET /candidates` | Paginated pending suggestions |
| `POST /reviews` | Queue bounded preparation or exact-intent revalidation |
| `GET /reviews`, `GET /reviews/{id}` | Paginated saved reviews or one complete preview/receipt |
| `POST /reviews/{id}/accept` | Queue acceptance of the exact receipt |
| `DELETE /reviews/{id}` | Cancel an uncommitted review while retaining its bytes |

HTTP handlers never enumerate media or apply grouping. Discovery shares the
existing replica worker and Release drain; its private state never enters metadata
transport. [ADR-0032](adr/0032-replica-discovery.md) defines the capability boundary.
