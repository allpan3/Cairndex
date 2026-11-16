from pathlib import Path

from cairndex.devtools import openapi

_COMMITTED = Path(__file__).resolve().parents[2] / "web" / "src" / "api" / "openapi.json"


# The web app builds against the committed schema, so a route change that skips
# `just api` would ship a client typed for the old API
def test_committed_openapi_matches_the_server() -> None:
    assert _COMMITTED.read_text(encoding="utf-8") == openapi.render(), (
        "apps/web/src/api/openapi.json is stale; run `just api` and commit both files"
    )
