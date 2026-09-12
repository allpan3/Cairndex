"""Per-library FTS5 search over bundle names, bundle/file notes and moment comments

Triggers maintain the derived index across edits, membership changes and deletion.
Versioned upgrades and explicit rebuilds use bounded batches in one transaction.
Names of files, paths, tags and collections are not free-text search fields.
"""

from cairndex.search.index import (
    FTS_TABLE,
    drop_maintenance_triggers,
    ensure_search_schema,
    matching_ids_select,
    rebuild,
    search_predicate,
    to_match_query,
)

__all__ = [
    "FTS_TABLE",
    "drop_maintenance_triggers",
    "ensure_search_schema",
    "matching_ids_select",
    "rebuild",
    "search_predicate",
    "to_match_query",
]
