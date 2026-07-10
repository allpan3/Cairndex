import type { FilterExpression } from '../api/client'

// --- Editor model ------------------------------------------------------------
// A single Eagle-style condition group: a match mode (all/any) over flat
// predicate rows. This is the shape the UI produces *and* round-trips; the
// underlying AST supports arbitrary nesting, but the editor exposes one level.

export type FieldKind = 'text' | 'number' | 'bool' | 'date' | 'tags' | 'collections' | 'rating'

export interface FieldDef {
  field: string
  label: string
  kind: FieldKind
  operators: string[]
}

export const FIELDS: FieldDef[] = [
  {
    field: 'title',
    label: 'Title',
    kind: 'text',
    operators: ['contains', 'not_contains', 'equals', 'starts_with'],
  },
  { field: 'note', label: 'Notes', kind: 'text', operators: ['contains', 'not_contains'] },
  { field: 'source', label: 'Source', kind: 'text', operators: ['contains', 'not_contains'] },
  { field: 'filename', label: 'Filename', kind: 'text', operators: ['contains', 'not_contains'] },
  { field: 'extension', label: 'Extension', kind: 'text', operators: ['equals'] },
  // Rating uses a star picker + the Unrated (is_null) operator — a typed UI is
  // clearer than raw numbers here.
  { field: 'rating', label: 'Rating', kind: 'rating', operators: ['eq', 'gte', 'lte', 'is_null'] },
  {
    field: 'file_count',
    label: 'File count',
    kind: 'number',
    operators: ['eq', 'gte', 'lte', 'gt', 'lt'],
  },
  {
    field: 'tags',
    label: 'Tags',
    kind: 'tags',
    operators: ['contains_any', 'contains_all', 'contains_none'],
  },
  {
    field: 'collections',
    label: 'Collections',
    kind: 'collections',
    operators: ['contains_any', 'contains_all', 'contains_none'],
  },
  { field: 'date_added', label: 'Date added', kind: 'date', operators: ['gte', 'lte', 'gt', 'lt'] },
  { field: 'has_cover', label: 'Has cover', kind: 'bool', operators: ['equals'] },
  { field: 'has_missing', label: 'Has missing file', kind: 'bool', operators: ['equals'] },
]

export const OP_LABELS: Record<string, string> = {
  contains: 'contains',
  not_contains: 'does not contain',
  equals: 'is',
  starts_with: 'starts with',
  eq: '=',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  contains_any: 'any of',
  contains_all: 'all of',
  contains_none: 'none of',
  is_null: 'is unrated',
}

export interface Condition {
  field: string
  operator: string
  value: unknown
  include_descendants: boolean
}

export interface FilterDraft {
  match: 'all' | 'any'
  rows: Condition[]
}

export const fieldDef = (field: string): FieldDef =>
  FIELDS.find((f) => f.field === field) ?? FIELDS[0]!

export function defaultValue(kind: FieldKind): unknown {
  if (kind === 'number') return 0
  if (kind === 'rating') return 3
  if (kind === 'bool') return true
  if (kind === 'tags' || kind === 'collections') return []
  return ''
}

export function newCondition(field = 'title'): Condition {
  const def = fieldDef(field)
  return {
    field,
    operator: def.operators[0]!,
    value: defaultValue(def.kind),
    include_descendants: false,
  }
}

export const emptyDraft = (): FilterDraft => ({ match: 'all', rows: [newCondition()] })

/** Editor draft → canonical AST (null root when there are no usable rows). */
export function draftToExpression(draft: FilterDraft): FilterExpression {
  const children = draft.rows
    .filter((r) => !isBlank(r))
    .map((r) => ({
      field: r.field,
      operator: r.operator,
      // The rating "Unrated" (is_null) operator carries a boolean, not a star.
      value: r.operator === 'is_null' ? true : r.value,
      include_descendants: r.include_descendants,
    }))
  if (children.length === 0) return { version: 1, root: null }
  if (children.length === 1) return { version: 1, root: children[0]! }
  return { version: 1, root: { op: draft.match === 'all' ? 'and' : 'or', children } }
}

function isBlank(r: Condition): boolean {
  const def = fieldDef(r.field)
  if (def.kind === 'text') return (r.value as string).trim() === ''
  if (def.kind === 'tags' || def.kind === 'collections') return (r.value as string[]).length === 0
  return false
}

/** AST → editor draft, for editing a saved Smart Collection built by this UI. */
export function expressionToDraft(expr: FilterExpression | null): FilterDraft {
  const root = expr?.root
  if (!root) return { match: 'all', rows: [newCondition()] }
  if ('op' in root && (root.op === 'and' || root.op === 'or')) {
    const rows = root.children.filter((c): c is Condition => 'field' in c).map(toCondition)
    return { match: root.op === 'and' ? 'all' : 'any', rows: rows.length ? rows : [newCondition()] }
  }
  if ('field' in root) return { match: 'all', rows: [toCondition(root)] }
  return { match: 'all', rows: [newCondition()] }
}

function toCondition(node: {
  field: string
  operator: string
  value?: unknown
  include_descendants?: boolean
}): Condition {
  return {
    field: node.field,
    operator: node.operator,
    value: node.value ?? '',
    include_descendants: node.include_descendants ?? false,
  }
}
