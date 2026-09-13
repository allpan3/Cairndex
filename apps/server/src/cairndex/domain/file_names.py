"""Maintain legacy filename copies during existing scan, repair and source-move paths

API names derive from the current path. The stored display_title is compatibility
data, not an alias: values differing from the old basename stay untouched because
their origin cannot be inferred. This helper does not affect filename presentation.
"""

from pathlib import PurePosixPath


# Update an exact filename copy before assigning the new path, preserving other legacy values
def display_title_after_move(*, display_title: str, old_path: str, new_path: str) -> str:
    if display_title == PurePosixPath(old_path).name:
        return PurePosixPath(new_path).name
    return display_title
