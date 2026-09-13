"""Private generation bindings and process exclusion for explicit recovery activation"""

import json
import os
import re
from pathlib import Path
from typing import Any
from uuid import uuid4

from cairndex.replicas.protocol import PackageIdentity, ReplicaError, canonical, checksum


# Administrative paths are local-only and must not resolve through a linked parent
def private_path(path: Path, root: Path) -> Path:
    path = path.absolute()
    if path.resolve() != path or path.is_relative_to(root.resolve()):
        raise ReplicaError("Private recovery storage must be unlinked and outside the library")
    return path


# Receipts and bindings are small, exact JSON documents rather than arbitrary path instructions
def read_json(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise ReplicaError("Recovery receipt is missing or unsupported")
    try:
        raw = path.read_bytes()
        value = json.loads(raw)
        if not isinstance(value, dict) or canonical(value) != raw:
            raise ValueError
        return value
    except (ValueError, UnicodeError) as error:
        raise ReplicaError("Recovery receipt is corrupt or noncanonical") from error


# Durable metadata publication completes before a pointer can expose a prepared generation
def write_json(path: Path, value: dict[str, Any], *, replace: bool = False) -> None:
    temporary = path.with_name(f".{uuid4().hex}.partial")
    with temporary.open("xb") as stream:
        os.chmod(temporary, 0o600)
        stream.write(canonical(value))
        stream.flush()
        os.fsync(stream.fileno())
    try:
        if replace:
            os.replace(temporary, path)
        else:
            os.link(temporary, path, follow_symlinks=False)
    finally:
        temporary.unlink(missing_ok=True)
    sync_directory(path.parent)


# Directory durability is a local POSIX boundary, not a provider or power-loss guarantee
def sync_directory(path: Path) -> None:
    handle = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(handle)
    finally:
        os.close(handle)


# One server or activating administrator holds this lock until all admitted work has closed
class BindingLock:
    # Nonblocking OS exclusion prevents a second process from racing admitted server work
    def __init__(self, base: Path, descriptor: PackageIdentity) -> None:
        import fcntl

        directory = base / "replica-bindings"
        if directory.resolve() != directory:
            raise ReplicaError("Private replica bindings must not be linked")
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.fd = os.open(
            directory / f"{descriptor.library_uuid}.lock",
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
            0o600,
        )
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            os.close(self.fd)
            raise ReplicaError(
                "Private replica is active; finish Release or stop its server"
            ) from error

    # Closing follows lifecycle drain, so requests, exchange and media retain exclusion together
    def close(self) -> None:
        os.close(self.fd)


# Bindings live outside the store tree so a missing tree cannot silently create an empty author
def binding_file(base: Path, descriptor: PackageIdentity) -> Path:
    return base / "replica-bindings" / f"{descriptor.library_uuid}.json"


# Only generated relative directory names are accepted from an on-disk binding
def location(
    base: Path, descriptor: PackageIdentity, *, pending: str | None = None
) -> tuple[Path, str]:
    record = binding_file(base, descriptor)
    if record.parent.resolve() != record.parent:
        raise ReplicaError("Private replica bindings must not be linked")
    default = base / "replicas" / descriptor.library_uuid
    if not record.exists():
        if record.is_symlink():
            raise ReplicaError("Private binding must not be linked")
        generations = default / "generations"
        # Only an explicit first-activation retry may resume its sole unpublished generation
        if generations.exists() and not (
            pending and all(item.name == pending for item in generations.iterdir())
        ):
            raise ReplicaError(
                "Private generation binding is missing; preserve this server data and "
                "recover a verified backup in a separate data directory"
            )
        return default, "unbound"
    value = read_json(record)
    if set(value) != {"version", "descriptor", "generation", "review"} or (
        value["version"] != 1 or value["descriptor"] != descriptor.model_dump(mode="json")
    ):
        raise ReplicaError("Private binding authority changed; recovery review required")
    generation = value["generation"]
    if not isinstance(generation, str) or not re.fullmatch(r"original|[a-f0-9]{32}", generation):
        raise ReplicaError("Unsupported private generation")
    path = default if generation == "original" else default / "generations" / generation
    if path.resolve() != path:
        raise ReplicaError("Private generation must not be linked")
    return path, checksum(canonical(value))


# Registration and activation both pin exact package capabilities, ancestry and a generated location
def bind(base: Path, descriptor: PackageIdentity, generation: str, review: str) -> None:
    write_json(
        binding_file(base, descriptor),
        {
            "version": 1,
            "descriptor": descriptor.model_dump(mode="json"),
            "generation": generation,
            "review": review,
        },
        replace=True,
    )
