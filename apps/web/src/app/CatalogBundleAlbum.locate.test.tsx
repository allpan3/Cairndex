import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { CatalogBundleAlbum } from './CatalogBundleAlbum'
import { replicaRequest } from '../api/replicas'
import type { LocatedFile } from './types'

vi.mock('../api/replicas', () => ({ replicaRequest: vi.fn() }))
vi.mock('./AlbumItems', () => ({
  AlbumItems: ({
    items,
    render,
  }: {
    items: { id: string }[]
    render: (item: { id: string }) => React.ReactNode
  }) => items.map((item) => <div key={item.id}>{render(item)}</div>),
}))

const file = (id: string, path: string) => ({
  id,
  file: {
    id,
    relative_path: path,
    filename: path.split('/').at(-1),
    display_title: path.split('/').at(-1),
    original_filename: path.split('/').at(-1),
    media_kind: 'other',
    role: 'attachment',
    size_bytes: 5,
    availability: 'present',
  },
  directory: null,
})
const page = (items: unknown[], next: number | null) => ({
  total: 3,
  revision: 'synthetic-revision',
  next_offset: next,
  items,
})
beforeEach(() => {
  // The top level spans two pages; the folder member holds the deep file
  vi.mocked(replicaRequest).mockImplementation(
    (_library, path) =>
      Promise.resolve(
        path.includes('directory_id=folder-member')
          ? page([file('deep-file', 'Pictures/deep.png')], null)
          : path.includes('offset=0')
            ? page(
                [
                  {
                    id: 'folder-member',
                    file: null,
                    directory: { directory_path: 'Pictures', name: 'Pictures', file_count: 1 },
                  },
                  file('loose-file', 'loose.png'),
                ],
                2,
              )
            : page([file('later-file', 'later.png')], null),
      ) as never,
  )
})
function setup(initialFile: LocatedFile) {
  const onSelectFile = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <CatalogBundleAlbum
        library="library"
        bundle="bundle"
        layout="list"
        zoom={100}
        onBack={vi.fn()}
        onOpen={vi.fn()}
        onSelectFile={onSelectFile}
        initialFile={initialFile}
      />
    </QueryClientProvider>,
  )
  return { ...view, onSelectFile }
}

test('locate selects a top-level file on a later page', async () => {
  const { container, onSelectFile } = setup({ id: 'later-file', path: 'later.png' })
  await waitFor(() => {
    expect(container.querySelector('[data-file-id="later-file"]')).toHaveClass('file-row--selected')
    expect(onSelectFile).toHaveBeenLastCalledWith('later-file')
  })
})

test('locate opens the folder member holding the file and selects it there', async () => {
  const { container, onSelectFile } = setup({ id: 'deep-file', path: 'Pictures/deep.png' })
  await waitFor(() => {
    expect(container.querySelector('[data-file-id="deep-file"]')).toHaveClass('file-row--selected')
    expect(onSelectFile).toHaveBeenLastCalledWith('deep-file')
  })
})
