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


class ValidationError(DomainError):
    """Input that is well-formed but semantically invalid."""

    code = "validation_error"
