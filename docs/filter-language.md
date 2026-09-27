# Filter language

The version-one AST, validator and SQL compiler live in
`apps/server/src/cairndex/filters/`. The API supports nested boolean expressions;
the simple editor supports a subset of predicates in one all/any group.

## Saved-rule editing

Opening or renaming a Smart Collection preserves its accepted expression. Name-only
PATCH requests omit `filter`; view defaults and ordering also leave it intact.
The editor retains its opening read basis. Independent name/expression changes
can coexist; a conflicting field returns 409 with a retained proposed value for
exact-version review. The expression version and AST form one indivisible unit.
Nested expressions, root NOT and predicates the simple controls cannot faithfully
represent have protected conditions: only the name can be edited there. Cancel
and Escape discard the local draft. A richer nested editor is deferred.

## Replica saved filters

Complete synthetic catalogs store each saved filter as one indivisible version
plus its exact AST JSON text. Conversion and edits validate the allowlisted AST;
unknown versions/operators stop acceptance. Arbitrary supported nesting, whitespace
and precise JSON literals survive unrelated edits unchanged. A structured replacement
builder composes an explicit all/any group; it never simplifies an existing AST
merely by opening it. Tag/collection IDs inside predicates retain query-literal
semantics rather than foreign-key lifetime guards: deleting a target does not
rewrite the filter, and an absent target matches no direct membership.

Ordinary replica browse supports free text and title/rating/date-added sorting.
Structured filter and facet execution is not yet connected. The toolbar marks
filters unavailable; the strict browse request rejects filter/view fields and
unsupported sorts instead of applying a partial expression. Stored Smart Collection
expressions remain available unchanged through Metadata review.

## Goals

