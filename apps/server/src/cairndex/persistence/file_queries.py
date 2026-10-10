"""Shared SQL expressions for library-visible paths and filename queries"""

from typing import Any

from sqlalchemy import and_, func, not_

from cairndex.scanning.media_types import HIDDEN_NAMES


# Trim every non-separator suffix character to find the last separator in SQLite
def path_basename(path: Any) -> Any:
    prefix = func.rtrim(path, func.replace(path, "/", ""))
    return func.substr(path, func.length(prefix) + 1)


# Match exact hidden path segments using the same names as the scanner
def visible_path(path: Any) -> Any:
    wrapped = "/" + path + "/"
    return and_(
        not_(path.like(".%") | path.like("%/.%")),
        *(func.instr(wrapped, f"/{name}/") == 0 for name in sorted(HIDDEN_NAMES)),
    )
