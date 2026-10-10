"""Bound expensive lazy media work before it enters Starlette's shared threads."""

from collections.abc import Callable

from anyio import CapacityLimiter, to_thread

_DERIVATIVE_LIMITER = CapacityLimiter(4)


# Keep cold media grids from occupying every shared request worker
async def run_derivative[T](function: Callable[[], T]) -> T:
    return await to_thread.run_sync(function, limiter=_DERIVATIVE_LIMITER)
