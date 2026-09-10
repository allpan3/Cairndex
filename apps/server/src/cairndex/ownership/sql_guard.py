"""Fence existing SQL connections and notice storage failures before retrying"""

import sqlite3
from collections.abc import Callable

from sqlalchemy import Engine, ExceptionContext, event

from cairndex.core.errors import LibraryReleasedError
from cairndex.ownership.manager import LeaseManager


# Bind guards to the engine generation, not a later replacement sessionmaker
def guard_engine(
    engine: Engine,
    manager: LeaseManager,
    library_id: str,
    retired: Callable[[], bool] = lambda: False,
) -> None:
    def validate(*args: object, **kwargs: object) -> None:
        """Revalidate elapsed ownership before statements and commits"""
        if retired():
            raise LibraryReleasedError("This library session belongs to a closed engine")
        manager.validate(library_id)

    def failed(context: ExceptionContext) -> None:
        """A storage error invalidates cached certainty even between heartbeats"""
        error = context.original_exception
        code = getattr(error, "sqlite_errorcode", 0) & 0xFF
        if context.is_disconnect or code in (sqlite3.SQLITE_IOERR, sqlite3.SQLITE_CANTOPEN):
            manager.mark_uncertain(library_id)

    event.listen(engine, "before_cursor_execute", validate)
    event.listen(engine, "commit", validate)
    event.listen(engine, "handle_error", failed)
