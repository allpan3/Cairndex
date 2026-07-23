# CLAUDE.md

`AGENTS.md` is the canonical instruction file for this repository. Read it before planning or modifying code. This file adds a concise operating procedure for Claude-based coding agents; it does not override `AGENTS.md`.

## Required reading order

1. `AGENTS.md`
2. `README.md`
3. `docs/STATUS.md`
4. `docs/product-brief.md`
5. `docs/architecture.md` and `docs/data-model.md`, if relevant
6. relevant files under `docs/adr/`
7. `CHANGELOG.md`
8. the code and tests in the area being changed

## Core reminders

- `AGENTS.md` defines execution rules, gates, safety constraints, documentation discipline, and definition of done.
- `docs/product-brief.md` defines the product model, domain concepts, UI direction, future compatibility goals, and first-release anti-goals.
- `docs/STATUS.md` defines the latest implementation state, known gaps, and next recommended tasks.
- ADRs define accepted consequential architecture decisions.

When these sources disagree, follow the source-of-truth order in `AGENTS.md` and correct stale documentation in the same change where practical.

## Working procedure

For each meaningful task:

1. Inspect current repository patterns before proposing architecture changes.
2. Create or switch to a focused non-main branch unless the owner explicitly requested direct-to-main work.
3. State a short implementation plan and acceptance criteria.
4. Implement one coherent vertical slice at a time.
5. Add or update focused tests.
6. Run formatter, linter, type checks, tests, and relevant manual checks.
7. Update documentation, `CHANGELOG.md`, generated API artifacts, and `docs/STATUS.md` as needed.
8. Commit at a meaningful checkpoint with a descriptive message.
9. Prepare a PR-style summary for large work.

Do not implement several major milestones in one unreviewable patch.

## Git rules

- Keep `main` stable.
- Use feature/fix/docs branches unless the owner explicitly asks for a direct-to-main documentation or maintenance commit.
- Commit frequently but meaningfully.
- Never force-push `main`.
- Rebase and use `git push --force-with-lease` only on non-main branches.
- Large features must be merged through a pull request or a PR-style documented review.
- Preserve useful commits; squash noisy fixups before merge.
- **Do not open a pull request until the owner asks for one.** Work freely on a
  branch and commit as usual; opening the PR is the owner's call, not a default
  step at the end of a task. The same applies to merging.
- **Follow-up work belongs in the open PR it follows up on.** When a review
  comment, a bug found during testing, or a doc gap relates to a PR that is still
  open, commit it to that branch instead of opening a second PR. Reserve a new
  branch and PR for work that is genuinely independent. Cherry-pick and
  `--force-with-lease` onto the existing branch when something has already landed
  in the wrong place.

## Safety rules

- Never rename, move, overwrite, or delete original media except through an explicit, journaled write-mode operation (ADR-0013) — per-library opt-in, deployment-permitted, and recorded before the filesystem is touched. Everything outside that path stays metadata-only.
- Validate every path against the active library root.
- Never trust a client-supplied absolute path.
- Do not full-hash large files on the request path.
- Do not run full scans in HTTP request handlers.
- Do not claim browser playback support for a format until it has been tested.
- Do not write into an Eagle library; Eagle is reference material only.
- Do not commit source media, private screenshots, databases, caches, thumbnails, or secrets.

## Decision handling

When a question is non-blocking, choose the safest incremental default, record it in an ADR, status note, or code comment as appropriate, and continue. Ask the product owner before decisions that are destructive, difficult to migrate, or materially change the agreed product model.

## Session handoff

Before ending a substantial session, update `docs/STATUS.md` with:

- branch and latest commit;
- completed work;
- tests run;
- known issues;
- next recommended task;
- unresolved decisions.

Do not report a feature as complete unless it was built, tested, and verified according to `AGENTS.md`.
