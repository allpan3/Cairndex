import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { type FileRead, setActiveLibraryId } from '../api/client'
import { AlbumTile } from './AlbumItem'

beforeEach(() => setActiveLibraryId('library'))

const file = (fields: Partial<FileRead>) =>
  ({
    id: 'synthetic-file',
    bundle_id: 'synthetic-bundle',
    relative_path: 'Synthetic/frame.png',
    display_title: 'frame.png',
    media_kind: 'image',
    availability: 'missing',
    size_bytes: null,
    tech_metadata: null,
    ...fields,
  }) as FileRead

const caption = (value: FileRead) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AlbumTile
        file={value}
        selected={false}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onContextMenu={vi.fn()}
        previewDisabled
        dragProps={{ draggable: false, onDragStart: undefined }}
        catalog
      />
    </QueryClientProvider>,
  ).container.querySelector('.album-tile__sub')?.textContent

// Portable tiles caption from this device's observations, as v0.2.1 tiles did
test('a portable album tile shows observed dimensions, then duration, then size', () => {
  expect(caption(file({ tech_metadata: { width: 400, height: 300 }, size_bytes: 9100 }))).toBe(
    '400 × 300',
  )
  expect(caption(file({ media_kind: 'audio', tech_metadata: { duration: 75 } }))).toBe('1:15')
  expect(caption(file({ size_bytes: 9100 }))).toBe('8.9 KB')
  expect(caption(file({}))).toBe('—')
})
