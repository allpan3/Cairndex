"""The write-mode gate: may this library be written to at all? (ADR-0013 §1)

Two independent switches must both say yes, and they are separate on purpose
because they answer to different people:

* ``CAIRNDEX_WRITE_MODE`` is the deployment master switch, set by whoever runs
  the server. ``disabled`` forces every library read-only, so a hardened or
  shared deployment cannot have writing turned on through the UI at all.
* ``registered_libraries.write_mode_enabled`` is the owner's per-library
  opt-in, default off. It lives in the **registry**, never in the portable
  manifest (ADR-0008), so copying a library to another server does not carry
  write permission with it — the new server starts read-only.

Enabling is the one direction that is guarded further: a library with a
passphrase (ADR-0010) re-prompts for it. That is a one-time re-auth on a
consequential capability change, not a second session model — an already
unlocked session proves who was there *earlier*, and turning on the ability to
move and delete files is worth asking again for. Disabling never re-prompts:
giving up a capability is always safe, and a passphrase the owner has forgotten
must never be able to strand a library in a writable state.
"""

from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.orm import Session

from cairndex.auth import is_protected
from cairndex.core.config import get_settings
from cairndex.core.errors import AuthRequiredError, WriteModeDisabledError
from cairndex.registry import services as registry_service


@dataclass(frozen=True)
class WriteModeState:
    """Everything a client needs to render (and explain) the write-mode toggle."""

    # The library's own opt-in flag, as stored. Reported as-is even when the
    # deployment overrides it, so the UI can say "on, but blocked here" rather
    # than silently showing a switch the owner did not turn off.
    enabled: bool
    # The deployment master switch.
    allowed_by_deployment: bool
    # Whether enabling will ask for the library's passphrase.
    requires_passphrase: bool

    @property
    def effective(self) -> bool:
        """Whether write operations are actually permitted right now."""
        return self.enabled and self.allowed_by_deployment


def _state(*, enabled: bool, root: Path) -> WriteModeState:
    return WriteModeState(
        enabled=enabled,
        allowed_by_deployment=get_settings().deployment_allows_write_mode(),
        requires_passphrase=is_protected(root),
    )


def read_write_mode(registry: Session, library_id: str) -> WriteModeState:
    """Report the write-mode state of one registered library (404 if unknown)."""
    library = registry_service.get_library(registry, library_id)
    return _state(enabled=library.write_mode_enabled, root=Path(library.root_path))


def ensure_write_mode(registry: Session, library_id: str) -> None:
    """Refuse a write operation unless both gates permit it (ADR-0013 §1).

    Every endpoint that can touch a file calls this. The refusal names which
    gate said no, because the two have different fixes — one is a toggle the
    owner owns, the other is server configuration they may not control.
    """
    state = read_write_mode(registry, library_id)
    if not state.allowed_by_deployment:
        raise WriteModeDisabledError(
            "This server is configured read-only; file operations are disabled.",
            details={"reason": "deployment"},
        )
    if not state.enabled:
        raise WriteModeDisabledError(
            "Write mode is off for this library; file operations are disabled.",
            details={"reason": "library"},
        )


def set_write_mode(
    registry: Session,
    library_id: str,
    *,
    enabled: bool,
    passphrase_verified: bool = False,
) -> WriteModeState:
    """Turn write mode on or off for one library.

    The caller has already been authorized for this library. ``passphrase_verified``
    reports whether they *also* presented the library's passphrase on this
    request — the extra re-auth that enabling a protected library requires. The
    secret itself stays in the API layer and never reaches here.
    """
    library = registry_service.get_library(registry, library_id)
    root = Path(library.root_path)

    if enabled:
        if not get_settings().deployment_allows_write_mode():
            raise WriteModeDisabledError(
                "This server is configured read-only; write mode cannot be enabled.",
                details={"reason": "deployment"},
            )
        if is_protected(root) and not passphrase_verified:
            # Generic on purpose, exactly like unlocking: never distinguish a
            # missing passphrase from a wrong one, and never log either.
            raise AuthRequiredError("Enabling write mode requires this library's passphrase.")

    library.write_mode_enabled = enabled
    registry.flush()
    return _state(enabled=enabled, root=root)
