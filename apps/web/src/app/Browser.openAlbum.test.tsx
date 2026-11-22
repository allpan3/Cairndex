import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { BundleCardItem } from './BundleCard'
import { Browser } from './Browser'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: index,
        index,
        start: index * 40,
        size: 40,
      })),
    measure: vi.fn(),
    scrollToIndex: vi.fn(),
  }),
}))

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const item = (id: string, title: string, fileCount: number): BundleCardItem =>
  ({
    id,
    title,
    file_count: fileCount,
    has_cover: false,
    has_missing: false,
    total_size: 120,
    date_added: '2026-01-01T00:00:00Z',
    extension: 'MP4',
    media_kind: 'video',
    width: 320,
    height: 180,
    size_known: true,
  }) as unknown as BundleCardItem

test('list layout renders Open bundle triggers for multi-file and single-file rows without triggering row select or open', () => {
  const onSelect = vi.fn()
  const onOpen = vi.fn()
  const onOpenAlbum = vi.fn()
  render(
    <Browser
      items={[item('b-multi', 'Synthetic multi', 5), item('b-single', 'Synthetic single', 1)]}
      total={2}
      layout="list"
      zoom={100}
      sort="manual"
      order="asc"
      onSort={vi.fn()}
      selectedIds={new Set()}
      onSelect={onSelect}
      onMarqueeSelect={vi.fn()}
      onOpen={onOpen}
      onOpenAlbum={onOpenAlbum}
      onContextMenu={vi.fn()}
      isLoading={false}
      isError={false}
      hasNextPage={false}
      isFetchingNextPage={false}
      fetchNextPage={vi.fn()}
    />,
  )
  const multi = screen.getByRole('button', { name: 'Open bundle (5 files)' })
  expect(multi).toHaveClass('list-row__open')
  expect(multi).not.toHaveClass('list-row__open--hover')
  expect(multi).toHaveTextContent('5')

  const single = screen.getByRole('button', { name: 'Open bundle' })
  expect(single).toHaveClass('list-row__open--hover')

  fireEvent.mouseDown(multi)
  fireEvent.click(multi)
  fireEvent.doubleClick(multi)
  expect(onOpenAlbum).toHaveBeenCalledExactlyOnceWith('b-multi')
  expect(onSelect).not.toHaveBeenCalled()
  expect(onOpen).not.toHaveBeenCalled()

  fireEvent.keyDown(single, { key: 'Enter' })
  expect(onOpenAlbum).toHaveBeenCalledTimes(2)
  expect(onOpenAlbum).toHaveBeenLastCalledWith('b-single')
})
