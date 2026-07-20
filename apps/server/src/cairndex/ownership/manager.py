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

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from cairndex.core.config import get_settings
from cairndex.core.errors import (
    LeaseTakeoverRequiredError,
    LibraryLeaseError,
    LibraryLeaseHeldError,
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

    @property
    def ttl_delta(self) -> timedelta:
        return timedelta(seconds=self.ttl)

    @property
    def observation_window(self) -> float:
        """How long to watch a lease before taking it over (ADR-0018 §3).

        One heartbeat period plus one more interval: long enough that a live
        holder writing to the same disk must touch the file within the window,
        which catches "two servers pointed at one NAS export" without comparing
        clocks across machines at all.
        """
        return self.heartbeat_interval * 2

    @classmethod
    def from_settings(cls) -> "LeaseSettings":
        settings = get_settings()
        return cls(
            heartbeat_interval=settings.lease_heartbeat_interval,
            ttl=settings.lease_ttl,
            verify_delay=settings.lease_verify_delay,
        )


@dataclass
class _Held:
    """A lease this server currently holds."""

    root: Path
    record: LeaseRecord


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
    ) -> None:
        self.server_uuid = server_uuid
        self.machine_name = machine_name
        self.advertised_url = advertised_url
        self.settings = settings
        self._clock = clock
        self._sleep = sleep
        self._on_ownership_lost = on_ownership_lost
        self._held: dict[str, _Held] = {}
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

        The common case — a library we already hold — costs one dict lookup and
        touches no filesystem, which is what keeps this usable on the request
        path for a NAS-mounted library (AGENTS.md: no hot-path I/O).
        """
        if self.holds(library_id, root):
            return
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
            self._acquire_locked(library_id=library_id, root=root, confirm=confirm_takeover)

    def _acquire_lock_for(self, library_id: str) -> threading.Lock:
        with self._lock:
            return self._acquire_locks.setdefault(library_id, threading.Lock())

    def _acquire_locked(self, *, library_id: str, root: Path, confirm: bool) -> None:
        snapshot = read_lease(root)
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
        if before_nonce == after_nonce and before.corrupt == after.corrupt:
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
            self._held[library_id] = _Held(root=root, record=record)

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
            self._takeovers[library_id] = TakeoverProgress(running=True)

        thread = threading.Thread(
            target=self._run_takeover,
            args=(library_id, root),
            name=f"cairndex-takeover-{library_id}",
            daemon=True,
        )
        thread.start()

    def _run_takeover(self, library_id: str, root: Path) -> None:
        try:
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
            self._takeovers[library_id] = progress

    def takeover_progress(self, library_id: str) -> TakeoverProgress | None:
        with self._lock:
            return self._takeovers.get(library_id)

    def describe(self, *, library_id: str, root: Path) -> tuple[LeaseState, LeaseRecord | None]:
        """Classify this library's lease without acquiring anything.

        Backs the ownership status endpoint, which has to stay callable exactly
        when the mount gate is refusing — so it never takes, writes, or waits.
        """
        if self.holds(library_id, root):
            return LeaseState.OWN, None
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
        with self._lock:
            current = list(self._held.items())

        lost: list[str] = []
        for library_id, held in current:
            try:
                if not self._heartbeat_library(library_id, held):
                    lost.append(library_id)
            except OSError:
                # An offline mount is not a lost lease — we simply could not
                # write. Staying held is right: nobody else can reach it either,
                # and dropping the library on a transient NFS blip would be far
                # more disruptive than a late heartbeat.
                logger.warning("lease heartbeat could not write for library %s", library_id)
        for library_id in lost:
            self._surrender(library_id)
        return lost

    def _heartbeat_library(self, library_id: str, held: _Held) -> bool:
        """Refresh one lease. ``False`` means ownership was lost."""
        snapshot = read_lease(held.root)
        record = snapshot.record

        if snapshot.corrupt:
            # Our own lease became unreadable. Someone is writing this file, and
            # it is not us; treat it the same as a foreign nonce.
            logger.warning("lease for library %s is unreadable; surrendering", library_id)
            return False
        if record is None:
            # The lease vanished (deleted, or a sync engine removed it). Rewrite
            # ours: we are the incumbent and no other server has claimed it.
            self._rewrite(library_id, held)
            return True
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
                self._held[library_id] = _Held(root=held.root, record=refreshed)

    def _surrender(self, library_id: str) -> None:
        """Drop a lost lease and let the app unmount the library.

        Deliberately does not write to the lease file: the new holder's record
        is the truth now, and a parting write would be us fighting for it.
        """
        with self._lock:
            self._held.pop(library_id, None)
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
        with self._lock:
            held = self._held.pop(library_id, None)
        if held is None:
            return
        snapshot = read_lease(held.root)
        if snapshot.record is not None and snapshot.record.server_uuid != self.server_uuid:
            return
        try:
            write_lease(
                held.root,
                LeaseRecord(
                    server_uuid=self.server_uuid,
                    machine_name=self.machine_name,
                    advertised_url=self.advertised_url,
                    acquired_at=held.record.acquired_at,
                    heartbeat_at=self._clock(),
                    nonce=new_nonce(),
                    released_at=self._clock(),
                ),
            )
        except OSError:
            # An unreachable mount at shutdown just means the lease ages out to
            # stale, which is recoverable with a confirmation. Not worth failing
            # a shutdown over.
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
    )


def _default_ownership_lost(library_id: str) -> None:
    """Unmount a library whose lease we lost (ADR-0018 §4).

    Stop writing immediately: close the content engine so no in-flight session
    can commit, and cancel the library's queued and running jobs so a scan
    cannot keep going long after another machine took over. Requests that
    arrive afterwards re-enter the mount gate, read the new holder's lease, and
    are refused with a redirect — no separate "we lost it" state to maintain.
    """
    from cairndex.registry import jobs as job_service
    from cairndex.registry.engine import registry_session_scope
    from cairndex.registry.library_engine import dispose_library_engine

    dispose_library_engine(library_id)
    try:
        with registry_session_scope() as session:
            job_service.request_cancel_for_library(session, library_id)
    except Exception:  # noqa: BLE001 — unmounting must succeed even if the queue is unreachable
        logger.exception("could not cancel jobs for unmounted library %s", library_id)


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
