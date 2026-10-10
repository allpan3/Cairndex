"""Count the entire ASGI request, including streams and cancellation cleanup"""

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from cairndex.core.errors import LibraryLeaseError
from cairndex.ownership.lifecycle import lifecycle


class LibraryLifecycleMiddleware:
    """Stop new content work while retaining already admitted request lifetimes"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        parts = scope.get("path", "").strip("/").split("/")
        # Registry and ownership controls must stay available while closed
        if (
            scope["type"] != "http"
            or parts[:3] != ["api", "v1", "libraries"]
            or len(parts) < 5
            or parts[4] in {"ownership", "auth", "private-recovery"}
        ):
            await self.app(scope, receive, send)
            return
        started = False

        async def tracked_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            with lifecycle.work(parts[3]):
                await self.app(scope, receive, tracked_send)
        except LibraryLeaseError as exc:
            if started:
                raise
            await JSONResponse({"code": exc.code, "message": exc.message}, status_code=409)(
                scope, receive, send
            )
