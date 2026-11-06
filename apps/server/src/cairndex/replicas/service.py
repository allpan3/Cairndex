"""Serve private replicas without ever opening a database inside the provider folder"""

import threading
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import suppress
from pathlib import Path
from typing import Literal

from cairndex.core.config import get_settings
from cairndex.core.errors import DomainError, LibraryReleasedError
from cairndex.file_ops import smb_transport
from cairndex.ownership.lifecycle import lifecycle
from cairndex.registry.library_package import read_manifest
from cairndex.registry.models import RegisteredLibrary
from cairndex.replicas.binding import BindingLock, bind, location
from cairndex.replicas.catalog.jobs import run_one
from cairndex.replicas.catalog.protocol import CatalogDescriptor
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import PackageFormatError, ReplicaError
from cairndex.replicas.source_transport import SourceTransport
from cairndex.replicas.store import Store
from cairndex.replicas.transport import Transport

_handles: dict[str, tuple[Store | CatalogStore, Transport, threading.Lock, str, BindingLock]] = {}
_lock = threading.RLock()
_source_transports: dict[str, SourceTransport] = {}
# Libraries whose last exchange needs the owner to allow or save the share's login.
# Runtime state: after a restart the next exchange finds the same problem again.
_storage_access: dict[str, Literal["authorization", "login"]] = {}


# Cache only handles, never authoritative metadata or an in-memory causal history
# Private storage must remain outside the library and its provider transport
# A changed descriptor cannot silently rebind an existing private store
def get_store(library: RegisteredLibrary) -> Store | CatalogStore:
    if library.serving_released or lifecycle.blocked(library.id):
        raise LibraryReleasedError("Library released; choose Reopen")
    root = Path(library.root_path)
    smb_transport._mount(root)
    manifest = read_manifest(root)
    if manifest.replica is None:
        raise PackageFormatError("This library uses the existing central metadata workflow")
    if manifest.library_uuid != library.library_uuid:
        raise ReplicaError("Registered library identity changed; recovery review required")
    identity = manifest.replica.model_dump_json()
    with _lock:
        prior = _handles.get(library.id)
        if prior:
            if prior[3] != identity:
                raise ReplicaError("Library descriptor changed; recovery review required")
            return prior[0]
        base = get_settings().data_dir.resolve()
        if base.is_relative_to(root.resolve()):
            raise ReplicaError("Replica data directory must be private and outside the library")
        guard = BindingLock(base, manifest.replica)
        registered = False
        try:
            smb_transport.register_root(root)
            registered = True
            target, revision = location(base, manifest.replica)
            if revision != "unbound" and not (target / "replica.db").is_file():
                raise ReplicaError("Private database is missing; use explicit replica recovery")
            store: Store | CatalogStore = (
                CatalogStore(target, manifest.replica)
                if isinstance(manifest.replica, CatalogDescriptor)
                else Store(target, manifest.replica)
            )
            if revision == "unbound":
                bind(base, manifest.replica, "original", "initial")
            _handles[library.id] = store, Transport(root, store), threading.Lock(), identity, guard
            if isinstance(store, CatalogStore):
                _source_transports[library.id] = SourceTransport(root, store)
        except BaseException:
            if registered:
                smb_transport.close_root(root)
            guard.close()
            raise
        return store


