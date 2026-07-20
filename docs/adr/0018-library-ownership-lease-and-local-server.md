# ADR-0018: Library ownership lease and desktop local-server sidecar

- Status: accepted (owner-ratified 2026-07-19)
- Date: 2026-07-19
- Branch/PR: `docs/adr-library-ownership-lease`

## Context

The owner ratified two requirements in a design discussion on 2026-07-19:

1. **One server per library.** A library must never be served — and therefore
   written — by two Cairndex servers at once, and users must not be able to
   create that situation accidentally.
2. **Local libraries must "just work" in the desktop client.** With library A
   on a NAS (served by the NAS server) and library B in a local folder on a
   laptop, the desktop client should open both: A through the remote server,
   and B by transparently starting a local server — no command line. If
   library B's folder is cloud-synced to a second laptop, opening it there
   must behave identically to the first laptop, even though no server state
   was synced.

The architecture already anticipates most of this. ADR-0008 split portable
per-library metadata (`.cairndex/{manifest.json,library.db,cache/}`) from the
server-local registry (`registry.db`: registered paths, job queue, device
tokens), and reserved — without implementing — an active-owner lease at
`.cairndex/locks/active-owner.json` (decision 9). ADR-0012/plan 3 §8 declined
an embedded server for desktop v1 but noted a bundled "local mode" sidecar as
a plausible later milestone. ADR-0010 deliberately put the passphrase hash in
the portable manifest so access control travels with the library.

Constraints that shape the design: single-owner-first (AGENTS.md); no client
may open `library.db` directly over a share (ADR-0008 rejected multi-writer
SQLite over SMB/NFS); no full scans or hot-path hashing; the registry is
server-local infrastructure and never travels with a library.

The key observation: enforcement cannot live on any server, because the two
servers involved in a conflict do not know about each other, and a
cloud-synced copy of a library has no server at all. The library folder is
the one thing every would-be server can see, so ownership must be recorded
there. Conversely, the second-laptop use case works only if the registry
holds no authoritative library state — an invariant this ADR makes explicit.

## Decision

A server may serve a library only while it holds a lease file inside that
library. The desktop shell gains a managed local server ("sidecar") so local
libraries open without user-visible server administration. Concretely:

### 1. Portability invariant (makes cloud sync work)

**Everything a user would miss must live in `.cairndex/`; everything in the
registry must be reconstructible from nothing.** Content metadata, watch
progress, bundle cursors, thumbnails/storyboards, and the passphrase hash
already travel with the folder. Registry rows are recreated on registration;
the job queue is transient; HLS/transcode output is ephemeral (ADR-0012);
device-pairing tokens are genuinely a device↔server relationship and are
intentionally per-server. Any future feature that stores authoritative
library state in `registry.db` violates this ADR and needs a superseding one.

### 2. The lease file

`.cairndex/locks/active-owner.json`, written atomically (temp file + rename
in the same directory) so sync engines and concurrent readers never observe
partial JSON. Fields:

- `server_uuid` — persistent per server install, generated once and stored in
  that server's data directory;
- `machine_name` — human-readable, for prompts ("Allen's MacBook Pro");
- `advertised_url` — the URL clients can reach this server at, or null /
  loopback for a local sidecar. Only non-loopback URLs are offered as
  redirects;
- `acquired_at`, `heartbeat_at` — ISO-8601 UTC timestamps;
- `nonce` — random, regenerated on **every** write, including heartbeats;
- `released_at` — present only after a clean release.

Defaults (tunable in server settings, revisit with real-world data):
heartbeat interval **60 s**, staleness TTL **5 min** (5× interval).

### 3. Lease states and acquisition

A server evaluating a library classifies the lease:

- **Released** — no lease file, or `released_at` is set. Acquire silently.
  Clean shutdown, library close, and unregistration all release the lease, so
  the everyday quit-laptop-1 / open-laptop-2 flow has zero friction.
- **Own** — lease carries our `server_uuid` (we crashed before releasing).
  Re-acquire silently regardless of staleness.
