# Filter language

> Status: skeleton (Phase 0). The full contract is implemented and tested in
> `feature/smart-filters` (Phase 5), but the shape below is fixed by
> `AGENTS.md` and the product brief now so that earlier phases (toolbar
> filters in Phase 3, tag/folder pickers in Phase 4) don't paint themselves
> into a corner.

## Goals

- One canonical, versioned, JSON-serializable filter AST used by **both**
  the simple top-toolbar filters and the Smart Folder editor — they must
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
| `note`, `source` (file origin), `filename` | `contains`, `not_contains` |
| `tags` | `contains_any`, `contains_all`, `contains_none` (+ `include_descendants`) |
| `folders` | `contains_any`, `contains_all`, `contains_none` (+ `include_descendants`) |
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

## Compilation contract

- Input: AST (JSON) + a fixed `version`.
- Validation step: every `field` must be in the allowlist; every `operator`
  must be valid for that field's type; `value` must match the field's
  expected type/shape. Invalid expressions are rejected with a structured
  error — they must never reach SQL.
- Compilation step: AST → SQLAlchemy `ColumnElement`/`Select` construction,
  not string concatenation.
- `include_descendants` on `tags`/`folders` resolves against the hierarchy
  (recursive CTE or closure table — see `docs/data-model.md`) before the
  containment check runs.

## Open questions for Phase 5

- Exact typed-value/autocomplete contract per field (tag/folder ID
  resolution vs. display-name resolution in the API payload).
- Whether `version` bumps require a migration of stored `smart_folders.
  filter_json`, or whether old versions are interpreted forever
  (leaning: support old versions read-only, write only the latest).
- Tie-breaker columns for deterministic pagination under arbitrary filters
  (`AGENTS.md` §10).
