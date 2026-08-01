"""Journal-mode lifecycle for library databases (ADR-0021).

``journal_mode`` is the one SQLite pragma in Cairndex's set that is **not**
per-connection. It is recorded in the database file header (bytes 18 and 19,
the write/read format versions: ``2`` means WAL, ``1`` means a rollback
journal) and is therefore a property of the *file*, which travels with the
library folder like everything else under ``.cairndex/``.

That matters because a WAL database **cannot be opened at all over SMB or
NFS**. WAL needs a ``-shm`` index that every connection memory-maps, and mmap
coherence is not available on a network filesystem, so SQLite refuses with
``unable to open database file`` — for a read-only connection, on a file that
reads fine, in a writable directory. Flipping a library to WAL from a machine
with local access therefore locks out every machine that reaches the same
folder over a share, and only a machine with local access can flip it back.

So the lifecycle is: **WAL while we are serving the library, rollback at
rest.** A library this server has open gets WAL's concurrency; a clean close
checkpoints and converts it back, leaving a single portable ``library.db``
that any machine can open. The residual risk is explicit and accepted (see
ADR-0021): an *unclean* stop — ``docker kill``, power loss, the OOM killer —
leaves the file in WAL, and the next machine to reach it over a share is
locked out until a machine with local access converts it. That is why
:func:`diagnose_open_failure` exists and why an open that finds WAL on a
network filesystem heals it.

The server-local registry DB is deliberately not covered here: it lives on the
server's own disk, is never shared, and never travels. It stays in WAL
unconditionally.
"""

import ctypes
import ctypes.util
import logging
import os
import platform
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import Engine

logger = logging.getLogger(__name__)

# The SQLite file header records the file format version at offsets 18 (write)
# and 19 (read). 1 = legacy rollback journal, 2 = WAL.
_HEADER_JOURNAL_OFFSET = 18
_HEADER_WAL = 2

#: Recorded in the header, so ``DELETE`` and ``TRUNCATE`` are indistinguishable
#: once written — both are "legacy rollback". We only ever ask for ``DELETE``.
ROLLBACK = "rollback"
WAL = "wal"

#: The command an operator runs on a machine with local access to convert a
#: locked-out library back. Kept here so the error message, the deployment
#: runbook and the tests cannot drift apart.
RECOVERY_PRAGMA = "PRAGMA journal_mode=DELETE;"

# Filesystem types that cannot host a WAL database, by the names Linux and
# macOS report for them. Matched as a prefix so ``nfs4``, ``smb3`` and the
# ``fuse.`` family are covered without enumerating every variant.
_NETWORK_FILESYSTEM_PREFIXES = (
    "9p",
    "afp",
    "afs",
    "cifs",
    "ftp",
    "fuse.rclone",
    "fuse.s3fs",
    "fuse.sshfs",
    "nfs",
    "smb",
    "webdav",
)


@dataclass(frozen=True)
class FilesystemInfo:
    """What we could learn about the filesystem holding a path.

    ``kind`` is the OS's own name for it (``apfs``, ``ext4``, ``smbfs``,
    ``nfs4``, ``overlay``…) or ``None`` when we could not tell. ``local`` is
    tri-state on purpose: ``None`` means unknown, and unknown must not be
    treated as either answer — we attempt WAL and verify it took, rather than
    guessing.
    """

    kind: str | None = None
    local: bool | None = None

    @property
    def can_host_wal(self) -> bool:
        """Whether WAL is worth attempting here.

        Only a *positive* identification of a network filesystem says no. An
        unrecognised filesystem gets the benefit of the doubt and is settled by
        reading back what SQLite actually did.
        """
        if self.local is False:
            return False
        return not (self.kind is not None and self.kind.startswith(_NETWORK_FILESYSTEM_PREFIXES))


# --- filesystem identification --------------------------------------------


