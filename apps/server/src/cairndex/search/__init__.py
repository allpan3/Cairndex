"""Per-library full-text metadata search (SQLite FTS5).

Each library DB carries a contentless-ish FTS5 table ``bundle_search`` that
indexes, per bundle, its title/note plus the aggregated text of its files
(display title, original filename, relative path, source, media kind), tag
names, and collection names. Search covers the *whole* active library, not just
the loaded browse window.

Freshness is maintained by SQLite triggers over the underlying tables (bundles,
files, the tag/collection association tables, and tag/collection renames), so
every write path — interactive edits, scan, moved-file repair, grouping apply,
deletion — keeps the index current with no application plumbing. A one-shot
``rebuild`` repopulates from scratch (initial fill and drift recovery).
"""

from cairndex.search.index import (
    ensure_search_schema,
    matching_ids_select,
    rebuild,
    search_predicate,
    to_match_query,
)

__all__ = [
    "ensure_search_schema",
    "matching_ids_select",
    "rebuild",
    "search_predicate",
    "to_match_query",
]
