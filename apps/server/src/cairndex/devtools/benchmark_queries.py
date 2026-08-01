"""Benchmark the hot browse/query paths of a (synthetic) Cairndex library.

Opens a library's ``library.db`` directly and times the queries that power the
desktop browser — browse pages, collection/tag filters (incl. descendants),
Smart-Collection preview, the sidebar counts, and per-bundle reads — reporting
min/median/mean/max milliseconds over ``--iterations`` runs. With ``--explain``
it captures the actual SQL each path emits and prints SQLite ``EXPLAIN QUERY
PLAN`` output, so slow paths can be diagnosed before adding any index.

Read-only: it never writes to the library. Pair it with
``synthetic_library`` to measure at scale:

    uv run python -m cairndex.devtools.benchmark_queries \\
        --library-root /tmp/cairndex-synth --iterations 20 \\
        --json /tmp/cairndex-benchmark.json
"""

import argparse
import json
import statistics
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import Engine, event, func, select
from sqlalchemy.orm import Session

from cairndex.filters.ast import FilterExpression, PredicateNode
from cairndex.media.thumbnails import effective_cover_file
from cairndex.persistence.engine import library_engine_scope
from cairndex.persistence.models import AssetBundle, Collection, Tag
from cairndex.registry import library_package as pkg
from cairndex.services import browse as browse_service
from cairndex.services import bundles as bundle_service
from cairndex.services.collections import collection_descendant_ids
from cairndex.services.tags import tag_descendant_ids


@dataclass(frozen=True)
class BenchResult:
    name: str
    iterations: int
    min_ms: float
    median_ms: float
    mean_ms: float
    max_ms: float


def _time(label: str, fn: Callable[[], Any], iterations: int) -> BenchResult:
    samples: list[float] = []
    for _ in range(iterations):
        start = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - start) * 1000.0)
    return BenchResult(
        name=label,
        iterations=iterations,
        min_ms=round(min(samples), 3),
        median_ms=round(statistics.median(samples), 3),
        mean_ms=round(statistics.fmean(samples), 3),
        max_ms=round(max(samples), 3),
    )


def _busiest_collection(session: Session) -> str | None:
    """A root collection with the largest descendant subtree (for descendant
    filter timing); falls back to any collection."""
    roots = list(session.scalars(select(Collection.id).where(Collection.parent_id.is_(None))))
    if not roots:
        return session.scalar(select(Collection.id))
    return max(
        roots, key=lambda cid: len(collection_descendant_ids(session, cid, include_self=True))
    )


def _busiest_tag(session: Session) -> str | None:
    roots = list(session.scalars(select(Tag.id).where(Tag.parent_id.is_(None))))
    if not roots:
        return session.scalar(select(Tag.id))
    return max(roots, key=lambda tid: len(tag_descendant_ids(session, tid, include_self=True)))


def _tag_filter(tag_id: str, *, descendants: bool) -> FilterExpression:
    return FilterExpression(
        root=PredicateNode(
            field="tags", operator="contains_any", value=[tag_id], include_descendants=descendants
        )
    )


def _rating_filter() -> FilterExpression:
    # Stands in for a saved Smart Collection (a numeric predicate path).
    return FilterExpression(root=PredicateNode(field="rating", operator="gte", value=4))


def build_benchmarks(session: Session, total_bundles: int) -> list[tuple[str, Callable[[], Any]]]:
    """Wire each benchmark name to a thunk that runs it once."""
    collection_id = _busiest_collection(session)
    tag_id = _busiest_tag(session)
    deep_offset = max(0, total_bundles - 100)
    sample_bundle = session.scalar(select(AssetBundle.id))

    benches: list[tuple[str, Callable[[], Any]]] = [
        ("browse_first_page", lambda: browse_service.browse_bundles(session, offset=0, limit=100)),
        (
            "browse_deep_pagination",
            lambda: browse_service.browse_bundles(session, offset=deep_offset, limit=100),
        ),
        ("view_counts", lambda: browse_service.view_counts(session)),
        ("collection_counts", lambda: browse_service.collection_counts(session)),
        ("tag_counts", lambda: browse_service.tag_counts(session)),
        (
            "smart_collection_preview",
            lambda: browse_service.browse_bundles(session, filter_expr=_rating_filter(), limit=100),
        ),
    ]
    if collection_id is not None:
        benches += [
            (
                "collection_filter",
                lambda: browse_service.browse_bundles(
                    session, collection_id=collection_id, include_descendants=False, limit=100
                ),
            ),
            (
                "collection_descendant_filter",
                lambda: browse_service.browse_bundles(
                    session, collection_id=collection_id, include_descendants=True, limit=100
                ),
            ),
        ]
    if tag_id is not None:
        benches += [
            (
                "tag_filter",
                lambda: browse_service.browse_bundles(
                    session, filter_expr=_tag_filter(tag_id, descendants=False), limit=100
                ),
            ),
            (
                "tag_descendant_filter",
                lambda: browse_service.browse_bundles(
                    session, filter_expr=_tag_filter(tag_id, descendants=True), limit=100
                ),
            ),
        ]
    if sample_bundle is not None:
        benches += [
            ("bundle_detail_read", lambda: bundle_service.get_bundle(session, sample_bundle)),
            ("bundle_files_read", lambda: bundle_service.list_files(session, sample_bundle)),
            ("thumbnail_lookup", lambda: effective_cover_file(session, sample_bundle)),
        ]
    return benches


