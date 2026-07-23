"""What to do when the destination is already taken (ADR-0013 §3.3).

The owner-required interaction is Finder's and Eagle's: **Replace / Skip / Keep
both**. This module implements the two that are safe without a trash, plus the
default of refusing outright:

- ``fail`` (default) — a structured 409 the client turns into that prompt;
- ``skip`` — do nothing, report it;
- ``suffix`` — "keep both", picking ``name (2)`` and counting up.

``replace`` is deliberately **absent** rather than stubbed. ADR-0013 defines it
as *journaled trash-then-write* — the existing file moves into
``.cairndex/trash/`` before the incoming one takes the path — precisely so that
Replace never becomes a byte-level overwrite. The trash lands in W4, and until
it does there is no way to implement Replace that is recoverable, so offering
the word would be promising something the code cannot honour. Adding the member
later is additive for every client.
"""

import os
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from cairndex.core.errors import ConflictError
from cairndex.file_ops.paths import join_relative, resolve_writable, suffixed_name

# How many "(2)", "(3)", … names to try before giving up. A directory that has
# defeated a hundred attempts does not have a naming problem worth solving
# automatically.
_MAX_SUFFIX_ATTEMPTS = 100


class ConflictPolicy(StrEnum):
    """Caller's answer to a path collision, chosen before or after the 409."""

    FAIL = "fail"
    SKIP = "skip"
    SUFFIX = "suffix"


@dataclass(frozen=True)
class Settlement:
    """Where the operation should actually write, or that it should not."""

    relative_path: str
    skip: bool = False
    # The name changed to avoid a collision, so the UI can say which one it used.
    renamed: bool = False


def resolve_collision(
    root: Path,
    *,
    relative_path: str,
    policy: ConflictPolicy,
    name: str,
    parent: str,
) -> Settlement:
    """Apply ``policy`` to ``relative_path``, returning where to write.

    Raises ``ConflictError`` under the default policy so the API can answer 409
    with both sides' details and let the user choose — the collision prompt is a
    conversation, not a failure.
    """
    if not _exists(root, relative_path):
        return Settlement(relative_path=relative_path)

    if policy is ConflictPolicy.SKIP:
        return Settlement(relative_path=relative_path, skip=True)

    if policy is ConflictPolicy.SUFFIX:
        for attempt in range(2, _MAX_SUFFIX_ATTEMPTS + 2):
            candidate = join_relative(parent, suffixed_name(name, attempt))
            if not _exists(root, candidate):
                return Settlement(relative_path=candidate, renamed=True)
        raise ConflictError(f"Could not find an unused name for {name!r}.")

    raise ConflictError(
        f"An item named {name!r} already exists here.",
        details={"code": "path_conflict", "path": relative_path, "name": name},
    )


def _exists(root: Path, relative_path: str) -> bool:
    """Whether anything occupies this path — including a broken symlink.

    ``lexists`` rather than ``exists``: a dangling symlink is still a name the
    filesystem will refuse to let a rename take, so treating it as free would
    turn a collision into an ``EEXIST`` from deep inside the operation.
    """
    return os.path.lexists(resolve_writable(root, relative_path))
