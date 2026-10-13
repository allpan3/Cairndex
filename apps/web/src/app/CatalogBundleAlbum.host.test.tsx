import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { CatalogBundleAlbum } from './CatalogBundleAlbum'
import { replicaRequest } from '../api/replicas'
import type { LibraryHostFiles } from '../desktop/useLibraryHostFiles'

vi.mock('../api/replicas', () => ({ replicaRequest: vi.fn() }))
// Virtual geometry has separate coverage. Exercise the album's real item handlers.
vi.mock('./AlbumItems', () => ({
  AlbumItems: ({
    items,
    render,
  }: {
    items: { id: string }[]
    render: (item: { id: string }) => React.ReactNode
  }) => items.map((item) => <div key={item.id}>{render(item)}</div>),
}))
beforeEach(() => {
  vi.mocked(replicaRequest).mockResolvedValue({
    total: 3,
    revision: 'synthetic-revision',
    next_offset: null,
    items: ['amber', 'blue']
      .map((id) => ({
        id,
        file: {
          id,
          relative_path: `Synthetic/${id}.txt`,
          filename: `${id}.txt`,
          display_title: `${id}.txt`,
          original_filename: `${id}.txt`,
          media_kind: 'other',
          role: 'attachment',
          size_bytes: 5,
          availability: 'present',
        },
        directory: null,
      }))
      .concat([
        {
          id: 'directory',
          file: null,
          directory: { relative_path: 'Synthetic/folder', directory_path: 'Synthetic/folder' },
        },
      ] as never),
  })
})
function setup(mapped = true) {
  const drag = vi.fn(),
    reveal = vi.fn(),
    open = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const hostFiles = {
    labels: { openFile: 'Open in Default App', revealFile: 'Reveal in Finder' },
    onStartFileDrag: mapped ? drag : undefined,
    onOpenFile: mapped ? open : undefined,
    onRevealFile: mapped ? reveal : undefined,
  } as unknown as LibraryHostFiles
  const view = render(
    <QueryClientProvider client={client}>
      <CatalogBundleAlbum
        library="library"
        bundle="bundle"
        layout="list"
        zoom={100}
        onBack={vi.fn()}
        onOpen={vi.fn()}
        onSelectFile={vi.fn()}
        hostFiles={hostFiles}
      />
    </QueryClientProvider>,
  )
  return { ...view, drag, reveal, open }
}
test('album drag carries the selected regular files and excludes directory members', async () => {
  const { container, drag } = setup()
  await screen.findByText('amber.txt')
  const amber = container.querySelector<HTMLElement>('[data-file-id="amber"]')!
  const blue = container.querySelector<HTMLElement>('[data-file-id="blue"]')!
  const directory = container.querySelector<HTMLElement>('[data-file-id="directory"]')!
  fireEvent.click(amber)
  fireEvent.click(blue, { ctrlKey: true })
  fireEvent.click(directory, { ctrlKey: true })
  fireEvent.dragStart(amber)
  expect(drag).toHaveBeenCalledWith(['Synthetic/amber.txt', 'Synthetic/blue.txt'])
  expect(directory).not.toHaveAttribute('draggable', 'true')
})
test('album host context actions use the clicked file and are absent when unmapped', async () => {
  const view = setup()
  await screen.findByText('amber.txt')
  fireEvent.contextMenu(view.container.querySelector('[data-file-id="amber"]')!)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Finder' }))
  expect(view.reveal).toHaveBeenCalledWith('Synthetic/amber.txt')
  view.unmount()
  const unmapped = setup(false)
  await screen.findByText('amber.txt')
  fireEvent.contextMenu(unmapped.container.querySelector('[data-file-id="amber"]')!)
  expect(screen.queryByRole('menuitem', { name: 'Reveal in Finder' })).not.toBeInTheDocument()
})