class _DarwinStatfs(ctypes.Structure):
    """macOS ``struct statfs`` (the 64-bit-inode layout, the only one on
    64-bit macOS). Only the fields up to ``f_fstypename`` are laid out; the
    trailing name buffers are declared so the struct is large enough for the
    kernel to fill, but we never read them (they hold mount paths)."""

    _fields_ = [
        ("f_bsize", ctypes.c_uint32),
        ("f_iosize", ctypes.c_int32),
        ("f_blocks", ctypes.c_uint64),
        ("f_bfree", ctypes.c_uint64),
        ("f_bavail", ctypes.c_uint64),
        ("f_files", ctypes.c_uint64),
        ("f_ffree", ctypes.c_uint64),
        ("f_fsid", ctypes.c_int32 * 2),
        ("f_owner", ctypes.c_uint32),
        ("f_type", ctypes.c_uint32),
        ("f_flags", ctypes.c_uint32),
        ("f_fssubtype", ctypes.c_uint32),
        ("f_fstypename", ctypes.c_char * 16),
        ("f_mntonname", ctypes.c_char * 1024),
        ("f_mntfromname", ctypes.c_char * 1024),
        ("f_flags_ext", ctypes.c_uint32),
        ("f_reserved", ctypes.c_uint32 * 7),
    ]


# ``MNT_LOCAL``: "filesystem is stored locally". Exactly the question WAL asks.
_MNT_LOCAL = 0x00001000


def _darwin_filesystem(path: Path) -> FilesystemInfo:
    libc_name = ctypes.util.find_library("c")
    if libc_name is None:  # pragma: no cover — libc is always present on macOS
        return FilesystemInfo()
    libc = ctypes.CDLL(libc_name, use_errno=True)
    # x86_64 exports the 64-bit-inode variant under a suffixed symbol; arm64
    # only ever had one ABI and exports it plain.
    statfs = getattr(libc, "statfs$INODE64", None) or getattr(libc, "statfs", None)
    if statfs is None:  # pragma: no cover — defensive
        return FilesystemInfo()
    buffer = _DarwinStatfs()
    if statfs(os.fsencode(path), ctypes.byref(buffer)) != 0:
        return FilesystemInfo()
    return FilesystemInfo(
        kind=buffer.f_fstypename.decode("ascii", "replace").lower() or None,
        local=bool(buffer.f_flags & _MNT_LOCAL),
    )


_MOUNTINFO = Path("/proc/self/mountinfo")


def _linux_filesystem(path: Path, mountinfo: Path = _MOUNTINFO) -> FilesystemInfo:
    """Identify the mount holding ``path`` from ``/proc/self/mountinfo``.

    ``mountinfo`` rather than ``/proc/mounts`` because it carries the mount
    point and filesystem type in fixed positions relative to the ``-``
    separator, which survives bind mounts and unusual device names. The longest
    matching mount point wins — a library root can itself contain a mount point
    (see docs/deployment.md), so the *nearest* enclosing mount is the answer.

    ``mountinfo`` is a parameter so the parsing can be tested from a macOS
    development machine; Linux is where this actually runs.
    """
    try:
        lines = mountinfo.read_text(encoding="utf-8").splitlines()
    except OSError:
        return FilesystemInfo()

    best_len = -1
    best_kind: str | None = None
    for line in lines:
        head, _, tail = line.partition(" - ")
        if not tail:
            continue
        fields = head.split()
        rest = tail.split()
        if len(fields) < 5 or not rest:
            continue
        mount_point = _unescape_mountinfo(fields[4])
        if not _is_within(path, mount_point):
            continue
        if len(mount_point) > best_len:
            best_len = len(mount_point)
            best_kind = rest[0].lower()

    if best_kind is None:
        return FilesystemInfo()
    return FilesystemInfo(kind=best_kind)


def _unescape_mountinfo(value: str) -> str:
    """``mountinfo`` octal-escapes space, tab, newline and backslash."""
    for escape, char in (("\\040", " "), ("\\011", "\t"), ("\\012", "\n"), ("\\134", "\\")):
        value = value.replace(escape, char)
    return value


def _is_within(path: Path, mount_point: str) -> bool:
    try:
        path.relative_to(mount_point)
    except ValueError:
        return False
    return True


def filesystem_for(path: Path) -> FilesystemInfo:
    """Identify the filesystem holding ``path``, or its nearest existing parent.

    The nearest existing parent because this is asked for a database file that
    may not exist yet — a library being created sits in a directory that does.
    Never raises: an unidentifiable filesystem is a legitimate answer
    (``FilesystemInfo()``), and every caller handles it.
    """
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent

    try:
        if platform.system() == "Darwin":
            return _darwin_filesystem(probe)
        if platform.system() == "Linux":
            return _linux_filesystem(probe.resolve())
    except Exception:  # noqa: BLE001 — identification is advisory, never fatal
        logger.debug("could not identify the filesystem holding a library database", exc_info=True)
    return FilesystemInfo()


