"""Owner-started conversion of legacy ``cairndex.library`` packages (ADR-0038).

Inspection only reads. Preparation works on private copies in server storage.
Activation changes the library root by two no-replace directory relocations:
the legacy ``.cairndex`` folder keeps its exact contents under a backup name,
and a staged format-three package takes its place. Media is never read.
"""

import fcntl
import os
import re
import sqlite3
import tempfile
from collections.abc import Callable, Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any

from cairndex.devtools.catalog_fixture import create_schema
from cairndex.file_ops import smb_transport
from cairndex.persistence.sqlite_durability import configure_durability, connect_writable
from cairndex.replicas.binding import private_path, read_json, sync_directory, write_json
from cairndex.replicas.catalog.conversion import build_candidate, seal_archive, verify_archive
from cairndex.replicas.catalog.legacy_input import (
    METADATA,
    _additive_defaults,
    _authored_tables,
    _copy_database,
    _entries,
    _lease,
    _manifest,
    _metadata,
    _quoted,
)
from cairndex.replicas.catalog.legacy_input import (
    inspect as inspect,
)
from cairndex.replicas.catalog.protocol import CatalogDescriptor
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError, canonical, checksum
from cairndex.replicas.store import no_fault
from cairndex.replicas.transport import directory, read_file

STAGING = ".cairndex-conversion-"
BACKUP = ".cairndex-legacy-"
CONVERTED = ".cairndex-converted-"
WORKSPACE = "legacy-conversions"
ATTEMPT = re.compile(r"^[a-f0-9]{32}$")


# Private workspaces are named only by library identity and a generated attempt
def workspace(base: Path, library_uuid: str, attempt: str) -> Path:
    if not ATTEMPT.fullmatch(attempt) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", library_uuid):
        raise ReplicaError("Invalid conversion identity")
    return base / WORKSPACE / library_uuid / attempt


