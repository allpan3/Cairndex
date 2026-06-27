# ADR-0007: File View host integration and default-app handoff

- Status: accepted for future implementation
- Date: 2026-06-27
- Branch/PR: `feat/collections-and-file-view`

## Context

The Collections + File View refactor adds a read-only File View over configured
storage roots. The first milestone is intentionally web/server friendly: the
backend lists physical files and directories under configured roots, while the
browser presents them without moving, renaming, deleting, or launching anything.

The longer-term product still needs a split server/client model. That split is
primarily for eventual TV-side and remote viewing: media and metadata live on a
server/NAS, while different clients browse or play the library from elsewhere.
This split is not necessarily the ideal desktop-only architecture. A desktop app
could technically open the library directly from an SMB-mounted storage root and
operate on local mount paths, although that may make large-library browsing,
metadata sharing, scanning, and remote playback less smooth than a true
server/client model.

The owner also wants a future `open with default app` feature. A normal web UI
may not be able to support that safely or consistently, especially when the
backend runs on a NAS/container and the browser runs on another machine. That is
acceptable. The likely long-term path is a macOS/native desktop client or shell
that can invoke native applications directly after mapping a Cairndex storage
root to a local filesystem path.

## Decision

Do not implement `open with default app` or `reveal in file manager` in the first
read-only File View milestone.

Do not treat these features as ordinary remote web-server capabilities. A web
browser talking to the NAS/server should not be assumed to have permission or
ability to open files on the user's desktop.

Future support should be designed around explicit client/host integration, most
likely one of these paths:

1. a macOS/native desktop app or Tauri shell that hosts or embeds the Cairndex UI
   and can open local files after mapping storage-root paths;
2. a local companion helper running on the user's desktop with a narrow,
   user-initiated API;
3. a documented platform integration that proves the target path is inside an
   allowed storage root and that the action is initiated by the authenticated
   owner.

The server may expose metadata needed by such clients, for example stable file
IDs, storage-root IDs, relative paths, and future path-alias hints. The server
should not expose a generic host-level file-launch feature for arbitrary remote
browser sessions.

## Required safety properties

Any future host handoff must:

- only operate on files resolved from `storage_root_id + relative_path`;
- reject absolute paths supplied by clients;
- reuse existing traversal and symlink-escape checks;
- require explicit user action;
- be disabled or unavailable in deployments where no safe local/native client or
  helper is present;
- return a clear unsupported-state error rather than silently doing nothing;
- keep auditability in mind before adding write-mode file operations.

## Consequences

- The first File View milestone remains read-only.
- The current web UI may show a future placeholder or unsupported state for
  default-app handoff, but should not pretend the feature is available.
- File View code should preserve storage-root-relative path semantics so a future
  desktop client can map server roots to local mount paths.
- A future macOS/native client can offer better desktop affordances, including
  native default-app launching and reveal-in-file-manager, without weakening the
  safety model of the web/NAS deployment.

## Follow-ups

- Decide whether the first host-integration path is a macOS app, Tauri shell, or
  local helper.
- Design storage-root path aliases for desktop clients whose local mount paths
  differ from the server's canonical paths.
- Add UX for unsupported deployment modes.
- Revisit authentication before exposing any host-level file operation.
