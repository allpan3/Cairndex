"""Guarded file operations inside a library root (ADR-0013, plan 4).

Everything in this package can touch real files, so it all sits behind the
write-mode gate in ``gate.py``. The gate is the whole of milestone W0; the
operation journal, path validator, and the operations themselves land in later
slices and import from here.
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
