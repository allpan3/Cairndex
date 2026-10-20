"""One private file queue over retained staging and the last completed discovery."""

import sqlite3

# A running/cancelled pass never replaces the last complete observation. Current
# catalog paths exclude accepted files, replacements and repaired identities.
LATEST_RUN = (
    "(SELECT id FROM discovery_runs WHERE state='succeeded' ORDER BY sequence DESC LIMIT 1)"
)
FRESH_WHERE = (
    f"d.run={LATEST_RUN} AND d.owner IS NULL AND d.body<>'{{}}' "
    "AND NOT EXISTS (SELECT 1 FROM catalog_paths p WHERE p.family='asset_files' AND p.path=d.path)"
)
QUEUE = (
    "WITH unbundled_sources AS ("
    "SELECT f.entity AS id,b.entity AS bundle_id,p.path AS relative_path "
    "FROM catalog_rows f JOIN catalog_rows b ON b.family='asset_bundles' "
    "AND b.entity=json_extract(f.body,'$.bundle_id') JOIN catalog_paths p "
    "ON p.family='asset_files' AND p.entity=f.entity WHERE f.family='asset_files' "
    "AND json_extract(b.body,'$.grouping_state')='PROVISIONAL' "
    "AND json_extract(b.body,'$.grouping_source')='SCAN_SUGGESTION' UNION ALL "
    "SELECT NULL,NULL,d.path FROM discovery_plan_files d WHERE " + FRESH_WHERE + ") "
)


def latest_run(db: sqlite3.Connection) -> str | None:
    value = db.execute("SELECT " + LATEST_RUN).fetchone()[0]
    return str(value) if value is not None else None
