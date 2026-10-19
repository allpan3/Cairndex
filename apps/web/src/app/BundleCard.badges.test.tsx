import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { BundleCard, type BundleCardItem } from './BundleCard'

vi.mock('./HoverPreview', () => ({
  HoverPreview: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

test('grouping confirmation stays internal while type and missing badges remain', () => {
  const item = {
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
  const props = {
    selected: false,
    showMeta: true,
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onContextMenu: vi.fn(),
  }
  const view = render(<BundleCard item={item} {...props} />)
  expect(screen.queryByText(/^review$/i)).not.toBeInTheDocument()
  expect(screen.getByText('MP4')).toBeInTheDocument()
  view.rerender(<BundleCard item={{ ...item, has_missing: true }} {...props} />)
  expect(screen.getByText('missing')).toBeInTheDocument()
  expect(screen.queryByText('MP4')).not.toBeInTheDocument()
  expect(screen.queryByText(/^review$/i)).not.toBeInTheDocument()
})