# HTTP and background exchanges share a nonblocking per-replica lock and lifecycle admission
def exchange(library_id: str, *, source_work: Callable[[], bool] | None = None) -> None:
    with _lock:
        handle = _handles.get(library_id)
    if handle is None or not handle[2].acquire(blocking=False):
        return
    try:
        with lifecycle.work(library_id):
            manifest = read_manifest(handle[1].root)
            if manifest.replica is None or manifest.replica.model_dump_json() != handle[3]:
                raise ReplicaError("Library descriptor changed; recovery review required")
            if isinstance(handle[0], CatalogStore):
                run_one(handle[0], handle[1].root)
                advance_discovery(handle[0], handle[1].root)
                advance_grouping(handle[0])
                from cairndex.file_ops.gate import ensure_portable_write_mode
                from cairndex.media.hls import close_library_sessions
                from cairndex.registry.engine import registry_session_scope
                from cairndex.replicas.source_execute import run_one as run_source

                def authorize_source() -> None:
                    if source_work is not None and not source_work():
                        raise ReplicaError("Source worker stopped; exact retry is required")
                    info = handle[1].root.stat(follow_symlinks=False)
                    if (info.st_dev, info.st_ino) != handle[1]._root_identity:
                        raise ReplicaError("Library root changed; source operations are stopped")
                    with registry_session_scope() as registry:
                        ensure_portable_write_mode(registry, library_id)

                if source_work is not None:
                    run_source(
                        handle[0],
                        handle[1].root,
                        authorize_source,
                        lambda: close_library_sessions(library_id),
                    )
            handle[1].tick()
            source_transport = _source_transports.get(library_id)
            if source_transport:
                source_transport.tick()
            with handle[0].connection() as db:
                db.execute("DELETE FROM config WHERE key='exchange_error'")
            _storage_access.pop(library_id, None)
    except (OSError, DomainError) as error:
        problem = smb_transport.access_problem(error)
        if problem is None:
            _storage_access.pop(library_id, None)
        else:
            _storage_access[library_id] = problem
        with handle[0].connection() as db:
            db.execute(
                "INSERT OR REPLACE INTO config VALUES ('exchange_error', ?)",
                (
                    "Changes are saved on this device but not yet written to the library "
                    "folder. Cairndex keeps trying.",
                ),
            )
        raise ReplicaError(
            "Metadata exchange is waiting for storage; saved work remains private"
        ) from error
    finally:
        handle[2].release()


def advance_discovery(store: CatalogStore, root: Path) -> None:
    """Amortize exchange overhead without extending an individual Update transaction."""
    from cairndex.replicas.discovery import tick
    from cairndex.replicas.discovery_state import run

    deadline = time.monotonic() + DISCOVERY_SECONDS
    for _ in range(32):
        tick(store, root)
        if time.monotonic() >= deadline or run(store).get("state") != "running":
            return


# A review edit takes several steps, each its own commit. Running them in one bounded
# pass skips the transport tick and the pause between passes.
def advance_grouping(store: CatalogStore) -> None:
    from cairndex.replicas.grouping.worker import step

    deadline = time.monotonic() + GROUPING_SECONDS
    while step(store) and time.monotonic() < deadline:
        pass


# Queued work that another bounded pass would advance. Inbox dependencies are not
# counted: they can wait indefinitely for objects that have not arrived yet.
_PENDING_WORK = (
    "SELECT 1 FROM discovery_runs WHERE state='running' LIMIT 1",
    "SELECT 1 FROM catalog_jobs WHERE state='queued' "
    "AND json_extract(intent,'$.action')!='media_maintenance' LIMIT 1",
    "SELECT 1 FROM discovery_reviews WHERE state IN ('queued','apply_queued') LIMIT 1",
    "SELECT 1 FROM discovery_verifications WHERE state IN ('queued','running') LIMIT 1",
    "SELECT 1 FROM grouping_commands WHERE state IN ('queued','running') LIMIT 1",
    "SELECT 1 FROM grouping_workspaces WHERE state='building' LIMIT 1",
    "SELECT 1 FROM grouping_workspaces w JOIN discovery_reviews r ON r.id=w.accepting "
    "WHERE w.accepting IS NOT NULL AND r.state='applied' LIMIT 1",
    "SELECT 1 FROM events WHERE local=1 AND published=0 LIMIT 1",
)


def pending(library_id: str) -> bool:
    """Report whether an open catalog has queued work for the next worker pass.

    A blocked or not-yet-ready store reports none, because the discovery and job
    steps do nothing for it until recovery or reconstruction completes.
    """
    with _lock:
        handle = _handles.get(library_id)
    if handle is None or not isinstance(handle[0], CatalogStore):
        return False
    store = handle[0]
    with store.connection(readonly=True) as db:
        if db.execute("SELECT 1 FROM config WHERE key='blocked'").fetchone():
            return False
        if not db.execute(
            "SELECT 1 FROM events WHERE id=?", (store.descriptor.genesis,)
        ).fetchone():
            return False
        return any(db.execute(query).fetchone() for query in _PENDING_WORK)