- One canonical, versioned, JSON-serializable filter AST used by **both**
  the simple top-toolbar filters and the Smart Collection editor — they must
  compile to the same model and return identical results for equivalent
  expressions; see the [product brief](product-brief.md#smart-collection-editor).
- Server-side validation against an allowlist of fields/operators. The AST
  is never interpolated into raw SQL; it is compiled by trusted code that
  maps each node to a parameterized query fragment.
- Composable boolean logic (`and`, `or`, `not`), even though the first UI
  milestone only exposes a single `all/any` condition group (Eagle-style).

## AST shape (version 1)

```json
{
  "version": 1,
  "root": {
    "op": "and",
    "children": [
      {"field": "tags", "operator": "contains_all", "value": ["tag-one", "tag-two"], "include_descendants": true},
      {"op": "not", "child": {"field": "tags", "operator": "contains_any", "value": ["tag-watched"]}},
      {"field": "rating", "operator": "gte", "value": 4}
    ]
  }
}
```

Logical nodes: `and` / `or` (take `children: Node[]`), `not` (takes a single
`child: Node`). Leaf nodes are `{field, operator, value, ...field-specific
options}`.

## Supported API predicates

| Field | Operators | Value |
| --- | --- | --- |
| `title`, `name`, `notes`, `source`, `filename` | `contains`, `not_contains`, `equals`, `starts_with` | string |
| `extension` | `equals`, `in`, `not_in` | string / list of extensions |
| `rating`, `file_count`, `size_bytes` | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between` | number / `[lo, hi]` |
| `rating` | `is_null` | boolean; true = unrated, false = rated |
| `date_added` | `gt`, `gte`, `lt`, `lte`, `between` | ISO-8601 string / two strings |
| `tags`, `collections` | `contains_any`, `contains_all`, `contains_none` | list of IDs; optional `include_descendants` |
| `has_cover`, `has_missing` | `equals` | boolean |

Text contains/prefix comparisons are case-insensitive with literal wildcard
characters; equality is exact. `notes` tests each bundle note independently.
`filename` explicitly tests member files' library-relative paths; `source` tests
member file origins. These structured predicates remain independent of free-text
search. File predicates are existential: `filename not_contains` matches when at
least one member path does not contain the text. `file_count` and `size_bytes`
include stored member rows. `has_cover` accepts an explicit cover or an image
member; `has_missing` tests missing member rows.

File-note edits and clears update bundle free text. The structured `notes`
predicate continues to test bundle notes only. Source values round-trip verbatim
through the file API and explicit `source` predicates, including non-HTTP origins;
neither origins nor stored legacy file titles participate in free text.

The API supports empty AND/OR groups as match-all. Empty membership lists mean
match-none for `contains_any`, match-all for `contains_all`/`contains_none`.
`container`, `codec`, `duration`, `date_modified`, `date_imported`, `availability`,
`has_subtitles` and `file_role` are deferred, not accepted API fields.

## Simple editor subset

| Field | Editable operators |
| --- | --- |
| `title` | `contains`, `not_contains`, `equals`, `starts_with` |
| `notes`, `source`, `filename` | `contains`, `not_contains` |
| `extension` | `equals` |
| `rating` | `eq`, `gte`, `lte`, `is_null` (true only) |
| `file_count` | `eq`, `gte`, `lte`, `gt`, `lt` |
| `tags`, `collections` | `contains_any`, `contains_all`, `contains_none` |
| `date_added` | `gte`, `lte`, `gt`, `lt` (date-only values) |
| `has_cover`, `has_missing` | `equals` |

Empty text/membership conditions, time-bearing dates, off-grid rating values and
other API-only shapes are protected on reopen. They are never silently converted
into an empty filter or a smaller group.

### Rating values are stars, in half-star steps

A `rating` value is a **number of stars** on a 0–5 scale with 0.5 granularity:
`{"field": "rating", "operator": "gte", "value": 3.5}` selects three-and-a-half
stars and up. See [Rating scale](data-model.md#rating-scale) for why the value
counts stars rather than half-star units.

The practical consequence for saved filters: **half stars did not reinterpret
anything already written down**. A Smart Collection whose `filter_json` says
`rating >= 4` selected four stars and up before half stars existed and still
does. Nothing has to be rewritten, and a filter authored on either side of the
change means the same thing on both.

Values off the half-star grid (`3.3`) are rejected by the bundle write schemas.
The filter compiler does **not** reject them — a filter is a comparison, not a
stored rating, and `rating > 3.3` is a well-defined (if unusual) query that
cannot corrupt anything.

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

- `POST /api/v1/libraries/{library_id}/filters/preview` — `{ "filter": <expr> }` → `{ "count": n }`.
- `POST /api/v1/libraries/{library_id}/bundles/browse` — same params as `GET /browse` plus an
  optional `filter`; this is the shared path for ad-hoc filters and Smart
  Collections, so equivalent expressions return identical results.
- `POST /api/v1/libraries/{library_id}/filters/facets` — faceted counts for the
  toolbar filter popovers. Request: `{ view, collection_id, include_descendants,
  q, filter, facets: ["tags"|"ratings"], tag_include_descendants }`. Response:
  `{ tags: { <tag_id>: n }, ratings: { "0"|"0.5"|…|"5"|"unrated": n } }` —
  whole stars key without a decimal part (`"4"`, never `"4.0"`). Counts are
  scoped to the current browse context (view/collection/search + the base
  `filter`), computed server-side (never by fetching bundles). The base `filter`
  must exclude the facet category being shown, so a category's own selections
  don't shrink its own counts. Tag counts follow the active rule:
  `tag_include_descendants` rolls a parent up over its subtree as a *distinct*
  bundle count (Any/All), otherwise direct membership only (Equal/direct).
- `GET|POST /api/v1/libraries/{library_id}/smart-collections` and
  `GET|PATCH|DELETE /api/v1/libraries/{library_id}/smart-collections/{id}` — persisted named filters.
  The stored AST is validated and compiled on write, so an unsupported filter
  is rejected at save time, never at browse.

Preview uses the normal All/Smart Collection population: unconfirmed scan-staged
bundles and hidden-only bundles are excluded. Empty bundles, confirmed missing
bundles and bundles with both hidden and visible members are eligible. Counts
apply the expression before pagination. Preview has no view/search override;
facets accept that additional context. A failed UI preview offers retry.

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

OpenAPI describes the recursive envelope and node shapes. Predicate `field` and
`operator` remain strings and `value` is untyped there; the compiler enforces the
field-dependent contract above. Unknown fields/operators and invalid values return
422. Unsupported AST versions are rejected; no version-two language is defined.
Bundle pagination uses the active sort plus stable bundle ID ties.
