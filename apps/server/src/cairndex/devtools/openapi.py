"""CLI: print the application's OpenAPI schema as JSON.

Used to regenerate the frontend's typed API client:

    uv run python -m cairndex.devtools.openapi > ../web/src/api/openapi.json
"""

import json

from cairndex.main import app


# The exact text committed as apps/web/src/api/openapi.json
def render() -> str:
    return json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n"


def main() -> None:
    print(render(), end="")


if __name__ == "__main__":
    main()
