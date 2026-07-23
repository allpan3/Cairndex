"""Importing external files into a library (ADR-0013 §7, plan 4 W5/§6).

The only path by which bytes from outside a library ever enter it, and the one
operation here that *creates* rather than rearranges. The shape follows from
three constraints:

* **The server never reaches out to a client's paths.** The caller streams the
  bytes; a request carrying an absolute path for the server to read would be
  exactly the "trust a client-supplied path" rule the whole product refuses
  (AGENTS.md). So the body *is* the file.
* **A 60 GB video must not be held in memory.** The body is written to a
  temporary file in chunks, and that temporary lives inside the library package
  — the same filesystem as its destination — so the final step is a rename
  rather than a second copy of everything just written.
* **A failed or abandoned upload must not leave litter.** The partial file is
  removed on every failure path, and the journal row records the failure.

One file per request, deliberately. A dropped selection of twelve files becomes
twelve imports, which is what makes per-file progress, per-file collision
answers, and per-file undo possible; batching them into one request would make
all three worse to get a round trip back.
"""

import contextlib
import os
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.orm import Session

from cairndex.core.config import get_settings
from cairndex.core.errors import ConflictError, ValidationError
from cairndex.core.paths import PathSafetyError, normalize_relative_path
from cairndex.domain.enums import FileOpType
from cairndex.file_ops import journal, operations
from cairndex.file_ops.conflicts import ConflictPolicy, resolve_collision
from cairndex.file_ops.paths import join_relative, resolve_writable, validate_name
from cairndex.registry import library_package as pkg

# Chunk size for streaming a body to disk. Large enough that a big import is not
# a syscall benchmark, small enough that memory use is a constant nobody notices.
CHUNK_BYTES = 1024 * 1024

# Partial uploads live here — inside the package, so they are invisible to
# scanning, on the same filesystem as any destination (making the final move a
# rename), and swept on the next import if a crash ever leaves one behind.
STAGING_DIR = "tmp"


@dataclass(frozen=True)
class ImportResult:
    operation: operations.OperationResult
    # Bytes actually written, which the client can check against what it sent.
    size_bytes: int


def staging_dir(root: Path) -> Path:
    return pkg.marker_dir(root) / STAGING_DIR


def sweep_staging(root: Path) -> int:
    """Delete leftover partial uploads. Returns how many were removed.

    Runs on library open next to the journal reconciler: a crash mid-upload
    leaves a `.part` file that nothing will ever finish, and it may be large.
    """
    directory = staging_dir(root)
    removed = 0
    try:
        entries = list(directory.iterdir())
    except OSError:
        return 0
    for entry in entries:
        try:
            entry.unlink()
            removed += 1
        except OSError:
            continue
    return removed


def plan_destination(
    session: Session,
    root: Path,
    *,
    dest_dir: str,
    filename: str,
    on_conflict: ConflictPolicy,
) -> tuple[str, bool]:
    """Decide where an import will land, before a single byte is accepted.

    Returns ``(relative_path, skip)``. Checked up front so a collision costs one
    round trip instead of a whole upload — and re-checked after the bytes land,
    because the answer can change while a large file is in flight.
    """
    try:
        name = validate_name(filename)
        directory = normalize_relative_path(dest_dir) if dest_dir else ""
        if directory:
            resolved_dir = resolve_writable(root, directory, what="destination folder")
        else:
            resolved_dir = Path(root)
    except PathSafetyError as error:
        raise ValidationError(str(error)) from error

    if not resolved_dir.is_dir():
        raise ValidationError(f"{dest_dir or '(library root)'} is not a folder in this library.")

    target = join_relative(directory, name)
    settled = resolve_collision(
        root, relative_path=target, policy=on_conflict, name=name, parent=directory
    )
    return settled.relative_path, settled.skip


