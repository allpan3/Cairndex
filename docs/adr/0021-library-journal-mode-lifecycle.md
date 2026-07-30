# ADR-0021: Library journal-mode lifecycle — WAL while served, rollback at rest

- Status: accepted (owner-ratified 2026-07-30)
- Date: 2026-07-30
- Branch/PR: `fix/library-journal-mode-portability`

## Context

A library became unopenable from the owner's Mac after being served by the
container on the NAS. `GET /api/v1/libraries/{id}/bundles/browse` returned a
bare 500 whose traceback ended at `PRAGMA journal_mode=WAL`, on a library whose
files read fine and whose directory was writable.

The cause is a mistaken premise recorded in the code itself.
`persistence/engine.py::_apply_sqlite_pragmas` set four pragmas on every new
DBAPI connection, its docstring explaining that "these are per-connection in
SQLite". That is true of `foreign_keys`, `busy_timeout` and `synchronous`. It is
**not** true of `journal_mode`: WAL is recorded in the database file header
(bytes 18 and 19, the write and read format versions) and is a property of the
*file*. Setting it was not reapplying a connection setting; it was rewriting the
library, on every connect.

Two facts turn that from untidy into an outage:

1. **A WAL database cannot be opened over SMB or NFS at all.** WAL needs a
   `-shm` index that every connection memory-maps, and mmap coherence is not
   available on a network filesystem. SQLite refuses with
   `unable to open database file` — for a *read-only* connection, on a readable
   file, in a writable directory.
2. **Only a machine with local access can convert it back**, which is by
   definition not the machine that is locked out.

The owner's library lives on an SMB share. Setting the pragma from the Mac had
always failed silently — SQLite keeps the existing mode and *returns* it, with
no error — so the library stayed in rollback mode and everything worked. The NAS
container opened the same library from the NAS's own filesystem, where the
pragma succeeds. That single successful write flipped the file permanently and
locked out every SMB client. Recovery was `PRAGMA journal_mode=DELETE` run from
a container on the NAS.

This directly violates ADR-0008's portability premise: a library is a directory
you can move, copy, sync or mount, and everything a user would miss lives inside
it. A library that only opens from one machine is not portable, and nothing in
the package records that it has become so.

Constraints that shape the answer: no client opens `library.db` directly over a
share (ADR-0008); a library we no longer own gets no further writes (ADR-0018
§4); errors must be structured and attributable (AGENTS.md §API rules).

## Decision

**A library database uses WAL while this server has it open, and a rollback
journal at rest.** Concretely:

1. **The server-local registry keeps WAL unconditionally.** It lives under
   `CAIRNDEX_DATA_DIR` on the server's own disk, is never reached over a share
   and never travels (ADR-0008 §3). None of the portability argument applies to
   it. `_apply_sqlite_pragmas` is split accordingly: the three genuinely
   per-connection pragmas stay on the connect hook for both engine kinds, and
   `journal_mode` leaves it entirely — set once per engine, and differently for
   a library than for the registry.

2. **A library engine settles its journal mode once, at open**, in
   `persistence/journal.py`. On a filesystem that can host WAL, WAL — for the
   concurrency it buys while the library is open.

3. **A clean close converts it back**: `wal_checkpoint(TRUNCATE)` then
   `journal_mode=DELETE`, so a library at rest is a single portable
   `library.db`. This runs on the paths that already exist for closing a
   library — server shutdown (`close_library_engines`), unregistration, and a
   library re-opened after a move — extending the ADR-0018 §6 clean-close path
   rather than inventing a second one.

   It does **not** run when we lose the lease to another server: converting the
   mode is a write, and ADR-0018 §4 is categorical that a library we no longer
   own gets no more writes from us. The new holder sets what it wants.

4. **WAL is not attempted where it cannot work.** The filesystem holding the
   database is identified (`/proc/self/mountinfo` on Linux, `statfs`'s
   `f_fstypename` and `MNT_LOCAL` on macOS); a positively-identified network
   filesystem does not get WAL. An *unidentified* filesystem still gets the
   attempt, and the result is read back rather than assumed — SQLite reports the
   mode actually in force, and it was precisely the habit of ignoring that
   return value that hid the original bug.

5. **An open failure explains itself.** `unable to open database file` on a
   library database is diagnosed from outside SQLite — read the header bytes (a
   plain file read, which succeeds exactly when the file is readable) and ask
   what filesystem it is on — and raised as `LibraryDatabaseOpenError`, a 409
   carrying the reason, the filesystem kind, and the recovery command. A
   `wal_on_network_filesystem` is distinguished from a permissions problem,
   because the two need opposite actions and SQLite gives them the same message.

