import { expect, test, type Page } from '@playwright/test'

// Hermetic mock for adding a library (storage root) with path autocomplete.
// No backend required.

async function mockApi(page: Page) {
  const roots: Array<Record<string, unknown>> = []

  await page.route('**/api/v1/bundles/counts', (r) =>
    r.fulfill({ json: { all: 0, recent: 0, uncategorized: 0, untagged: 0, missing: 0 } }),
  )
  await page.route('**/api/v1/collections?*', (r) =>
    r.fulfill({ json: { items: [], next_cursor: null } }),
  )
  await page.route('**/api/v1/collections/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/api/v1/smart-collections', (r) => r.fulfill({ json: [] }))
  await page.route('**/api/v1/bundles/browse**', (r) =>
    r.fulfill({ json: { items: [], total: 0, offset: 0, limit: 100 } }),
  )

  // Directory autocomplete.
  await page.route('**/api/v1/storage-roots/path-suggestions**', (r) =>
    r.fulfill({ json: { suggestions: ['/mnt/media', '/mnt/music'] } }),
  )
  // Any entries call (after the new root auto-selects) → empty listing.
  await page.route('**/api/v1/storage-roots/*/entries**', (r) =>
    r.fulfill({ json: { root_id: 'r1', path: '', entries: [] } }),
  )

  // Storage-roots list (mutable) + create.
  await page.route('**/api/v1/storage-roots?*', (r) =>
    r.fulfill({ json: { items: roots, next_cursor: null } }),
  )
  await page.route('**/api/v1/storage-roots', async (r) => {
    if (r.request().method() === 'POST') {
      const body = r.request().postDataJSON() as Record<string, unknown>
      const root = {
        id: 'r1',
        name: body.name,
        canonical_path: body.canonical_path,
        read_only: true,
        status: 'available',
        created_at: 'x',
        updated_at: 'x',
        last_scanned_at: null,
      }
      roots.push(root)
      await r.fulfill({ status: 201, json: root })
    } else {
      await r.fulfill({ json: { items: roots, next_cursor: null } })
    }
  })
}

test('adds a library via the path-autocomplete form', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  // With no libraries, File View offers a CTA that opens the manager.
  await page.getByRole('tab', { name: 'Files' }).click()
  await page.getByRole('button', { name: 'Add a library' }).click()

  // Name + path (with an autocomplete suggestion the user clicks).
  await page.getByLabel('Library name').fill('NAS Media')
  await page.getByLabel('Library path').fill('/mnt')
  await page.getByRole('option', { name: '/mnt/media' }).click()
  await expect(page.getByLabel('Library path')).toHaveValue('/mnt/media')

  await page.getByRole('button', { name: 'Add library' }).click()

  // The new library shows in the manager list with an availability badge.
  await expect(page.locator('.lib-row__name', { hasText: 'NAS Media' })).toBeVisible()
  await expect(page.locator('.lib-row', { hasText: 'NAS Media' })).toContainText('available')
})