def storage_access(library_id: str) -> Literal["authorization", "login"] | None:
    """What the owner must do before exchange can reach the library's network share."""
    problem = _storage_access.get(library_id)
    if problem is not None:
        return problem
    with _lock:
        handle = _handles.get(library_id)
    if handle is None or not isinstance(handle[0], CatalogStore):
        return None
    # Source workers retain failures instead of raising through exchange. Keep
    # their access request visible even when ordinary metadata exchange succeeds.
    with handle[0].connection(readonly=True) as db:
        row = db.execute(
            "SELECT json_extract(result,'$.storage_failure.access') FROM source_operations "
            "WHERE state='interrupted' AND "
            "json_extract(result,'$.storage_failure.access') IN ('authorization','login') "
            "ORDER BY sequence DESC LIMIT 1"
        ).fetchone()
    if row and row[0] == "authorization":
        return "authorization"
    if row and row[0] == "login":
        return "login"
    return None


def authorize_storage(library_id: str) -> None:
    """Ask macOS, on this computer's screen, to let the server use the share's saved login."""
    with _lock:
        handle = _handles.get(library_id)
    if handle is None:
        raise ReplicaError("Open the library on this server first")
    _authorize_storage(library_id, handle[1].root)


def prepare_write_access(library_id: str, root: Path) -> None:
    """Enabling Write Mode also admits the exact SMB login, without touching sources."""
    try:
        mounted = smb_transport.mount_for(root) is not None
    except OSError as error:
        raise ReplicaError(smb_transport.access_message(error)) from None
    if mounted:
        _authorize_storage(library_id, root)


def _authorize_storage(library_id: str, root: Path) -> None:
    try:
        smb_transport.authorize(root)
    except OSError as error:
        raise ReplicaError(smb_transport.access_message(error)) from None
    _storage_access.pop(library_id, None)
    with _lock:
        handle = _handles.get(library_id)
    if handle is not None and isinstance(handle[0], CatalogStore):
        with handle[0].connection() as db:
            # Authorization clears only the prompt, never the stopped intent or
            # its recovery checkpoints. The owner still explicitly retries it.
            db.execute(
                "UPDATE source_operations SET result="
                "json_remove(result,'$.storage_failure.access') "
                "WHERE state='interrupted' AND "
                "json_extract(result,'$.storage_failure.access') IN ('authorization','login')"
            )


def serving(library_id: str, store: Store | CatalogStore) -> bool:
    """Report whether this exact store still serves the library on this server."""
    with _lock:
        handle = _handles.get(library_id)
    return handle is not None and handle[0] is store


# Close iterators only after admitted work has drained; private history stays on disk
def close(library_id: str) -> None:
    with _lock:
        handle = _handles.pop(library_id, None)
        source_transport = _source_transports.pop(library_id, None)
        _storage_access.pop(library_id, None)
    if handle:
        if source_transport:
            source_transport.close()
        if isinstance(handle[0], CatalogStore):
            from cairndex.replicas.discovery import close as close_discovery

            close_discovery(handle[0])
        handle[1].close()
        handle[0].retire()
        handle[4].close()
        smb_transport.close_root(handle[1].root)


# Seconds between passes while work is queued, and while every open library is idle.
# Each pass keeps its bounded per-library steps, so Release still drains promptly;
# the short pause leaves the SQLite writer free for HTTP saves between passes.
BUSY_WAIT = 0.025
IDLE_WAIT = 1.0
# Longest run of review edit steps in one pass; a save waits at most this much longer
GROUPING_SECONDS = 0.25
DISCOVERY_SECONDS = 0.25

# Set when a request queues work, so the next pass starts now rather than after
# IDLE_WAIT. Clearing after the wait loses no request: the work is committed before
# wake() and every pass reads the queues afresh.
_wake = threading.Event()


def wake() -> None:
    """Start the next worker pass without waiting out the idle interval."""
    _wake.set()


