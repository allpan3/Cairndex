import { expect, test } from 'vitest'
import {
  adHocFiltersToExpression,
  anyAdHocActive,
  combineFilters,
  emptyAdHocFilters,
} from './adHocFilters'
import { draftToExpression, expressionToDraft, fieldDef, FIELDS, newCondition } from './filterModel'

test('has_starred_files is a boolean filter predicate supported in Smart Collections and ad-hoc filters', () => {
  const def = fieldDef('has_starred_files')
  expect(def.kind).toBe('bool')
  expect(def.operators).toEqual(['equals'])
  expect(FIELDS.some((f) => f.field === 'has_starred_files')).toBe(true)

  const row = newCondition('has_starred_files')
  expect(row).toEqual({
    field: 'has_starred_files',
    operator: 'equals',
    value: true,
    include_descendants: false,
  })
  const expr = draftToExpression({ match: 'all', rows: [row] })
  expect(expr).toEqual({
    version: 1,
    root: {
      field: 'has_starred_files',
      operator: 'equals',
      value: true,
      include_descendants: false,
    },
  })
  expect(expressionToDraft(expr)).toEqual({
    match: 'all',
    rows: [row],
  })
})

test('adHocFilters includes hasStarredFiles in active state, AST compilation, and reset', () => {
  const blank = emptyAdHocFilters()
  expect(anyAdHocActive(blank)).toBe(false)
  expect(adHocFiltersToExpression(blank)).toBeNull()

  const starredOnly = { ...blank, hasStarredFiles: true }
  expect(anyAdHocActive(starredOnly)).toBe(true)
  expect(adHocFiltersToExpression(starredOnly)).toEqual({
    version: 1,
    root: { field: 'has_starred_files', operator: 'equals', value: true },
  })

  const combined = {
    ...starredOnly,
    tags: { ...blank.tags, include: ['tag-1'] },
  }
  expect(adHocFiltersToExpression(combined)).toEqual({
    version: 1,
    root: {
      op: 'and',
      children: [
        {
          field: 'tags',
          operator: 'contains_any',
          value: ['tag-1'],
          include_descendants: true,
        },
        { field: 'has_starred_files', operator: 'equals', value: true },
      ],
    },
  })

  const smart = {
    version: 1 as const,
    root: { field: 'rating', operator: 'gte', value: 4, include_descendants: false },
  }
  expect(combineFilters(smart, adHocFiltersToExpression(starredOnly))).toEqual({
    version: 1,
    root: {
      op: 'and',
      children: [smart.root, { field: 'has_starred_files', operator: 'equals', value: true }],
    },
  })
})
