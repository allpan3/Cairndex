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
  await page.route('**/auth/status', (r) =>
    r.fulfill({ json: { protected: false, unlocked: true } }),
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

test('switching libraries replaces the browser shell without a reload', async ({ page }) => {
  const libraries = [
    { id: 'lib1', name: 'Library One', root_path: '/srv/one', status: 'available' },
    { id: 'lib2', name: 'Library Two', root_path: '/srv/two', status: 'available' },
  ]
  const item = (libraryId: string) => ({
    id: `${libraryId}-bundle`,
    title: libraryId === 'lib1' ? 'First Library Movie' : 'Second Library Movie',
    rating: null,
    file_count: 1,
    total_size: 100,
    has_missing: false,
    has_cover: false,
    media_kind: 'video',
    width: 1920,
    height: 1080,
    duration: 60,
    extension: 'mp4',
    date_added: '2026-07-10T00:00:00Z',
  })
  const libraryFrom = (url: string) => (url.includes('/lib2/') ? 'lib2' : 'lib1')

  await page.route('**/api/v1/libraries', (route) => route.fulfill({ json: libraries }))
  await page.route('**/auth/status', (route) =>
    route.fulfill({ json: { protected: false, unlocked: true } }),
  )
  await page.route('**/bundles/counts**', (route) =>
    route.fulfill({ json: { all: 1, recent: 1, uncategorized: 1, untagged: 1, missing: 0 } }),
  )
  await page.route('**/collections/counts**', (route) => route.fulfill({ json: { counts: {} } }))
  await page.route('**/collections?*', (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  )
  await page.route('**/smart-collections', (route) => route.fulfill({ json: [] }))
  await page.route('**/bundles/browse**', (route) => {
    const libraryId = libraryFrom(route.request().url())
    route.fulfill({ json: { items: [item(libraryId)], total: 1, offset: 0, limit: 100 } })
  })

  await page.addInitScript(() => localStorage.removeItem('cairndex.libraryId'))
  await page.goto('/')
  await expect(page.getByText('First Library Movie')).toBeVisible()

  await page.getByRole('combobox', { name: 'Library' }).selectOption('lib2')
  await expect(page.getByRole('combobox', { name: 'Library' })).toHaveValue('lib2')
  await expect(page.getByText('Second Library Movie')).toBeVisible()
  await expect(page.getByText('First Library Movie')).toHaveCount(0)
})
