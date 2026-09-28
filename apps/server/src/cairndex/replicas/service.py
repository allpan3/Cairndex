"""Serve private replicas without ever opening a database inside the provider folder"""

import threading
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import suppress
from pathlib import Path

from cairndex.core.config import get_settings
from cairndex.core.errors import DomainError, LibraryReleasedError
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


# Cache only handles, never authoritative metadata or an in-memory causal history
# Private storage must remain outside the library and its provider transport
# A changed descriptor cannot silently rebind an existing private store
def get_store(library: RegisteredLibrary) -> Store | CatalogStore:
    if library.serving_released or lifecycle.blocked(library.id):
        raise LibraryReleasedError("Library released; choose Reopen")
    root = Path(library.root_path)
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
        try:
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
                run_one(handle[0])
                from cairndex.replicas.discovery import tick

                tick(handle[0], handle[1].root)
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
    except (OSError, DomainError) as error:
        with handle[0].connection() as db:
            db.execute(
                "INSERT OR REPLACE INTO config VALUES ('exchange_error', ?)",
                ("Waiting for metadata storage or recovery; saved work remains private",),
            )
        raise ReplicaError(
            "Metadata exchange is waiting for storage; saved work remains private"
        ) from error
    finally:
        handle[2].release()


# Close iterators only after admitted work has drained; private history stays on disk
def close(library_id: str) -> None:
    with _lock:
        handle = _handles.pop(library_id, None)
        source_transport = _source_transports.pop(library_id, None)
    if handle:
        if source_transport:
            source_transport.close()
        if isinstance(handle[0], CatalogStore):
            from cairndex.replicas.discovery import close as close_discovery

            close_discovery(handle[0])
        handle[1].close()
        handle[0].retire()
        handle[4].close()


# Poll only replicas opened by this server, with bounded work per replica
class ReplicaWorker:
    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self.run, name="replica-exchange", daemon=True)
        self._sources = ThreadPoolExecutor(max_workers=2, thread_name_prefix="source-operation")
        self._pending: dict[str, Future[None]] = {}

    def start(self) -> None:
        """Begin local provider-folder exchange without making network requests"""
        self._thread.start()

    def run(self) -> None:
        "Storage failures remain visible on explicit status/exchange instead of killing the loop"
        while not self._stop.wait(1):
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
                                "WHERE state IN ('queued','accepted') LIMIT 1"
                            ).fetchone()
                        if waiting:
                            self._pending[library_id] = self._sources.submit(
                                exchange, library_id, source_work=lambda: not self._stop.is_set()
                            )
                except (DomainError, OSError):
                    continue

    def stop(self) -> None:
        """Stop admission to the worker before releasing its handles"""
        self._stop.set()
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
