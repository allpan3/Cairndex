import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { Entity } from '../api/catalog'
import { setActiveLibraryId } from '../api/client'
import { CatalogBundleInspector } from './CatalogBundleInspector'

vi.mock('../api/useReplicaStatus', () => ({ useReplicaStatus: () => ({ data: {} }) }))
vi.mock('./useCatalogBundleDraft', () => ({
  useCatalogBundleDraft: () => ({
    read: () => 'null',
    change: vi.fn(),
    draft: { inputs: {}, pending: null },
    error: '',
    busy: false,
    message: '',
    save: vi.fn(),
  }),
}))
// The dialog has its own tests; here only the entry and the advanced hand-off matter
vi.mock('./CatalogConflictDialog', () => ({
  CatalogConflictDialog: (props: { bundles: string[]; onAdvanced: (unit: string) => void }) => (
    <div role="dialog" aria-label="Conflicting Edits">
      {props.bundles.join(',')}
      <button onClick={() => props.onAdvanced('asset_bundles/synthetic-bundle/$members')}>
        Open Full Review…
      </button>
    </div>
  ),
}))

test('Review Conflicts opens the bundle review in place and hands structural scopes on', () => {
  setActiveLibraryId('synthetic-library')
  const onReview = vi.fn()
  const onReviewConflict = vi.fn()
  render(
    <CatalogBundleInspector
      library="synthetic-library"
      entity={{ id: 'synthetic-bundle', has_conflicts: true, fields: {} } as unknown as Entity}
      editor="synthetic-editor"
      inspectorEnabled={false}
      blocked={false}
      refresh={vi.fn()}
      onReview={onReview}
      onReviewConflict={onReviewConflict}
      onOpenFile={vi.fn()}
    />,
  )
  expect(screen.getByText('This bundle has conflicting edits.')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Review Conflicts' }))
  expect(screen.getByRole('dialog', { name: 'Conflicting Edits' })).toHaveTextContent(
    'synthetic-bundle',
  )
  expect(onReview).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Open Full Review…' }))
  expect(onReviewConflict).toHaveBeenCalledWith('asset_bundles/synthetic-bundle/$members')
  expect(screen.queryByRole('dialog')).toBeNull()
})