- **Fresh** — `heartbeat_at` within TTL, foreign `server_uuid`. Refuse to
  open. The structured error carries the holder fields; the client redirects
  ("This library is served at `http://nas:8000` — connect there?") when
  `advertised_url` is non-loopback, otherwise names the holding machine.
- **Stale** — heartbeat older than TTL, foreign `server_uuid`. Takeover is
  offered but **always requires explicit user confirmation** (owner-ratified),
  showing the holder machine and last-heartbeat time. Because clean shutdowns
  release, this prompt appears only after a crash or under sync lag — exactly
  the cases where a human check is warranted. There is no auto-takeover
  after any TTL.

There is no atomic compare-and-swap on a synced folder or SMB share, so
acquisition is **write-then-verify**: exclusive-create when no file exists;
otherwise write our lease with a fresh nonce, wait a short beat, re-read, and
proceed only if our nonce survived. Before a *stale* takeover the server
additionally observes the lease for one interval longer than the heartbeat
period: a live holder writing to the same disk (two servers pointed at one
NAS export) visibly touches the file during the window, catching that case
without trusting cross-machine clocks at all. Losing any verification step
backs off to the refuse path.

**Reads require the lease too.** Browsing already writes (bundle cursors,
missing-file reconciliation), and reading a SQLite DB that another machine is
writing through a share or sync engine is exactly what ADR-0008 rejected.
No lease → no mount; there is no leaseless read-only mode.

### 4. Holding: the heartbeat is also the watchdog

Every heartbeat the server **re-reads the lease before rewriting it**. A
foreign `server_uuid` or unknown nonce means ownership was lost (a confirmed
stale takeover elsewhere, or sync conflict resolution chose the other side).
The response is fixed (owner-ratified): never fight — do not re-grab; stop
all writes to that library immediately; cancel its running jobs; **unmount**
the library, returning a structured "ownership lost" error that carries the
new holder's fields so the client can offer the redirect. Long jobs
(scan/probe) re-verify the lease at start and at batch boundaries so a scan
cannot continue long after a takeover. Per-request lease checks are
deliberately omitted: the dual-write exposure window is bounded by one
heartbeat interval, the accepted cost of keeping this off the hot path.

Heartbeats continue while the library is idle. A ~200-byte write per minute
is negligible sync churn, and pausing on idle would make a NAS server's
libraries look stale — and therefore stealable — from other machines.

The heartbeat also scans `locks/` for sync-conflict artifacts (patterns for
the major services, e.g. `* (conflicted copy)*`, `*.sync-conflict-*`,
`* (1).json` variants). A conflict copy naming another live server means both
sides served during a partition: surface a prominent alert; never
auto-resolve or delete the artifact.

### 5. Desktop local-server sidecar

The desktop shell bundles the Python server as a managed sidecar process
(packaging via PyInstaller or a shell-managed `uv` runtime — an
implementation-time choice for the milestone, not fixed here). Behavior:

- Started on demand when the user opens a local library folder; bound to
  loopback on an ephemeral port; single instance per machine (existing
  single-instance behavior).
- Owns a private `CAIRNDEX_DATA_DIR` under the app's data directory
  (`~/Library/Application Support/Cairndex/local-server/` on macOS); its
  registry is invisible plumbing.
- Auth: the shell generates a token and passes it via environment at spawn —
  no pairing ceremony for the loopback owner. The ADR-0010 passphrase gate
  still applies per library, since the hash travels in the manifest.
- The client model generalizes from "one server URL" to a set of
  *connections*: remote servers plus one managed local server. "Open library
  folder…" reads `.cairndex/manifest.json`, spawns the sidecar if needed,
  registers the path, and mounts — subject to the lease rules above, so a
  local open of a NAS-served library becomes a redirect, not a second writer.
- Clean shell shutdown stops the sidecar, which releases its leases.

### 6. Cloud-synced libraries: supported semantics and SQLite hygiene

Cloud-synced libraries are supported with **"one active machine at a time"**
semantics, documented as such. To keep the folder's at-rest state consistent
for the sync engine:

- WAL checkpointing: `wal_checkpoint(TRUNCATE)` when a library goes idle, and
  a full checkpoint with WAL removal on clean close — so the synced state is
  normally a single consistent `library.db` file rather than a torn
  `db`/`-wal`/`-shm` triple captured mid-write.
