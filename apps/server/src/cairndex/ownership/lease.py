"""Ownership-lease file format and state classification (ADR-0018 §2–§3).

The lease is a small JSON file inside the library package. It is written
atomically (temp file + rename in the same directory) so a sync engine or a
concurrent reader never observes half a record, and every write — including a
heartbeat — regenerates ``nonce``, which is what makes the write-then-verify
acquisition in ``manager`` able to detect that another server overwrote us.
"""

import json
import os
import secrets
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from pathlib import Path

from cairndex.registry import library_package as pkg

# Sync engines leave a copy of the losing side next to the winner rather than
# discarding it. A copy here means two servers wrote the lease while partitioned
# (ADR-0018 §4/§7), which is the one case the lease cannot prevent — so it is
# surfaced loudly and never auto-resolved. Patterns cover the major services:
# Dropbox ("… (conflicted copy …)"), Syncthing (".sync-conflict-…"), iCloud and
# OneDrive (both use "name (1).json"-style numbering), and Nextcloud.
_CONFLICT_GLOBS = (
    "*conflicted copy*",
    "*.sync-conflict-*",
    "*conflicted-copy*",
    "* (?).json",
    "* (??).json",
)


class LeaseState(StrEnum):
    """How a server should treat a lease it just read.

    ``UNREADABLE`` is deliberately *not* folded into ``RELEASED``. A lease we
    cannot parse tells us nothing about whether someone is serving the library,
    so treating it as free would let a corrupt (or partially written) file
    become a silent second writer. It routes to the same explicit-confirmation
    path as ``STALE`` instead: the user is asked, with the holder unknown.
    """

    RELEASED = "released"
    OWN = "own"
    FRESH = "fresh"
    STALE = "stale"
    UNREADABLE = "unreadable"


@dataclass(frozen=True)
class LeaseHolder:
    """The subset of a lease that is safe and useful to show a user.

    Carried on the structured errors a refused mount returns, so the client can
    say "served by <machine>" and offer a redirect when ``advertised_url`` is a
    real network address.
    """

    server_uuid: str
    machine_name: str
    advertised_url: str | None
    heartbeat_at: datetime | None

    def as_details(self) -> dict[str, object]:
        return {
            "server_uuid": self.server_uuid,
            "machine_name": self.machine_name,
            "advertised_url": self.advertised_url,
            "heartbeat_at": self.heartbeat_at.isoformat() if self.heartbeat_at else None,
        }


@dataclass(frozen=True)
class LeaseRecord:
    """A parsed ``active-owner.json`` (ADR-0018 §2)."""

    server_uuid: str
    machine_name: str
    advertised_url: str | None
    acquired_at: datetime
    heartbeat_at: datetime
    nonce: str
    released_at: datetime | None = None

    @property
    def holder(self) -> LeaseHolder:
        return LeaseHolder(
            server_uuid=self.server_uuid,
            machine_name=self.machine_name,
            advertised_url=self.advertised_url,
            heartbeat_at=self.heartbeat_at,
        )

    def to_json(self) -> str:
        payload: dict[str, object] = {
            "server_uuid": self.server_uuid,
            "machine_name": self.machine_name,
            "advertised_url": self.advertised_url,
            "acquired_at": self.acquired_at.isoformat(),
            "heartbeat_at": self.heartbeat_at.isoformat(),
            "nonce": self.nonce,
        }
        if self.released_at is not None:
            payload["released_at"] = self.released_at.isoformat()
        return json.dumps(payload, indent=2) + "\n"


@dataclass(frozen=True)
class LeaseSnapshot:
    """The outcome of one read of the lease file.

    Three distinguishable outcomes, because they lead to different decisions:
    absent (``record is None`` and not ``corrupt``), parsed, or present but
    unparseable.
    """

    record: LeaseRecord | None = None
    corrupt: bool = False

    @property
    def absent(self) -> bool:
        return self.record is None and not self.corrupt


def new_nonce() -> str:
    """A fresh write marker. Regenerated on *every* write, heartbeats included."""
    return secrets.token_hex(16)


