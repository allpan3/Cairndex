import { expect, test } from 'vitest'
import { validCatalogBulkDraft } from './catalogBulkDraft'

const snapshot = JSON.stringify({
  items: [
    {
      id: 'bundle-a',
      title: 'Synthetic title',
      rating: null,
      held: false,
      observed: { 'asset_bundles/bundle-a/title': ['event-a'] },
    },
  ],
})
const draft = {
  snapshot,
  field: 'title',
  value: 'New title',
  operation: 'review-a',
  applying: 'true',
  label: 'Set title',
  command: JSON.stringify({
    action: 'bulk',
    ids: ['bundle-a'],
    field: 'title',
    value: 'New title',
    observed: {},
  }),
}

test('retained bulk requests cannot change targets through malformed storage', () => {
  expect(validCatalogBulkDraft(draft)).toBe(true)
  expect(validCatalogBulkDraft({ ...draft, snapshot: '{bad' })).toBe(false)
  expect(
    validCatalogBulkDraft({ ...draft, command: draft.command.replace('bundle-a', 'bundle-b') }),
  ).toBe(false)
  expect(validCatalogBulkDraft({ ...draft, snapshot: JSON.stringify({ items: [] }) })).toBe(false)
  expect(validCatalogBulkDraft({ ...draft, snapshot: '' })).toBe(false)
  expect(validCatalogBulkDraft({ ...draft, operation: '', command: '' })).toBe(false)
  expect(
    validCatalogBulkDraft({ ...draft, command: draft.command.replace('"title"', '"notes"') }),
  ).toBe(false)
})
