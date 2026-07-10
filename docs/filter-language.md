# Filter language

> Status: **implemented (Phase 5)**. The AST, validator, and SQL compiler live
> in `apps/server/src/cairndex/filters/` with tests in `tests/test_filters.py`
> and `tests/test_smart_collections.py`. The desktop FilterBuilder
> (`apps/web/src/app/filterModel.ts` + `FilterBuilder.tsx`) produces and
> round-trips this exact shape. The allowlist below is the long-term target;
> the currently implemented subset is listed under "Implemented fields".

## Goals

- One canonical, versioned, JSON-serializable filter AST used by **both**
  the simple top-toolbar filters and the Smart Collection editor — they must
  compile to the same model and return identical results for equivalent
  expressions (`AGENTS.md` §4.8, product brief Phase 5 acceptance criteria).
- Server-side validation against an allowlist of fields/operators. The AST
  is never interpolated into raw SQL; it is compiled by trusted code that
  maps each node to a parameterized query fragment.
- Composable boolean logic (`and`, `or`, `not`), even though the first UI
  milestone only exposes a single `all/any` condition group (Eagle-style).

## AST shape (version 1)

```json
{
  "version": 1,
  "op": "and",
  "children": [
    {
      "field": "tags",
      "operator": "contains_all",
      "value": ["tag-id-1", "tag-id-2"],
      "include_descendants": true
    },
    {
      "op": "not",
      "child": {
        "field": "tags",
        "operator": "contains_any",
        "value": ["tag-id-watched"]
      }
    },
    {
      "field": "rating",
      "operator": "gte",
      "value": 4
    }
  ]
}
```

Logical nodes: `and` / `or` (take `children: Node[]`), `not` (takes a single
`child: Node`). Leaf nodes are `{field, operator, value, ...field-specific
options}`.

## Field/operator allowlist (minimum set, per `AGENTS.md` §8.7 and the
product brief's "Filter expression contract")

| Field | Operators |
| --- | --- |
| `title` / `name` | `contains`, `not_contains`, `equals`, `starts_with` |
| `notes`, `source` (file origin), `filename` | `contains`, `not_contains` |
| `tags` | `contains_any`, `contains_all`, `contains_none` (+ `include_descendants`) |
| `collections` | `contains_any`, `contains_all`, `contains_none` (+ `include_descendants`) |
| `rating` | `eq`, `neq`, `gt`, `gte`, `lt`, `lte` |
| `extension` / `container` / `codec` | `equals`, `in`, `not_in` |
| `duration`, `size_bytes`, `file_count` | `eq`, `gt`, `gte`, `lt`, `lte`, `between` |
| `date_added`, `date_modified`, `date_imported` | `gt`, `gte`, `lt`, `lte`, `between` |
| `availability` (missing/offline) | `equals` |
| `has_cover`, `has_subtitles` | `equals` (boolean) |
| `file_role` | `contains_any` |

This table will move into generated/tested documentation (e.g. derived from
the Pydantic field/operator registry) once Phase 5 implements the compiler,
so the two cannot drift.

## Implemented fields (Phase 5)

The compiler (`filters/compiler.py`) currently supports the following. Each
is exercised by `tests/test_filters.py`; the desktop FilterBuilder exposes
exactly this set.

