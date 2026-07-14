# ADR-0015: Device pairing and scoped bearer tokens

- Status: proposed (accepted-pending-owner-review)
- Date: 2026-07-13
- Branch/PR: `feat/device-pairing`

> This ADR records the implementation-time decision required by ADR-0012
> decision 5 and plan 2 §4. The slice is implemented for review; owner
> ratification is pending.

## Context

ADR-0010's optional passphrase lock uses an HTTP-only cookie and is deliberately
browser-shaped. Desktop and TV clients need a credential they can retain and
send in an `Authorization` header without storing a passphrase or emulating a
browser cookie jar. ADR-0012 chose owner-approved short-code pairing, registry
DB persistence, and coexistence with ADR-0010, but deferred the security and
lifecycle details to this ADR.

Constraints: remain single-owner and additive under `/api/v1`; never put tokens
in URLs or logs; store only token/code hashes; scope every token to explicit
library ids; preserve anonymous behavior for passphrase-less libraries; avoid
registry writes and connections on streaming response bodies; and make
revocation immediate.

## Decision

1. **Token format, entropy, and hashing.** A token is
   `cdx_<device ULID>.<secret>`, where `secret` is 32 random bytes encoded with
   URL-safe base64 (256 bits of entropy). The ULID selects one registry row;
   it is not an authority claim. The stored `token_hash` is a versioned salted
   SHA-256 record and verification uses `hmac.compare_digest`. This follows
   ADR-0010's hash-only, salted, scheme-recorded, constant-time pattern, but not
   its 600,000-round PBKDF2 work factor: a machine-generated 256-bit secret is
   not guessable like a passphrase, and a password KDF on every media range
   request would create an avoidable playback hot path. Plaintext is produced
   only in the successful poll call and is never persisted or buffered between
   requests.

2. **Registry placement and scope.** The server-local registry DB gains the
   additive `device_tokens` table: `id`, `name`, `token_hash`, JSON
   `library_ids`, `created_at`, nullable `last_used_at`, and nullable
   `revoked_at`. Device grants are server ownership/runtime state, not portable
   content metadata, so they do not travel with `library.db` or a library
   manifest. Each request validates the bearer and requires the requested
   `library_id` to be in its immutable approved scope; scope changes require a
   new pairing.

3. **Pairing UX and bounds.** `pair/start` returns an uppercase six-character
   code from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` plus a high-entropy poll key.
   Pairing state is in-process, expires after ten minutes, and is capped at 16
   outstanding requests; at capacity, the oldest request is evicted. Only
   digests of codes and poll keys are held. Unknown, evicted, expired,
   unapproved, and already-consumed poll keys all return the same
   `{status:"pending"}` response. Approval attaches explicit library ids. The
   first approved poll creates the database row and returns the token; it then
   removes the pairing request, so delivery is exactly once.

4. **Owner authorization.** Approval uses the ADR-0010 browser session. When
   any registered library is protected, global device listing/revocation and
   pairing approval require a live unlock for at least one protected library;
   every protected library selected for a new token must itself be unlocked in
   that cookie session. With no protected libraries, the existing anonymous
   single-owner posture remains. Thus pairing cannot bypass a configured
   passphrase or broaden a token beyond the ids the owner selected.

5. **Cookie coexistence and streaming safety.** An explicit
   `Authorization: Bearer` header is validated first and never falls back to a
   cookie or anonymous access when malformed, unknown, revoked, or out of
   scope. Without that header, ADR-0010 cookie and passphrase-less anonymous
   behavior are unchanged. Both `get_library_session` and the cancellation-safe
   `LibraryAccess` streaming gate use the same bearer verifier. Streaming gates
   close their registry session before returning bytes. `last_used_at` is
   updated only when absent or more than 60 seconds stale, inside that short
   registry scope.

6. **Revocation.** Revocation sets `revoked_at`; it does not delete audit
   history. All subsequent uses return structured HTTP 401
   `invalid_device_token`. A valid token outside its scope returns structured
   HTTP 403 `device_scope_forbidden`. Tokens have no automatic expiry or
   refresh policy in this slice.

## Alternatives considered

- **Reuse the ADR-0010 cookie in native clients** — rejected: it couples native
  clients to browser session behavior and asks users to type passphrases on TV.
- **JWT/stateless bearer tokens** — rejected: persistent registry rows provide
  immediate revocation and require no signing-key lifecycle.
- **Store device grants in each library manifest/DB** — rejected: one device
  may span libraries, and server-issued credentials should not travel with a
  portable library package.
- **PBKDF2 for the random bearer secret** — rejected for this hot path. It adds
  CPU cost to every media request without meaningful protection against an
  offline attack on a 256-bit random value.
- **Persist pairing requests** — rejected: ten-minute, bounded, restart-droppable
  state is safer and simpler in process; a restart returning all polls to the
  uniform pending shape is acceptable.
- **Token refresh or automatic expiry** — deferred. Revocation is the only
  lifecycle control until external-client operational experience justifies a
  rotation policy.

## Consequences

- Desktop and TV clients can authenticate through one OpenAPI-described flow
  and retain only server URL plus bearer token.
- Restarting the server cancels outstanding pair requests but preserves issued
  and non-revoked device tokens.
- The registry backup now contains device names, scopes, hashes, and usage
  timestamps, but never bearer plaintext.
- A stolen bearer remains valid until revoked. Token expiry/refresh, device
  scope editing, and recovery UX are open questions for a future ADR or
  additive extension.
- This remains a private-network, single-owner guardrail. It does not make
  direct public-internet exposure supported.

## References

- ADR-0008 (server-local registry and portable libraries)
- ADR-0010 (per-library passphrase lock and cookie sessions)
- ADR-0012 decision 5 (native-client device tokens)
- `docs/plans/02-android-tv-client.md` §4
- `docs/plans/README.md` foundation 8 and API-evolution discipline
