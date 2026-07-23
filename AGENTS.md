# AGENTS.md

This file is the canonical operating guide for coding agents working in this repository. It defines how agents should plan, modify, test, document, and report work.

Product context lives in [`docs/product-brief.md`](docs/product-brief.md). Current project state lives in [`docs/STATUS.md`](docs/STATUS.md). Consequential architecture decisions live in [`docs/adr/`](docs/adr/).

If another agent-specific file conflicts with this file, `AGENTS.md` wins.

## Required reading before changes

Before planning or modifying code, read:

1. `AGENTS.md`
2. `README.md`
3. `docs/STATUS.md`
4. `docs/product-brief.md`
5. relevant ADRs under `docs/adr/`
6. relevant architecture, data-model, deployment, development, and filter docs
7. `CHANGELOG.md`
8. the code and tests in the area being changed

Do not rely on stale summaries when the repo contains a more recent source of truth.

## Source-of-truth order

Use this order when documents disagree:

1. explicit product-owner instruction in the current task
2. accepted ADRs
3. `docs/STATUS.md` for current implementation state and known deviations
4. `docs/product-brief.md` for product model and direction
5. `AGENTS.md` for agent workflow and engineering rules
6. README and other topic docs
7. code, tests, migrations, and generated API artifacts as evidence of current behavior

When implementation and docs disagree, do not silently pick one. Either correct the stale document/code in the same change or record the accepted deviation in `docs/STATUS.md` or a new ADR.

## Core product constraints agents must preserve

These are repeated here because violating them can corrupt user data or derail the product model:

- Cairndex is local-first, single-owner-first, and metadata-first.
- The primary user-facing object in Bundle Browser is an Asset Bundle, not a file.
- Collections are logical groupings; collection membership must never move files on disk.
- File Browser is scoped to the active library root and must never become an unrestricted server filesystem browser.
- Existing source media must not be renamed, moved, overwritten, or deleted during metadata-only milestones.
- A Cairndex library is a root directory with `.cairndex/{manifest.json,library.db,cache/}`; content metadata belongs in the library DB, while the server registry is runtime state.
- Store file locations as library-relative paths. Do not reintroduce content `storage_roots` or `asset_files.storage_root_id` without a new ADR.
- Preserve `AssetFile.id` during moved-file repair so bundle membership, covers, subtitles, notes, ratings, and cache identity survive path changes.
- Eagle import/synchronization is removed from the current product path. Eagle remains a UI/interaction reference only.
- Do not add destructive file management, open-with-default-app, or reveal-in-file-manager through arbitrary server-side command execution.

For the full product model, read `docs/product-brief.md`.

## Implementation stack and dependency rules

Use the existing stack unless an ADR or explicit owner instruction changes it:

- Backend: Python 3.12+, FastAPI, SQLAlchemy 2.x, SQLite/WAL, ffmpeg/ffprobe, database-backed jobs.
- Frontend: React, TypeScript strict mode, Vite, TanStack Query, TanStack Virtual, Playwright for e2e tests.
- Desktop: Tauri 2 with a Rust host over the shared `apps/web` build; use cross-platform plugins and keep target-OS conditionals isolated.
- Repository layout: keep the current monorepo shape under `apps/server`, `apps/web`, `apps/desktop`, `docs`, and `infra`.

Do not introduce Redis, Celery, Postgres, Elasticsearch, a separate search service, a new frontend state framework, or other major infrastructure without demonstrated need and an ADR.

Prefer simple, measurable improvements before complex infrastructure. Profile representative workloads before adding performance-oriented dependencies.

## API and data-safety rules

- Version public endpoints under `/api/v1`.
- Content endpoints must be library-scoped under `/api/v1/libraries/{library_id}/...`.
- Use stable IDs rather than paths as resource identifiers where possible.
- Keep path resolution server-side.
- Never trust client-supplied absolute paths.
- File Browser endpoints must accept only library-relative paths and must reject absolute paths, traversal, and symlink escapes.
- Paginate all list endpoints.
- Support deterministic sorting with a stable tie-breaker.
- Return structured errors.
- Validate filter expressions against an allowlist of fields/operators.
- Separate metadata removal from physical file deletion.
- Make long-running operations asynchronous jobs with status endpoints.
- Publish and validate OpenAPI when backend contracts change.
- Regenerate frontend API types after API/schema changes.

