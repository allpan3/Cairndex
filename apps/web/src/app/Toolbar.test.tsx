import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { Toolbar } from './Toolbar'
import type { AdHocFilters, FacetContext } from './adHocFilters'
import { DEFAULT_PREFS } from './types'

const filters: AdHocFilters = {
  tags: { rule: 'any', includeDescendants: true, include: [], exclude: [] },
  rating: null,
}

const facetContext: FacetContext = {
  view: 'all',
  collectionId: null,
  includeDescendants: false,
  q: null,
  smartFilter: null,
}

function renderToolbar(overrides: { onReshuffle?: () => void } = {}) {
  render(
    <Toolbar
      title="All"
      total={1500}
      search=""
      onSearch={vi.fn()}
      prefs={DEFAULT_PREFS}
      onPrefs={vi.fn()}
      sort="manual"
      order="asc"
      onSort={vi.fn()}
      perCollectionSort={false}
      onPerCollectionSort={vi.fn()}
      adHocFilters={filters}
      onAdHocFilters={vi.fn()}
      facetContext={facetContext}
      {...overrides}
    />,
  )
}

/** Left-to-right order of the toolbar's own children, by accessible name. */
function toolbarOrder(): string[] {
  const bar = document.querySelector('.toolbar')
  if (!bar) throw new Error('expected a toolbar')
  return [...bar.children].map((el) => el.getAttribute('aria-label') ?? el.className)
}

test('an action sits left of every resident control', () => {
  renderToolbar({ onReshuffle: vi.fn() })
  const order = toolbarOrder()

  // Reshuffle used to occupy the sort control's slot, which put it between the
  // search box and the layout buttons — in the middle of the row, where an
  // action appearing shifts the furniture around it (owner, 2026-08-23).
  expect(order.indexOf('Reshuffle')).toBeGreaterThan(-1)
  expect(order.indexOf('Reshuffle')).toBeLessThan(order.indexOf('Filters'))
  expect(order.indexOf('Filters')).toBeLessThan(order.indexOf('Search'))
  expect(order.indexOf('Search')).toBeLessThan(order.indexOf('Layout'))
})

test('Random offers no sort, because sorting is the one thing it is not', () => {
  renderToolbar({ onReshuffle: vi.fn() })

  expect(screen.getByRole('button', { name: 'Reshuffle' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Sort/ })).not.toBeInTheDocument()
})

test('every other view keeps its sort control and shows no action', () => {
  renderToolbar()
  const order = toolbarOrder()

  expect(screen.queryByRole('button', { name: 'Reshuffle' })).not.toBeInTheDocument()
  // The residents keep their places whether or not a view contributes an action.
  expect(order.indexOf('Filters')).toBeLessThan(order.indexOf('Search'))
  expect(order.indexOf('Search')).toBeLessThan(order.indexOf('Layout'))
})

test('each layout offers a drawn icon rather than a box-drawing glyph', () => {
  renderToolbar()

  // ▦ and ▥ stood for Card and Justified, and at 15px they were near
  // indistinguishable — neither said anything about the layout it selected
  // (owner, 2026-08-23). The icons draw what each layout does, so the pair reads
  // as a contrast: equal tiles against variable-width ones.
  for (const name of ['Card', 'Justified', 'List']) {
    const button = screen.getByRole('button', { name })
    expect(button.querySelector('svg'), name).not.toBeNull()
    expect(button.textContent, name).toBe('')
  }
})
