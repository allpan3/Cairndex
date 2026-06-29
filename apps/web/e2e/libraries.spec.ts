import { expect, test, type Page } from '@playwright/test'

// Hermetic mock for creating a library with path autocomplete (ADR-0008).
// With no libraries, the app shows an empty shell; clicking "+" opens the
// manager, and creating one transitions into the workspace. No backend required.

async function mockApi(page: Page) {
  const libraries: Array<Record<string, unknown>> = []

  await page.route('**/bundles/counts**', (r) =>
    r.fulfill({ json: { all: 0, recent: 0, uncategorized: 0, untagged: 0, missing: 0 } }),
  )
  await page.route('**/collections?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/collections/counts**', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/smart-collections', (r) => r.fulfill({ json: [] }))
  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({ json: { items: [], total: 0, offset: 0, limit: 100 } }),
  )

  // Directory autocomplete.
  await page.route('**/path-suggestions**', (r) =>
    r.fulfill({ json: { suggestions: ['/mnt/media', '/mnt/music'] } }),
  )

  // Create a new library.
  await page.route('**/api/v1/libraries/create', async (r) => {
    const body = r.request().postDataJSON() as Record<string, unknown>
    const lib = {
      id: 'lib1',
      library_uuid: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      name: body.display_name,
      root_path: body.root_path,
      status: 'available',
      schema_version: 1,
      created_at: 'x',
      updated_at: 'x',
      last_opened_at: null,
    }
    libraries.push(lib)
    await r.fulfill({ status: 201, json: lib })
  })

  // Libraries list (mutable).
  await page.route('**/api/v1/libraries', (r) => r.fulfill({ json: libraries }))
}

test('creates a library via the path-autocomplete form', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  // No libraries yet → empty shell. Open the manager from the sidebar "+".
  await expect(page.locator('.center')).toContainText('No library yet')
  await page.getByRole('button', { name: 'Manage libraries' }).click()

  // Fill the create form.
  await page.getByLabel('Library name').fill('NAS Media')
  await page.getByLabel('Library path').fill('/mnt')
  await page.getByRole('option', { name: '/mnt/media' }).click()
  await expect(page.getByLabel('Library path')).toHaveValue('/mnt/media')

  await page.getByRole('button', { name: 'Create library' }).click()

  // After creation the app transitions into the workspace with the new library
  // selected in the sidebar.
  await expect(page.locator('.sidebar__library-select')).toHaveValue('lib1')
  await expect(page.locator('.sidebar__library-select')).toContainText('NAS Media')
})