## Performance and reliability rules

Design for multi-terabyte libraries, network-mounted storage, large files, and large item counts.

Required practices:

- no full-library scans in HTTP request handlers;
- no full hashing of multi-gigabyte files on hot paths;
- lazy full hashing only for duplicate verification, ambiguous repair, or explicit integrity work;
- incremental scans and batched database writes;
- moved-file repair before creating duplicate replacement bundles;
- bounded worker concurrency;
- resumable/cancellable jobs where practical;
- progress reporting for long-running jobs;
- no unbounded in-memory collection of scan results;
- virtualized large UI lists/grids;
- complete server-side or indexed search/filtering rather than filtering only the loaded client window;
- relational indexes and FTS/search indexes justified by real query paths;
- thumbnail and derived-media caches under `.cairndex/cache/`, ignored by scan;
- graceful handling of unavailable NAS mounts;
- backups of registry and library databases.

Record performance baselines for representative libraries before claiming large-library readiness.

## Security and privacy rules

- Treat all source media and metadata as user-owned private data.
- Never upload media or metadata to external services unless explicitly enabled by the owner.
- Do not add analytics or telemetry by default.
- Do not log notes, URLs, filenames, or paths unnecessarily.
- Never commit secrets, databases, thumbnails, generated caches, or source media.
- Use a non-root container user where practical.
- Validate all file paths against the active library root.
- Do not expose arbitrary host command execution.
- Preserve the single-owner model unless the owner explicitly requests multi-user work.
- Optional owner passphrase lock is acceptable as a lightweight access guard; full multi-user RBAC is not an MVP goal.
- Clearly document that direct public internet exposure is unsupported unless hardened separately.

## Code quality standards

- Use clear module boundaries.
- Avoid god files and god services.
- Separate API routes, schemas, persistence, domain services, scan logic, media processing, grouping, registry jobs, and path handling.
- Keep business logic out of UI components and HTTP route functions.
- Use type checking in both backend and frontend.
- Document public interfaces and non-obvious invariants.
- Comments should explain why, edge cases, and safety constraints; do not narrate obvious code.
- Prefer small composable functions and explicit error handling.
- Avoid speculative abstractions.
- Do not add dependencies without documenting the reason and maintenance cost.
- Keep generated files clearly marked and reproducible.

## Testing expectations

Add tests with every non-trivial feature.

Minimum coverage areas:

- library-root path normalization and traversal rejection;
- File Browser path scoping, hidden-file exclusion, and symlink escape rejection;
- asset bundle/file relationships;
- tag hierarchy and descendant behavior;
- tag group many-to-many behavior;
- collection hierarchy and descendant behavior;
- collection membership preserving bundle metadata;
- filter AST validation and SQL compilation;
- Smart Collection preview counts;
- scanner idempotency and missing-file behavior;
- automatic high-confidence moved-file repair preserving `AssetFile.id`;
- quick fingerprint/full-hash transitions;
- subtitle matching and track selection;
- range requests and playback headers;
- thumbnail job deduplication;
- grouping apply conflicts and selected-accept behavior;
- metadata-only deletion safeguards;
- critical UI flows with Playwright.

Tests must not depend on user media. Generate small synthetic fixtures or use redistributable test assets.

## Gate usage

Run the smallest useful gate while developing, then the full relevant gate before reporting completion.

Backend gates, from `apps/server`:

```bash
uv run ruff check
uv run ruff format --check
uv run mypy src packaging
uv run pytest
```

Frontend gates, from `apps/web`:

```bash
npm run lint
npm run format:check
npm run typecheck
npm run test
npm run build
```

Desktop gates, from `apps/desktop/src-tauri` unless noted:

```bash
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cd ..
npm run tauri build
```

Desktop changes must keep both the macOS build job and Ubuntu Rust-only job green. Do not add direct AppKit, `NSWorkspace`, or other target-native APIs without a new accepted ADR; any required `#[cfg(target_os = "…")]` code belongs in one clearly named host module.

