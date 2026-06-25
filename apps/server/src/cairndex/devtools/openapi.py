"""CLI: print the application's OpenAPI schema as JSON.

Used to regenerate the frontend's typed API client:

    uv run python -m cairndex.devtools.openapi > ../web/src/api/openapi.json
"""

import json

from cairndex.main import app


def main() -> None:
    print(json.dumps(app.openapi(), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