# --- reading the mode out of the file --------------------------------------


def journal_mode_in_file(db_path: Path) -> str | None:
    """The journal mode recorded in a database file's header, without opening it.

    Deliberately a plain read of two header bytes rather than a connection:
    the whole point is to answer "what mode is this file in?" for a file we may
    be *unable* to open, which is precisely the locked-out case. Returns
    ``None`` if the file is missing, unreadable, or too short to be a database.
    """
    try:
        with db_path.open("rb") as handle:
            header = handle.read(20)
    except OSError:
        return None
    if len(header) < 20:
        return None
    return WAL if header[_HEADER_JOURNAL_OFFSET] == _HEADER_WAL else ROLLBACK


# --- applying and reverting -------------------------------------------------


def apply_library_journal_mode(engine: Engine, db_path: Path) -> str:
    """Put a library database into the journal mode this machine should use.

    Returns the mode actually in force afterwards, which is what SQLite reports
    rather than what we asked for — the two differ, silently, on a filesystem
    that cannot host WAL, and depending on that silence is what caused the
    incident this module exists to prevent.

    Two directions:

    - a filesystem that can host WAL gets WAL, for the concurrency it buys
      while the library is open;
    - a filesystem that cannot, holding a file that is *already* in WAL, is
      **healed** back to rollback here. That cannot help a machine that is
      already locked out — it never gets far enough to run this — but it
      repairs the library the first moment a capable machine opens it, which is
      the common way out of an unclean shutdown.
    """
    info = filesystem_for(db_path)
    if info.can_host_wal:
        mode = _set_journal_mode(engine, "WAL")
        if mode != WAL:
            # Not an error: the filesystem simply refused, and rollback works.
            # Logged because it changes the performance characteristics of every
            # subsequent write, and because it means our identification of the
            # filesystem (%s) was wrong about this mount.
            logger.info(
                "library database stayed in %s journal mode on a %s filesystem",
                mode,
                info.kind or "unidentified",
            )
        return mode

    current = _current_journal_mode(engine)
    if current == WAL:
        logger.info(
            "converting a WAL library database back to rollback on a %s filesystem",
            info.kind or "network",
        )
        checkpoint_and_revert(engine)
        return _current_journal_mode(engine)
    return current


def checkpoint_and_revert(engine: Engine) -> bool:
    """Fold the WAL in and convert the file back to a rollback journal.

    Three steps, none of them interchangeable:

    1. ``wal_checkpoint(TRUNCATE)`` — done explicitly, where a failure is
       visible, rather than left implicit in the conversion below;
    2. ``engine.dispose()`` — **load-bearing**. ``journal_mode=DELETE`` is
       refused outright while any *other* connection to the database is open,
       and a SQLAlchemy pool routinely holds several idle ones after a browsing
       session. Without this the conversion silently reports ``wal`` and the
       library stays unopenable over a share, which is the entire failure this
       function exists to prevent;
    3. the conversion itself, on the sole remaining connection.

    Returns whether the file ended up in rollback mode. ``False`` means the
    library is still in WAL and therefore still unopenable over a share; the
    caller cannot fix that here (something else holds it open), but ADR-0021's
    residual risk is exactly this case and it must not be reported as success.
    """
    if engine.dialect.name != "sqlite":
        return False
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)")
        engine.dispose()
        with engine.connect() as conn:
            row = conn.exec_driver_sql("PRAGMA journal_mode=DELETE").fetchone()
    except Exception:  # noqa: BLE001 — a busy DB or an offline mount is not fatal
        logger.debug("could not convert a library database back to rollback", exc_info=True)
        return False
    return _normalize(row) == ROLLBACK


def _set_journal_mode(engine: Engine, mode: str) -> str:
    with engine.connect() as conn:
        row = conn.exec_driver_sql(f"PRAGMA journal_mode={mode}").fetchone()
    return _normalize(row)


