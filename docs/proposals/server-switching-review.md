# Server and library switching review

The shared app exposes one active server and one intended library. Persistent server
controls remain reachable during outages; desktop offers saved remotes, This Computer,
reconnect and cancellable preparation. Browser server selection navigates to the
server's own web app. Missing or unavailable intended libraries keep their recovery
screen instead of selecting a sibling. Ownership redirects resolve the target library
on the named server before selection, and authorization polling detects access loss.

## State and ownership boundaries

- Pairing grants are retained independently per normalized server. Transport URL,
  token and media relay commit together; forgetting one grant preserves the others.
- A server activation remounts the query cache, including a same-server reconnect.
  Library changes fence requests, polling, mutations and delayed optimistic writes.
- Content preferences and legacy title/note drafts include server and registry library
  identity. Drafts retain optimistic-concurrency versions; failed saves preserve them,
  and receipts clear only the submitted generation. Storage failure is visible.
- Native Browse identifies This Computer as the serving machine, preserves confirmation
  and ownership checks, and hands a new local library's indexing to its destination.
- Native mappings use a server namespace and registry ID. Old unscoped entries remain
  stored and require Locate again. Open/reveal/drag/import path resolution captures
  the original namespace; import transport and credentials share that same snapshot.
  Late import results cannot advance the old batch or invoke new-workspace callbacks.
- Switching the client does not transfer ownership, release a remote server's leases,
  or cancel already admitted server jobs. Existing lifecycle gates remain authoritative.

## Validation

| Layer | Result |
| --- | --- |
| Frontend | 1,169 tests; lint, format, types and production build pass |
| Browser | Full suite 153 passed; final switching/library rerun 56 passed |
| Backend | 1,434 passed, one existing FFmpeg zscale skip; Ruff, format and mypy pass |
| Rust | 124 tests; formatting and clippy pass |
| Managed sidecar | 18 tests with the built frozen binary, including restart and folder registration |
| Packaging | ARM frozen sidecar build and smoke, launcher test, isolated production `.app` and signature pass |

The three-server browser flow uses real independent HTTP servers and the production
desktop entry with simulated native IPC. Shared portable UUIDs and bundle IDs verify
server draft separation; the flow also covers restart intent, failed compatibility,
cancellation, cold outage and reconnect. Separate browser coverage verifies failed
legacy saves across library changes/reload, discard, missing intent and keyboard use.
The actual packaged app started its managed sidecar, switched to a disposable remote,
then used native Browse from that remote view to create a confirmed local library and
select This Computer. Switching back selected the remembered remote library. After
quitting and stopping the disposable remote, the next launch retained that intended
server, reported its outage and offered This Computer. The server dialog opened with
Enter and closed with Escape through the macOS keyboard path. Native settings retained
only the local mapping namespace and no local token; both synthetic library databases
passed integrity checks after shutdown. These checks use the real WKWebView, Tauri IPC,
folder picker and bundled sidecar, without an alternate test UI.

A direct launch with the repository as its working directory initially made the
sidecar reject unrelated Docker `.env` entries. Launching from the disposable directory
and through Launch Services succeeded. This group does not change `.env` parsing;
repository-directory launch is not qualified by the packaged-app result.

## Qualification limits

The isolated `.app` uses the same production UI and bundled sidecar, with only its
bundle identity and deep-link scheme overridden to protect owner data. No installed
app is replaced. Docker and NAS testing are explicitly deferred. Ubuntu/Windows,
notarization, real providers, owner-library operations, large-library performance and
physical source workflows are not qualified by this group. The existing cumulative
8 MiB publication-volume gate remains blocked; history is preserved and nothing is
pushed, published or deployed.
