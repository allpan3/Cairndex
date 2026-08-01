"""CLI: rebuild one library's full-text search index from scratch.

The FTS index is normally kept fresh by triggers, but this repopulates it from
current rows — useful after a bulk external change, a schema upgrade, or to
recover from drift. Selects the library by root path or by registry id.

Usage (from apps/server):

    uv run python -m cairndex.devtools.reindex_search --library-root /path/to/lib
    uv run python -m cairndex.devtools.reindex_search --library-id <registry-id>
"""

import argparse
from pathlib import Path

from sqlalchemy.orm import Session

from cairndex.persistence.engine import library_engine_scope
from cairndex.registry import library_package as pkg
from cairndex.registry import services as registry_service
from cairndex.registry.engine import registry_session_scope
from cairndex.search import ensure_search_schema, rebuild


def _root_from_args(args: argparse.Namespace) -> Path:
    if args.library_root:
        return Path(args.library_root)
    with registry_session_scope() as registry:
        library = registry_service.get_library(registry, args.library_id)
        return Path(library.root_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Rebuild a library's FTS search index.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--library-root", help="path to the library root directory")
    group.add_argument("--library-id", help="registry id of the library")
    args = parser.parse_args()

    root = _root_from_args(args)
    if pkg.detect(root) is None:
        raise SystemExit(f"no Cairndex library at {root}")

    with library_engine_scope(f"sqlite:///{pkg.db_path(root).as_posix()}") as engine:
        ensure_search_schema(engine)
        with Session(engine) as session:
            count = rebuild(session)
            session.commit()
    print(f"Rebuilt search index for {root}: {count} bundles indexed.")


if __name__ == "__main__":
    main()
