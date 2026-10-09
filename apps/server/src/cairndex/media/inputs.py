"""Pass validated local input descriptors to media subprocesses without reopening paths"""

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

_inputs: ContextVar[dict[Path, int] | None] = ContextVar("media_inputs", default=None)


# Only explicitly pinned replica operations opt into descriptor inheritance
@contextmanager
def inherited_inputs(inputs: dict[Path, int]) -> Iterator[None]:
    token = _inputs.set(inputs)
    try:
        yield
    finally:
        _inputs.reset(token)


# Keep ordinary commands unchanged and replace replica input paths including subtitle filters
def source_path(path: Path) -> Path:
    fd = (_inputs.get() or {}).get(path)
    return Path(f"/dev/fd/{fd}") if fd is not None else path


# Preserve input identity across both direct arguments and subtitle filter expressions
def command(args: list[str]) -> tuple[list[str], tuple[int, ...]]:
    from cairndex.media.hls import _escape_filter_path

    inputs = _inputs.get() or {}
    result = list(args)
    for path, fd in inputs.items():
        pinned = Path(f"/dev/fd/{fd}")
        result = [
            str(pinned)
            if arg == str(path)
            else arg.replace(
                f"subtitles={_escape_filter_path(path)}",
                f"subtitles={_escape_filter_path(pinned)}",
            )
            for arg in result
        ]
    return result, tuple(inputs.values())
