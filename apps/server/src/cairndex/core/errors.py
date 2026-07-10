"""Domain-level exceptions, independent of HTTP.

Services raise these; the API layer (api/errors.py) maps them to HTTP status
codes and a structured error body. Keeping them HTTP-agnostic lets the same
services back a future non-HTTP caller (AGENTS.md §14).
"""


class DomainError(Exception):
    """Base class for expected, client-attributable domain errors."""

    code = "domain_error"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


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
