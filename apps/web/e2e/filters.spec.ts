import { expect, test, type Page } from '@playwright/test'

// Hermetic mock for the ad-hoc toolbar Tags filter (Slice 1). No backend
// required: unfiltered browse (GET) returns 3 bundles, filtered browse (POST)
// returns 1, so the test proves the ad-hoc tag filter drove a filtered request.

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
    extension: null,
    date_added: '2026-06-25T00:00:00Z',
    grouping_state: 'confirmed',
  }
}

function tag(id: string, name: string) {
  return {
    id,
    parent_id: null,
    name,
    color: null,
    sort_order: 0,
    created_at: 'x',
    updated_at: 'x',
    version: 1,
  }
}

async function mockApi(
  page: Page,
): Promise<{ lastBrowsePost: () => Record<string, unknown> | null }> {
  let lastBrowsePost: Record<string, unknown> | null = null

  await page.route('**/api/v1/libraries', (r) =>
    r.fulfill({
      json: [{ id: 'lib1', name: 'Test Library', root_path: '/srv/lib', status: 'available' }],
    }),
  )
  await page.route('**/bundles/counts', (r) =>
    r.fulfill({
      json: { all: 3, recent: 3, uncategorized: 3, untagged: 1, missing: 0, unbundled: 0 },
    }),
  )
  await page.route('**/collections?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/collections/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/tag-groups?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/tags/counts', (r) => r.fulfill({ json: { counts: { t1: 2, t2: 1 } } }))
  await page.route('**/tags?*', (r) =>
    r.fulfill({ json: { items: [tag('t1', 'alpha'), tag('t2', 'beta')], next_cursor: null } }),
  )
  await page.route('**/smart-collections', (r) => r.fulfill({ json: [] }))

  // Faceted counts for the popover.
  await page.route('**/filters/facets', (r) =>
    r.fulfill({
      json: {
        tags: { t1: 2, t2: 1 },
        ratings: { '1': 0, '2': 0, '3': 1, '4': 1, '5': 1, unrated: 1 },
      },
    }),
  )

  await page.route('**/bundles/browse**', (r) => {
    const filtered = r.request().method() === 'POST'
    if (filtered) lastBrowsePost = r.request().postDataJSON() as Record<string, unknown>
    r.fulfill({
      json: {
        items: filtered
          ? [summary('b0', 'Alpha')]
          : [summary('b0', 'Alpha'), summary('b1', 'Beta'), summary('b2', 'Gamma')],
        total: filtered ? 1 : 3,
        offset: 0,
        limit: 100,
      },
    })
  })

  return { lastBrowsePost: () => lastBrowsePost }
}

test('ad-hoc Tags filter: left-click includes, right-click excludes', async ({ page }) => {
  const { lastBrowsePost } = await mockApi(page)
  await page.goto('/')

  await expect(page.locator('.toolbar__count')).toContainText('3 items')

  // Reveal the filter row and open the Tags popover.
  await page.getByRole('button', { name: 'Filters' }).click()
  await page.getByRole('button', { name: 'Filter by tags' }).click()

  // Left-click "alpha" to include it → filtered browse (1 item), badge shows 1.
  await page.locator('.tag-filter__row', { hasText: 'alpha' }).click()
  await expect(page.locator('.toolbar__count')).toContainText('1 items')
  await expect(page.locator('.filter-chip__badge')).toHaveText('1')

  // The filtered browse used contains_any with descendants (Any is the default rule).
  await expect
    .poll(() => JSON.stringify(lastBrowsePost()?.filter ?? null))
    .toContain('contains_any')

  // Right-click "beta" to exclude it → badge shows 2, row marked excluded.
  await page.locator('.tag-filter__row', { hasText: 'beta' }).click({ button: 'right' })
  await expect(page.locator('.filter-chip__badge')).toHaveText('2')
  await expect(page.locator('.tag-filter__row--exc')).toContainText('beta')
  await expect
    .poll(() => JSON.stringify(lastBrowsePost()?.filter ?? null))
    .toContain('contains_none')
})

test('ad-hoc Rating filter: star picker and Unrated', async ({ page }) => {
  const { lastBrowsePost } = await mockApi(page)
  await page.goto('/')

  await page.getByRole('button', { name: 'Filters' }).click()
  await page.getByRole('button', { name: 'Filter by rating' }).click()

  // Pick 4 stars → rating = 4 (Equal is the default operator), filtered browse.
  await page.getByRole('radio', { name: '4 stars' }).click()
  await expect(page.locator('.filter-chip__badge--text')).toHaveText('=4')
  await expect
    .poll(() => JSON.stringify(lastBrowsePost()?.filter ?? null))
    .toContain('"operator":"eq"')

  // Switch to Unrated → is_null filter.
  await page.getByRole('button', { name: 'Unrated' }).click()
  await expect(page.locator('.filter-chip__badge--text')).toHaveText('Unrated')
  await expect.poll(() => JSON.stringify(lastBrowsePost()?.filter ?? null)).toContain('is_null')

  // Clicking Unrated again clears the filter.
  await page.getByRole('button', { name: 'Unrated' }).click()
  await expect(page.locator('.filter-chip__badge--text')).toHaveCount(0)
})

test('Equal rule hides the subtags toggle', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  await page.getByRole('button', { name: 'Filters' }).click()
  await page.getByRole('button', { name: 'Filter by tags' }).click()

  await expect(page.locator('.tag-filter__desc')).toBeVisible()
  await page.locator('.tag-filter__rules button', { hasText: 'Equal' }).click()
  await expect(page.locator('.tag-filter__desc')).toHaveCount(0)
})
