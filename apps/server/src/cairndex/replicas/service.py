"""Serve private replicas without ever opening a database inside the provider folder"""

import threading
from pathlib import Path

from cairndex.core.config import get_settings
from cairndex.core.errors import DomainError, LibraryReleasedError
from cairndex.ownership.lifecycle import lifecycle
from cairndex.registry.library_package import read_manifest
from cairndex.registry.models import RegisteredLibrary
from cairndex.replicas.catalog.jobs import run_one
from cairndex.replicas.catalog.protocol import CatalogDescriptor
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import PackageFormatError, ReplicaError
from cairndex.replicas.store import Store
from cairndex.replicas.transport import Transport

_handles: dict[str, tuple[Store | CatalogStore, Transport, threading.Lock, str]] = {}
_lock = threading.RLock()


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
        target = base / "replicas" / manifest.library_uuid
        if target.is_symlink() or target.parent.is_symlink():
            raise ReplicaError("Private replica storage must not be symlinked")
        store: Store | CatalogStore = (
            CatalogStore(target, manifest.replica)
            if isinstance(manifest.replica, CatalogDescriptor)
            else Store(target, manifest.replica)
        )
        _handles[library.id] = store, Transport(root, store), threading.Lock(), identity
        return store


# HTTP and background exchanges share a nonblocking per-replica lock and lifecycle admission
def exchange(library_id: str) -> None:
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
            handle[1].tick()
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
    if handle:
        handle[1].close()


# Poll only replicas opened by this server, with bounded work per replica
class ReplicaWorker:
    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self.run, name="replica-exchange", daemon=True)

    def start(self) -> None:
        """Begin local provider-folder exchange without making network requests"""
        self._thread.start()

    def run(self) -> None:
        "Storage failures remain visible on explicit status/exchange instead of killing the loop"
        while not self._stop.wait(1):
            with _lock:
                libraries = list(_handles)
            for library_id in libraries:
                if self._stop.is_set():
                    return
                try:
                    exchange(library_id)
                except (DomainError, OSError):
                    continue

    def stop(self) -> None:
        """Stop admission to the worker before releasing its handles"""
        self._stop.set()
        self._thread.join(timeout=15)
        if self._thread.is_alive():
            return  # Do not close a descriptor still used by an in-flight storage operation
        with _lock:
            libraries = list(_handles)
        for library_id in libraries:
            close(library_id)
