import { expect, test, type Page } from '@playwright/test'

// Hermetic mock for the Phase 5 flow: build a filter, watch the live preview
// count, save a Smart Folder, and browse it. No backend required.

function summary(id: string, title: string) {
  return {
    id,
    title,
    rating: 5,
    file_count: 1,
    total_size: 0,
    has_missing: false,
    has_cover: false,
    media_kind: null,
    width: null,
    height: null,
    duration: null,
    extension: null,
    date_added: '2026-06-25T00:00:00Z',
  }
}

async function mockApi(page: Page) {
  const smartFolders: Array<Record<string, unknown>> = []

  await page.route('**/api/v1/bundles/counts', (r) =>
    r.fulfill({ json: { all: 3, recent: 3, uncategorized: 3, untagged: 3, missing: 0 } }),
  )
  await page.route('**/api/v1/folders?*', (r) =>
    r.fulfill({ json: { items: [], next_cursor: null } }),
  )
  await page.route('**/api/v1/folders/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/api/v1/tags?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))

  // Filtered (POST) vs. unfiltered (GET) browse return different totals so the
  // test can prove the Smart Folder actually filters.
  await page.route('**/api/v1/bundles/browse**', (r) => {
    const filtered = r.request().method() === 'POST'
    r.fulfill({
      json: {
        items: filtered ? [summary('b0', 'Movie 0')] : [summary('b0', 'A'), summary('b1', 'B')],
        total: filtered ? 1 : 2,
        offset: 0,
        limit: 100,
      },
    })
  })

  await page.route('**/api/v1/filters/preview', (r) => r.fulfill({ json: { count: 1 } }))

  await page.route('**/api/v1/smart-folders', async (r) => {
    if (r.request().method() === 'POST') {
      const body = r.request().postDataJSON() as Record<string, unknown>
      const sf = {
        id: 'sf1',
        name: body.name,
        filter: body.filter,
        default_sort: null,
        default_layout: null,
        sort_order: 0,
        created_at: 'x',
        updated_at: 'x',
      }
      smartFolders.push(sf)
      await r.fulfill({ status: 201, json: sf })
    } else {
      await r.fulfill({ json: smartFolders })
    }
  })
}

test('build, preview, save, and browse a Smart Folder', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  await page.getByRole('button', { name: 'New smart folder' }).click()
  await page.getByLabel('Smart folder name').fill('Highly rated')
  await page.getByLabel('Field').selectOption('rating')
  await page.getByLabel('Operator').selectOption('gte')
  await page.getByLabel('Value').fill('4')

  // Live count from POST /filters/preview.
  await expect(page.locator('.modal__preview')).toContainText('1 matching bundle')

  await page.getByRole('button', { name: 'Create' }).click()

  // The saved folder appears in the sidebar and drives a filtered browse.
  await expect(page.locator('.nav-item__label', { hasText: 'Highly rated' })).toBeVisible()
  await expect(page.locator('.toolbar__count')).toContainText('1 items')
})
