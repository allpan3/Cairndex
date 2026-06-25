# ADR-0002: Core schema — identity, hierarchy, and ORM access

- Status: accepted
- Date: 2026-06-25
- Branch/PR: `feature/core-domain-model`

## Context

Phase 1 introduces the first real tables (storage roots, asset bundles, asset
files, tags, tag groups, folders, smart folders) and the queries that read
them. Several cross-cutting decisions shape every table and must be settled
before the first migration. `AGENTS.md` §4 fixes the concepts; this ADR fixes
the mechanics. §4.5 specifically requires the tag-hierarchy strategy to be
recorded in an ADR with descendant-query tests.

## Decisions

### 1. Primary keys: ULID stored as a 26-char string

All user-facing entities use a **ULID** primary key (`CHAR(26)`,
Crockford base32), generated in the application layer.

- `AGENTS.md` §4.2 asks for "UUID or ULID" for bundles; we apply it uniformly
  for a consistent, stable, non-sequential API identity (`AGENTS.md` §10 — use
  stable IDs, not paths, as resource identifiers).
- ULIDs are lexicographically sortable by creation time, which gives a natural
  **stable tie-breaker for keyset/cursor pagination** (`AGENTS.md` §10/§11)
  without a separate sortable column.
- Stored as text because SQLite has no native 128-bit type; text keeps the
  values human-greppable in the DB and portable if we ever move off SQLite.
- Dependency: `python-ulid` (small, single-purpose). Justified per
  `AGENTS.md` §14 by the pagination/identity benefit above.

Join/membership tables (`asset_bundle_tags`, etc.) use composite PKs of the
two foreign keys rather than a surrogate ULID.

### 2. Tag and folder hierarchy: adjacency list + recursive CTE

Both `tags` and `folders` are stored as an **adjacency list** (`parent_id`
nullable self-FK). Descendant queries use SQLite **recursive CTEs**.

- Rejected closure table for the MVP: it speeds deep-descendant reads but adds
  a maintenance table and write-time bookkeeping. Tag/folder counts are
  modest (hundreds, per the reference screenshots — 90 tags, 445 folders), so
  recursive-CTE read cost is negligible and writes stay trivial.
- The descendant-inclusion toggle (`AGENTS.md` §4.5/§4.7) is implemented by
  optionally expanding a parent id to "itself + all descendants" via the CTE
  before the membership check. This is covered by dedicated tests.
- Revisit (new ADR) only if profiling shows descendant expansion is a real
  bottleneck on a large library.

The hierarchy (`parent_id`) is **independent** of tag-group membership
(`tag_group_memberships`, many-to-many). A group is not a parent and does not
affect descendant semantics (`AGENTS.md` §4.5/§4.6).

### 3. ORM access: synchronous SQLAlchemy 2.0

Use **synchronous** SQLAlchemy 2.0 (typed `Mapped[...]` models) with a
`sessionmaker`, not the async engine.

- SQLite serializes writes regardless; async buys little here and adds
  session-lifecycle complexity. FastAPI runs sync path operations in a
  threadpool, so the event loop is not blocked.
- Simpler, well-trodden testing story (a plain session fixture).
- Revisit if a future non-SQLite backend or concurrency profile justifies it;
  the service layer hides the session so the blast radius is contained.

### 4. SQLite pragmas

On every connection: `journal_mode=WAL` (concurrent readers + one writer —
ADR-0001), `foreign_keys=ON` (SQLite disables FK enforcement by default),
`busy_timeout=5000` (tolerate brief write-lock contention from the future
background worker), `synchronous=NORMAL` (safe with WAL, faster than FULL).

### 5. Timestamps

Stored as timezone-aware UTC (`DateTime(timezone=True)`), set in the
application layer (`datetime.now(UTC)`), not via DB clock, so behavior is
identical across SQLite/other backends and is deterministic in tests.

### 6. Soft vs hard deletion

`AGENTS.md` §3/§10 separate **metadata removal** from **physical file
deletion**. Phase 1 implements metadata-only removal as a real DB delete of
the bundle/file rows (the physical file is never touched). "Missing/offline"
is a *file availability state*, distinct from deletion, and is represented by
a status column on `asset_files` for the scanner (Phase 2) to maintain. No
file row carries a destructive on-disk action in Phase 1.

## Consequences

- Migrations must enable `foreign_keys` per-connection (done in `env.py` and
  the app engine), since the pragma is connection-scoped.
- Alembic on SQLite must use `render_as_batch=True` for `ALTER`-heavy
  migrations (limited `ALTER TABLE` support) — configured up front.
- ULID generation lives in one place (`core/ids.py`) so the format is
  consistent and mockable in tests.

## References

- `AGENTS.md` §4 (domain model), §10 (API/IDs), §11 (performance), §15 (tests)
- ADR-0001 (stack and database choice)
