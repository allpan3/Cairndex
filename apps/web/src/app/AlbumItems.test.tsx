import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { expect, test, vi } from 'vitest'
import { setActiveLibraryId, type FileRead } from '../api/client'
import { AlbumRow, AlbumTile } from './AlbumItem'
import { AlbumItems } from './AlbumItems'
import type { BrowserNavigation } from './Browser'
import { fileDragProps } from './dragOut'
import { albumFileAspect, packRows } from './layout'

function makeFile(id: string, width: number, height: number): FileRead {
  return {
    id,
    bundle_id: 'bundle-1',
    relative_path: `Album/${id}.png`,
    display_title: `${id}.png`,
    original_filename: `${id}.png`,
    media_kind: 'image',
    mime_type: 'image/png',
    size_bytes: 1024,
    availability: 'available',
    supported: true,
    sequence: 0,
    role: 'image',
    updated_at: '2026-01-01T00:00:00Z',
    tech_metadata: { width, height },
  } as unknown as FileRead
}

test('packRows and albumFileAspect pack Justified, Card details, and List layouts distinctly', () => {
  const wide = makeFile('wide', 1920, 1080)
  const tall = makeFile('tall', 900, 1600)
  const square = makeFile('square', 1000, 1000)
  const items = [wide, tall, square]

  expect(albumFileAspect(wide)).toBeCloseTo(16 / 9)
  expect(albumFileAspect(tall)).toBeCloseTo(9 / 16)
  expect(albumFileAspect(square)).toBeCloseTo(1)

  const gridWithDetails = packRows(items, 'grid', 600, 200, true, albumFileAspect)
  const gridWithoutDetails = packRows(items, 'grid', 600, 200, false, albumFileAspect)
  const justified = packRows(items, 'justified', 600, 200, true, albumFileAspect)
  const list = packRows(items, 'list', 600, 200, true, albumFileAspect)

  // Card details adds the 44px footer height in Card (`grid`) layout
  expect(gridWithDetails[0]!.height - gridWithoutDetails[0]!.height).toBeCloseTo(44)
  // Card gives uniform widths; Justified gives aspect-proportional widths
  expect(gridWithDetails[0]!.cards[0]!.width).toBeCloseTo(gridWithDetails[0]!.cards[1]!.width)
  expect(justified[0]!.cards[0]!.width).toBeGreaterThan(justified[0]!.cards[1]!.width * 2)
  // List gives one full-width row per item
  expect(list).toHaveLength(3)
  expect(list[0]!.cards[0]!.width).toBe(600)
})

test('AlbumItems renders Card (with/without details), Justified, and List and steps vertically by x-center', () => {
  setActiveLibraryId('library')
  const items = [
    makeFile('f1', 1600, 900),
    makeFile('f2', 1600, 900),
    makeFile('f3', 1600, 900),
    makeFile('f4', 1600, 900),
  ]
  const scrollDiv = document.createElement('div')
  Object.defineProperty(scrollDiv, 'clientWidth', { value: 500, configurable: true })
  Object.defineProperty(scrollDiv, 'clientHeight', { value: 800, configurable: true })
  Object.defineProperty(scrollDiv, 'offsetWidth', { value: 500, configurable: true })
  Object.defineProperty(scrollDiv, 'offsetHeight', { value: 800, configurable: true })
  scrollDiv.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 500,
      bottom: 800,
      width: 500,
      height: 800,
      toJSON: () => ({}),
    }) as DOMRect
  document.body.appendChild(scrollDiv)
  const scrollRef = { current: scrollDiv }
  const navRef = createRef<BrowserNavigation>()

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { rerender } = render(
    <QueryClientProvider client={client}>
      <AlbumItems
        items={items}
        scrollRef={scrollRef}
        layout="grid"
        zoom={200}
        showCardDetails={true}
        getAspect={albumFileAspect}
        navigationRef={navRef}
        render={(file) => (
          <AlbumTile
            file={file}
            showMeta={true}
            selected={false}
            onSelect={vi.fn()}
            onOpen={vi.fn()}
            onContextMenu={vi.fn()}
            previewDisabled
            dragProps={fileDragProps(undefined, () => [])}
            catalog
          />
        )}
      />
    </QueryClientProvider>,
  )

  expect(screen.getByText('f1.png')).toBeInTheDocument()
  // At innerWidth ~476 and zoom 200, 2 columns per row -> f1/f2 on row 0, f3/f4 on row 1
  expect(navRef.current?.step('f2', 'down')).toBe('f4')
  expect(navRef.current?.step('f4', 'up')).toBe('f2')

  // Justified layout hides the footer text while preserving accessible labels
  rerender(
    <QueryClientProvider client={client}>
      <AlbumItems
        items={items}
        scrollRef={scrollRef}
        layout="justified"
        zoom={200}
        showCardDetails={true}
        getAspect={albumFileAspect}
        navigationRef={navRef}
        render={(file) => (
          <AlbumTile
            file={file}
            showMeta={false}
            selected={false}
            onSelect={vi.fn()}
            onOpen={vi.fn()}
            onContextMenu={vi.fn()}
            previewDisabled
            dragProps={fileDragProps(undefined, () => [])}
            catalog
          />
        )}
      />
    </QueryClientProvider>,
  )
  expect(screen.queryByText('f1.png')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'f1.png' })).toBeInTheDocument()

  // List layout renders AlbumRow rows
  rerender(
    <QueryClientProvider client={client}>
      <AlbumItems
        items={items}
        scrollRef={scrollRef}
        layout="list"
        zoom={200}
        getAspect={albumFileAspect}
        navigationRef={navRef}
        render={(file) => (
          <AlbumRow
            file={file}
            selected={false}
            onSelect={vi.fn()}
            onOpen={vi.fn()}
            onContextMenu={vi.fn()}
            dragProps={fileDragProps(undefined, () => [])}
            catalog
          />
        )}
      />
    </QueryClientProvider>,
  )
  expect(screen.getAllByRole('row')).toHaveLength(4)
})
