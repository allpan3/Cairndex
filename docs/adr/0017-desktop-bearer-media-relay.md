# ADR-0017: Desktop bearer media relay

- Status: proposed (accepted-pending-owner-review)
- Date: 2026-07-16
- Branch/PR: `feat/desktop-platform-auth`

## Context

ADR-0015 requires native clients to send library-scoped bearer tokens without
putting them in URLs. Programmatic JSON requests can use `Authorization`, but
WKWebView-owned `<video>`, `<img>`, `<track>`, CSS image, and native-HLS requests
cannot set that header. Fetching whole media bodies into blobs would defeat
range playback and create unbounded memory use for multi-gigabyte files.

D2 initially added an embedded loopback HTTP relay. That is consequential
infrastructure: it introduces a listening socket, request routing, CORS,
timeouts, concurrency, redirect behavior, and response-framing responsibilities
inside the desktop host. It therefore needs a recorded boundary rather than an
implicit implementation choice.

Tauri custom URI schemes appear to remove the socket and CORS surface, but the
installed Tauri 2.11 protocol API requires the responder body to become an owned
`Cow<'static, [u8]>`. Both synchronous and asynchronous responders therefore
buffer the full response before WKWebView receives it. That cannot satisfy
Cairndex's streaming and large-file constraints.

## Decision

Keep a loopback-only HTTP relay for desktop media until Tauri exposes a
streaming custom-protocol response body. The relay is a narrow authenticated
read transport, not a general API proxy:

1. Bind an ephemeral port on `127.0.0.1` only. Generate a random 256-bit
   capability path on every server/token configuration and invalidate the old
   path immediately.
2. Fix the upstream origin and base path to the normalized owner-configured
   Cairndex server. Never accept an upstream host from the request.
3. Accept only `GET`, `HEAD`, and local CORS preflight. Allowlist the exact media
   routes used for streams, thumbnails, previews, storyboards, subtitles,
   File Browser bytes, and HLS session artifacts. Reject every other route.
4. Persist the token together with its approved library ids. Route an asset
   through the relay and inject its bearer only when its path names an approved
   library. Unscoped unprotected libraries use their existing anonymous server
   URLs; unscoped protected libraries require pairing.
5. Do not follow upstream redirects. Strip caller credentials, upstream cookies,
   redirect locations, hop-by-hop headers, and upstream CORS headers.
6. Allow only packaged Tauri origins and the fixed `127.0.0.1:5173` development
   origin. Requests without an Origin remain available to native diagnostics;
   any explicit unrecognized Origin is rejected before upstream I/O.
7. Bound connect and per-read stalls, active workers, and the request queue.
   Preserve `Content-Length` for known-length responses, including large 206
   ranges, rather than switching them to chunked transfer.

Programmatic requests remain a separate platform fetch transport and attach the
bearer only to approved library-scoped API URLs. ADR-0015's rule that an explicit
invalid or out-of-scope bearer fails closed remains unchanged on the server.

## Alternatives considered

- **Tauri custom URI scheme** — deferred because Tauri 2.11 responders require
  an owned byte body and therefore buffer media. Reconsider when the API can
  pass a streaming body through WKWebView on macOS and WebKitGTK on Linux.
- **Fetch media into Blob URLs** — rejected because it loses native range/HLS
  behavior and can buffer an entire large file in webview memory.
- **Put the bearer in media query parameters** — rejected by ADR-0015 because
  URLs leak through DOM state, caches, logs, history, and diagnostics.
- **Reuse ADR-0010 cookies in the shell** — rejected by ADR-0012/0015; it would
  make the native client emulate cross-origin browser-session behavior and
  retain owner passphrases indirectly.
- **Expose unauthenticated signed media URLs** — deferred; it adds a second
  server credential lifecycle, expiry semantics, and cache/log exposure without
  removing the need for client-specific authorization.

## Consequences

- WKWebView retains native range and HLS loading without credentials in media
  URLs or whole-file buffering.
- The relay remains security- and reliability-sensitive Rust code. Its route,
  origin, timeout, redirect, framing, and concurrency invariants require unit
  tests plus packaged-app range verification.
- The capability path is not an authorization grant by itself: Rust still
  checks the media route and approved library scope before injecting a bearer.
- The Tauri store retains the issued token in plaintext on the device, as plan 3
  D2 currently specifies. Moving it to an OS credential vault is a separate
  storage decision and does not change this transport boundary.

## References

- ADR-0010: per-library owner passphrase lock
- ADR-0012 decision 5: native-client device tokens
- ADR-0015: device pairing and scoped bearer tokens
- `docs/plans/03-macos-desktop-app.md` D2
- Tauri 2.11 `Builder::register_asynchronous_uri_scheme_protocol`
