# ADR-0034: Mounted-SMB copy publication

- Status: accepted (owner-ratified 2026-09-20)
- Date: 2026-09-18
- Branch: `fix/library-ownership-lifecycle`

## Context

Mac-hosted access to NAS files through an SMB mount is required. On the tested
mount, native hard links, exclusive rename and cloning reject vacant targets.
Ordinary rename can overwrite a concurrent arrival; final-name copying exposes
partial bytes. Neither preserves ADR-0013's journaled replacement contract.

An external prototype can issue an SMB3 hard-link request against the NAS service
while the backend, catalog and media access remain on the Mac and mounted paths.
[Verification](../nas-verification.md#direct-smb-feasibility-experiment) records
the evidence and limits. This is a separate authenticated SMB connection; it does
not reuse the mounted filesystem's authenticated session. The owner authorized
application access to the saved login on 2026-09-20.

## Decision

Use direct SMB only for the publication and file-identity operations needed by
Copy, copy Replace and their Undo/recovery paths on positively identified macOS
SMB mounts. Retain native publication on compatible local filesystems. Keep
existing write-mode, ownership, path-validation and journal-before-write gates.

### Authentication and mapping

- Let the owner enable use of the existing saved SMB login for the corresponding
  server/account. Retrieve only that Keychain item, on demand; do not enumerate
  credentials or copy the password into settings, the registry, a library,
  environment variables, logs or subprocess arguments. Keep session secrets in
  memory and release sessions when their library closes.
- Separate interactive authorization from background recovery. A missing,
  locked, denied or expired credential produces a recoverable unavailable state;
  background work must not repeatedly prompt or reinterpret failed authentication
  as evidence that a file is absent. Bound an unanswered Keychain prompt so a
  request and server shutdown can recover.
- Resolve endpoint, share and account from the actual mounted filesystem, never
  a client-provided URL or absolute path. Prove the mapped library is the same
  directory using a disposable staging challenge through both access paths.
  Validate the server identity and reject unapproved redirects, symlinks,
  reparse-point escapes and remapped mounts before touching source files.
- Require encrypted and signed SMB3 for this path. Use the maintained
  `smbprotocol` package rather than implementing SMB or vendoring its source;
  record its transitive authentication/cryptography dependencies and include it
  in sidecar packaging and dependency maintenance.

### Publication and recovery

- Flush completed staging before recording a stable server observation. Timestamp
  handling may affect staging only; never change an original to make a receipt
  match. Prove stability rather than ignoring a mismatched observation.
- Verify publication capability before displacing an existing destination. Use
  a server-side hard link that refuses an occupied destination, verify complete
  mounted visibility, then remove only the staging name. Preserve both original
  and arriving files when publication loses a race.
- Version the new journal protocol and observations. Record the authenticated
  server/share identity and server file identity needed for recovery without
  recording a secret. Native mount inode numbers are not server file IDs.
  Historical receipts retain their original interpretation.
- Make recovery idempotent after link creation, mounted-path refresh, staging
  removal, original backup and every Undo boundary. Credential loss or a changed
  mapping leaves recoverable files and pending intent intact. Do not sweep
  staging still referenced by an unresolved operation.
- Copy creates independent catalog identity. Copy Replace keeps the destination
  identity and authored metadata; Undo restores bytes while retaining later
  authored edits. No outside-source deletion is added.

## Acceptance

1. Unit coverage for endpoint parsing, mapping proof, path escapes, server identity,
   credential denial, signed/encrypted transport and secret-free error handling.
2. Versioned receipts, old-receipt regressions, duplicate recovery, mount loss,
   credential loss and interrupted publication/Undo tests with synthetic files.
3. Normal-service tests with ordinary account permissions, complete-file
   visibility, collision refusal and independent-process recovery.
4. Real HTTP Copy/Replace/Undo, browser picker and fresh desktop-sidecar checks
   against disposable libraries; validate packaging and the full relevant gates.

The external prototype alone satisfies none of the application implementation or
UI acceptance requirements. Power-loss and broader-server qualification remain
separate from process-exit recovery.

## Alternatives and consequences

Changing to a NAS-hosted server does not satisfy the required Mac-hosted scenario.
Check-then-rename and final-name copy violate the established safety contract.
The inspected mounted-session APIs provide no usable public SMB2 publication
operation, so the direct connection adds authentication and mapping responsibilities.

This decision adds a narrow storage transport and dependency maintenance burden.
It does not adopt the held desktop OS-drop adapter in ADR-0033. No production
share-setting change or installed-application replacement is authorized by this
record.
