import { expect, test, type Page } from '@playwright/test'

// Hermetic mock for the Eagle import dialog: preview then commit.

async function mockApi(page: Page) {
  await page.route('**/api/v1/bundles/counts', (r) =>
    r.fulfill({ json: { all: 0, recent: 0, uncategorized: 0, untagged: 0, missing: 0 } }),
  )
  await page.route('**/api/v1/bundles/browse**', (r) =>
    r.fulfill({ json: { items: [], total: 0, offset: 0, limit: 100 } }),
  )
  await page.route('**/api/v1/folders?*', (r) =>
    r.fulfill({ json: { items: [], next_cursor: null } }),
  )
  await page.route('**/api/v1/folders/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/api/v1/tags?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/api/v1/smart-folders', (r) => r.fulfill({ json: [] }))

  await page.route('**/api/v1/eagle/preview', (r) =>
    r.fulfill({
      json: {
        library_path: '/lib/My.library',
        total_items: 12,
        new_bundles: 10,
        skipped_existing: 1,
        skipped_deleted: 1,
        folders: 3,
        tags: 5,
        tag_groups: 2,
        merge_suggestions: [{ reason: 'two parts', item_ids: ['a', 'b'] }],
        warnings: [],
      },
    }),
  )
  await page.route('**/api/v1/eagle/import', (r) =>
    r.fulfill({
      json: {
        bundles_created: 10,
        folders_created: 3,
        tags_created: 5,
        tag_groups_created: 2,
        skipped: 2,
      },
    }),
  )
}

test('previews then imports an Eagle library', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  await page.getByRole('button', { name: 'Import from Eagle' }).click()
  await page.getByLabel('Eagle library path').fill('/lib/My.library')
  await page.getByRole('button', { name: 'Preview' }).click()

  // The dry-run report shows what would happen.
  await expect(page.locator('.import-report')).toContainText('10')
  await expect(page.locator('.import-report__hint')).toContainText('merge suggestion')

  await page.getByRole('button', { name: /Import 10 bundles/ }).click()
  await expect(page.locator('.import-report--done')).toContainText('Imported 10 bundles')
})
