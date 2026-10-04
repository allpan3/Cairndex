"""Private layouts retained by catalog conversion and recovery.

Workflow implementations are separate from the storage compatibility contract.
"""

MEDIA_SCHEMA = """
CREATE TABLE IF NOT EXISTS local_media (
    file_id TEXT PRIMARY KEY, generation TEXT, state TEXT NOT NULL,
    metadata TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS local_progress (
    file_id TEXT PRIMARY KEY, generation TEXT NOT NULL, position REAL NOT NULL,
    duration REAL, completed INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS local_cursors (bundle_id TEXT PRIMARY KEY, file_id TEXT NOT NULL);
"""

DISCOVERY_SCHEMA = """
CREATE INDEX IF NOT EXISTS discovery_path_claim ON catalog_revisions(value,active,unit);
CREATE TABLE IF NOT EXISTS discovery_runs (
    id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, state TEXT NOT NULL,
    phase TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '', observed INTEGER NOT NULL DEFAULT 0,
    repaired INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE IF NOT EXISTS discovery_entries (
    run TEXT NOT NULL REFERENCES discovery_runs(id), path TEXT NOT NULL, parent TEXT NOT NULL,
    body TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(run,path));
CREATE INDEX IF NOT EXISTS discovery_entry_pending ON discovery_entries(run,handled,path);
CREATE INDEX IF NOT EXISTS discovery_entry_parent ON discovery_entries(run,parent,path);
CREATE INDEX IF NOT EXISTS discovery_entry_evidence ON
discovery_entries(run,json_extract(body,'$.evidence.digest'));
CREATE TABLE IF NOT EXISTS discovery_missing (
    run TEXT NOT NULL REFERENCES discovery_runs(id), file_id TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(run,file_id));
CREATE INDEX IF NOT EXISTS discovery_missing_evidence ON
discovery_missing(run,json_extract(body,'$.evidence.digest'));
CREATE TABLE IF NOT EXISTS discovery_baselines (
    file_id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS discovery_baseline_path ON
discovery_baselines(json_extract(body,'$.path'));
CREATE TABLE IF NOT EXISTS discovery_identities (
    path TEXT NOT NULL, evidence TEXT NOT NULL, file_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY(path,evidence));
CREATE TABLE IF NOT EXISTS discovery_candidates (
    id TEXT PRIMARY KEY, run TEXT NOT NULL REFERENCES discovery_runs(id), path TEXT NOT NULL,
    body TEXT NOT NULL, state TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS discovery_candidate_state ON
discovery_candidates(state,path,id);
CREATE TABLE IF NOT EXISTS discovery_reviews (
    id TEXT PRIMARY KEY, intent TEXT NOT NULL, state TEXT NOT NULL, prepared TEXT,
    error TEXT, event TEXT);

CREATE TABLE IF NOT EXISTS discovery_verifications (
    id TEXT PRIMARY KEY, candidate TEXT NOT NULL REFERENCES discovery_candidates(id),
    state TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS discovery_hash_files (
    operation TEXT NOT NULL REFERENCES discovery_verifications(id), path TEXT NOT NULL,
    original TEXT NOT NULL, state TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0,
    evidence TEXT, PRIMARY KEY(operation,path));
CREATE TABLE IF NOT EXISTS discovery_verified (
    path TEXT NOT NULL, generation TEXT NOT NULL, evidence TEXT NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(path,generation));

CREATE TABLE IF NOT EXISTS discovery_plan_files (
    run TEXT NOT NULL, path TEXT NOT NULL, directory TEXT NOT NULL, body TEXT NOT NULL,
    file_id TEXT NOT NULL, kind TEXT NOT NULL, rank INTEGER NOT NULL, natural BLOB NOT NULL,
    stem TEXT NOT NULL, prefix TEXT NOT NULL, part TEXT, owner TEXT, owner_title TEXT,
    proposal TEXT, role TEXT, sequence INTEGER, PRIMARY KEY(run,path));
CREATE INDEX IF NOT EXISTS discovery_plan_directory ON
discovery_plan_files(run,directory,owner,kind,stem);
CREATE INDEX IF NOT EXISTS discovery_plan_group ON
discovery_plan_files(run,proposal,rank,natural,path);
CREATE TABLE IF NOT EXISTS discovery_plan_directories (
    run TEXT NOT NULL, path TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'videos',
    cursor TEXT NOT NULL DEFAULT '', PRIMARY KEY(run,path));
CREATE TABLE IF NOT EXISTS discovery_plan_groups (
    run TEXT NOT NULL, id TEXT NOT NULL, directory TEXT NOT NULL, parent TEXT,
    title TEXT NOT NULL DEFAULT '', target TEXT, kind TEXT NOT NULL DEFAULT 'bundle',
    folder INTEGER NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT 'match',
    cursor INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(run,id));
CREATE INDEX IF NOT EXISTS discovery_plan_group_directory ON
discovery_plan_groups(run,directory,kind,stage);
CREATE TABLE IF NOT EXISTS discovery_plan_folders (
    run TEXT NOT NULL, proposal TEXT NOT NULL, path TEXT NOT NULL,
    PRIMARY KEY(run,proposal,path));

CREATE TABLE IF NOT EXISTS discovery_candidate_groups (
    candidate TEXT NOT NULL REFERENCES discovery_candidates(id), id TEXT NOT NULL,
    body TEXT NOT NULL, PRIMARY KEY(candidate,id));
CREATE TABLE IF NOT EXISTS discovery_candidate_files (
    candidate TEXT NOT NULL REFERENCES discovery_candidates(id), position INTEGER NOT NULL,
    group_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(candidate,position));
CREATE INDEX IF NOT EXISTS discovery_candidate_file_group ON
discovery_candidate_files(candidate,group_id,position);
CREATE TABLE IF NOT EXISTS discovery_candidate_choices (
    candidate TEXT NOT NULL REFERENCES discovery_candidates(id), file_id TEXT NOT NULL,
    body TEXT NOT NULL, PRIMARY KEY(candidate,file_id));

CREATE TABLE IF NOT EXISTS discovery_review_work (
    operation TEXT PRIMARY KEY REFERENCES discovery_reviews(id), phase TEXT NOT NULL,
    cursor INTEGER NOT NULL DEFAULT 0, parents TEXT NOT NULL, total INTEGER NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0, header TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS discovery_review_files (
    operation TEXT NOT NULL REFERENCES discovery_reviews(id), position INTEGER NOT NULL,
    group_id TEXT NOT NULL, original TEXT NOT NULL, body TEXT, sort_order INTEGER NOT NULL,
    PRIMARY KEY(operation,position));
CREATE INDEX IF NOT EXISTS discovery_review_file_group ON
discovery_review_files(operation,group_id,position);
CREATE INDEX IF NOT EXISTS discovery_review_file_order ON
discovery_review_files(operation,sort_order,position);
CREATE TABLE IF NOT EXISTS discovery_review_groups (
    operation TEXT NOT NULL REFERENCES discovery_reviews(id), id TEXT NOT NULL,
    body TEXT NOT NULL, target TEXT, state TEXT NOT NULL DEFAULT 'queued',
    cursor INTEGER NOT NULL DEFAULT -1,
    PRIMARY KEY(operation,id));
CREATE TABLE IF NOT EXISTS discovery_review_values (
    operation TEXT NOT NULL REFERENCES discovery_reviews(id), unit TEXT NOT NULL,
    value TEXT NOT NULL, basis TEXT NOT NULL, cohort TEXT,
    PRIMARY KEY(operation,unit));
CREATE TABLE IF NOT EXISTS discovery_review_members (
    operation TEXT NOT NULL REFERENCES discovery_reviews(id), bundle TEXT NOT NULL,
    family TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, sequence INTEGER NOT NULL,
    PRIMARY KEY(operation,bundle,family,id));
CREATE TABLE IF NOT EXISTS discovery_review_forest (
    operation TEXT NOT NULL REFERENCES discovery_reviews(id), id TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(operation,id));
CREATE TABLE IF NOT EXISTS discovery_review_arrangements (
    operation TEXT NOT NULL REFERENCES discovery_reviews(id), unit TEXT NOT NULL,
    PRIMARY KEY(operation,unit));
CREATE TABLE IF NOT EXISTS discovery_review_parts (
    operation TEXT NOT NULL REFERENCES discovery_reviews(id), sequence INTEGER NOT NULL,
    id TEXT NOT NULL, raw BLOB NOT NULL, PRIMARY KEY(operation,sequence));
CREATE TABLE IF NOT EXISTS discovery_review_done (
    operation TEXT NOT NULL REFERENCES discovery_reviews(id), position INTEGER NOT NULL,
    PRIMARY KEY(operation,position));
CREATE TABLE IF NOT EXISTS discovery_review_commit (
    operation TEXT PRIMARY KEY REFERENCES discovery_reviews(id), intent TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS discovery_accepted_files (
    path TEXT NOT NULL, generation TEXT NOT NULL, file_id TEXT NOT NULL, event TEXT NOT NULL,
    PRIMARY KEY(path,generation));
"""

