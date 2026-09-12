# Servers, libraries and recovery

The app has one selected server and one intended library. A managed **This Computer**
server and optional remote servers share the same library experience. Storage location
and package capability do not introduce separate operating modes.

## Choose a destination

- **Servers** is always visible, including during library access failures. Desktop
  lists saved servers, accepts a private HTTP(S) address, and offers **This Computer**.
  Browser **Open server** navigates this tab to that server's own web app and sign-in.
- **Reconnect** starts a fresh desktop session for the selected server. Remote targets
  must answer a compatible health probe before becoming selected. A failed or cancelled
  preparation leaves the current destination in place. The short settings/transport
  commit cannot be cancelled halfway through.
- **Libraries** lists registrations on the selected server. **Open** chooses one;
  Release/Reopen preserve their server-level ownership meaning. Switching a client
  does not release server ownership or stop already admitted server jobs.
- Typed absolute paths refer to the named server. Desktop **Browse** picks on this
  computer; confirming registers locally, then selects This Computer when needed.
  The registry remains recoverable if registration succeeds but connection setup fails.
  A mounted remote folder grants no ownership; another holder still requires its
  existing connection, release or deliberate ownership recovery.

Desktop remembers the intended server and a library per server. Unavailable or missing
libraries show Retry and Manage Libraries instead of silently opening a sibling.
Server failure retains the intended choice across restart. Cancel a pending preparation
before starting a different switch. These controls work with keyboard focus and Enter;
Escape dismisses the server chooser.

## Recover access

Reconnect a drive/share for an unavailable root, or restore the registration at its
actual location. Retry the library list after doing so. An unreachable server needs
network/server recovery or another saved destination; incompatible servers need a
compatible Cairndex build. This Computer retry starts or reconnects its managed sidecar.
Ownership uncertainty and changed holders remain fenced by the existing Release/Reopen
and explicit takeover rules. Authorization polling detects lost access; a revoked
desktop grant can be forgotten for that server and paired again in Settings.

## Private state

Pairing grants are bound to the issuing server and approved registry IDs. URL, grant
and relay configuration change together. Tokens never enter connection URLs; local
sidecar tokens are not persisted. Forgetting one grant leaves other servers' grants.

Each desktop connection gets a fresh query cache, including same-server reconnects.
Library switches invalidate content requests and stop late mutation/cache continuations.
Content preferences and legacy title/note drafts include server and library identity.
Drafts retain their original optimistic-concurrency version; a later conflicting edit
must still be reviewed. Failed saves keep the draft. Successful receipts clear only
the submitted generation. Browser-storage failure keeps the legacy draft in memory for
this session and shows a warning to save before quitting. Replica private drafts keep
their existing durable server recovery and use a stable local key across sidecar ports.

Native mappings are scoped by server plus registry ID and revalidate the portable UUID
and path containment before use. Legacy mappings without a server association remain
stored but are not adopted implicitly; use Locate once for the selected server.
