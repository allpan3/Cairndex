"""Guarded file operations inside a library root (ADR-0013, plan 4).

Everything in this package can touch real files, so it all sits behind the
write-mode gate in ``gate.py`` (W0). The pieces, in the order an operation meets
them:

* ``gate`` — may this library be written to at all?
* ``paths`` — is this path/name safe, inside the root, and outside ``.cairndex``?
* ``conflicts`` — the destination is taken; fail, skip, or keep both?
* ``journal`` — record the intent, then the outcome;
* ``operations`` — rename and New Folder (W1); move/trash/import follow;
* ``reconcile`` — settle anything a crash interrupted, on the next open.
"""

from cairndex.file_ops.gate import (
    WriteModeState,
    ensure_write_mode,
    read_write_mode,
    set_write_mode,
)

__all__ = [
    "WriteModeState",
    "ensure_write_mode",
    "read_write_mode",
    "set_write_mode",
]