SOURCE_SCHEMA = """
CREATE TABLE IF NOT EXISTS source_operations (
    id TEXT PRIMARY KEY, intent TEXT NOT NULL, state TEXT NOT NULL,
    review TEXT, result TEXT, phase TEXT NOT NULL, progress INTEGER NOT NULL,
    error TEXT, sequence INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS source_operation_state ON source_operations(state,sequence);
CREATE UNIQUE INDEX IF NOT EXISTS source_operation_sequence ON source_operations(sequence);
CREATE TABLE IF NOT EXISTS source_receipts (
    id TEXT PRIMARY KEY, raw TEXT NOT NULL, state TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS source_uploads (
    id TEXT PRIMARY KEY, size INTEGER NOT NULL, state TEXT NOT NULL, evidence TEXT);
"""

DISCOVERY_TABLES = {
    "discovery_verified",
    "discovery_baseline_path",
    "discovery_verifications",
    "discovery_plan_group_directory",
    "discovery_missing",
    "discovery_review_work",
    "discovery_review_done",
    "discovery_runs",
    "discovery_candidate_files",
    "discovery_accepted_files",
    "discovery_candidate_groups",
    "discovery_review_forest",
    "discovery_review_commit",
    "discovery_entry_pending",
    "discovery_hash_files",
    "discovery_candidate_choices",
    "discovery_plan_groups",
    "discovery_plan_folders",
    "discovery_review_files",
    "discovery_identities",
    "discovery_review_parts",
    "discovery_entry_evidence",
    "discovery_reviews",
    "discovery_candidates",
    "discovery_missing_evidence",
    "discovery_review_values",
    "discovery_plan_files",
    "discovery_baselines",
    "discovery_entries",
    "discovery_review_file_order",
    "discovery_review_members",
    "discovery_candidate_file_group",
    "discovery_review_file_group",
    "discovery_path_claim",
    "discovery_plan_group",
    "discovery_review_arrangements",
    "discovery_review_groups",
    "discovery_plan_directory",
    "discovery_candidate_state",
    "discovery_plan_directories",
    "discovery_entry_parent",
}