def _current_journal_mode(engine: Engine) -> str:
    with engine.connect() as conn:
        row = conn.exec_driver_sql("PRAGMA journal_mode").fetchone()
    return _normalize(row)


def _normalize(row: object) -> str:
    """The mode a ``PRAGMA journal_mode`` row reports, as WAL-or-not.

    SQLite names five rollback flavours (``delete``, ``truncate``, ``persist``,
    ``memory``, ``off``) and only the WAL/not-WAL distinction is meaningful
    here. Typed against ``object`` and read by index rather than unpacked:
    SQLAlchemy's ``Row`` is a sequence but *not* a ``tuple`` subclass, and an
    ``isinstance(row, tuple)`` guard here silently reported "rollback" for a
    database that had just been put into WAL.
    """
    if row is None:
        return ROLLBACK
    try:
        value = str(row[0]).lower()  # type: ignore[index]
    except (IndexError, TypeError):
        return ROLLBACK
    return WAL if value == WAL else ROLLBACK


# --- diagnosing a failed open -----------------------------------------------


@dataclass(frozen=True)
class OpenFailure:
    """Why a library database would not open, in terms an operator can act on."""

    reason: str
    message: str
    filesystem: str | None = None


def diagnose_open_failure(db_path: Path) -> OpenFailure:
    """Explain an ``unable to open database file`` on a library database.

    SQLite gives the same message for "you lack permission", "the directory is
    read-only" and "this file is in WAL and your filesystem cannot host that",
    which is why the incident behind ADR-0021 surfaced as an unattributable
    500. The three are distinguishable from outside SQLite: read the header
    bytes (a plain file read, which succeeds exactly when the file is readable)
    and ask what filesystem it sits on.

    The message names the concrete database path because the recovery command
    is useless without it, and because the library's ``root_path`` is already
    part of ``GET /api/v1/libraries/{id}``. Nothing else about the library —
    its name, its contents — appears.
    """
    info = filesystem_for(db_path)
    recorded = journal_mode_in_file(db_path)

    if recorded is None:
        if not db_path.exists():
            return OpenFailure(
                reason="missing",
                message=(
                    f"This library's database is missing at {db_path}. "
                    "Check that the library's storage is mounted."
                ),
                filesystem=info.kind,
            )
        return OpenFailure(
            reason="unreadable",
            message=(
                f"This library's database at {db_path} could not be read. "
                "Check the file's ownership and permissions, and that the server "
                "process can write to the directory holding it."
            ),
            filesystem=info.kind,
        )

    if recorded == WAL and not info.can_host_wal:
        return OpenFailure(
            reason="wal_on_network_filesystem",
            message=(
                "This library's database is in WAL journal mode, which cannot be "
                f"opened over a {info.kind or 'network'} filesystem — WAL needs a shared-memory "
                "index that network filesystems cannot provide. Convert it back "
                "from a machine with local access to the storage:\n\n"
                f"    sqlite3 {db_path} '{RECOVERY_PRAGMA}'\n\n"
                "This normally follows an unclean shutdown of the server that "
                "had the library open; a clean shutdown converts it back itself."
            ),
            filesystem=info.kind,
        )

    return OpenFailure(
        reason="unreadable",
        message=(
            f"This library's database at {db_path} could not be opened. "
            "Check the file's ownership and permissions, and that the server "
            "process can write to the directory holding it."
        ),
        filesystem=info.kind,
    )


_CANTOPEN = "unable to open database file"


def is_unable_to_open(error: BaseException) -> bool:
    """Whether an exception is SQLite's ``unable to open database file``.

    Matched on the message because SQLite collapses several distinct causes
    into one ``SQLITE_CANTOPEN``; there is no finer code to switch on — which is
    also why :func:`diagnose_open_failure` has to work the causes out from
    outside SQLite.

    Walks the exception chain *and* SQLAlchemy's ``.orig``, since a DBAPI error
    reaches us wrapped and the wrapper's own type says nothing.
    """
    seen: set[int] = set()
    pending: list[BaseException | None] = [error]
    while pending:
        current = pending.pop()
        if current is None or id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, sqlite3.Error) and _CANTOPEN in str(current):
            return True
        pending.extend(
            [current.__cause__, current.__context__, getattr(current, "orig", None)],
        )
    return False
