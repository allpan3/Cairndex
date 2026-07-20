"""This server install's persistent identity (ADR-0018 §2).

Split from ``registry.services`` because it answers a different question: not
"which libraries does this server know about" but "who is this server", which is
what every lease file it writes is stamped with.
"""

import socket

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from cairndex.core.config import get_settings
from cairndex.core.ids import new_id
from cairndex.registry.models import ServerIdentity


def default_machine_name() -> str:
    """A human-readable name for this machine, for takeover prompts."""
    configured = get_settings().machine_name
    if configured and configured.strip():
        return configured.strip()[:255]
    try:
        # Prefer the short name: "Allens-MacBook-Pro" reads better in a prompt
        # than the FQDN, and the domain part adds nothing for the owner.
        host = socket.gethostname().split(".")[0]
    except OSError:
        host = ""
    return host[:255] or "unknown machine"


def get_or_create_identity(session: Session) -> ServerIdentity:
    """Return this install's identity row, creating it on first use.

    The ``machine_name`` is refreshed on every read so renaming the machine (or
    setting ``CAIRNDEX_MACHINE_NAME``) shows up in the next lease write without
    needing a new identity — the ``server_uuid`` is what must stay stable.
    """
    identity = session.scalars(select(ServerIdentity).limit(1)).first()
    name = default_machine_name()
    if identity is None:
        identity = ServerIdentity(server_uuid=new_id(), machine_name=name)
        session.add(identity)
        try:
            session.flush()
        except IntegrityError:
            # Another thread inserted the single row between our read and write.
            session.rollback()
            existing = session.scalars(select(ServerIdentity).limit(1)).first()
            if existing is None:  # pragma: no cover — only reachable on real DB loss
                raise
            return existing
        return identity
    if identity.machine_name != name:
        identity.machine_name = name
        session.flush()
    return identity
