"""CLI: create a library and seed it with synthetic metadata (ADR-0008).

Usage (from apps/server):

    uv run python -m cairndex.devtools.seed --root /tmp/vl-demo --bundles 2000

Creates a Cairndex library at ``--root`` (``.cairndex/`` package + registry
row), then seeds synthetic metadata into its ``library.db``. Writes only
synthetic metadata — never real media. Intended for local development and for
exercising the browsing UI at scale.
"""

import argparse
from pathlib import Path

from cairndex.devtools.synthetic import seed_synthetic_library
from cairndex.registry import services as registry_service
from cairndex.registry.engine import registry_session_scope
from cairndex.registry.library_engine import get_library_sessionmaker


def main() -> None:
    parser = argparse.ArgumentParser(description="Create and seed a synthetic Cairndex library.")
    parser.add_argument("--root", required=True, help="absolute path for the new library root")
    parser.add_argument("--name", default="Demo Library", help="library display name")
    parser.add_argument("--bundles", type=int, default=500, help="number of bundles")
    parser.add_argument("--seed", type=int, default=42, help="RNG seed (deterministic)")
    args = parser.parse_args()

    with registry_session_scope() as registry:
        library = registry_service.create_library(
            registry,
            root_path=str(Path(args.root)),
            display_name=args.name,
            create_if_missing=True,
        )
        library_id = library.id
        maker = get_library_sessionmaker(library)

    with maker() as session:
        summary = seed_synthetic_library(session, n_bundles=args.bundles, seed=args.seed)
        session.commit()

    print(
        f"Seeded {summary.bundles} bundles / {summary.files} files, "
        f"{summary.tags} tags in {summary.tag_groups} groups, "
        f"{summary.collections} collections into library {library_id} at {args.root}."
    )


if __name__ == "__main__":
    main()
