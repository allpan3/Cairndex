"""One private file queue over retained staging and the last completed discovery."""

import sqlite3

# A running/cancelled pass never replaces the last complete observation. Current
# catalog paths exclude accepted files, replacements and repaired identities.
# Both directory columns are the path's parent; matching them uses catalog_path_parent
# instead of scanning every catalog path for each observed file.
LATEST_RUN = (
    "(SELECT id FROM discovery_runs WHERE state='succeeded' ORDER BY sequence DESC LIMIT 1)"
)
FRESH_WHERE = (
    f"d.run={LATEST_RUN} AND d.owner IS NULL AND d.body<>'{{}}' "
    "AND NOT EXISTS (SELECT 1 FROM catalog_paths p WHERE p.parent=d.directory "
    "AND p.path=d.path AND p.family='asset_files')"
)
# Sort facts come from stored observations only (ADR-0040): a staged file's last
# path-matched local fact, or the discovery observation of a fresh one. Times are
# Unix seconds; a fact this instance does not have is NULL and sorts last.
QUEUE = (
    "WITH unbundled_sources AS ("
    "SELECT f.entity AS id,b.entity AS bundle_id,p.path AS relative_path,"
    "s.size AS size,(julianday(s.modified_at)-2440587.5)*86400 AS modified,"
    "(julianday(json_extract(f.body,'$.created_at'))-2440587.5)*86400 AS added "
    "FROM catalog_rows f JOIN catalog_rows b ON b.family='asset_bundles' "
    "AND b.entity=json_extract(f.body,'$.bundle_id') JOIN catalog_paths p "
    "ON p.family='asset_files' AND p.entity=f.entity "
    "LEFT JOIN local_file_facts s ON s.file_id=f.entity AND s.path=p.path "
    "WHERE f.family='asset_files' "
    "AND json_extract(b.body,'$.grouping_state')='PROVISIONAL' "
    "AND json_extract(b.body,'$.grouping_source')='SCAN_SUGGESTION' UNION ALL "
    "SELECT NULL,NULL,d.path,json_extract(d.body,'$.evidence.size'),"
    "json_extract(d.body,'$.mtime')/1e9,NULL FROM discovery_plan_files d WHERE "
    + FRESH_WHERE
    + ") "
)
# The file name and extension, as the legacy queue sorted them
NAME = "replace(relative_path,rtrim(relative_path,replace(relative_path,'/','')),'')"
EXTENSION = (
    f"CASE WHEN instr({NAME},'.')>0 THEN lower(replace({NAME},"
    f"rtrim({NAME},replace({NAME},'.','')),'')) ELSE '' END"
)
SORTS = {
    "name": None,
    "type": EXTENSION,
    "size": "size",
    "added": "added",
    "modified": "modified",
}


def order_by(sort: str | None, order: str) -> str:
    """The whole queue's order, applied before a page is taken; path is unique."""
    if sort is None:
        return "lower(relative_path),relative_path"
    direction = "DESC" if order == "desc" else "ASC"
    column = SORTS[sort]
    if column is None:
        return f"lower({NAME}) {direction},lower(relative_path),relative_path"
    # Equal values keep name order in either direction, as the legacy queue did
    ties = f"lower({NAME}),lower(relative_path),relative_path"
    unknown = f"({column}) IS NULL," if sort in {"size", "added", "modified"} else ""
    return f"{unknown}{column} {direction},{ties}"


def latest_run(db: sqlite3.Connection) -> str | None:
    value = db.execute("SELECT " + LATEST_RUN).fetchone()[0]
    return str(value) if value is not None else None