Run Playwright/e2e tests for user-visible flows, routing changes, dialogs, keyboard interactions, context menus, playback, or anything likely to regress in a browser.

Run Docker/build/deployment checks when changing `infra/`, Dockerfiles, compose files, production settings, static serving, backup scripts, or deployment docs.

Do not claim a gate passed unless it was actually run. If a gate was skipped, say why.

## Git and branch workflow

Keep `main` stable and reviewable.

Use a dedicated branch for each meaningful feature or fix unless the owner explicitly asks for a direct-to-main documentation or maintenance commit.

Do not combine unrelated large features in one branch.

Commit frequently at meaningful checkpoints. Commits should be small enough to review and should normally leave the branch buildable. Use descriptive conventional-style messages when practical. Do not create meaningless `update` or `changes` commits.

Every PR should include problem and scope, design summary, screenshots/video for UI changes, migration notes, tests run and results, performance/safety considerations, changelog entry, documentation updated, and follow-up work explicitly out of scope.

Never force-push `main`. Force-push only non-main branches and use `--force-with-lease`.

**Releasing is owner-triggered, like opening a PR.** Do not create or push a `v*` tag unless the owner asks for one: the tag is what builds and publishes artifacts to other people, and it spends billed macOS CI minutes. Never move or delete a tag that has a **published** release — downloaded checksums would stop matching; ship a new version instead. The full procedure, including pre-tag version bumps and how to back out a draft, is in [`docs/deployment.md`](docs/deployment.md) under *Cutting a release*.

## Documentation discipline

Documentation is part of implementation, not an optional cleanup step.

For every meaningful phase or commit, ask which docs are affected before moving on. If behavior, schema, API, routes, filters, UI, deployment, operations, or product decisions change, update the relevant docs in the same branch and preferably the same commit slice.

Required documentation targets include, as applicable:

- `README.md`
- `docs/product-brief.md`
- `docs/architecture.md`
- `docs/development.md`
- `docs/deployment.md`
- `docs/data-model.md`
- `docs/filter-language.md`
- `docs/adr/` for consequential decisions
- `docs/STATUS.md`
- `CHANGELOG.md`
- generated OpenAPI/frontend API artifacts when backend contracts change

Maintain `CHANGELOG.md` using an `Unreleased` section with Added, Changed, Fixed, Removed, Security, and Internal. Update it for every meaningful user-visible, API-visible, migration-visible, operational, or architectural change.

Do not say “docs later” unless the PR explicitly records a narrow docs-debt item and the owner accepts it. PR summaries must include a `Documentation updated` section listing changed docs, or explain why no docs were affected.

## Agent execution loop

Before changing code:

1. read the required context;
2. inspect repository conventions;
3. state intended scope and branch;
4. identify migrations, safety risks, tests, gates, and docs that must change.

For each meaningful step:

1. implement one coherent slice;
2. run focused tests/static checks;
3. update docs/changelog/generated API artifacts when applicable;
4. commit the slice;
5. record remaining work.

At the end of a branch or direct-to-main task:

1. run the full relevant gate, or clearly state what was not run;
2. verify the feature manually where practical;
3. add screenshots/video for UI work where helpful;
4. update `docs/STATUS.md` when project status or next tasks changed;
5. prepare a PR-style or commit-style summary;
6. do not claim completion unless it was actually run or verified.

Ask the product owner only when a decision is genuinely blocking, destructive, hard to migrate, or materially changes the agreed product model. For non-blocking ambiguity, choose the safest metadata-only default, document the assumption, and proceed incrementally.

## Definition of done

A feature is done only when:

- the code is implemented with clear boundaries;
- migrations or clean-break bootstrap changes are included and tested when needed;
- focused tests pass;
- type checks and linters pass, unless explicitly skipped with reason;
- security/path/file-safety concerns are addressed;
- UI behavior is keyboard-accessible where applicable;
- loading, empty, error, and large-data states are handled;
- documentation, changelog, and generated API artifacts are updated where applicable;
- the branch has a reviewable history;
- a PR-style summary exists for major changes;
- the feature has been run or otherwise verified.