# Poll only replicas opened by this server, with bounded work per replica
class ReplicaWorker:
    def __init__(self) -> None:
        self._stop = threading.Event()
        self._wake = _wake
        self._thread = threading.Thread(target=self.run, name="replica-exchange", daemon=True)
        self._sources = ThreadPoolExecutor(max_workers=2, thread_name_prefix="source-operation")
        self._pending: dict[str, Future[None]] = {}

    def start(self) -> None:
        """Begin local provider-folder exchange without making network requests"""
        self._thread.start()

    def run(self) -> None:
        "Storage failures remain visible on explicit status/exchange instead of killing the loop"
        busy = False
        while True:
            self._wake.wait(BUSY_WAIT if busy else IDLE_WAIT)
            self._wake.clear()
            if self._stop.is_set():
                return
            busy = False
            for identity, future in list(self._pending.items()):
                if future.done():
                    with suppress(DomainError, OSError):
                        future.result()
                    del self._pending[identity]
            with _lock:
                libraries = list(_handles)
            for library_id in libraries:
                if self._stop.is_set():
                    return
                try:
                    exchange(library_id)
                    busy = pending(library_id) or busy
                    with _lock:
                        handle = _handles.get(library_id)
                    if (
                        handle
                        and isinstance(handle[0], CatalogStore)
                        and library_id not in self._pending
                        and len(self._pending) < 2
                    ):
                        with handle[0].connection(readonly=True) as db:
                            waiting = db.execute(
                                "SELECT 1 FROM source_operations "
                                "WHERE state IN ('queued','accepted') UNION ALL "
                                "SELECT 1 FROM catalog_jobs WHERE state='queued' "
                                "AND json_extract(intent,'$.action')='media_maintenance' LIMIT 1"
                            ).fetchone()
                        if waiting:
                            self._pending[library_id] = self._sources.submit(
                                self.run_sources, library_id
                            )
                except (DomainError, OSError):
                    continue

    def run_sources(self, library_id: str) -> None:
        """Keep local media work independent of the size of shared history.

        Maintenance uses the same lifecycle admission and guarded media adapter
        as playback. It needs no transport lock; source writes still use exchange.
        """
        from cairndex.replicas.maintenance import advance

        while not self._stop.is_set():
            with _lock:
                handle = _handles.get(library_id)
            if handle is None or not isinstance(handle[0], CatalogStore):
                return
            store, transport = handle[0], handle[1]
            with lifecycle.work(library_id):
                if not serving(library_id, store):
                    return
                with store.connection(readonly=True) as db:
                    if db.execute("SELECT 1 FROM config WHERE key='blocked'").fetchone():
                        return
                    if not db.execute("SELECT 1 FROM config WHERE key='catalog_ready'").fetchone():
                        return
                    source = db.execute(
                        "SELECT 1 FROM source_operations "
                        "WHERE state IN ('queued','accepted') LIMIT 1"
                    ).fetchone()
                    media = db.execute(
                        "SELECT 1 FROM catalog_jobs WHERE state='queued' "
                        "AND json_extract(intent,'$.action')='media_maintenance' LIMIT 1"
                    ).fetchone()
                if media:
                    manifest = read_manifest(transport.root)
                    if manifest.replica is None or manifest.replica.model_dump_json() != handle[3]:
                        raise ReplicaError("Library descriptor changed; recovery review required")
                    advance(
                        store,
                        transport.root,
                        library_id,
                        lambda: self._stop.is_set() or lifecycle.blocked(library_id),
                    )
            if source:
                exchange(library_id, source_work=lambda: not self._stop.is_set())
            if not source and not media:
                return
            # Yield between bounded batches and wake immediately on shutdown.
            if self._stop.wait(BUSY_WAIT):
                return

    def stop(self) -> None:
        """Stop admission to the worker before releasing its handles"""
        self._stop.set()
        self._wake.set()
        self._thread.join(timeout=15)
        self._sources.shutdown(wait=False, cancel_futures=True)
        if self._thread.is_alive():
            return  # Do not close a descriptor still used by an in-flight storage operation
        with _lock:
            libraries = list(_handles)
        for library_id in libraries:
            future = self._pending.get(library_id)
            if future is None or future.done():
                close(library_id)
