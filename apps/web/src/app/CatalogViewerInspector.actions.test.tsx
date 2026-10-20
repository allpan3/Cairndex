import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { setActiveLibraryId } from '../api/client'
import { advanceLibraryScope } from '../api/requestScope'
import type { LibraryHostFiles } from '../desktop/useLibraryHostFiles'
import { catalogBundleDragPaths } from '../desktop/catalogHostFiles'
import { CatalogViewerInspector } from './CatalogViewerInspector'

vi.mock('../desktop/catalogHostFiles', () => ({ catalogBundleDragPaths: vi.fn() }))
vi.mock('./useCatalogBundleDraft', () => ({
  useCatalogBundleDraft: () => ({
    read: () => 'null',
    draft: { inputs: {}, pending: null },
    copies: [],
  }),
}))

beforeEach(() => {
  vi.resetAllMocks()
  setActiveLibraryId('synthetic-library')
})

function setup() {
  const drag = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  client.setQueryData(
    ['catalog-detail', 'synthetic-library', 'asset_bundles', 'synthetic-bundle'],
    {
      id: 'synthetic-bundle',
      fields: { $alive: { value: 'true' } },
    },
  )
  client.setQueryData(['catalog-status', 'synthetic-library'], {})
  const { container } = render(
    <QueryClientProvider client={client}>
      <CatalogViewerInspector
        library="synthetic-library"
        bundle="synthetic-bundle"
        editor="synthetic-editor"
        inspectorEnabled={false}
        blocked={false}
        onReview={vi.fn()}
        moments={null}
        onOpenFile={vi.fn()}
        hostFiles={{ onStartFileDrag: drag } as unknown as LibraryHostFiles}
      />
    </QueryClientProvider>,
  )
  const cover = container.querySelector('.catalog-inspector-cover')!
  expect(cover).toHaveAttribute('draggable', 'true')
  return { cover, drag }
}

test('viewer cover resolves the complete guarded bundle selection before native drag', async () => {
  const paths = ['Synthetic/one.png', 'Synthetic/two.mp4']
  vi.mocked(catalogBundleDragPaths).mockResolvedValue(paths)
  const { cover, drag } = setup()
  fireEvent.dragStart(cover)
  await waitFor(() => expect(drag).toHaveBeenCalledWith(paths))
  expect(catalogBundleDragPaths).toHaveBeenCalledWith('synthetic-library', 'synthetic-bundle')
})

test('viewer cover reports refused drags and suppresses delivery after a library switch', async () => {
  vi.mocked(catalogBundleDragPaths).mockRejectedValueOnce(new Error('Bundle files changed.'))
  const { cover, drag } = setup()
  fireEvent.dragStart(cover)
  expect(await screen.findByRole('status')).toHaveTextContent('Bundle files changed.')
  expect(drag).not.toHaveBeenCalled()

  let resolve!: (paths: string[]) => void
  vi.mocked(catalogBundleDragPaths).mockReturnValue(new Promise((done) => (resolve = done)))
  fireEvent.dragStart(cover)
  advanceLibraryScope()
  resolve(['Synthetic/old-selection.png'])
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  expect(drag).not.toHaveBeenCalled()
})
