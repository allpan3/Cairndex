# CLAUDE.md

`AGENTS.md` is the canonical instruction file for this repository. Read it in full before planning or modifying code. This file adds a concise operating procedure for Claude-based coding agents; it does not override `AGENTS.md`.

## Required reading order

1. `AGENTS.md`
2. `README.md`
3. `docs/STATUS.md`, if present
4. `docs/architecture.md` and `docs/data-model.md`, if present
5. relevant files under `docs/adr/`
6. `CHANGELOG.md`
7. the code and tests in the area being changed

## Core product reminders

- The primary object is an **Asset Bundle**, not a single file.
- Existing source files remain in place by default.
- The MVP is metadata-only and non-destructive.
- Tags are hierarchical **and** may belong to multiple independent tag groups.
- Collections are hierarchical virtual groupings with multi-collection membership.
- A Cairndex library is a portable root with `.cairndex/{manifest.json,library.db,cache/}`.
- File View is a filesystem-first browser over the active library root, not a bundle view.
- Bundle metadata is shared; file-level title/note/link remain schema-compatible for later use.
- Subtitle association and playback are first-class features.
- The computer-side web app comes before TV/native clients.
- The interface should be Eagle-inspired and desktop-like, not a generic admin dashboard.

## Working procedure

For each meaningful task:

1. Inspect current repository patterns before proposing architecture changes.
2. Create or switch to a focused non-main branch.
3. State a short implementation plan and acceptance criteria.
4. Implement one coherent vertical slice at a time.
5. Add or update focused tests.
6. Run formatter, linter, type checks, tests, and relevant manual checks.
7. Update documentation, `CHANGELOG.md`, and `docs/STATUS.md` as needed.
8. Commit at a meaningful checkpoint with a descriptive message.
9. Prepare a PR-style summary for large work.

Do not implement several major milestones in one unreviewable patch.

## Git rules

- Keep `main` stable.
- Use feature/fix/docs branches.
- Commit frequently but meaningfully.
- Never force-push `main`.
- Rebase and use `git push --force-with-lease` only on non-main branches.
- Large features must be merged through a pull request or a PR-style documented review.
- Preserve useful commits; squash noisy fixups before merge.

## Safety rules

- Never rename, move, overwrite, or delete original media during the metadata-only milestones.
- Validate every path against the active library root.
- Never trust a client-supplied absolute path.
- Do not full-hash large files on the request path.
- Do not run full scans in HTTP request handlers.
- Do not claim browser playback support for a format until it has been tested.
- Never write into an Eagle library during migration/reference work.
- Do not commit source media, private screenshots, databases, caches, thumbnails, or secrets.

## Decision handling

When a question is non-blocking, choose the safest incremental default, record it in an ADR or comment, and continue. Ask the product owner before decisions that are destructive, difficult to migrate, or materially change the agreed product model.

## Session handoff

Before ending a substantial session, update `docs/STATUS.md` with:

- branch and latest commit;
- completed work;
- tests run;
- known issues;
- next recommended task;
- unresolved decisions.

Do not report a feature as complete unless it was built, tested, and verified according to `AGENTS.md`.