def _parse_dt(raw: object) -> datetime | None:
    """Parse an ISO-8601 timestamp, treating a missing offset as UTC.

    The format is documented as ISO-8601 UTC, but this file is plain JSON that
    people legitimately read and edit by hand, and "2026-07-20T12:00:00" is the
    obvious thing to type. Left naive it would poison every comparison against
    an aware ``now`` with ``TypeError: can't subtract offset-naive and
    offset-aware datetimes`` — which the heartbeat's never-die guard would
    swallow, leaving the library silently held instead of unmounting. Assuming
    UTC matches both the documented format and what a person editing it means.
    """
    if not isinstance(raw, str) or not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def parse_lease(raw: str) -> LeaseRecord | None:
    """Parse lease JSON, or ``None`` if it is malformed or missing a field."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None

    server_uuid = data.get("server_uuid")
    machine_name = data.get("machine_name")
    acquired_at = _parse_dt(data.get("acquired_at"))
    heartbeat_at = _parse_dt(data.get("heartbeat_at"))
    nonce = data.get("nonce")
    if not isinstance(server_uuid, str) or not server_uuid:
        return None
    if not isinstance(nonce, str) or not nonce:
        return None
    if acquired_at is None or heartbeat_at is None:
        return None

    advertised_url = data.get("advertised_url")
    return LeaseRecord(
        server_uuid=server_uuid,
        machine_name=machine_name if isinstance(machine_name, str) else "",
        advertised_url=advertised_url if isinstance(advertised_url, str) else None,
        acquired_at=acquired_at,
        heartbeat_at=heartbeat_at,
        nonce=nonce,
        released_at=_parse_dt(data.get("released_at")),
    )


def read_lease(root: Path) -> LeaseSnapshot:
    """Read the lease under ``root``. Never raises for ordinary I/O problems.

    An unreadable *directory entry* (permissions, a vanished mount) is reported
    as ``corrupt`` rather than absent for the same reason a malformed file is:
    "we could not find out" must not be mistaken for "nobody holds it".
    """
    path = pkg.lease_path(root)
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return LeaseSnapshot()
    except OSError:
        return LeaseSnapshot(corrupt=True)
    except UnicodeDecodeError:
        return LeaseSnapshot(corrupt=True)

    record = parse_lease(raw)
    if record is None:
        return LeaseSnapshot(corrupt=True)
    return LeaseSnapshot(record=record)


def classify(
    snapshot: LeaseSnapshot,
    *,
    our_uuid: str,
    now: datetime,
    ttl: timedelta,
) -> LeaseState:
    """Decide how to treat a lease we just read (ADR-0018 §3).

    Staleness compares ``heartbeat_at`` — written by whatever machine holds the
    lease — against our own clock, so it is only a hint: a skewed peer can look
    stale when it is alive. That is why a stale classification never leads
    straight to a takeover. ``manager`` first watches the file for longer than a
    heartbeat interval (a live holder visibly touches it, no clocks involved)
    and then still requires the user to confirm. Skew in the other direction —
    a heartbeat dated in the future — reads as fresh, which errs toward
    refusing to serve.
    """
    if snapshot.corrupt:
        return LeaseState.UNREADABLE
    record = snapshot.record
    if record is None or record.released_at is not None:
        return LeaseState.RELEASED
    if record.server_uuid == our_uuid:
        # We crashed before releasing. Re-acquire regardless of staleness: a
        # lease in our own name cannot be another server's.
        return LeaseState.OWN
    if now - record.heartbeat_at <= ttl:
        return LeaseState.FRESH
    return LeaseState.STALE


def write_lease(root: Path, record: LeaseRecord) -> None:
    """Atomically write the lease: temp file in the same dir, fsync, rename.

    Same-directory rename is what makes this atomic on POSIX; a reader either
    sees the whole old record or the whole new one. The temp file is fsynced
    before the rename so a crash cannot publish a truncated lease under the real
    name, which would read as ``UNREADABLE`` and demand a needless confirmation.
    """
    directory = pkg.locks_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=directory, prefix=".active-owner-", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(record.to_json())
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, pkg.lease_path(root))
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    _fsync_dir(directory)


def create_lease_exclusive(root: Path, record: LeaseRecord) -> bool:
    """Create the lease only if no file exists yet. ``False`` if one already did.

    The uncontended fast path: ``O_EXCL`` means exactly one of two servers
    racing from a clean state can win, without either having to trust a
    timestamp. The loser re-reads and classifies normally, so it sees the
    winner's fresh lease and refuses.

    Unlike ``write_lease`` this publishes the name before the content, leaving a
    sub-millisecond window where a reader could see an empty file. That is
    exactly why an unparseable lease classifies as ``UNREADABLE`` and asks
    rather than as ``RELEASED`` and takes.
    """
    directory = pkg.locks_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    path = pkg.lease_path(root)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(record.to_json())
        handle.flush()
        os.fsync(handle.fileno())
    _fsync_dir(directory)
    return True


def _fsync_dir(directory: Path) -> None:
    """Durably record the rename/create itself. Best effort by design.

    Directory fsync is unsupported on several of the filesystems a library can
    legitimately live on (SMB, some FUSE mounts). Failing the acquisition over
    it would make the lease unusable exactly where it matters most, and the
    consequence of skipping it is bounded: a power loss could lose the *last*
    lease write, which the next classification handles as a stale or released
    lease like any other.
    """
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def find_conflict_artifacts(root: Path) -> list[str]:
    """Names of sync-conflict copies sitting next to the lease (ADR-0018 §4).

    Returns bare file names, never absolute paths, so the caller can surface
    this without leaking the library's location into logs or API responses.
    """
    directory = pkg.locks_dir(root)
    found: set[str] = set()
    for pattern in _CONFLICT_GLOBS:
        try:
            matches = directory.glob(pattern)
            found.update(entry.name for entry in matches if entry.is_file())
        except OSError:
            continue
    found.discard(pkg.LEASE_NAME)
    return sorted(found)
