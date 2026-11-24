import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { BundleCard, type BundleCardItem } from './BundleCard'

vi.mock('./HoverPreview', () => ({
  HoverPreview: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

const baseItem = {
  id: 'synthetic',
  title: 'Synthetic bundle',
  grouping_state: 'provisional',
  extension: 'MP4',
  has_missing: false,
  has_cover: false,
  file_count: 1,
  media_kind: 'video',
  width: null,
  height: null,
} as BundleCardItem

test('grouping confirmation stays internal while type and missing badges remain', () => {
  const props = {
    selected: false,
    showMeta: true,
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onContextMenu: vi.fn(),
  }
  const view = render(<BundleCard item={baseItem} {...props} />)
  expect(screen.queryByText(/^review$/i)).not.toBeInTheDocument()
  expect(screen.getByText('MP4')).toBeInTheDocument()
  view.rerender(<BundleCard item={{ ...baseItem, has_missing: true }} {...props} />)
  expect(screen.getByText('missing')).toBeInTheDocument()
  expect(screen.queryByText('MP4')).not.toBeInTheDocument()
  expect(screen.queryByText(/^review$/i)).not.toBeInTheDocument()
})

test('Open bundle trigger distinguishes single vs multi-file cards and stops card selection or media open', () => {
  const onSelect = vi.fn()
  const onOpen = vi.fn()
  const onOpenAlbum = vi.fn()
  const view = render(
    <BundleCard
      item={{ ...baseItem, file_count: 4 }}
      selected={false}
      showMeta={true}
      onSelect={onSelect}
      onOpen={onOpen}
      onOpenAlbum={onOpenAlbum}
      onContextMenu={vi.fn()}
    />,
  )
  const countBtn = screen.getByRole('button', { name: 'Open bundle (4 files)' })
  expect(countBtn).toHaveClass('card__open--count')
  expect(countBtn).toHaveTextContent('4')
  fireEvent.mouseDown(countBtn)
  fireEvent.click(countBtn)
  fireEvent.doubleClick(countBtn)
  expect(onOpenAlbum).toHaveBeenCalledExactlyOnceWith('synthetic')
  expect(onSelect).not.toHaveBeenCalled()
  expect(onOpen).not.toHaveBeenCalled()

  fireEvent.keyDown(countBtn, { key: 'Enter' })
  fireEvent.keyDown(countBtn, { key: ' ' })
  expect(onOpenAlbum).toHaveBeenCalledTimes(3)

  view.rerender(
    <BundleCard
      item={{ ...baseItem, file_count: 1 }}
      selected={false}
      showMeta={true}
      onSelect={onSelect}
      onOpen={onOpen}
      onOpenAlbum={onOpenAlbum}
      onContextMenu={vi.fn()}
    />,
  )
  const singleBtn = screen.getByRole('button', { name: 'Open bundle' })
  expect(singleBtn).toHaveClass('card__open--hover')

  view.rerender(
    <BundleCard
      item={{ ...baseItem, file_count: 3 }}
      selected={false}
      showMeta={true}
      onSelect={onSelect}
      onOpen={onOpen}
      onContextMenu={vi.fn()}
    />,
  )
  expect(screen.queryByRole('button', { name: /Open bundle/ })).not.toBeInTheDocument()
  expect(screen.getByText('3')).toBeInTheDocument()
})

test('a Justified tile labels its cover with the size it knows, and no placeholder dash', () => {
  const props = {
    selected: false,
    showMeta: true,
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onContextMenu: vi.fn(),
  }
  const view = render(
    <BundleCard item={{ ...baseItem, duration: 4 }} layout="justified" {...props} />,
  )
  const card = view.container.querySelector('.card')!
  expect(card).toHaveClass('card--justified')
  expect(card).not.toHaveClass('card--framed')
  // Duration is already on the tile, and the size is unknown: the line stays blank
  expect(card.querySelector('.card__sub')).toHaveTextContent(/^$/)
  view.rerender(
    <BundleCard item={{ ...baseItem, width: 1280, height: 720 }} layout="justified" {...props} />,
  )
  expect(card.querySelector('.card__sub')).toHaveTextContent('1280 × 720')
})