@contextmanager
def _exclusive(base: Path, library_uuid: str) -> Iterator[None]:
    directory = base / WORKSPACE / library_uuid
    if directory.resolve() != directory:
        raise ReplicaError("Private conversion storage must not be linked")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    handle = os.open(directory / ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise ReplicaError("Another conversion step for this library is running") from error
        yield
    finally:
        os.close(handle)


def normalize(source: Path, checkpoint: Path) -> None:
    """Write the current legacy schema with every source row, by column name.

    Columns that older versions lacked receive the defaults of their additive upgrade.
    Unsettled operations block; settled ones stay, except trashed items, which only
    the backup folder can restore.
    """
    checkpoint.mkdir(mode=0o700)
    defaults = _additive_defaults()
    # URI filenames let the source attach read-only
    with closing(connect_writable((checkpoint / "library.db").as_uri(), uri=True)) as db:
        db.execute("ATTACH DATABASE ? AS plans", ((checkpoint / "plans.db").as_uri(),))
        configure_durability(db, schema="plans")
        create_schema(db)
        db.execute("ATTACH DATABASE ? AS source", (source.as_uri() + "?mode=ro",))
        tables = {
            name: [row[1] for row in db.execute(f"PRAGMA source.table_info({_quoted(name)})")]
            for (name,) in db.execute(
                "SELECT name FROM source.sqlite_master WHERE type='table'"
            ).fetchall()
        }
        db.execute("BEGIN")
        try:
            _copy_rows(db, tables, defaults)
        except sqlite3.Error as error:
            raise ReplicaError(
                "The library database has values this version cannot convert"
            ) from error
        db.commit()
        db.execute("DETACH DATABASE source")
        if db.execute("PRAGMA main.foreign_key_check").fetchone():
            raise ReplicaError("The library database has unresolved references")


def _copy_rows(
    db: sqlite3.Connection, tables: dict[str, list[str]], defaults: dict[tuple[str, str], str]
) -> None:
    for table in _authored_tables():
        if table not in tables:
            continue  # An absent table cannot hold metadata; the new one stays empty
        columns = [row[1] for row in db.execute(f"PRAGMA main.table_info({_quoted(table)})")]
        values = [
            _quoted(column) if column in tables[table] else defaults[(table, column)]
            for column in columns
        ]
        where = ""
        if table == "file_operations":
            where = " WHERE NOT (op='TRASH' AND status='DONE')"
        db.execute(
            f"INSERT INTO main.{_quoted(table)} ({','.join(map(_quoted, columns))}) "
            f"SELECT {','.join(values)} FROM source.{_quoted(table)}{where}"
        )
    # The legacy app derives each file's folder this way on every open
    db.execute(
        "UPDATE main.asset_files SET directory_path = "
        "rtrim(rtrim(relative_path, replace(relative_path, '/', '')), '/') "
        "WHERE directory_path = '' AND instr(relative_path, '/') > 0"
    )


def _compare_normalized(source: Path, checkpoint: Path) -> None:
    """Every source cell of each authored table survives normalization unchanged."""
    with closing(sqlite3.connect(checkpoint.as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("ATTACH DATABASE ? AS source", (source.as_uri() + "?mode=ro",))
        present = {
            name
            for (name,) in db.execute("SELECT name FROM source.sqlite_master WHERE type='table'")
        }
        for table in _authored_tables():
            if table not in present:
                continue
            target = {row[1] for row in db.execute(f"PRAGMA main.table_info({_quoted(table)})")}
            shared = [
                _quoted(row[1])
                for row in db.execute(f"PRAGMA source.table_info({_quoted(table)})")
                if row[1] in target
            ]
            where = (
                " WHERE NOT (op='TRASH' AND status='DONE')" if table == "file_operations" else ""
            )
            order = ",".join(shared)
            if table == "asset_files":
                # The derived folder may be filled in; every authored column is compared
                shared_cells = [name for name in shared if name != '"directory_path"']
                order = ",".join(shared_cells)
            else:
                shared_cells = shared
            columns = ",".join(shared_cells)
            left = db.execute(
                f"SELECT {columns} FROM source.{_quoted(table)}{where} ORDER BY {order}"
            )
            right = db.execute(f"SELECT {columns} FROM main.{_quoted(table)} ORDER BY {order}")
            while True:
                first, second = left.fetchmany(256), right.fetchmany(256)
                if first != second:
                    raise ReplicaError("Conversion changed a stored value; nothing was changed")
                if not first:
                    break


def prepare(
    root: Path,
    base: Path,
    attempt: str,
    *,
    fault: Callable[[str], None] = no_fault,
) -> dict[str, Any]:
    """Build and verify a private format-three candidate; the library is unchanged."""
    if not ATTEMPT.fullmatch(attempt):
        raise ReplicaError("Invalid conversion identity")
    metadata = _metadata(root)
    base = private_path(base, root)
    manifest, raw = _manifest(metadata)
    inspection = inspect(root)
    if inspection["blocking"]:
        raise ReplicaError(inspection["blocking"][0])
    library = manifest["library_uuid"]
    with _exclusive(base, library):
        directory = workspace(base, library, attempt)
        if (directory / "review.json").exists():
            return review_at(base, library, attempt)
        if directory.exists():
            raise ReplicaError("An interrupted preparation remains; start a new attempt")
        directory.mkdir(parents=True, mode=0o700)
        digest = _copy_database(metadata, directory / "original")
        fault("original_copied")
        checkpoint = directory / "checkpoint"
        normalize(directory / "original" / "library.db", checkpoint)
        _compare_normalized(directory / "original" / "library.db", checkpoint / "library.db")
        (checkpoint / "manifest.json").write_bytes(raw)
        seal_archive(checkpoint)
        fault("checkpoint_sealed")
        package, store = build_candidate(
            checkpoint,
            directory,
            library_uuid=library,
            display_name=manifest["display_name"],
            format_version=3,
            fault=fault,
        )
        objects = _object_receipt(package / METADATA)
        review = {
            "format": "cairndex.legacy-conversion",
            "version": 1,
            "attempt": attempt,
            "library_uuid": library,
            "display_name": manifest["display_name"],
            "root": root.as_posix(),
            "manifest": checksum(raw),
            "source": digest,
            "entries": _entries(metadata),
            "descriptor": store.descriptor.model_dump(mode="json"),
            "objects": objects,
            "inspection": inspection,
            "backup_name": BACKUP + attempt,
        }
        write_json(directory / "review.json", review)
        fault("review_written")
        return review | {"receipt": checksum(canonical(review))}


def review_at(base: Path, library_uuid: str, attempt: str) -> dict[str, Any]:
    directory = workspace(base, library_uuid, attempt)
    review = read_json(directory / "review.json")
    if review.get("format") != "cairndex.legacy-conversion" or review.get("attempt") != attempt:
        raise ReplicaError("The conversion review is not recognized")
    verify_archive(directory / "checkpoint")
    return review | {"receipt": checksum(canonical(review))}


def _object_receipt(metadata: Path) -> dict[str, str]:
    if metadata.is_symlink() or not metadata.is_dir():
        raise ReplicaError("Conversion metadata must not be linked")
    result = {}
    for path in sorted(metadata.rglob("*")):
        if path.is_symlink():
            raise ReplicaError("Conversion metadata must not be linked")
        if path.is_file():
            name = path.relative_to(metadata).as_posix()
            if name != "manifest.json" and not re.fullmatch(
                r"replica/objects/[a-f0-9]{2}/[a-f0-9]{64}\.json", name
            ):
                raise ReplicaError("The conversion package has an unknown entry")
            parts = name.split("/")
            with directory(metadata, parts[:-1]) as source:
                result[name] = checksum(read_file(source, parts[-1]))
    return result


def _directory_fd(path: Path) -> int:
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


def _relocate(root: Path, source: str, target: str) -> None:
    from cairndex.file_ops.exclusive import relocate
    from cairndex.file_ops.smb_portable import refresh

    handle = _directory_fd(root)
    try:
        try:
            relocate(handle, source, handle, target)
        except FileExistsError as error:
            raise ReplicaError(
                "A metadata destination already exists; nothing replaced it"
            ) from error
        os.fsync(handle)
        # A directory rename can leave the former manifest's pages cached at
        # the reused metadata path. Refresh only this known metadata file.
        with directory(root / target, []) as destination:
            refresh(destination, "manifest.json")
    finally:
        os.close(handle)


def _stage(package: Path, staging: Path, objects: dict[str, str]) -> None:
    """Copy the candidate into a hidden folder in the library root, descriptor last."""
    staging.mkdir(exist_ok=True, mode=0o700)
    names = sorted(objects, key=lambda name: name == "manifest.json")
    for name in names:
        parts = name.split("/")
        if any(part in {"", ".", ".."} or "\\" in part for part in parts):
            raise ReplicaError("Invalid conversion metadata path")
        with directory(staging, parts[:-1], create=True) as target:
            try:
                existing = read_file(target, parts[-1])
            except FileNotFoundError:
                existing = None
            if existing is not None:
                if checksum(existing) != objects[name]:
                    raise ReplicaError("The staged conversion changed; start a new attempt")
                continue
            with directory(package, parts[:-1]) as source:
                data = read_file(source, parts[-1])
            if checksum(data) != objects[name]:
                raise ReplicaError("The prepared conversion changed; start a new attempt")
            handle = os.open(
                parts[-1],
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=target,
            )
            with os.fdopen(handle, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.fsync(target)
    for folder in sorted({path.parent for path in staging.rglob("*")}, reverse=True):
        sync_directory(folder)
    if _object_receipt(staging) != objects:
        raise ReplicaError("The staged conversion is incomplete; retry")


def _converted(metadata: Path, descriptor: dict[str, Any]) -> bool:
    if metadata.is_symlink() or not metadata.is_dir():
        return False
    try:
        return read_json(metadata / "manifest.json") == descriptor
    except ReplicaError:
        return False


def _intent(folder: Path, name: str, root: Path, attempt: str, receipt: str) -> None:
    """Record the exact step before changing any library directory entry."""
    body = {"root": root.as_posix(), "attempt": attempt, "receipt": receipt}
    target = folder / name
    if target.exists():
        if read_json(target) != body:
            raise ReplicaError("The retained conversion intent changed")
    else:
        write_json(target, body)


def _verify_source(metadata: Path, folder: Path, review: dict[str, Any]) -> None:
    """Verify the original metadata without opening its database in place."""
    if metadata.is_symlink() or not metadata.is_dir():
        raise ReplicaError("The original metadata folder is missing or linked")
    _, raw = _manifest(metadata)
    if checksum(raw) != review["manifest"] or _entries(metadata) != review["entries"]:
        raise ReplicaError("The library metadata changed after review; prepare again")
    with tempfile.TemporaryDirectory(prefix="check-", dir=folder) as scratch:
        if _copy_database(metadata, Path(scratch) / "copy") != review["source"]:
            raise ReplicaError("The library changed after review; prepare again")


def _verify_published(metadata: Path, review: dict[str, Any]) -> None:
    """Validate the seed while permitting legitimate later immutable history."""
    if not _converted(metadata, review["descriptor"]):
        raise ReplicaError("The converted package changed")
    for name, digest in review["objects"].items():
        parts = name.split("/")
        with directory(metadata, parts[:-1]) as source:
            if checksum(read_file(source, parts[-1])) != digest:
                raise ReplicaError("The converted seed changed; recovery is required")


@contextmanager
def _publication(root: Path) -> Iterator[None]:
    """Register the exact mounted root for authenticated no-replace SMB renames."""
    smb_transport.register_root(root)
    try:
        yield
    finally:
        smb_transport.close_root(root)


def activate(
    root: Path,
    base: Path,
    attempt: str,
    receipt: str,
    *,
    confirm_stale_lease: bool = False,
    fault: Callable[[str], None] = no_fault,
) -> dict[str, Any]:
    """Swap the reviewed package into the library root; a retry finishes the same swap.

    An old version that stopped without releasing leaves a stale lease. Only the owner
    can confirm that no old server still uses the library, so a stale or unreadable
    lease needs ``confirm_stale_lease``.
    """
    base = private_path(base, root)
    if not root.is_absolute() or root.resolve() != root or not root.is_dir():
        raise ReplicaError("Select an existing, unlinked library folder")
    metadata, backup, staging = (
        root / METADATA,
        root / (BACKUP + attempt),
        root / (STAGING + attempt),
    )
    library = _attempt_library(root, base, attempt)
    with _exclusive(base, library), _publication(root):
        review = review_at(base, library, attempt)
        if review.pop("receipt") != receipt:
            raise ReplicaError("The conversion review changed; review it again")
        if review["root"] != root.as_posix():
            raise ReplicaError("Select the same library folder that was reviewed")
        directory = workspace(base, library, attempt)
        if (directory / "undo.json").exists():
            raise ReplicaError(
                "This conversion was undone or Undo started; prepare a new conversion"
            )
        descriptor = review["descriptor"]
        if backup.exists() and _converted(metadata, descriptor):
            _verify_source(backup, directory, review)
            _verify_published(metadata, review)
            return {"state": "converted", "attempt": attempt, "descriptor": descriptor}
        if not backup.exists():
            _verify_source(_metadata(root), directory, review)
            lease = _lease(root)
            if lease == "fresh":
                raise ReplicaError("Another server is serving this library; release it there")
            if lease in ("stale", "unreadable") and not confirm_stale_lease:
                raise ReplicaError(
                    "Confirm that no other server or old app version is serving this library"
                )
            _intent(directory, "activation.json", root, attempt, receipt)
            _stage(directory / "package" / METADATA, staging, review["objects"])
            fault("staged")
            _verify_source(metadata, directory, review)
            if _lease(root) == "fresh":
                raise ReplicaError("Another server is serving this library; release it there")
            _relocate(root, METADATA, BACKUP + attempt)
            fault("legacy_moved")
        _verify_source(backup, directory, review)
        _stage(directory / "package" / METADATA, staging, review["objects"])
        # The no-replace rename checks vacancy atomically. smbfs stat can remain
        # positive for the old name after its completed directory rename.
        _relocate(root, STAGING + attempt, METADATA)
        fault("published")
        _verify_published(metadata, review)
        return {"state": "converted", "attempt": attempt, "descriptor": descriptor}


def _attempt_library(root: Path, base: Path, attempt: str) -> str:
    """Find the library identity for an attempt from its private review."""
    if not ATTEMPT.fullmatch(attempt):
        raise ReplicaError("Invalid conversion identity")
    found = [
        path.parent.parent.name
        for path in (base / WORKSPACE).glob(f"*/{attempt}/review.json")
        if path.is_file() and not path.is_symlink()
    ]
    if len(found) != 1:
        raise ReplicaError("Select a prepared conversion")
    return found[0]


def undo(
    root: Path,
    base: Path,
    attempt: str,
    receipt: str,
    *,
    fault: Callable[[str], None] = no_fault,
) -> dict[str, Any]:
    """Restore the legacy folder; the converted one stays under a retained name.

    The caller has released the library on this server. The binding lock refuses
    while a server still serves the converted package.
    """
    from cairndex.replicas.binding import BindingLock, binding_file, location

    base = private_path(base, root)
    if not root.is_absolute() or root.resolve() != root or not root.is_dir():
        raise ReplicaError("Select an existing, unlinked library folder")
    library = _attempt_library(root, base, attempt)
    metadata, backup = root / METADATA, root / (BACKUP + attempt)
    retained = root / (CONVERTED + attempt)
    with _exclusive(base, library), _publication(root):
        review = review_at(base, library, attempt)
        if review.pop("receipt") != receipt or review["root"] != root.as_posix():
            raise ReplicaError("The conversion review changed; review it again")
        descriptor = CatalogDescriptor.model_validate(review["descriptor"])
        folder = workspace(base, library, attempt)
        guard = BindingLock(base, descriptor)
        try:
            if (folder / "undo-complete.json").exists():
                _intent(folder, "undo-complete.json", root, attempt, receipt)
                restored, _ = _manifest(_metadata(root))
                if restored["library_uuid"] != library:
                    raise ReplicaError("The restored library identity changed")
                _verify_published(retained, review)
                return {"state": "restored", "attempt": attempt, "retained": retained.name}
            binding = binding_file(base, descriptor)
            if binding.exists() or binding.is_symlink():
                location(base, descriptor)
            elif (base / "replicas" / library).exists():
                raise ReplicaError("Private binding is missing; use recovery before Undo")
            if not backup.exists():
                _verify_source(_metadata(root), folder, review)
                _verify_published(retained, review)
                _intent(folder, "undo.json", root, attempt, receipt)
            else:
                _verify_source(backup, folder, review)
                _intent(folder, "undo.json", root, attempt, receipt)
                if _converted(metadata, review["descriptor"]):
                    _verify_published(metadata, review)
                    _relocate(root, METADATA, CONVERTED + attempt)
                    fault("converted_retained")
                else:
                    if not retained.exists():
                        staging = root / (STAGING + attempt)
                        _verify_published(staging, review)
                        _relocate(root, STAGING + attempt, CONVERTED + attempt)
                        fault("converted_retained")
                    else:
                        _verify_published(retained, review)
                _relocate(root, BACKUP + attempt, METADATA)
                fault("legacy_restored")
            # A later conversion gets a new epoch, so retire this one's private store
            from cairndex.file_ops.exclusive import relocate

            retired = folder / "retired"
            retired.mkdir(exist_ok=True, mode=0o700)
            for source, target, point in (
                (base / "replicas" / library, "store", "store_retired"),
                (binding, "binding.json", "binding_retired"),
            ):
                if source.exists() or source.is_symlink():
                    if source.is_symlink():
                        raise ReplicaError("Private conversion storage must not be linked")
                    with (
                        directory(source.parent, []) as original,
                        directory(retired, []) as destination,
                    ):
                        relocate(original, source.name, destination, target)
                fault(point)
            _intent(folder, "undo-complete.json", root, attempt, receipt)
            fault("undo_completed")
        finally:
            guard.close()
    return {"state": "restored", "attempt": attempt, "retained": CONVERTED + attempt}


def store_at(base: Path, review: dict[str, Any]) -> CatalogStore:
    """Open the verified private candidate of a prepared conversion (tests, review)."""
    descriptor = CatalogDescriptor.model_validate(review["descriptor"])
    directory = workspace(base, review["library_uuid"], review["attempt"])
    return CatalogStore(directory / "replica", descriptor)
