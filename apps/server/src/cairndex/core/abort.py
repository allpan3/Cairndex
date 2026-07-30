"""Cooperative abort signalling for long external work.

Cancelling a job is cooperative: a handler notices at its next checkpoint. That
is fine when checkpoints are close together and useless when one step is a
minute long — a storyboard pass over a network-mounted library spends ~30s
inside a single ffmpeg call, and "stop" that takes half a minute to visibly
stop is indistinguishable from a stuck button.

The signal is a context variable rather than a parameter because the code that
must observe it (``media/ffmpeg_exec``) sits several layers below the code that
knows about jobs, through call paths that have no reason to carry a job around.
Outside an ``abort_scope`` — an HLS session, a request-path derivative, a test —
``aborted()`` is False and nothing changes.
"""

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar

_ABORT: ContextVar[Callable[[], bool] | None] = ContextVar("cairndex_abort", default=None)


class OperationAborted(Exception):
    """Raised when in-flight external work is stopped by an abort signal.

    Deliberately not a subclass of any error type callers already handle:
    ``FfmpegError`` and its friends mean "this derivative failed", and an abort
    is not a failure of the work — it is the work being taken away. Anything
    that caught it as a failure would record the wrong terminal state.
    """


@contextmanager
def abort_scope(should_abort: Callable[[], bool]) -> Iterator[None]:
    """Make ``should_abort`` the abort signal for everything called inside."""
    token = _ABORT.set(should_abort)
    try:
        yield
    finally:
        _ABORT.reset(token)


def aborted() -> bool:
    """True when the current scope has been asked to stop."""
    signal = _ABORT.get()
    return signal is not None and signal()