- A periodic consistent snapshot via the SQLite backup API (e.g.
  `.cairndex/library.db.bak`) as the heal path if a machine's last sync ever
  shipped a mid-write state and that machine never syncs again.

### 7. Accepted limitation

If a holder is actively serving while partitioned (sync paused/offline) and a
user on another machine confirms a stale takeover, both serve until the
partition heals. No folder-based lease can prevent two writers across a
partition. The design guarantees instead: **bounded detection** (the old
holder unmounts within one heartbeat of the foreign lease syncing in) and
**no silent data loss** (the sync engine preserves both `library.db` versions
as a conflict pair; the user picks, and the loser remains on disk). A
merge/export tool for diverged libraries is explicitly out of scope.

## Alternatives considered

- **Server-side enforcement (registry flag / port probing / mDNS discovery)**
  — rejected: the conflicting servers don't know about each other across
  machines, and a synced copy has no server; discovery can supplement UX
  later but cannot be the guard.
- **Binding a library to a home server in `manifest.json`** — rejected:
  defeats portability, the point of the ADR-0008 package design; a moved or
  synced library must be servable wherever it lands.
- **OS/file-system advisory locks (flock etc.)** — rejected as the mechanism:
  not propagated by cloud-sync engines, unreliable over SMB/NFS, and
  invisible cross-machine. The JSON lease syncs like any file and is
  inspectable/debuggable.
- **Auto-takeover of stale leases after a long TTL** — rejected
  (owner-ratified): silently wrong exactly in the paused-sync /
  laptop-in-a-drawer case the lease exists to catch; clean releases make the
  confirmation prompt rare enough not to matter.
- **Read-only mode instead of unmount on lost ownership** — rejected
  (owner-ratified): "reads" over a share or sync engine while another server
  writes can be stale or torn; unmount + redirect is unambiguous.
- **Leaseless read-only mounts** — rejected for now: browsing writes cursors
  and reconciliation today; a true inspect-only mode would need those writes
  gated and is not required by any current use case.
- **Embedding the server in the Tauri process** — rejected: ADR-0012's
  process split stands; a sidecar keeps the server contract identical for
  local and remote libraries and keeps the shell a pure client.

## Consequences

Easier: the second-laptop story reduces to "open the folder" — a fresh
sidecar registers, acquires the released lease, and everything the user
cares about was already in `.cairndex/`; accidental second servers become a
redirect to the right server instead of silent divergence; the lease's
`advertised_url` doubles as a lightweight "where is this library served"
hint.

Harder / follow-up:

- Server: lease module (state classification, write-then-verify, observation
  window, heartbeat/watchdog loop, conflict-artifact scan), "ownership lost"
  unmount path with structured errors, job-boundary lease re-verification,
  idle/close checkpointing, snapshot job. Registry gains the persistent
  `server_uuid`.
- Desktop: sidecar packaging + lifecycle (spawn, health, env-token auth,
  shutdown), the connections model in the shell UI, takeover-confirmation
  and redirect UX.
- Docs: deployment/architecture updates; user-facing documentation of the
  one-active-machine sync semantics.
- Registry-audit gate: nothing authoritative may land in `registry.db`
  (decision 1) — reviewers should check this on future schema changes.
- Milestone placement (owner-ratified 2026-07-19): the top of build-order
  phase F in `docs/plans/README.md` — after plan 3 D5 shell polish, ahead of
  the write-mode slices. The lease lands server-side first (it hardens the
  NAS deployment on its own); the sidecar follows as plan 3 milestone D6.

## References

- ADR-0008 (per-library metadata and registry; reserved the active-owner
  lease this ADR implements), ADR-0010 (portable passphrase hash), ADR-0012 /
  `docs/plans/03-macos-desktop-app.md` §8 (local-mode sidecar noted, not
  planned — this ADR plans it), ADR-0013 (write mode; unaffected, but the
  lease becomes a precondition for any write-mode operation), ADR-0015
  (device tokens stay per-server by design).
- Owner design discussion, 2026-07-19 (takeover confirmation and
  lost-ownership unmount ratified).
