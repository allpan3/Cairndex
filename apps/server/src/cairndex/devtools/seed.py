"""CLI: seed the configured database with a synthetic library.

Usage (from apps/server, after `alembic upgrade head`):

    uv run python -m cairndex.devtools.seed --bundles 2000

Intended for local development and for exercising the Phase 3 browsing UI at
scale. It writes only synthetic metadata — never real media.
"""

import argparse

from cairndex.devtools.synthetic import seed_synthetic_library
from cairndex.persistence.engine import session_scope


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed a synthetic Cairndex library.")
    parser.add_argument("--bundles", type=int, default=500, help="number of bundles")
    parser.add_argument("--seed", type=int, default=42, help="RNG seed (deterministic)")
    args = parser.parse_args()

    with session_scope() as session:
        summary = seed_synthetic_library(session, n_bundles=args.bundles, seed=args.seed)

    print(
        f"Seeded {summary.bundles} bundles / {summary.files} files, "
        f"{summary.tags} tags in {summary.tag_groups} groups, "
        f"{summary.folders} folders (storage root {summary.storage_root_id})."
    )


if __name__ == "__main__":
    main()
