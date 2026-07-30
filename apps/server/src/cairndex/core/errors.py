"""Domain-level exceptions, independent of HTTP.

Services raise these; the API layer (api/errors.py) maps them to HTTP status
codes and a structured error body. Keeping them HTTP-agnostic lets the same
services back a future non-HTTP caller (AGENTS.md §14).
"""


class DomainError(Exception):
    """Base class for expected, client-attributable domain errors.

    ``details`` is an optional machine-readable payload for errors a client must
    *act* on rather than merely display — currently the ownership-lease refusals
    (ADR-0018), which carry the holding server so the client can offer a
    redirect instead of a dead end. It is serialized as-is, so it must never
    contain a filesystem path or anything else the caller should not see.
    """

    code = "domain_error"

    def __init__(self, message: str, *, details: dict[str, object] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details


class NotFoundError(DomainError):
    code = "not_found"


class ConflictError(DomainError):
    """A uniqueness or state conflict (e.g. duplicate name, root in use)."""

    code = "conflict"


class VersionConflictError(ConflictError):
    """An optimistic-concurrency precondition failed (stale ``If-Match`` version).

    The client's expected version no longer matches the stored row, so another
    writer changed it first. Clients should reload and retry. Maps to 409.
    """

    code = "version_conflict"


class ValidationError(DomainError):
    """Input that is well-formed but semantically invalid."""

    code = "validation_error"


class CapacityError(DomainError):
    """A bounded interactive resource is exhausted (e.g. HLS transcode sessions).

    Distinct from a state conflict: the request is well-formed but the server is
    momentarily at capacity and the client should retry later. Maps to 429
    (ADR-0014). Interactive HLS sessions are bounded so a couple of players
    cannot saturate the box.
    """

    code = "capacity_exhausted"


class MediaProcessingError(DomainError):
    """A server-side media tool (ffmpeg) failed to produce output.

    Server-side, not client-attributable: the request was valid but the encoder
    exited with an error, so we surface a structured 500 instead of a misleading
    404/retry loop (ADR-0014). The message never carries source paths.
    """

    code = "media_processing_failed"


class AuthRequiredError(DomainError):
    """A protected library's content was requested without a valid unlock (ADR-0010).

    A private-network guardrail, not multi-user auth. Maps to 401; the client
    should show that library's passphrase screen and unlock before retrying.
    """

    code = "auth_required"


class InvalidDeviceTokenError(DomainError):
    """A supplied bearer credential is unknown, malformed, or revoked."""

    code = "invalid_device_token"


class DeviceScopeError(DomainError):
    """A valid device token does not include the requested library."""

    code = "device_scope_forbidden"


class WriteModeDisabledError(DomainError):
    """A guarded file operation was requested on a read-only library (ADR-0013).

    Not an authentication problem — the caller is authorized, the *capability*
    is off — so it maps to 403 rather than 401. ``details`` reports which of the
    two gates refused, because the fixes differ: a per-library toggle the owner
    can flip in the UI, versus a deployment-wide ``CAIRNDEX_WRITE_MODE=disabled``
    that only whoever runs the server can change. The UI greys write actions
    rather than hiding them, and this is what it explains in the tooltip.
    """

    code = "write_mode_disabled"


class LibraryDatabaseOpenError(ConflictError):
    """This server cannot open a library's ``library.db`` (ADR-0021). Maps to 409.

    A conflict rather than a 500 for the same reason the lease refusals are: the
    request is well formed and the library exists, but its *state on disk* is one
    this machine cannot serve, and the fix is an operator action rather than a
    retry. Without this the commonest instance — a database left in WAL journal
    mode that a machine reaching it over SMB or NFS cannot open at all — arrived
    as a bare 500 with a traceback and no attribution.

    ``details`` carries ``reason`` (``wal_on_network_filesystem``, ``unreadable``,
    ``missing``) and the filesystem kind, so a client can tell a fixable state
    apart from a permissions problem without parsing prose. Deliberately no path:
    the recovery command in ``message`` carries the one path an operator needs.
    """

    code = "library_database_unopenable"


class LibraryLeaseError(ConflictError):
    """Base for ownership-lease refusals (ADR-0018). Maps to 409.

    All three carry the holding server in ``details`` when it is known, so the
    client can name the machine and — when the holder advertises a reachable,
    non-loopback URL — offer to connect there instead.
    """

    code = "library_lease_conflict"


class LibraryLeaseHeldError(LibraryLeaseError):
    """Another server holds a live lease on this library.

    Not recoverable by this server: the right action is to talk to the holder,
    not to take the library from it. Distinct from ``LeaseTakeoverRequiredError``
    precisely so the client does not offer a takeover the user should not take.
    """

    code = "library_lease_held"


class LeaseTakeoverRequiredError(LibraryLeaseError):
    """A foreign lease looks abandoned; serving it needs explicit confirmation.

    Because a clean shutdown releases the lease, this is reached only after a
    crash, or while a holder's sync is lagging or paused — exactly the cases
    ADR-0018 ratified as needing a human decision rather than a timeout. There
    is deliberately no auto-takeover after any TTL.
    """

    code = "library_lease_takeover_required"


class LibraryOwnershipLostError(LibraryLeaseError):
    """We held this library's lease and another server took it (ADR-0018 §4).

    The library has been unmounted and its jobs cancelled. We never fight for a
    lease back; the client is redirected to the new holder.
    """

    code = "library_ownership_lost"
