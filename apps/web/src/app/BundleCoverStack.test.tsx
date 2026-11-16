import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { BundleCoverStack } from './BundleCoverStack'
import type { BundleCardItem } from './BundleCard'
vi.mock('../api/client', () => ({ thumbnailUrl: (id: string) => `/cover/${id}` }))

test('the selection stack bounds cover loads to three and handles missing covers', () => {
  const items = Array.from(
    { length: 100 },
    (_, index) => ({ id: String(index), has_cover: index !== 1 }) as BundleCardItem,
  )
  render(<BundleCoverStack items={items} />)
  const stack = screen.getByRole('img', { name: 'Selected bundle covers' })
  expect(stack.querySelectorAll('.bundle-cover-stack__card')).toHaveLength(3)
  expect([...stack.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual([
    '/cover/0',
    '/cover/2',
  ])
})