async def import_stream(
    session: Session,
    root: Path,
    *,
    dest_dir: str,
    filename: str,
    body: AsyncIterator[bytes],
    on_conflict: ConflictPolicy = ConflictPolicy.FAIL,
    link: bool = False,
) -> ImportResult:
    """Stream one uploaded file into the library, journaled end to end."""
    target_relative, skip = plan_destination(
        session, root, dest_dir=dest_dir, filename=filename, on_conflict=on_conflict
    )
    if skip:
        operation = journal.begin(
            session, op=FileOpType.IMPORT, payload={"destination": target_relative, "skipped": True}
        )
        journal.finish(session, operation, files_updated=0)
        return ImportResult(
            operation=operations.OperationResult(
                operation=operation, path=target_relative, files_updated=0, skipped=True
            ),
            size_bytes=0,
        )

    operation = journal.begin(
        session,
        op=FileOpType.IMPORT,
        payload={"destination": target_relative, "filename": filename},
    )
    staging = staging_dir(root) / f"{operation.id}.part"
    staging.parent.mkdir(parents=True, exist_ok=True)

    limit = get_settings().import_max_bytes
    written = 0
    try:
        with staging.open("wb") as handle:
            async for chunk in body:
                written += len(chunk)
                if limit and written > limit:
                    raise ValidationError(
                        f"This file is larger than the {limit}-byte import limit "
                        "(CAIRNDEX_IMPORT_MAX_BYTES)."
                    )
                handle.write(chunk)
        if written == 0:
            raise ValidationError("The uploaded file was empty.")
    except Exception as error:
        _discard(staging)
        journal.fail(session, operation, _reason(error))
        raise

    # Re-settle: a large upload takes time, and something may have taken the
    # name while it was in flight. The pre-check saved the round trip; this is
    # the one that decides.
    try:
        final_relative, skip_now = plan_destination(
            session, root, dest_dir=dest_dir, filename=filename, on_conflict=on_conflict
        )
        if skip_now:
            _discard(staging)
            journal.finish(session, operation, skipped=True, files_updated=0)
            return ImportResult(
                operation=operations.OperationResult(
                    operation=operation, path=target_relative, files_updated=0, skipped=True
                ),
                size_bytes=0,
            )
        if final_relative != target_relative:
            operation.payload = {**operation.payload, "destination": final_relative}
            target_relative = final_relative
    except Exception as error:
        _discard(staging)
        journal.fail(session, operation, _reason(error))
        raise

    # Only if something is *still* there: a large upload gives the owner time to
    # delete the file it was going to replace, and trashing a path that is
    # already free would fail the import over a conflict that resolved itself.
    if on_conflict is ConflictPolicy.REPLACE and os.path.lexists(root / target_relative):
        try:
            displaced = operations.trash_paths(session, root, paths=[target_relative])
            journal.finish_payload(session, operation, replaced_operation_id=displaced.operation.id)
        except Exception as error:
            _discard(staging)
            journal.fail(session, operation, _reason(error))
            raise

    try:
        destination = resolve_writable(root, target_relative, what="destination")
        os.rename(staging, destination)
    except (OSError, PathSafetyError) as error:
        _discard(staging)
        journal.fail(session, operation, _reason(error))
        raise ConflictError(f"Could not save {filename!r} into the library.") from error

    linked = _link_if_asked(session, target_relative) if link else 0
    journal.finish(session, operation, size_bytes=written, files_updated=linked)
    return ImportResult(
        operation=operations.OperationResult(
            operation=operation, path=target_relative, files_updated=linked
        ),
        size_bytes=written,
    )


def _link_if_asked(session: Session, relative_path: str) -> int:
    """Fast-add the imported file so it appears as an unbundled item.

    Best-effort by design: an import that landed is a success even if the file
    is not media the app knows how to bundle. The bytes are in the library
    either way, and the next scan will pick up anything this skipped.
    """
    from cairndex.scanning.fast_add import fast_add

    return fast_add(session, paths=[relative_path]).files_linked


def _discard(staging: Path) -> None:
    """Remove a partial upload. A failure here must not mask the real error."""
    with contextlib.suppress(OSError):
        staging.unlink()


def _reason(error: Exception) -> str:
    if isinstance(error, OSError):
        return os.strerror(error.errno) if error.errno else "filesystem error"
    return str(error) or error.__class__.__name__


def chunks_of(data: Iterable[bytes]) -> AsyncIterator[bytes]:
    """Adapt a synchronous iterable of chunks to the async body protocol (tests)."""

    async def _iterate() -> AsyncIterator[bytes]:
        for chunk in data:
            yield chunk

    return _iterate()
