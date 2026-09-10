"""Lease acquisition, holding, and release (ADR-0018 §3–§4).

The manager is the only thing that decides whether this server may serve a
library. It keeps an in-memory set of the leases it holds so the mount gate is a
dictionary lookup rather than a stat of a possibly-offline NAS mount on every
request, and a background thread refreshes those leases — the same loop that
detects we have *lost* one.

Design notes worth keeping in view:

- **We never fight for a lease.** Losing ownership unmounts the library. Two
  servers each re-grabbing a lease from the other would produce exactly the
  alternating dual-writer the lease exists to prevent.
- **Nothing here trusts a remote clock.** Timestamps only ever *suggest*
  staleness; the observation window before a takeover is what actually
  establishes that no one is writing, by watching the file change or not.
"""

import errno
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from pathlib import Path

from cairndex.core.config import get_settings
from cairndex.core.errors import (
    DomainError,
    LeaseTakeoverRequiredError,
    LibraryLeaseError,
    LibraryLeaseHeldError,
    LibraryMetadataUnwritableError,
    LibraryOwnershipLostError,
    LibraryOwnershipUncertainError,
)
from cairndex.core.time import utcnow
from cairndex.ownership.lease import (
    LeaseRecord,
    LeaseState,
    classify,
    create_lease_exclusive,
    find_conflict_artifacts,
    new_nonce,
    read_lease,
    write_lease,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LeaseSettings:
    heartbeat_interval: float
    ttl: float
    verify_delay: float
    observation_margin: float = 20.0

    @property
    def ttl_delta(self) -> timedelta:
        return timedelta(seconds=self.ttl)

    @property
    def observation_window(self) -> float:
        """How long to watch a lease before taking it over (ADR-0018 §3).

        One full heartbeat interval, plus a margin. The interval is the part
        that carries the guarantee and is deliberately not configurable: a
        takeover starts at an arbitrary point in the holder's cycle, so only
        after a whole interval has elapsed is a live holder certain to have
        written. Watching for less would let a healthy server stay silent
        through the window and lose its library.

        The margin is slack for a write that has to reach us — through a
        cloud-sync engine, say — rather than appearing on a local disk at once.
        It was previously a second full interval, which made the wait twice as
        long as it needs to be for a library that is not synced.
        """
        return self.heartbeat_interval + self.observation_margin

    @classmethod
    def from_settings(cls) -> "LeaseSettings":
        settings = get_settings()
        return cls(
            heartbeat_interval=settings.lease_heartbeat_interval,
            ttl=settings.lease_ttl,
            verify_delay=settings.lease_verify_delay,
            observation_margin=settings.lease_observation_margin,
        )


@dataclass
class _Held:
    """A lease this server currently holds."""

    root: Path
    record: LeaseRecord
    checked_at: float = 0.0
    checked_wall: float = 0.0
    uncertain: bool = False


@dataclass(frozen=True)
class TakeoverProgress:
    """The outcome of a confirmed takeover that is running, or just finished.

    A takeover watches the lease for longer than a heartbeat period before it
    may proceed, which is far too long to hold an HTTP request open. So the
    endpoint starts it and returns, and the client polls the ownership status
    until ``running`` clears — at which point either we hold the lease or
    ``error_code`` says why we do not.
    """

    running: bool
    error_code: str | None = None
    error_message: str | None = None
    holder: dict[str, object] | None = None
    # When the observation started, and how long it runs. Reported so the client
    # can say how much longer rather than showing an unexplained spinner for
    # minutes — the wait is inherent to the design, so it should be legible.
    started_at: datetime | None = None
    observation_seconds: float | None = None


class LeaseManager:
    """Owns this server's leases. Thread-safe; one instance per process."""

    def __init__(
        self,
        *,
        server_uuid: str,
        machine_name: str,
        advertised_url: str | None,
        settings: LeaseSettings,
        clock: Callable[[], datetime] = utcnow,
        sleep: Callable[[float], None] = time.sleep,
        on_ownership_lost: Callable[[str], None] | None = None,
        package_check: Callable[[Path], object] = lambda root: None,
    ) -> None:
        self.server_uuid = server_uuid
        self.machine_name = machine_name
        self.advertised_url = advertised_url
        self.settings = settings
        self._clock = clock
        self._sleep = sleep
        self._on_ownership_lost = on_ownership_lost
        self._package_check = package_check
        self._held: dict[str, _Held] = {}
        self._lost: set[str] = set()
        self._takeovers: dict[str, TakeoverProgress] = {}
        self._acquire_locks: dict[str, threading.Lock] = {}
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # --- state -----------------------------------------------------------

    def holds(self, library_id: str, root: Path | None = None) -> bool:
        """Whether we currently hold this library's lease.

        ``root`` re-checks that the lease we hold is for the *path* the caller
        means: a library that was re-registered at a new root is a different
        folder, and its lease has to be acquired there before we may serve it.
        """
        with self._lock:
            held = self._held.get(library_id)
            if held is None:
                return False
            return root is None or held.root == root

    def held_library_ids(self) -> list[str]:
        with self._lock:
            return sorted(self._held)

    def held_library_id_set(self) -> set[str]:
        """The libraries we may safely write to right now (ADR-0018 §6 callers)."""
        with self._lock:
            return set(self._held)

    # --- acquisition -----------------------------------------------------

    def ensure_owned(self, *, library_id: str, root: Path) -> None:
        """The mount gate. Returns quietly if we may serve; raises otherwise.

        The common case uses cached ownership and clock reads without filesystem
        access. A heartbeat gap or I/O uncertainty requires nonce validation.
        """
        if self.holds(library_id, root):
            self.validate(library_id)
            return
        if library_id in self._lost:
            raise LibraryOwnershipLostError(
                "Ownership moved; deliberately reopen after checking the holder"
            )
        self.acquire(library_id=library_id, root=root)

    def acquire(self, *, library_id: str, root: Path, confirm_takeover: bool = False) -> None:
        """Acquire the lease for ``root``, or raise a lease refusal.

        ``confirm_takeover`` is the user's explicit "yes, take it" and is the
        *only* way a foreign lease is ever taken. It is not a force flag: a
        holder that proves itself alive during the observation window still
        wins, because the confirmation answers "is this machine gone?" and the
        observation is what actually checks.

        Serialized per library, deliberately **not** under the state lock: an
        acquisition sleeps — a second for the write-verify, two minutes for a
        takeover observation — and holding the state lock across that would
        block ``holds()``, and therefore every request to every *other* library,
        for the duration.
        """
        with self._acquire_lock_for(library_id):
            # Another thread may have acquired it while we waited our turn.
            if self.holds(library_id, root):
                return
            try:
                self._acquire_locked(library_id=library_id, root=root, confirm=confirm_takeover)
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EPERM, errno.EROFS):
                    raise LibraryOwnershipUncertainError(
                        "Library storage is unavailable; check the mount and retry"
                    ) from exc
                raise LibraryMetadataUnwritableError(
                    "Cairndex needs a writable .cairndex package "
                    "for metadata, locks, progress and cache. "
                    "Source media may remain protected; "
                    "check the library mount and server permissions"
                ) from exc

    def _acquire_lock_for(self, library_id: str) -> threading.Lock:
        with self._lock:
            return self._acquire_locks.setdefault(library_id, threading.Lock())

    def _acquire_locked(self, *, library_id: str, root: Path, confirm: bool) -> None:
        self._package_check(root)
        snapshot = read_lease(root)
        if snapshot.io_error:
            raise LibraryOwnershipUncertainError(
                "Cannot read library ownership; restore the storage connection before opening"
            )
        state = classify(
            snapshot,
            our_uuid=self.server_uuid,
            now=self._clock(),
            ttl=self.settings.ttl_delta,
        )

        if state is LeaseState.FRESH:
            assert snapshot.record is not None
            raise LibraryLeaseHeldError(
                self._held_message(snapshot.record.machine_name),
                details=snapshot.record.holder.as_details(),
            )

        if state in (LeaseState.STALE, LeaseState.UNREADABLE):
            if not confirm:
                raise LeaseTakeoverRequiredError(
                    self._takeover_message(state, snapshot.record),
                    details=(
                        snapshot.record.holder.as_details()
                        if snapshot.record is not None
                        else {"server_uuid": None, "machine_name": None}
                    ),
                )
            self._observe_before_takeover(root)

        self._write_and_verify(library_id=library_id, root=root, existing=not snapshot.absent)
        self._warn_on_conflict_artifacts(root)

    def _observe_before_takeover(self, root: Path) -> None:
        """Watch the lease for longer than a heartbeat before taking it.

        A holder that is alive — including one writing to this very same disk
        from another machine — rewrites the lease with a new nonce inside the
        window. Any change at all (a new nonce, a lease appearing where there
        was none, a corrupt file becoming valid) means someone is there, so we
        stand down and report it as held rather than stale.
        """
        before = read_lease(root)
        self._sleep(self.settings.observation_window)
        after = read_lease(root)

        before_nonce = before.record.nonce if before.record else None
        after_nonce = after.record.nonce if after.record else None
        unchanged = (
            before_nonce == after_nonce
            and before.corrupt == after.corrupt
            and before.io_error == after.io_error
        )
        if unchanged:
            return

        if after.record is not None and after.record.server_uuid != self.server_uuid:
            raise LibraryLeaseHeldError(
                self._held_message(after.record.machine_name),
                details=after.record.holder.as_details(),
            )
        raise LibraryLeaseHeldError(
            "another server wrote this library's lease while it was being observed"
        )

    def _write_and_verify(self, *, library_id: str, root: Path, existing: bool) -> None:
        """Claim the lease, then prove the claim survived (ADR-0018 §3).

        There is no compare-and-swap on a synced folder or an SMB share, so the
        claim is checked after the fact: write a unique nonce, pause, read back.
        If someone else wrote in between, their record is what we read, and we
        back off rather than assume we won.
        """
        self._package_check(root)  # The package may have changed during takeover observation
        now = self._clock()
        record = LeaseRecord(
            server_uuid=self.server_uuid,
            machine_name=self.machine_name,
            advertised_url=self.advertised_url,
            acquired_at=now,
            heartbeat_at=now,
            nonce=new_nonce(),
        )

        if not existing and create_lease_exclusive(root, record):
            # Uncontended: O_EXCL means no other server can also have created
            # it, so there is nothing to verify.
            self._remember(library_id, root, record)
            return

        if not existing:
            # An exclusive-create loser must classify the winner before writing
            self._acquire_locked(library_id=library_id, root=root, confirm=False)
            return
        write_lease(root, record)
        self._sleep(self.settings.verify_delay)
        verify = read_lease(root)
        if verify.record is not None and verify.record.nonce == record.nonce:
            self._remember(library_id, root, record)
            return

        if verify.record is not None and verify.record.server_uuid != self.server_uuid:
            raise LibraryLeaseHeldError(
                self._held_message(verify.record.machine_name),
                details=verify.record.holder.as_details(),
            )
        raise LibraryLeaseHeldError(
            "could not confirm this server's claim on the library; another server may be starting"
        )

    def _remember(self, library_id: str, root: Path, record: LeaseRecord) -> None:
        with self._lock:
            self._lost.discard(library_id)
            self._held[library_id] = _Held(
                root, record, time.monotonic(), self._clock().timestamp()
            )

    # --- confirmed takeover (asynchronous) --------------------------------

    def start_takeover(self, *, library_id: str, root: Path) -> None:
        """Begin a user-confirmed takeover in the background.

        Returns as soon as the observation is under way. The caller polls
        ``describe`` until ``takeover.running`` clears; at that point we either
        hold the lease or the recorded error says which holder stopped us.
        """
        with self._lock:
            existing = self._takeovers.get(library_id)
            if existing is not None and existing.running:
                return
            self._takeovers[library_id] = TakeoverProgress(
                running=True,
                started_at=self._clock(),
                observation_seconds=self.settings.observation_window,
            )

        thread = threading.Thread(
            target=self._run_takeover,
            args=(library_id, root),
            name=f"cairndex-takeover-{library_id}",
            daemon=True,
        )
        thread.start()

    def _run_takeover(self, library_id: str, root: Path) -> None:
        try:
            from cairndex.ownership.lifecycle import lifecycle

            with lifecycle.work(library_id):
                self.acquire(library_id=library_id, root=root, confirm_takeover=True)
        except LibraryLeaseError as exc:
            self._finish_takeover(
                library_id,
                TakeoverProgress(
                    running=False,
                    error_code=exc.code,
                    error_message=exc.message,
                    holder=exc.details,
                ),
            )
        except Exception as exc:  # noqa: BLE001 — surface, never strand "running"
            logger.exception("takeover failed for library %s", library_id)
            self._finish_takeover(
                library_id,
                TakeoverProgress(
                    running=False, error_code="takeover_failed", error_message=str(exc)
                ),
            )
        else:
            self._finish_takeover(library_id, TakeoverProgress(running=False))

    def _finish_takeover(self, library_id: str, progress: TakeoverProgress) -> None:
        with self._lock:
            previous = self._takeovers.get(library_id)
            self._takeovers[library_id] = replace(
                progress,
                started_at=previous.started_at if previous else None,
                observation_seconds=previous.observation_seconds if previous else None,
            )

    def takeover_progress(self, library_id: str) -> TakeoverProgress | None:
        with self._lock:
            return self._takeovers.get(library_id)

    def describe(self, *, library_id: str, root: Path) -> tuple[LeaseState, LeaseRecord | None]:
        """Classify this library's lease without acquiring anything.

        Backs the ownership status endpoint, which has to stay callable exactly
        when the mount gate is refusing — so it never takes, writes, or waits.
        """
        if self.holds(library_id, root):
            try:
                self.validate(library_id)
                return LeaseState.OWN, None
            except LibraryOwnershipUncertainError:
                return LeaseState.UNREADABLE, None
            except LibraryOwnershipLostError:
                pass
        snapshot = read_lease(root)
        state = classify(
            snapshot,
            our_uuid=self.server_uuid,
            now=self._clock(),
            ttl=self.settings.ttl_delta,
        )
        return state, snapshot.record

    # --- holding ---------------------------------------------------------

    def heartbeat_once(self) -> list[str]:
        """Refresh every held lease. Returns the ids we discovered we had lost.

        Re-reading *before* rewriting is what makes this a watchdog and not just
        a keepalive: a foreign ``server_uuid``, or our own uuid under a nonce we
        did not write, both mean ownership moved (a confirmed takeover, or a
        sync engine resolving a conflict in the other side's favour).

        Heartbeats continue while a library is idle. A ~200-byte write a minute
        is nothing, and going quiet would make a healthy NAS server's libraries
        look abandoned — and therefore stealable — from every other machine.
        """
        lost: list[str] = []
        for library_id in self.held_library_ids():
            with self._acquire_lock_for(library_id):
                with self._lock:
                    held = self._held.get(library_id)
                if held is None:
                    continue
                try:
                    if not self._heartbeat_library(library_id, held):
                        lost.append(library_id)
                        self._surrender(library_id)
                except OSError:
                    held.uncertain = True
                    logger.warning("lease heartbeat unavailable for library %s", library_id)
        return lost

    def mark_uncertain(self, library_id: str) -> None:
        """Require a fresh lease read after a database connection or I/O failure"""
        with self._lock:
            held = self._held.get(library_id)
            if held is not None:
                held.uncertain = True

    def validate(self, library_id: str, *, force: bool = False) -> None:
        """Fence resumed work using elapsed and wall clocks before trusting memory

        Package capability is checked before trusting cached ownership. Wall time
        catches suspend gaps and backward adjustments force a lease read too.
        Uncertainty remains closed until a
        successful read proves the exact nonce, never by acquiring another lease
        """
        with self._acquire_lock_for(library_id):
            with self._lock:
                held = self._held.get(library_id)
            if held is None:
                raise LibraryOwnershipLostError("This server no longer owns the library")
            self._package_check(held.root)
            elapsed = time.monotonic() - held.checked_at
            wall = self._clock().timestamp() - held.checked_wall
            if (
                not force
                and not held.uncertain
                and 0 <= wall < self.settings.heartbeat_interval
                and elapsed < self.settings.heartbeat_interval
            ):
                return
            snapshot = read_lease(held.root)
            if snapshot.io_error:
                held.uncertain = True
                raise LibraryOwnershipUncertainError(
                    "Cannot verify library ownership; check the storage connection and retry"
                )
            if snapshot.record != held.record or snapshot.corrupt or snapshot.record is None:
                self._surrender(library_id)
                raise LibraryOwnershipLostError(
                    "Library ownership changed; this server stopped writing"
                )
            held.checked_at = time.monotonic()
            held.checked_wall = self._clock().timestamp()
            held.uncertain = False

    def _heartbeat_library(self, library_id: str, held: _Held) -> bool:
        """Refresh one lease. ``False`` means ownership was lost."""
        try:
            self._package_check(held.root)
        except LibraryLeaseError:
            return False  # Never refresh a lease in an incompatible package
        snapshot = read_lease(held.root)
        record = snapshot.record

        if snapshot.io_error:
            held.uncertain = True
            return True
        if snapshot.corrupt or record is None or record.released_at is not None:
            return False
        if record.server_uuid != self.server_uuid or record.nonce != held.record.nonce:
            logger.warning(
                "lease for library %s now held by %s; surrendering",
                library_id,
                record.machine_name or record.server_uuid,
            )
            return False

        self._rewrite(library_id, held)
        self._warn_on_conflict_artifacts(held.root)
        return True

    def _rewrite(self, library_id: str, held: _Held) -> None:
        refreshed = LeaseRecord(
            server_uuid=self.server_uuid,
            machine_name=self.machine_name,
            advertised_url=self.advertised_url,
            acquired_at=held.record.acquired_at,
            heartbeat_at=self._clock(),
            nonce=new_nonce(),
        )
        write_lease(held.root, refreshed)
        with self._lock:
            if library_id in self._held:
                self._held[library_id] = _Held(
                    held.root, refreshed, time.monotonic(), self._clock().timestamp()
                )

    def _surrender(self, library_id: str) -> None:
        """Drop a lost lease and let the app unmount the library.

        Deliberately does not write to the lease file: the new holder's record
        is the truth now, and a parting write would be us fighting for it.
        """
        with self._lock:
            self._held.pop(library_id, None)
            self._lost.add(library_id)
        if self._on_ownership_lost is not None:
            try:
                self._on_ownership_lost(library_id)
            except Exception:  # noqa: BLE001 — an unmount failure must not stop the loop
                logger.exception("ownership-lost handler failed for library %s", library_id)

    # --- release ---------------------------------------------------------

    def release(self, library_id: str) -> None:
        """Cleanly release a lease so the next server acquires it silently.

        This is what keeps the takeover prompt rare: quit laptop 1, open laptop
        2, no questions. Only ever releases a lease still in our name — if it
        moved on while we were shutting down, we leave the new holder's record
        alone.
        """
        with self._acquire_lock_for(library_id):
            with self._lock:
                held = self._held.pop(library_id, None)
            if held is None:
                return
            try:
                self._package_check(held.root)
            except LibraryLeaseError:
                return  # Retain the on-disk evidence without a release rewrite
            snapshot = read_lease(held.root)
            # Never overwrite an unknown, missing or changed ownership record
            if snapshot.record != held.record:
                return
            try:
                write_lease(
                    held.root, replace(held.record, nonce=new_nonce(), released_at=self._clock())
                )
            except OSError:
                logger.warning("could not release lease for library %s", library_id)

    def release_all(self) -> None:
        for library_id in self.held_library_ids():
            self.release(library_id)

    def forget(self, library_id: str) -> None:
        """Drop local lease state without writing (test/teardown use)."""
        with self._lock:
            self._held.pop(library_id, None)

    # --- background loop -------------------------------------------------

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="cairndex-lease-heartbeat", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None

    def _loop(self) -> None:
        while not self._stop.wait(self.settings.heartbeat_interval):
            try:
                self.heartbeat_once()
            except Exception:  # noqa: BLE001 — never let the heartbeat thread die
                logger.exception("lease heartbeat pass failed")

    # --- messages --------------------------------------------------------

    def _held_message(self, machine_name: str) -> str:
        who = machine_name or "another server"
        return f"this library is currently served by {who}"

    def _takeover_message(self, state: LeaseState, record: LeaseRecord | None) -> str:
        if state is LeaseState.UNREADABLE or record is None:
            return (
                "this library's ownership record could not be read; "
                "confirm takeover to serve it here"
            )
        who = record.machine_name or "another server"
        return (
            f"this library was last served by {who} at "
            f"{record.heartbeat_at.isoformat()}; confirm takeover to serve it here"
        )

    def _warn_on_conflict_artifacts(self, root: Path) -> None:
        """Surface sync-conflict copies of the lease; never resolve them.

        A conflict copy means both sides held the lease while partitioned — the
        accepted limitation in ADR-0018 §7. Deleting it would destroy the only
        evidence the user has that their library may have diverged.
        """
        artifacts = find_conflict_artifacts(root)
        if artifacts:
            logger.error(
                "sync-conflict artifacts next to the ownership lease (%s) — "
                "two servers may have written this library while partitioned",
                ", ".join(artifacts),
            )


