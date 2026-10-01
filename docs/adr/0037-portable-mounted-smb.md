# ADR-0037: Portable publication on mounted SMB

- Status: accepted within the approved mounted-SMB repair scope; bounded synthetic qualification passes
- Date: 2026-09-30
- Amends: ADR-0034; complements ADR-0035 and ADR-0036

## Context

Portable creation and metadata exchange require exclusive publication of complete
immutable files. Portable source operations also require no-replace file and
directory relocation. The tested macOS SMB mount refuses native hard links and
exclusive rename. It can retain obsolete directory entries after a direct SMB
rename and assigns different mounted inode numbers to moved objects. Native
inode observations cannot identify those objects through capture and recovery.

## Decision

Extend the existing signed, encrypted SMB3 transport to portable metadata
publication and reviewed source operations. Local storage retains native
primitives. A positively identified macOS SMB mount uses a bound server request
with replacement disabled for relocation. Metadata publication uses a bound
hard-link request when the native hard-link operation is unsupported. Neither
path falls back to check-then-rename, final-name copying or overwriting.

Resolve parent paths from held kernel directory descriptors. Verify their native
identity and canonical path. Require the same mounted endpoint, share and account
for both parents. Hold direct SMB ancestors against deletion, reject reparse
objects and referrals, and prove each mutation's parent mapping with temporary
nonce bytes read through the mount. Recheck held parent paths after publication.
Background work retrieves only the saved login for the exact mounted server,
account and share path, with interaction disabled. The Keychain path is the
mounted share name, without an added leading slash. A pathless lookup must not
select another share's item or its application access rules. The signed sidecar's
explicit `authorize-smb` command can request access and verify signed, encrypted
SMB3 without opening a library or starting an HTTP server.
Missing authorization is a recoverable unavailable state. Creation and serving
register roots; the last use of an account releases its private SMB session.

Source journals use a tagged private observation on SMB: `smb3-v1`, a digest of
the endpoint/share/account/server GUID/volume identity, the server file ID, size
and last-write time. Directory observations also retain their bounded subtree
digest. Historical native arrays retain their native interpretation and cannot
match the SMB tag. Shared receipts contain no transport credentials or private
physical identities. Discovery and media generations retain native observations.

Completed output staging is observed after its mounted writer closes. Only owned
staging receives an explicit last-write timestamp to prevent a deferred SMB close
from changing its recorded identity. Original sources and completed retained
versions never receive that timestamp operation. Recovery versions remain
independent copies, not hard links to mutable source files.

Mounted source observations discard cached file pages before reopening a file.
macOS can otherwise return old pages with a replacement file's new attributes.
This uses Darwin `F_NOCACHE`, flush and close on the selected regular file; it does
not change mount settings. Directory reviews refresh each bounded child file.

Direct publication verifies the server object and waits at most five seconds for
mounted namespace visibility. A replaced directory may wait up to thirty seconds
for its mounted child listing while its server identity remains exact. A missing
child requires retry; it never means that the whole directory is absent. These
waits never remove a cached or arriving name.
Callers retain complete-byte checks for immutable metadata and strict physical
identity checks for source operations. Definite server leaf absence is accepted
only after its direct parents were verified. Credential, mapping and parent
failures remain errors. A lost reply or delayed mounted view leaves exact intent
and recovery files available for explicit retry.

## Consequences and acceptance

The implementation retains source write permission, journal-before-mutation,
independent versions, bounded directory reviews and conditional Undo. Metadata
publication does not grant source-write permission. A server GUID change requires
review rather than automatic adoption of a new authority.

Tests must cover occupied names, changed bytes, server/account changes, symlinks,
missing parents, missing credentials, delayed visibility, lost replies, exact
retry, nested directories and historical observations. Real mounted-share tests
must exercise portable Create and all source operations with synthetic data.
HTTP, packaged credential handling and native interaction require separate
results. Broader servers, power loss and independently syncing providers remain
outside this decision's qualification evidence. See
[storage qualification](../storage-qualification.md).