| Field | Operators | Value |
| --- | --- | --- |
| `title` / `name`, `notes`, `source`, `filename` | `contains`, `not_contains`, `equals`, `starts_with` (text fields; `notes`/`source`/`filename` use contains/not_contains in the UI) | string |
| `extension` | `equals`, `in`, `not_in` | string / list |
| `rating`, `file_count`, `size_bytes` | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between` | number / `[lo, hi]` |
| `rating` (also) | `is_null` | boolean (`true` = unrated, `rating IS NULL`) |
| `date_added` | `gt`, `gte`, `lt`, `lte`, `between` | ISO-8601 string |
| `tags`, `collections` | `contains_any`, `contains_all`, `contains_none` (+ `include_descendants`) | list of ids |
| `has_cover`, `has_missing` | `equals` | boolean |

### Rating "Unrated" (`is_null`)

`rating` accepts a rating-specific `is_null` operator: `true` matches bundles with
no rating (`AssetBundle.rating IS NULL`), `false` matches rated bundles
(`IS NOT NULL`). It is deliberately scoped to `rating` — the generic numeric
compiler path does not accept null, so other numeric fields cannot smuggle in a
null comparison. The toolbar Rating filter's "Unrated" row and the Smart
Collection editor's rating "is unrated" operator both emit this node, so they
round-trip identically.

### Tag rules (toolbar) → operators

The Eagle-style toolbar Tags filter maps its per-category rule onto the same
`tags` operators (no new AST):

| Toolbar rule | Operator | `include_descendants` |
| --- | --- | --- |
| **Equal / direct** | `contains_any` | `false` — exact *direct* membership only; a parent tag applied directly still matches, but descendants are never expanded. Multiple selections mean direct membership in *any* of them. |
| **Any** | `contains_any` | toggle (default `true`) |
| **All** | `contains_all` | toggle (default `true`) |
| **Exclude** (right-click) | `contains_none` | direct-only in Equal mode, else follows the same toggle |

Excluded tags are always forbidden and AND-compose with the included tags.

Node shapes are disambiguated structurally (`extra="forbid"` + Pydantic's
smart union): logical nodes carry `op` (`and`/`or` over `children`, `not`
over a single `child`); predicate nodes carry `field`. A `null`/absent `root`
matches everything.

## Endpoints

- `POST /api/v1/filters/preview` — `{ "filter": <expr> }` → `{ "count": n }`.
- `POST /api/v1/bundles/browse` — same params as `GET /browse` plus an
  optional `filter`; this is the shared path for ad-hoc filters and Smart
  Collections, so equivalent expressions return identical results.
- `POST /api/v1/libraries/{library_id}/filters/facets` — faceted counts for the
  toolbar filter popovers. Request: `{ view, collection_id, include_descendants,
  q, filter, facets: ["tags"|"ratings"], tag_include_descendants }`. Response:
  `{ tags: { <tag_id>: n }, ratings: { "0".."5"|"unrated": n } }`. Counts are
  scoped to the current browse context (view/collection/search + the base
  `filter`), computed server-side (never by fetching bundles). The base `filter`
  must exclude the facet category being shown, so a category's own selections
  don't shrink its own counts. Tag counts follow the active rule:
  `tag_include_descendants` rolls a parent up over its subtree as a *distinct*
  bundle count (Any/All), otherwise direct membership only (Equal/direct).
- `GET|POST|PATCH|DELETE /api/v1/smart-collections` — persisted named filters.
  The stored AST is validated and compiled on write, so an unsupported filter
  is rejected at save time, never at browse.

## Compilation contract

- Input: AST (JSON) + a fixed `version`.
- Validation step: every `field` must be in the allowlist; every `operator`
  must be valid for that field's type; `value` must match the field's
  expected type/shape. Invalid expressions are rejected with a structured
  error — they must never reach SQL.
- Compilation step: AST → SQLAlchemy `ColumnElement`/`Select` construction,
  not string concatenation.
- `include_descendants` on `tags`/`collections` resolves against the hierarchy
  (recursive CTE or closure table — see `docs/data-model.md`) before the
  containment check runs.

## Open questions for Phase 5

- Exact typed-value/autocomplete contract per field (tag/collection ID
  resolution vs. display-name resolution in the API payload).
- Whether `version` bumps require a migration of stored `smart_folders.
  filter_json`, or whether old versions are interpreted forever
  (leaning: support old versions read-only, write only the latest).
- Tie-breaker columns for deterministic pagination under arbitrary filters
  (`AGENTS.md` §10).
