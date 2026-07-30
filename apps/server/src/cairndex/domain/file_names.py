"""The one rule for what a file is *called* when its path changes.

``asset_files`` carries three names and they are not interchangeable:

* ``relative_path`` — where the file is.
* ``original_filename`` — what it was called when it entered the library.
* ``display_title`` — the name every bundle surface renders: the inspector's
  file rail, the album, the viewer's file list.

A path can change in three different places — a rename or move Cairndex performs
(``file_ops.operations``), a rename it *discovers* during a scan
(``scanning.scanner``), and a missing file the owner repairs by hand
(``scanning.repair``). Each of them used to move the path and leave
``display_title`` behind, which is how one file came to show its new name in the
File Browser and its old one inside its bundle (owner reports, 2026-07-30). One
function so there is one answer, rather than three sites remembering to agree.

Kept free of any model import on purpose: this is a decision about strings, and
that keeps it callable from both ``file_ops`` and ``scanning`` without either
depending on the other.
"""

from pathlib import PurePosixPath


def display_title_after_move(*, display_title: str, old_path: str, new_path: str) -> str:
    """What to show for a file that is moving from ``old_path`` to ``new_path``.

    The shown name follows the file while it still *is* the old filename — which
    it is for almost every row, since it is seeded from the filename at scan and
    at fast-add. A title that differs has been set deliberately through
    ``PATCH …/files/{file_id}``, and a path change is not entitled to overwrite
    someone's choice.

    Call it *before* reassigning the path; both paths are named arguments so a
    swapped pair is visible at the call site rather than silently wrong.
    """
    if display_title == PurePosixPath(old_path).name:
        return PurePosixPath(new_path).name
    return display_title
