"""Ownership-lease API schemas (ADR-0018)."""

from pydantic import BaseModel


class LeaseHolderRead(BaseModel):
    """The server currently recorded in a library's lease.

    Never carries a filesystem path — only what a user needs to recognize the
    machine and, when ``advertised_url`` is set, reach it.
    """

    server_uuid: str | None = None
    machine_name: str | None = None
    advertised_url: str | None = None
    heartbeat_at: str | None = None


class TakeoverRead(BaseModel):
    """State of a confirmed takeover started on this server."""

    running: bool
    error_code: str | None = None
    error_message: str | None = None


class LibraryOwnershipRead(BaseModel):
    """How this server currently relates to a library's ownership lease.

    Deliberately readable while the library is *not* mountable — it is the
    endpoint a client calls after a mount was refused, to find out who holds the
    library and whether a takeover is on the table.
    """

    library_id: str
    # One of the ``LeaseState`` values: owned by us, released, held by a live
    # foreign server, stale, or unreadable.
    state: str
    # Whether this server may serve the library right now.
    mountable: bool
    # Whether a user-confirmed takeover is the appropriate offer. False for a
    # live holder: the answer there is to connect to that server, not to take
    # the library from it.
    can_take_over: bool
    # Set only when the holder advertises a reachable, non-loopback address —
    # a loopback URL from another machine is meaningless here (ADR-0018 §2).
    redirect_url: str | None = None
    holder: LeaseHolderRead | None = None
    takeover: TakeoverRead | None = None
