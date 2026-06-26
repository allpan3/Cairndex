"""Serve the built single-page frontend from the backend.

In production a single container ships both halves of the app (docs/
deployment.md): FastAPI handles ``/api/*`` and serves the compiled SPA
(``apps/web/dist``) for everything else. In development this is inactive —
Vite serves the frontend on its own port — so mounting is gated on
``settings.static_dir`` being set and present.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


def mount_static_site(app: FastAPI, static_dir: Path) -> None:
    """Serve hashed assets and fall back to ``index.html`` for client routes.

    Mounted last so it never shadows the API: FastAPI matches the explicit
    ``/api/v1`` routes first and only unmatched paths reach here. Hashed build
    assets (``/assets/...``) are served directly; any other GET returns
    ``index.html`` so the SPA can resolve the path client-side (a hard refresh
    on a deep link still works). Unknown ``/api`` paths keep returning JSON 404s
    rather than the HTML shell.
    """
    index = static_dir / "index.html"
    if not index.is_file():
        raise RuntimeError(
            f"static_dir {static_dir} has no index.html — build the frontend "
            "(npm run build) or unset CAIRNDEX_STATIC_DIR"
        )

    assets = static_dir / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa_fallback(path: str) -> FileResponse:
        # Real files at the web root (favicon, manifest, robots) win; otherwise
        # hand back the SPA shell. Never serve API paths as HTML.
        if path.startswith("api/"):
            raise HTTPException(status_code=404)
        candidate = static_dir / path
        if path and candidate.is_file() and candidate.parent == static_dir:
            return FileResponse(candidate)
        return FileResponse(index)
