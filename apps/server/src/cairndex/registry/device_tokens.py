"""Registry persistence and authentication for paired device tokens."""

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.auth.device_tokens import (
    create_device_token,
    device_id_from_token,
    hash_device_token,
    verify_device_token,
)
from cairndex.core.errors import DeviceScopeError, InvalidDeviceTokenError, NotFoundError
from cairndex.core.time import utcnow
from cairndex.registry.models import DeviceToken

LAST_USED_WRITE_INTERVAL = timedelta(seconds=60)


def issue_device_token(session: Session, *, name: str, library_ids: list[str]) -> str:
    """Persist a hash-only device credential and return its one-time plaintext."""
    device_id, token = create_device_token()
    session.add(
        DeviceToken(
            id=device_id,
            name=name,
            token_hash=hash_device_token(token),
            library_ids=list(library_ids),
        )
    )
    session.flush()
    return token


def authenticate_device_token(session: Session, *, token: str, library_id: str) -> DeviceToken:
    """Validate a bearer token, enforce its scope, and throttle usage writes."""
    device_id = device_id_from_token(token)
    device = session.get(DeviceToken, device_id) if device_id is not None else None
    if (
        device is None
        or device.revoked_at is not None
        or not verify_device_token(token, device.token_hash)
    ):
        raise InvalidDeviceTokenError("Device token is invalid or revoked")
    if library_id not in device.library_ids:
        raise DeviceScopeError(f"Device token does not grant access to library {library_id!r}")

    now = utcnow()
    if device.last_used_at is None or now - device.last_used_at > LAST_USED_WRITE_INTERVAL:
        device.last_used_at = now
        session.flush()
    return device


def list_device_tokens(session: Session) -> list[DeviceToken]:
    """List paired devices newest first, including revoked history."""
    return list(session.scalars(select(DeviceToken).order_by(DeviceToken.id.desc())))


def revoke_device_token(session: Session, device_id: str) -> DeviceToken:
    """Revoke a device credential immediately and idempotently."""
    device = session.get(DeviceToken, device_id)
    if device is None:
        raise NotFoundError(f"device {device_id!r} not found")
    if device.revoked_at is None:
        device.revoked_at = utcnow()
        session.flush()
    return device


def revoke_device_tokens_for_library(session: Session, library_id: str) -> int:
    """Revoke every live credential whose immutable scope includes a library."""
    devices = session.scalars(select(DeviceToken).where(DeviceToken.revoked_at.is_(None)))
    now = utcnow()
    revoked = 0
    for device in devices:
        if library_id in device.library_ids:
            device.revoked_at = now
            revoked += 1
    if revoked:
        session.flush()
    return revoked