def explain_paths(
    engine: Engine, benches: list[tuple[str, Callable[[], Any]]]
) -> dict[str, list[str]]:
    """Capture every SELECT each benchmark emits, then EXPLAIN QUERY PLAN it.

    Uses a statement-capture listener so the plans reflect exactly what the
    service layer runs — no hand-reconstructed SQL to drift out of sync."""
    captured: list[tuple[str, Any]] = []

    def _capture(
        conn: Any, cursor: Any, statement: str, parameters: Any, context: Any, many: bool
    ) -> None:
        if not many and statement.lstrip()[:6].upper() == "SELECT":
            captured.append((statement, parameters))

    plans: dict[str, list[str]] = {}
    for name, fn in benches:
        captured.clear()
        event.listen(engine, "before_cursor_execute", _capture)
        try:
            fn()
        finally:
            event.remove(engine, "before_cursor_execute", _capture)
        seen: set[str] = set()
        lines: list[str] = []
        with engine.connect() as conn:
            raw = conn.connection.cursor()  # DBAPI cursor for EXPLAIN
            for statement, params in captured:
                if statement in seen:
                    continue
                seen.add(statement)
                try:
                    raw.execute(f"EXPLAIN QUERY PLAN {statement}", params or {})
                    plan = " | ".join(str(row[-1]) for row in raw.fetchall())
                except Exception as exc:  # noqa: BLE001 — diagnostic best-effort
                    plan = f"(could not explain: {exc})"
                lines.append(plan)
        plans[name] = lines
    return plans


def run(library_root: Path, *, iterations: int, explain: bool) -> dict[str, Any]:
    if pkg.detect(library_root) is None:
        raise SystemExit(f"no Cairndex library at {library_root}")
    with (
        library_engine_scope(f"sqlite:///{pkg.db_path(library_root).as_posix()}") as engine,
        Session(engine) as session,
    ):
        total = session.scalar(select(func.count()).select_from(AssetBundle)) or 0
        benches = build_benchmarks(session, total)
        results = [_time(name, fn, iterations) for name, fn in benches]
        plans = explain_paths(engine, benches) if explain else {}
    return {
        "library_root": str(library_root),
        "total_bundles": total,
        "iterations": iterations,
        "results": [asdict(r) for r in results],
        "query_plans": plans,
    }


def _print_table(report: dict[str, Any]) -> None:
    print(f"\nLibrary: {report['library_root']}  ({report['total_bundles']} bundles)")
    print(f"Iterations: {report['iterations']}\n")
    print(f"{'path':<32}{'min':>10}{'median':>10}{'mean':>10}{'max':>10}")
    print("-" * 72)
    for r in report["results"]:
        print(
            f"{r['name']:<32}{r['min_ms']:>10.2f}{r['median_ms']:>10.2f}"
            f"{r['mean_ms']:>10.2f}{r['max_ms']:>10.2f}"
        )
    if report["query_plans"]:
        print("\nQuery plans (EXPLAIN QUERY PLAN):")
        for name, lines in report["query_plans"].items():
            print(f"\n  {name}:")
            for line in lines:
                print(f"    {line}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark Cairndex browse/query paths.")
    parser.add_argument("--library-root", required=True)
    parser.add_argument("--iterations", type=int, default=20)
    parser.add_argument("--explain", action="store_true", help="also print EXPLAIN QUERY PLAN")
    parser.add_argument("--json", dest="json_path", help="write the full report to this JSON file")
    args = parser.parse_args()

    report = run(Path(args.library_root), iterations=args.iterations, explain=args.explain)
    _print_table(report)
    if args.json_path:
        Path(args.json_path).write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\nWrote {args.json_path}")


if __name__ == "__main__":
    main()
