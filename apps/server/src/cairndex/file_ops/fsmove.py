"""Moving one path to another on disk, for the cases plain ``os.rename`` fails.

Every guarded write operation (rename, move, trash, restore, undo) ultimately
relocates a path, and all of them come through :func:`move_path`. Two real-storage
cases break the obvious one-line implementation:

**Case-only renames on a case-insensitive filesystem** — an SMB share from macOS,
or APFS as usually formatted — see source and destination as the *same* file. A
plain rename is a silent no-op and an existence check on the destination reports
the source. Going via a temporary name makes it real.

**Cross-device moves** (``EXDEV``). ``os.rename`` cannot cross a filesystem
boundary, and a library root can easily span one: a NAS share or external drive
mounted at a subdirectory, or a bind mount in a container. Today that surfaces as
a per-file failure, so nothing is lost but the move can never succeed. The
fallback is the standard copy-then-delete, ordered so the original is the last
thing to go (ADR-0013: original media is never destroyed except through an
explicit journaled operation, and this *is* one — but only once its replacement is
committed):

1. copy to a hidden staging name **beside the destination**, so the final step is
   a same-filesystem rename and therefore atomic;
2. flush it to disk;
3. rename staging → destination — the commit point;
4. only now remove the source.

A crash before step 3 leaves the source untouched and an inert hidden staging
entry. A crash between 3 and 4 leaves *both* copies — a state a plain rename can
never produce, which is why :mod:`cairndex.file_ops.reconcile` learns to
recognize it rather than calling the outcome undecidable.
"""

import errno
import os
import shutil
import uuid
from pathlib import Path

# Hidden, and named after what it is, so a leftover from an interrupted
# cross-device move is recognizable rather than mysterious. The random suffix
# keeps two concurrent moves of the same name from colliding.
STAGING_PREFIX = ".cairndex-xdev-"


def staging_name(destination: Path) -> str:
    """The hidden name a cross-device copy of ``destination`` stages under."""
    return f"{STAGING_PREFIX}{uuid.uuid4().hex[:8]}-{destination.name}"


def is_staging(name: str) -> bool:
    """Whether a filename is one of our cross-device staging leftovers."""
    return name.startswith(STAGING_PREFIX)


def clear_marker(destination: Path) -> None:
    """Drop the in-flight marker for ``destination`` once its fate is settled."""
    _discard(pending_marker(destination))


def marker_names_source(destination: Path, source: Path) -> bool:
    """Whether an in-flight marker exists for ``destination`` *and* names ``source``.

    The reconciler's evidence for "both copies exist because a cross-device move
    crashed between commit and cleanup". Requiring the recorded source to match —
    not just the marker to exist — narrows the false-positive window further: a
    stale marker from some earlier attempt at this destination cannot vouch for a
    move from somewhere else, and the wrong guess here repoints an owner's
    metadata onto the wrong file.
    """
    try:
        return pending_marker(destination).read_text(encoding="utf-8") == str(source)
    except OSError:
        return False


def pending_marker(destination: Path) -> Path:
    """The marker that says a cross-device move to ``destination`` was in flight.

    The reconciler needs to tell "we crashed between committing the copy and
    removing the original" from "two unrelated files happen to sit at both
    paths". Comparing size and mtime cannot do it: two files of the same size
    written moments apart look identical by that measure, and treating them as a
    copy would repoint an owner's metadata onto the wrong file. So the fallback
    leaves explicit evidence instead, the same way an interrupted import is
    identified by its leftover staging file rather than by inference.

    Written before the commit and removed after the original is gone, so it
    exists exactly across the window where both copies are on disk.
    """
    return destination.with_name(f"{STAGING_PREFIX}pending-{destination.name}")


def move_path(source: Path, destination: Path) -> None:
    """Relocate ``source`` to ``destination``, handling the two hard cases.

    Raises ``OSError`` on failure, having left the source in place. The caller
    journals what a failure means; this function never decides that.
    """
    if source == destination:
        return
    if str(source).lower() == str(destination).lower() and source.parent == destination.parent:
        _case_only_rename(source, destination)
        return
    try:
        os.rename(source, destination)
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise
        _copy_then_delete(source, destination)


def _case_only_rename(source: Path, destination: Path) -> None:
    """Force a case-only rename through a temporary name."""
    staging = destination.with_name(f".cairndex-rename-{os.getpid()}-{destination.name}")
    os.rename(source, staging)
    try:
        os.rename(staging, destination)
    except OSError:
        os.rename(staging, source)  # put it back rather than leave a dotfile
        raise


def _copy_then_delete(source: Path, destination: Path) -> None:
    """Copy across a filesystem boundary, then drop the original.

    The source is removed only after the destination is committed, so every
    interruption leaves the file readable at one path or both — never neither.
    """
    is_directory = source.is_dir() and not source.is_symlink()
    staging = destination.with_name(staging_name(destination))
    marker = pending_marker(destination)
    try:
        if is_directory:
            shutil.copytree(source, staging, symlinks=True)
        else:
            shutil.copy2(source, staging, follow_symlinks=False)
            _flush(staging)
        # `os.rename` would overwrite silently. Callers settle collisions before
        # anything is touched (trash-then-write for Replace), so an occupied
        # destination here means something changed underneath us — and
        # overwriting original media is the one outcome that must not happen.
        if os.path.lexists(destination):
            raise FileExistsError(
                errno.EEXIST, "destination appeared while copying", str(destination)
            )
        # Written before the commit, so it is already there if the process dies
        # in the window where both copies exist (see `pending_marker`).
        marker.write_text(str(source), encoding="utf-8")
        os.rename(staging, destination)
    except BaseException:
        _discard(staging)
        _discard(marker)
        raise
    _remove(source, is_directory=is_directory)
    _discard(marker)


def _flush(path: Path) -> None:
    """Push a copied file to storage before it is committed under its real name.

    Without this, power loss just after the commit rename could leave a
    correctly-named destination whose contents never arrived — and the source is
    removed on the strength of that name.
    """
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return  # best-effort: an unflushable copy is still a complete copy
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _discard(path: Path) -> None:
    """Remove a staging entry after a failed copy. Missing is fine."""
    try:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)
    except OSError:
        pass


def _remove(path: Path, *, is_directory: bool) -> None:
    """Drop the original once its replacement is committed."""
    if is_directory:
        shutil.rmtree(path)
    else:
        path.unlink()
