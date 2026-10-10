import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { FilterExpression, SmartCollectionRead } from '../api/client'
import { expressionToDraft } from './filterModel'
import { SmartCollectionEditor } from './SmartCollectionEditor'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  preview: vi.fn(),
  retry: vi.fn(),
  failed: false,
}))
vi.mock('../api/hooks', () => ({
  useSmartCollectionMutations: () => ({
    create: { mutate: vi.fn() },
    update: { mutate: mocks.update },
    remove: { mutate: vi.fn() },
  }),
  useFilterPreview: (filter: FilterExpression) => {
    mocks.preview(filter)
    return { data: 7, isLoading: false, isError: mocks.failed, refetch: mocks.retry }
  },
  useTags: () => ({ data: [] }),
  useCollections: () => ({ data: [] }),
}))

const predicate = { include_descendants: false, field: 'rating', operator: 'gte', value: 4 }
const nested: FilterExpression = {
  version: 1,
  root: {
    op: 'and',
    children: [predicate, { op: 'or', children: [predicate, { op: 'not', child: predicate }] }],
  },
}

// Use an immutable saved version so rerenders cannot quietly advance the editor's basis
function saved(filter: FilterExpression): SmartCollectionRead {
  return {
    id: 'smart-one',
    name: 'Saved rules',
    filter,
    version: 3,
    default_sort: null,
    default_layout: null,
    sort_order: 0,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.failed = false
})

test.each([
  nested,
  { version: 1, root: { op: 'not', child: predicate } },
  {
    version: 1,
    root: { include_descendants: false, field: 'rating', operator: 'is_null', value: false },
  },
  {
    version: 1,
    root: { include_descendants: false, field: 'filename', operator: 'equals', value: 'clip.mp4' },
  },
  {
    version: 1,
    root: { include_descendants: false, field: 'tags', operator: 'contains_any', value: [] },
  },
  {
    version: 1,
    root: {
      include_descendants: false,
      field: 'date_added',
      operator: 'gte',
      value: '2026-01-01T12:00:00Z',
    },
  },
  {
    version: 1,
    root: { include_descendants: false, field: 'title', operator: 'equals', value: '' },
  },
] satisfies FilterExpression[])('preserves advanced rules on rename: %j', (filter) => {
  expect(expressionToDraft(filter)).toBeNull()
  render(<SmartCollectionEditor existing={saved(filter)} onClose={vi.fn()} onSaved={vi.fn()} />)
  expect(screen.getByRole('note')).toHaveTextContent('only the name')
  expect(screen.queryByLabelText('Field')).not.toBeInTheDocument()
  expect(mocks.preview).toHaveBeenLastCalledWith(filter)
  fireEvent.change(screen.getByLabelText('Smart collection name'), { target: { value: 'Renamed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(mocks.update.mock.calls[0]![0]).toEqual({
    id: 'smart-one',
    payload: { name: 'Renamed' },
    version: 3,
  })
})

test('flat rules are omitted until a condition is edited, retaining the opening version', () => {
  const original = saved({ version: 1, root: { op: 'and', children: [predicate] } })
  const props = { onClose: vi.fn(), onSaved: vi.fn() }
  const view = render(<SmartCollectionEditor existing={original} {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(mocks.update.mock.calls[0]![0].payload).toEqual({ name: 'Saved rules' })
  view.rerender(
    <SmartCollectionEditor existing={{ ...original, version: 4, filter: nested }} {...props} />,
  )
  fireEvent.change(screen.getByLabelText('Operator'), { target: { value: 'lte' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(mocks.update.mock.calls[1]![0]).toEqual({
    id: original.id,
    version: 3,
    payload: {
      name: 'Saved rules',
      filter: { version: 1, root: { ...predicate, operator: 'lte', include_descendants: false } },
    },
  })
})

test('cancel discards the local draft and reopen restores the saved expression', () => {
  const onClose = vi.fn()
  const props = { existing: saved(nested), onClose, onSaved: vi.fn() }
  const view = render(<SmartCollectionEditor {...props} />)
  fireEvent.change(screen.getByLabelText('Smart collection name'), { target: { value: 'Discard' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onClose).toHaveBeenCalledOnce()
  expect(mocks.update).not.toHaveBeenCalled()
  view.unmount()
  render(<SmartCollectionEditor {...props} />)
  expect(screen.getByLabelText('Smart collection name')).toHaveValue('Saved rules')
  expect(mocks.preview).toHaveBeenLastCalledWith(nested)
})

test('failed preview offers retry instead of reporting zero matches', () => {
  mocks.failed = true
  render(<SmartCollectionEditor existing={saved(nested)} onClose={vi.fn()} onSaved={vi.fn()} />)
  expect(screen.getByRole('alert')).toHaveTextContent('Could not count matches')
  fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }))
  expect(mocks.retry).toHaveBeenCalledOnce()
})
