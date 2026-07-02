import { expect, test, type Page } from '@playwright/test'

// Hermetic mocks for the collection/bundle ordering features: Manual sort +
// "Clean up by…", folder-card context menu, and the flatten-on-show-contents
// toggle. No backend required — API calls are intercepted, and reorder/cleanup
// requests are captured to prove the UI wires through.

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
  collectionReorder: Array<Record<string, unknown>>
}

async function mockApi(page: Page): Promise<Captured> {
  const captured: Captured = { bundleCleanup: [], collectionReorder: [] }

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
  await page.route('**/collections/reorder', async (r) => {
    captured.collectionReorder.push(r.request().postDataJSON() as Record<string, unknown>)
    await r.fulfill({ json: [] })
  })
  await page.route('**/tags?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))

  await page.route('**/bundles/cleanup-order', async (r) => {
    captured.bundleCleanup.push(r.request().postDataJSON() as Record<string, unknown>)
    await r.fulfill({ status: 204, body: '' })
  })

  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({
      json: {
        items: [
          summary('b0', 'Bundle 0'),
          summary('b1', 'Bundle 1'),
          summary('b2', 'Bundle 2'),
          summary('b3', 'Bundle 3'),
        ],
        total: 4,
        offset: 0,
        limit: 100,
      },
    }),
  )
  await page.route('**/smart-collections', (r) => r.fulfill({ json: [] }))

  return captured
}

test('Manual sort exposes "Clean up…" and cleans up bundle order', async ({ page }) => {
  const captured = await mockApi(page)
  await page.goto('/')

  await expect(page.locator('.toolbar__title')).toHaveText('All')
  // Switch to Manual sort → the toolbar "Clean up…" affordance appears.
  await page.getByLabel('Sort by').selectOption('manual')
  const cleanup = page.locator('.toolbar button', { hasText: 'Clean up…' })
  await expect(cleanup).toBeVisible()

  // Open the dialog, pick a sort, confirm → POST /bundles/cleanup-order fires.
  await cleanup.click()
  await page.getByLabel('Clean-up order').selectOption('title:desc')
  await page.getByRole('button', { name: 'Clean up', exact: true }).click()

  await expect.poll(() => captured.bundleCleanup.length).toBe(1)
  expect(captured.bundleCleanup[0]).toMatchObject({ sort: 'title', order: 'desc' })
})

test('Shift-click selects a range of bundles', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  const cards = page.locator('[data-bundle-id]')
  await cards.nth(0).click()
  await cards.nth(2).click({ modifiers: ['Shift'] })
  // Anchor (0) → shift (2) inclusive = three cards selected.
  await expect(page.locator('.card--selected')).toHaveCount(3)
})

test('folder card has a Delete Collection context menu', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  await page.locator('.collcard__grid [data-collection-id]').first().click({ button: 'right' })
  await expect(page.locator('.context-menu__item', { hasText: 'Delete Collection' })).toBeVisible()
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
