// Ad-hoc toolbar filters (Eagle-style). Local UI state only — not persisted to
// localStorage or the URL in this milestone. Both these filters and saved Smart
// Collections compile to the *same* canonical FilterExpression AST (see
// docs/filter-language.md), so equivalent selections return identical results.

import type { FilterExpression, SystemView } from '../api/client'

// A predicate node in the AST. Kept structural (not the generated union) so we
// can build nodes the same way filterModel.ts does.
interface Pred {
  field: string
  operator: string
  value: unknown
  include_descendants?: boolean
}

// --- Tags --------------------------------------------------------------------
// Rule applies per category (Eagle-style), not globally.
// - any    → contains_any over included tags (descendant inclusion, default on)
// - all    → contains_all over included tags (descendant inclusion, default on)
// - equal  → exact *direct* membership only: contains_any with descendants off.
//            A parent tag applied directly still matches (no descendant expand).
export type TagRule = 'any' | 'all' | 'equal'

export interface TagFilter {
  rule: TagRule
  includeDescendants: boolean
  include: string[]
  exclude: string[]
}

// --- Rating (wired in Slice 2) ----------------------------------------------
export type RatingOp = 'eq' | 'gte' | 'lte'

export interface RatingFilter {
  // 'unrated' filters bundles with no rating (rating IS NULL); 'value' uses the
  // star value + operator.
  mode: 'value' | 'unrated'
  op: RatingOp
  value: number // 1..5, meaningful only when mode === 'value'
}

export interface AdHocFilters {
  tags: TagFilter
  rating: RatingFilter | null
}

export type FilterCategory = 'tags' | 'rating'

export const emptyTagFilter = (): TagFilter => ({
  rule: 'any',
  includeDescendants: true,
  include: [],
  exclude: [],
})

export const emptyAdHocFilters = (): AdHocFilters => ({
  tags: emptyTagFilter(),
  rating: null,
})

export const tagFilterActive = (t: TagFilter): boolean =>
  t.include.length > 0 || t.exclude.length > 0

export const ratingFilterActive = (r: RatingFilter | null): boolean => r !== null

export const anyAdHocActive = (f: AdHocFilters): boolean =>
  tagFilterActive(f.tags) || ratingFilterActive(f.rating)

/** Drop one category (used to build the base scope for that category's facet
 * counts — a category's own selections must not shrink its own counts). */
export function withoutCategory(f: AdHocFilters, category: FilterCategory): AdHocFilters {
  if (category === 'tags') return { ...f, tags: emptyTagFilter() }
  return { ...f, rating: null }
}

function tagPredicates(t: TagFilter): Pred[] {
  const preds: Pred[] = []
  if (t.include.length > 0) {
    if (t.rule === 'all') {
      preds.push({
        field: 'tags',
        operator: 'contains_all',
        value: t.include,
        include_descendants: t.includeDescendants,
      })
    } else {
      // 'any' and 'equal' both use contains_any; only descendant expansion differs.
      preds.push({
        field: 'tags',
        operator: 'contains_any',
        value: t.include,
        include_descendants: t.rule === 'equal' ? false : t.includeDescendants,
      })
    }
  }
  if (t.exclude.length > 0) {
    // Excluded tags are always forbidden (contains_none), AND-composed with the
    // includes. Direct-only in Equal mode; otherwise respects the same toggle.
    preds.push({
      field: 'tags',
      operator: 'contains_none',
      value: t.exclude,
      include_descendants: t.rule === 'equal' ? false : t.includeDescendants,
    })
  }
  return preds
}

function ratingPredicates(r: RatingFilter | null): Pred[] {
  if (r === null) return []
  if (r.mode === 'unrated') return [{ field: 'rating', operator: 'is_null', value: true }]
  return [{ field: 'rating', operator: r.op, value: r.value }]
}

/** Ad-hoc filters → canonical AST (null when nothing is active). Multiple
 * predicates are AND-composed. */
export function adHocFiltersToExpression(f: AdHocFilters): FilterExpression | null {
  const preds: Pred[] = [...tagPredicates(f.tags), ...ratingPredicates(f.rating)]
  if (preds.length === 0) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural nodes
  const nodes = preds as any[]
  if (nodes.length === 1) return { version: 1, root: nodes[0] }
  return { version: 1, root: { op: 'and', children: nodes } }
}

/** Combine a Smart Collection filter and an ad-hoc filter. Null filters are
 * ignored; when both exist the root is AND; a single one is used directly. */
export function combineFilters(
  a: FilterExpression | null | undefined,
  b: FilterExpression | null | undefined,
): FilterExpression | null {
  const ra = a?.root ?? null
  const rb = b?.root ?? null
  if (ra && rb) return { version: 1, root: { op: 'and', children: [ra, rb] } }
  if (ra) return { version: 1, root: ra }
  if (rb) return { version: 1, root: rb }
  return null
}

/** The current browse context a facet query needs (everything but the category
 * being displayed, which the popover strips itself). */
export interface FacetContext {
  view: SystemView
  collectionId: string | null
  includeDescendants: boolean
  q: string | null
  smartFilter: FilterExpression | null
}
