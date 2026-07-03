import { expect, test, type Page } from '@playwright/test'

// Hermetic mocks for the collection/bundle ordering features: the sort-control
// popover (Manual default + per-collection scope), the folder-card context menu,
// the flatten-on-show-contents toggle, and the bundle "Clean up…" context-menu
// action. No backend required — API calls are intercepted; sort params and
// cleanup requests are captured to prove the UI wires through.

function summary(id: string, title: string) {
  return {
    id,
    title,
    rating: null,
    file_count: 1,
    total_size: 0,
    has_missing: false,
    has_cover: false,
    cover_key: null,
    media_kind: null,
    width: null,
    height: null,
    duration: null,
    extension: 'mp4',
    date_added: '2026-06-25T00:00:00Z',
    grouping_state: 'confirmed',
  }
}

function coll(id: string, name: string, parentId: string | null, sortOrder: number) {
  return {
    id,
    parent_id: parentId,
    name,
    note: null,
    cover_bundle_id: null,
    sort_order: sortOrder,
    created_at: 'x',
    updated_at: 'x',
    version: 1,
  }
}

interface Captured {
  bundleCleanup: Array<Record<string, unknown>>
  sorts: string[]
}

async function mockApi(page: Page): Promise<Captured> {
  const captured: Captured = { bundleCleanup: [], sorts: [] }

  // Two roots; the first has two subcollections, the deeper one has a grandchild
  // (so flattening a subtree surfaces more than the direct children).
  const collections = [
    coll('root-a', 'Root A', null, 0),
    coll('root-b', 'Root B', null, 1),
    coll('sub-a1', 'Sub A1', 'root-a', 0),
    coll('sub-a2', 'Sub A2', 'root-a', 1),
    coll('sub-a1x', 'Sub A1 Child', 'sub-a1', 0),
  ]

  await page.route('**/api/v1/libraries', (r) =>
    r.fulfill({
      json: [{ id: 'lib1', name: 'Test Library', root_path: '/srv/lib', status: 'available' }],
    }),
  )
  await page.route('**/bundles/counts', (r) =>
    r.fulfill({
      json: { all: 3, recent: 3, uncategorized: 3, untagged: 3, missing: 0, unbundled: 0 },
    }),
  )
  await page.route('**/collections?*', (r) =>
    r.fulfill({ json: { items: collections, next_cursor: null } }),
  )
  await page.route('**/collections/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/collections/cleanup-order', (r) => r.fulfill({ status: 204, body: '' }))
  await page.route('**/collections/reorder', (r) => r.fulfill({ json: [] }))
  await page.route('**/tags?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))

  await page.route('**/bundles/cleanup-order', async (r) => {
    captured.bundleCleanup.push(r.request().postDataJSON() as Record<string, unknown>)
    await r.fulfill({ status: 204, body: '' })
  })

  await page.route('**/bundles/browse**', (r) => {
    const sort = new URL(r.request().url()).searchParams.get('sort')
    if (sort) captured.sorts.push(sort)
    r.fulfill({
      json: {
        items: [summary('b0', 'Bundle 0'), summary('b1', 'Bundle 1'), summary('b2', 'Bundle 2')],
        total: 3,
        offset: 0,
        limit: 100,
      },
    })
  })
  await page.route('**/smart-collections', (r) => r.fulfill({ json: [] }))

  return captured
}

test('sort control defaults to Manual and changes the sort', async ({ page }) => {
  const captured = await mockApi(page)
  await page.goto('/')
  await expect(page.locator('.toolbar__title')).toHaveText('All')

  // The sort button shows the active sort — Manual by default.
  const sortBtn = page.getByRole('button', { name: 'Sort' })
  await expect(sortBtn).toContainText('Manual')

  // Open the pane and switch to Title → a browse request goes out with sort=title.
  await sortBtn.click()
  await page.locator('.sortctl__opt', { hasText: 'Title' }).click()
  await expect.poll(() => captured.sorts.includes('title')).toBe(true)
  await expect(sortBtn).toContainText('Title')
})

test('sort pane offers a per-collection scope toggle', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  await page.getByRole('button', { name: 'Sort' }).click()
  const scope = page.getByLabel('Remember sort per collection')
  await expect(scope).not.toBeChecked()
  await scope.check()
  await expect(scope).toBeChecked()
})

test('Shift-click selects a range of bundles', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  const cards = page.locator('[data-bundle-id]')
  await cards.nth(0).click()
  await cards.nth(2).click({ modifiers: ['Shift'] })
  await expect(page.locator('.card--selected')).toHaveCount(3)
})

test('folder card has a Delete Collection context menu', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  await page.locator('.collcard__grid [data-collection-id]').first().click({ button: 'right' })
  await expect(page.locator('.context-menu__item', { hasText: 'Delete Collection' })).toBeVisible()
})

test('bundle "Clean up…" lives in the empty-space context menu', async ({ page }) => {
  const captured = await mockApi(page)
  await page.goto('/')

  // Enter a collection first — bundle "Clean Up Order" applies to a scoped list
  // (a collection's own bundles), not the flattened All view where it's disabled.
  await page.locator('.collcard__grid [data-collection-id]').first().dblclick()
  await expect(page.locator('[data-bundle-id]').first()).toBeVisible()
  // Right-click empty grid space (the .browser root, not a card) → Clean Up Order.
  await page.evaluate(() => {
    const el = document.querySelector('.browser') as HTMLElement
    const r = el.getBoundingClientRect()
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: r.left + 8,
        clientY: r.bottom - 8,
      }),
    )
  })
  await page.locator('.context-menu__item', { hasText: 'Clean Up Order' }).click()
  await page.getByLabel('Clean-up order').selectOption('title:desc')
  await page.getByRole('button', { name: 'Clean up', exact: true }).click()

  await expect.poll(() => captured.bundleCleanup.length).toBe(1)
  expect(captured.bundleCleanup[0]).toMatchObject({ sort: 'title', order: 'desc' })
})

test('"Show subcollection contents" flattens descendant collections', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  // Into Root A (sidebar) → its two direct subcollections show.
  await page.locator('.collection-row', { hasText: 'Root A' }).first().click()
  await expect(page.locator('.collsec__title').first()).toContainText('Subcollections (2)')

  // Flatten: the grandchild (Sub A1 Child) now also surfaces → 3 folder cards.
  await page.getByText('Show subcollection contents').click()
  await expect(page.locator('.collsec__title').first()).toContainText('Subcollections (3)')
  await expect(page.locator('.collcard__name', { hasText: 'Sub A1 Child' })).toBeVisible()
})
