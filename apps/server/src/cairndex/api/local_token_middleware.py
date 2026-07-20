"""Whole-server gate for the desktop local-server sidecar (ADR-0018 §5).

A sidecar binds to loopback on an ephemeral port, which any process on the
machine can reach. Registered only when ``CAIRNDEX_LOCAL_TOKEN`` is set, so an
ordinary NAS or container deployment is completely unaffected.
"""

from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from cairndex.api.schemas.common import ErrorBody
from cairndex.auth.local_token import is_local_owner_token

# The shell polls this to know the sidecar is up, and needs it to answer before
# it has any reason to trust the process it just spawned. It exposes no library
# data — only liveness and capability flags — so leaving it open costs nothing
# a closed port would not already reveal.
_OPEN_PATHS = frozenset({"/api/v1/health"})


class LocalTokenMiddleware(BaseHTTPMiddleware):
    """Require the loopback owner token on every API request."""

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        path = request.url.path
        if not path.startswith("/api/") or path in _OPEN_PATHS:
            return await call_next(request)

        # CORS preflights never carry an Authorization header — the browser
        # sends them precisely to ask whether it may. Rejecting them would make
        # every cross-origin request fail before the real one is attempted.
        if request.method == "OPTIONS":
            return await call_next(request)

        header = request.headers.get("authorization", "")
        scheme, separator, token = header.partition(" ")
        if not separator or scheme.lower() != "bearer" or not is_local_owner_token(token.strip()):
            body = ErrorBody(
                code="local_token_required",
                message="this server requires its local owner token",
            )
            return JSONResponse(status_code=401, content=body.model_dump(exclude_none=True))
        return await call_next(request)


def register_local_token_gate(app: FastAPI) -> None:
    app.add_middleware(LocalTokenMiddleware)
