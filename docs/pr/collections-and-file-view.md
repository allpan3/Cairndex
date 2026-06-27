# Refactor: Collections + read-only File View

Branch: `feat/collections-and-file-view` (from `main`).

This is a terminology + model + API + UI + scanner + docs refactor that splits
browsing into two surfaces — a logical, bundle-first **Collection View** (the
old "folder" concept, renamed) and a physical, storage-root-scoped read-only
**File View** — and teaches the scanner to repair high-confidence moved files
while preserving `AssetFile.id`.

## Phase 0 — orientation note

### Where `folder` exists today

The logical-folder concept is implemented end to end and must be renamed to
**collection**. Occurrences (the rename surface):

- **DB / ORM** (`persistence/models.py`): `Folder` model (`folders` table),
  `asset_bundle_folders` association, `AssetBundle.folders`, FK `folder_id`.
  Tested by `create_all` in `conftest.py`; the migration itself is exercised by
  `tests/test_migrations.py` (`EXPECTED_TABLES`).
- **Services**: `services/folders.py` (whole module), `services/bundles.py`
  (`set_bundle_folders`, `_resolve_all` over `Folder`, batch add/remove folder
  ids), `services/browse.py` (`folder_id` scoping, `folder_counts`,
  `SystemView.UNCATEGORIZED` = "in no folder"), `services/hierarchy.py`
  (`HierarchyModel = Tag | Folder`).
- **Filters** (`filters/ast.py`, `filters/compiler.py`): the `folders` filter
  field + descendant expansion over `Folder`.
- **API** (`api/v1/folders.py`, `api/v1/router.py`, `api/v1/bundles.py`
  `/bundles/{id}/folders`, `api/v1/filters.py`/`schemas/filters.py`
  `folder_id`): `/api/v1/folders`, `/folders/counts`, `BundleFolders`,
  `FolderCreate/Update/Read`, `BrowseRequest.folder_id`.
- **Frontend** (`apps/web/src`): `FolderPicker.tsx`, `useFolders`,
  `useFolderCounts`, `useBundleFolders`, `useSetBundleFolders`, `folderId`,
  `smartFolderId`, "Folders"/"Smart Folders" labels, generated
  `api/schema.d.ts` + `api/openapi.json`.

### Keep `folder` (do NOT rename)

- **Eagle's external folder concept**: `eagle/reader.py`, `eagle/planner.py`,
  `services/eagle.py`, `schemas/eagle.py` — these mirror Eagle's own data model.
  (Eagle folders are imported *into* Cairndex collections; the import target
  terminology becomes "collection", but Eagle-side fields stay "folder".)
- **`SmartFolder` → `SmartCollection`** *is* renamed (it is our logical concept).
- Ordinary filesystem directories in the new File View are "folders/directories".

### Route rename: breaking, no aliases

Per the brief this is an early private app: prefer a clean breaking rename of
`/folders` → `/collections` (and nested `/bundles/{id}/folders`) with no
compatibility aliases. The frontend is regenerated from OpenAPI in lockstep.

### Migration risks

- SQLite has no native `RENAME` for some constraints; use Alembic **batch**
  operations (the project already relies on batch + a deterministic
  `NAMING_CONVENTION`). Rename tables `folders`→`collections`,
  `asset_bundle_folders`→`asset_bundle_collections`, and column
  `folder_id`→`collection_id`, recreating FK/PK/unique names to match the
  convention. Data (hierarchy, memberships) is preserved by `batch_alter_table`
  table-copy semantics; **no physical files are touched**.
- `tests/test_migrations.py::EXPECTED_TABLES` and the downgrade test must be
  updated to the new table names.

### Affected docs (per phase)

`docs/data-model.md`, `docs/architecture.md`, `docs/filter-language.md`,
`docs/STATUS.md`, `CHANGELOG.md`, new ADRs (collection rename if consequential;
File View read-only API; scanner identity/repair), generated
`openapi.json`/`schema.d.ts`, README/deployment if setup changes.

### Test plan

Backend `uv run ruff check . && ruff format --check . && mypy . && pytest`;
frontend `npm run typecheck && lint && test` + Playwright; migration
upgrade/downgrade smoke test. Per phase, add: collection CRUD/hierarchy/
membership, collection filter + Smart Collection preview, File View listing/
traversal/hidden/symlink tests, scanner moved-file repair tests.

### Phase / commit plan

1. `refactor: rename folder model to collection` (DB/ORM + migration).
2. `refactor: expose collections in api and filters` (+ regen OpenAPI).
3. `refactor: rename frontend folders to collections`.
4. `feat: add read-only storage root file view api`.
5. `feat: add read-only file view ui`.
6. `feat: repair moved files during scans`.
7. `docs: plan file view host integration` (docs/ADR only).
8. `chore: final collections/file-view consistency + docs audit`.

## Documentation updated

(Per phase — filled in as phases land.)