# --- process-global instance ---------------------------------------------

_manager: LeaseManager | None = None
_manager_lock = threading.Lock()


def get_lease_manager() -> LeaseManager:
    """The process's lease manager, created on first use.

    Built lazily rather than at import so the server identity is read from the
    registry only once something actually needs a lease — which keeps importing
    the package free of database side effects.
    """
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = _build_manager()
        return _manager


# Background lease writes and resumed work must respect current package capabilities
def _check_legacy_package(root: Path) -> None:
    from cairndex.registry.library_package import require_legacy

    try:
        require_legacy(root)
    except (DomainError, OSError) as error:
        raise LibraryOwnershipUncertainError(
            "Library package changed or is unavailable; metadata remains untouched"
        ) from error


def _build_manager() -> LeaseManager:
    from cairndex.registry.engine import registry_session_scope
    from cairndex.registry.server_identity import get_or_create_identity

    with registry_session_scope() as session:
        identity = get_or_create_identity(session)
        server_uuid = identity.server_uuid
        machine_name = identity.machine_name

    return LeaseManager(
        server_uuid=server_uuid,
        machine_name=machine_name,
        advertised_url=get_settings().advertised_url,
        settings=LeaseSettings.from_settings(),
        on_ownership_lost=_default_ownership_lost,
        package_check=_check_legacy_package,
    )


def _default_ownership_lost(library_id: str) -> None:
    """Fence new and checked-out work; drain before non-rewriting disposal"""
    from cairndex.ownership.lifecycle import lifecycle

    lifecycle.lost(library_id)


def set_lease_manager(manager: LeaseManager | None) -> None:
    """Install (or clear) the process manager. Tests only."""
    global _manager
    with _manager_lock:
        _manager = manager


def reset_lease_manager() -> None:
    """Drop the process manager, stopping its heartbeat thread. Tests only."""
    global _manager
    with _manager_lock:
        existing, _manager = _manager, None
    if existing is not None:
        existing.stop()
    from cairndex.ownership.lifecycle import lifecycle

    lifecycle.reset()