6. **An open heals a library it finds in the wrong mode.** If this machine has
   decided the library should not be in WAL and finds it in WAL, it converts it
   there and then.

   Its reach is deliberately modest and should not be mistaken for the recovery
   story. It fires only where the library is on a network filesystem *and* the
   open still succeeded — a mount that tolerates WAL, or one identified as
   network conservatively. The ordinary SMB lockout never gets that far. The
   recovery that actually matters is decision 3: restart the server that crashed
   and stop it cleanly, and the clean close converts the file back.

### The residual risk, accepted deliberately

An **unclean** stop — `docker kill`, power loss, the OOM killer, a `SIGKILL`
after the stop timeout — never reaches the clean-close path, and leaves the file
flagged WAL. Any machine reaching that folder over a share is then locked out
until something with local access converts it.

The owner was shown this and chose it anyway, for the performance WAL buys while
a library is being browsed and scanned. The alternative — never using WAL for a
library — was rejected below.

**It is always recoverable and never loses data.** An abandoned `-wal` is
replayed by the next server to open the library, which is ordinary SQLite crash
recovery; what is lost is only the ability to open the library from a machine
reaching it over a share. Restarting the crashed server and stopping it cleanly
converts the file back, and that machine has local access by definition. So the
design minimises and *explains* the window rather than pretending it away:
decision 5 makes the failure legible instead of a 500 and names the command,
decision 6 covers the marginal cases, and `docs/deployment.md` carries the
procedure.

There is no automatic detection of "this library is also reached over SMB". The
server serving it locally cannot see the other machine's mount, exactly as
ADR-0018 found for ownership; the honest mitigations are the ones above.

## Alternatives considered

- **Never use WAL for a library database** — the only option with no residual
  risk, and rejected by the owner: WAL is what keeps a scan or a thumbnail job
  from blocking browsing, and giving that up permanently to protect against an
  unclean shutdown was judged the wrong trade. Reconsider if crashes turn out to
  be common in practice.
- **Convert to rollback on a timer, or when a library goes idle** — narrows the
  window but does not close it (a crash mid-write is still a crash mid-write),
  and it would fight the idle checkpoint that ADR-0018 §6 already runs, taking
  the library out of WAL repeatedly during ordinary use. The at-rest state is
  the one that matters; that is what a clean close writes.
- **Record "this library wants rollback" in `manifest.json`** — rejected: it
  makes the mode a piece of *configuration* the user can get wrong, when it is
  really a fact about the machine currently holding the file. The filesystem
  already knows.
- **Detect WAL-vs-network by attempting the pragma and reading it back, with no
  filesystem identification** — this is authoritative and needs no platform
  code, and it is still used as the final check. Rejected as the *only*
  mechanism: it makes the whole design rest on a silent no-op, which is the
  failure mode that hid the bug for months. The filesystem check states the
  intent; the readback verifies it.
- **A `PRAGMA journal_mode` probe instead of reading the header bytes** in
  diagnosis — rejected: the question is asked about a file we are *unable to
  open*, so a connection-based answer is unavailable exactly when it is needed.
- **Leaving the failure as a 500** — rejected: the traceback pointed at a pragma
  line, which named the mechanism but not the cause, and gave no hint that the
  fix had to be run from a different machine.

## Consequences

Easier: a library at rest is one file that opens anywhere, restoring the
ADR-0008 portability guarantee that the pragma had been quietly eroding; the
NAS-container-plus-SMB-client topology the owner actually runs works; a library
that does get locked out says so, in an error naming the command that fixes it,
instead of a 500.

Harder / follow-up:

- Opening a library now connects eagerly (`create_app_engine` settles the mode
  before anything else touches the file), so a library-open failure surfaces at
  engine creation rather than at first query. Callers see
  `LibraryDatabaseOpenError` where they previously saw a `sqlalchemy` error.
- Filesystem identification is platform code, in one module, with an
  unidentified-filesystem fallback that must stay permissive.
- An unclean stop leaves a real, documented hazard. `infra/docker/smoke.sh`
  asserts the header byte after a graceful `docker stop` so the clean path
  cannot regress silently.
- `dispose_library_engine` gained a `revert_journal_mode` flag; any new caller
  has to decide which close it is performing.

## References

- ADR-0008 (per-library metadata and registry — the portability invariant this
  restores), ADR-0018 §4 and §6 (no writes to a library we do not own; the
  clean-close and idle-checkpoint hygiene this extends), ADR-0002 (the pragma
  set whose docstring carried the mistaken premise).
- `docs/deployment.md` — *Journal mode and network filesystems*, including the
  recovery command.
- Owner-reported incident and design discussion, 2026-07-30 (WAL-while-serving
  ratified, with the unclean-shutdown risk accepted explicitly).
