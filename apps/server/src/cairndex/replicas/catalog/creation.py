"""Private creation intent and descriptor-last publication for disposable catalogs.

No application route or ordinary creation command calls this module. Its fixture
boundary does not authorize creation in an owner-selected directory.
"""

import os
from collections.abc import Callable
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal
from uuid import uuid4

from pydantic import Field, ValidationError

from cairndex.devtools.replica_creation_fixture import DisposableCreation
from cairndex.replicas.binding import BindingLock, read_json, sync_directory, write_json
from cairndex.replicas.catalog.protocol import (
    DISCOVERY_CAPABILITIES,
    CatalogDescriptor,
    UnitChange,
    payload,
)
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import PACKAGE_FORMAT, ReplicaError, StrictModel, Token, canonical
from cairndex.replicas.store import no_fault
from cairndex.replicas.transport import Transport, directory, read_file


class CreationIntent(StrictModel):
    """Exact package identity and private directory observations for one retry."""

    version: Literal[1] = 1
    descriptor: CatalogDescriptor
    replica: Token
    operation: Token
    root_identity: list[int] = Field(min_length=2, max_length=2)
    metadata_identity: list[int] = Field(min_length=2, max_length=2)


def _identity(path: Path) -> list[int]:
    if path.resolve() != path or not path.is_dir():
        raise ReplicaError("Creation requires the original unlinked fixture directories")
    info = path.stat(follow_symlinks=False)
    return [info.st_dev, info.st_ino]


def _seed(library: str, epoch: str, replica: str, operation: str) -> list[tuple[str, bytes]]:
    # Empty complete catalogs still contain both required hierarchy units.
    return list(
        payload(
            [
                UnitChange(unit=f"{family}/_/$forest", value="[]", basis=[])
                for family in ("tags", "collections")
            ],
            library=library,
            epoch=epoch,
            replica=replica,
            operation=operation,
            seed=True,
        )
    )


def prepare(fixture: DisposableCreation) -> None:
    """Record one identity only in a newly allocated empty developer fixture."""
    root_identity = _identity(fixture.root)
    metadata_identity = _identity(fixture.root / ".cairndex")
    _identity(fixture.private)
    if (
        {entry.name for entry in fixture.root.iterdir()} != {".cairndex"}
        or any((fixture.root / ".cairndex").iterdir())
        or any(fixture.private.iterdir())
    ):
        raise ReplicaError("Creation preparation requires a new empty fixture")
    library, epoch, replica, operation = (uuid4().hex for _ in range(4))
    artifacts = _seed(library, epoch, replica, operation)
    intent = CreationIntent(
        descriptor=CatalogDescriptor(
            format=PACKAGE_FORMAT,
            format_version=3,
            protocol_version=2,
            catalog_version=2,
            minimum_reader=3,
            capabilities=DISCOVERY_CAPABILITIES,
            library_uuid=library,
            display_name="Synthetic library",
            epoch=epoch,
            genesis=artifacts[-1][0],
        ),
        replica=replica,
        operation=operation,
        root_identity=root_identity,
        metadata_identity=metadata_identity,
    )
    sync_directory(fixture.root)
    sync_directory(fixture.directory)
    write_json(fixture.private / "creation.json", intent.model_dump(mode="json"))


def _check(fixture: DisposableCreation, intent: CreationIntent) -> None:
    if (
        _identity(fixture.root) != intent.root_identity
        or _identity(fixture.root / ".cairndex") != intent.metadata_identity
    ):
        raise ReplicaError("Creation directory changed; preserve the fixture for review")
    for entry in (fixture.root / ".cairndex").iterdir():
        if entry.name in {"manifest.json", "replica"}:
            continue
        if entry.name.startswith(".") and entry.name.endswith(".partial"):
            continue
        raise ReplicaError("Unclassified metadata blocks creation")


def _manifest(fd: int, expected: bytes) -> bool:
    try:
        raw = read_file(fd, "manifest.json")
    except FileNotFoundError:
        return False
    if raw != expected:
        raise ReplicaError("Creation descriptor changed; recovery review required")
    return True


def complete(
    fixture: DisposableCreation, *, fault: Callable[[str], None] = no_fault
) -> CatalogDescriptor:
    """Validate and publish the same seed and descriptor on every explicit retry.

    Incomplete private intent cannot be reconstructed from directory names. Retain
    such a fixture for inspection and allocate a separate new fixture.
    """
    _identity(fixture.private)
    try:
        intent = CreationIntent.model_validate(read_json(fixture.private / "creation.json"))
    except ValidationError as error:
        raise ReplicaError("Unsupported creation intent; preserve it for review") from error
    descriptor = intent.descriptor
    artifacts = _seed(descriptor.library_uuid, descriptor.epoch, intent.replica, intent.operation)
    if artifacts[-1][0] != descriptor.genesis or descriptor.format_version != 3:
        raise ReplicaError("Creation intent does not match its complete seed")
    expected = canonical(descriptor.model_dump(mode="json"))
    guard = BindingLock(fixture.private, descriptor)
    try:
        _check(fixture, intent)
        with directory(fixture.root, [".cairndex"]) as fd:
            _manifest(fd, expected)
        # Reconstruct independently on every retry; never trust a partial prior projection.
        with TemporaryDirectory(prefix="creation-check-", dir=fixture.private) as scratch:
            store = CatalogStore(Path(scratch), descriptor)
            for _, raw in reversed(artifacts):
                store.ingest(raw)
            for _ in range(len(artifacts) + 1):
                store.import_batch()
            if not store.status()["ready"] or store.status()["blocked"]:
                raise ReplicaError("Creation seed did not reconstruct a complete catalog")
            fault("creation_after_validation")
            transport = Transport(fixture.root, store)
            for identity, raw in artifacts:
                _check(fixture, intent)
                transport.publish(identity, raw)
                fault("creation_after_object")
            # Publication creates directory entries too; persist their parents before the marker.
            for parts in ([".cairndex", "replica", "objects"], [".cairndex", "replica"]):
                with directory(fixture.root, parts) as parent:
                    os.fsync(parent)
            fault("creation_before_manifest")
            _check(fixture, intent)
            with directory(fixture.root, [".cairndex"]) as fd:
                # Read published bytes back before exposing a usable descriptor.
                for identity, raw in artifacts:
                    with directory(
                        fixture.root, [".cairndex", "replica", "objects", identity[:2]]
                    ) as objects:
                        if read_file(objects, identity + ".json") != raw:
                            raise ReplicaError("Published creation seed changed")
                if not _manifest(fd, expected):
                    temporary = f".{uuid4().hex}.partial"
                    handle = os.open(
                        temporary,
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                        0o600,
                        dir_fd=fd,
                    )
                    with os.fdopen(handle, "wb") as stream:
                        stream.write(expected)
                        stream.flush()
                        os.fsync(stream.fileno())
                    fault("creation_after_manifest_temp")
                    try:
                        _check(fixture, intent)
                        os.link(temporary, "manifest.json", src_dir_fd=fd, dst_dir_fd=fd)
                    except FileExistsError:
                        _manifest(fd, expected)
                    finally:
                        os.unlink(temporary, dir_fd=fd)
                    fault("creation_after_manifest_link")
                os.fsync(fd)
            sync_directory(fixture.root)
            fault("creation_after_manifest")
    finally:
        guard.close()
    return descriptor