PLAN_TABLES = {
    "discovery_plan_groups",
    "discovery_plan_folders",
    "discovery_plan_group",
    "discovery_plan_files",
    "discovery_plan_group_directory",
    "discovery_plan_directory",
    "discovery_plan_directories",
}

PREVIEW_TABLES = {
    "discovery_review_files",
    "discovery_review_values",
    "discovery_review_arrangements",
    "discovery_review_done",
    "discovery_review_parts",
    "discovery_accepted_files",
    "discovery_review_file_order",
    "discovery_review_forest",
    "discovery_review_commit",
    "discovery_review_file_group",
    "discovery_review_groups",
    "discovery_review_members",
    "discovery_review_work",
}

PROPOSAL_TABLES = {
    "discovery_candidate_files",
    "discovery_candidate_choices",
    "discovery_candidate_file_group",
    "discovery_candidate_groups",
}

VERIFICATION_TABLES = {"discovery_verifications", "discovery_verified", "discovery_hash_files"}

SOURCE_TABLES = {
    "source_uploads",
    "source_operation_state",
    "source_operations",
    "source_receipts",
    "source_operation_sequence",
}

BASE_TABLES = {
    "discovery_path_claim",
    "discovery_missing_evidence",
    "discovery_baseline_path",
    "discovery_entry_pending",
    "discovery_missing",
    "discovery_baselines",
    "discovery_identities",
    "discovery_reviews",
    "discovery_runs",
    "discovery_entries",
    "discovery_entry_evidence",
    "discovery_candidate_state",
    "discovery_entry_parent",
    "discovery_candidates",
}
