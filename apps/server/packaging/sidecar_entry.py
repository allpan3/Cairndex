"""PyInstaller entry script for the sidecar (ADR-0019 §2).

A separate file from ``cairndex.sidecar`` on purpose: PyInstaller freezes a
*script*, and pointing it at a module inside the package would make the package
importable under two names (as ``__main__`` and as ``cairndex.sidecar``), which
is a classic source of duplicated module state. This keeps the frozen entry a
thin shim and the real logic importable and testable as ordinary library code.
"""

import multiprocessing
import sys

from cairndex.sidecar import main

if __name__ == "__main__":
    # Required in a frozen app before anything may spawn a process. Cairndex
    # does not use multiprocessing itself, but a dependency that does would
    # otherwise re-execute this bootloader and fork servers in a loop.
    multiprocessing.freeze_support()
    sys.exit(main())
