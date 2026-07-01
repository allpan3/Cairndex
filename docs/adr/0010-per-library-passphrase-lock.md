# ADR-0010: Per-library optional owner passphrase lock

- Status: accepted
- Date: 2026-07-01
- Branch/PR: `feat/per-library-passphrase-lock`

## Context

Cairndex is single-owner and local-first, typically reached over a LAN or a
private overlay network (Tailscale). There is no authentication yet, which is
fine on a trusted network but offers no guardrail if the app is reachable by
someone the owner would rather not let browse a particular library. The owner
wants an *optional*, lightweight lock — per library, because different libraries
have different sensitivity — without turning Cairndex into a multi-user system.

Constraints from `AGENTS.md`: preserve the single-owner model (no multi-user
RBAC); keep libraries portable and library-owned; store only a passphrase hash,
never plaintext; do not log secrets; direct public-internet exposure remains
unsupported and must be documented as such.

## Decision

Add an **optional per-library owner passphrase lock**. Each library independently
chooses no lock or a passphrase lock. The passphrase **hash** (PBKDF2-HMAC-SHA256
with a random salt and a fixed iteration count) lives in the library's own
portable `manifest.json` under an `auth` block, so it travels with the library
and is set/cleared by a helper command, never through a content API.

Unlocking is a **server-side session** keyed by an opaque, HTTP-only,
`SameSite=Lax` cookie. The session record maps to a set of unlocked
`library_id`s, each with its own expiry — so unlocking library A never unlocks
library B, and each protected library requires its own unlock. The session store
is in-process (single-owner, single-process app); a server restart drops all
sessions, i.e. everything returns to locked, which is the safe direction.

Enforcement is centralized in the `get_library_session` dependency that every
library-scoped content route already depends on: a protected library with no
valid unlocked session for that library id returns `401`. The registry library
list, health, static assets, and the `auth/status|unlock|lock` endpoints stay
reachable while locked, so the owner can see which libraries exist and unlock the
one they want.

## Alternatives considered

- **Global app passphrase** — rejected: the milestone requires *per-library*
  scope; one global secret can't express "lock library A but not C".
- **Full multi-user accounts / RBAC** — rejected: explicitly a non-goal for the
  first release; this is a guardrail, not identity/authorization.
- **Signed stateless JWT cookies** — rejected for now: server-side opaque
  sessions are simpler, need no key management, and give instant server-side
  revocation (lock, restart). A global session secret can be added later if
  stateless tokens become desirable.
- **Store the hash in the registry DB** — rejected: the registry is server-local
  runtime state; the lock should travel with the portable library, so the
  manifest (library-owned) is the right home.
- **Store the hash in the library content DB** — viable and portable too, but
  the manifest keeps the setting readable/settable without opening the content
  DB and avoids content-schema churn.

## Consequences

- Unprotected libraries behave exactly as before (no cookie, no gate).
- Protected library **content** APIs are blocked until that library is unlocked
  in the caller's session; the session is scoped to specific library ids.
- Sessions are in-memory: they do not survive a restart (re-lock) and do not
  scale to multiple server processes — acceptable for the single-owner model.
- This is a **private-network guardrail, not public-internet hardening**: no
  rate limiting, lockout, or TLS is provided here; direct exposure to the public
  internet remains unsupported without a separate hardened reverse proxy.
- Future work can layer per-user accounts on top without changing the storage
  location (the manifest `auth` block is owner-scoped today, extensible later).

## References

- ADR-0008 (per-library metadata and registry) — the manifest and library-scoped
  content routes this builds on.
- `AGENTS.md` security/privacy rules; `docs/deployment.md` exposure notes.
