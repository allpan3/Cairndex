import { expect, test, type Page } from '@playwright/test'

// Hermetic e2e: the API is mocked so the desktop library UI can be exercised
// in a real browser (where the virtualized grid actually lays out) without a
// running backend.

function bundle(i: number) {
  return {
    id: `b${i}`,
    title: `Movie ${i}`,
    rating: i % 5,
    file_count: 1,
    total_size: 1_000_000 * (i + 1),
    has_missing: false,
    has_cover: false,
    media_kind: 'video',
    width: 1920,
    height: 1080,
    duration: 60 + i,
    extension: 'mp4',
    date_added: '2026-06-25T00:00:00Z',
  }
}

async function mockApi(page: Page) {
  const items = Array.from({ length: 40 }, (_, i) => bundle(i))
  await page.route('**/api/v1/libraries', (r) =>
    r.fulfill({
      json: [{ id: 'lib1', name: 'Test Library', root_path: '/srv/lib', status: 'available' }],
    }),
  )
  await page.route('**/bundles/counts', (r) =>
    r.fulfill({ json: { all: 40, recent: 40, uncategorized: 5, untagged: 3, missing: 0 } }),
  )
  await page.route('**/collections/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/collections?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({ json: { items, total: items.length, offset: 0, limit: 100 } }),
  )
  await page.route('**/bundles/b0**', (r) => {
    const url = r.request().url()
    if (url.includes('/files')) {
      r.fulfill({
        json: [
          {
            id: 'f0',
            bundle_id: 'b0',
            storage_root_id: 'r0',
            relative_path: 'movie.mp4',
            original_filename: 'movie.mp4',
            display_title: 'movie.mp4',
            role: 'primary_video',
            media_kind: 'video',
            mime_type: null,
            sequence: 0,
            size_bytes: 1000,
            availability: 'available',
            tech_metadata: { width: 1920, height: 1080, duration: 60 },
            created_at: '2026-06-25T00:00:00Z',
            updated_at: '2026-06-25T00:00:00Z',
          },
        ],
      })
    } else {
      r.fulfill({
        json: {
          id: 'b0',
          title: 'Movie 0',
          note: null,
          source_url: null,
          rating: 0,
          cover_file_id: null,
          primary_file_id: null,
          created_at: '2026-06-25T00:00:00Z',
          imported_at: '2026-06-25T00:00:00Z',
          updated_at: '2026-06-25T00:00:00Z',
        },
      })
    }
  })
}

test('renders the shell and browses bundles', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  await expect(page.getByText('Cairndex')).toBeVisible()
  await expect(page.getByRole('button', { name: /Recently Added/ })).toBeVisible()
  // Grid renders cards from the mocked browse response.
  await expect(page.getByText('Movie 0')).toBeVisible()
  await expect(page.getByText('40 items')).toBeVisible()
})

test('selecting a bundle opens the inspector', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.locator('.card').first().click()
  // Inspector shows the bundle's (editable) title + its files.
  await expect(page.locator('.inspector input[aria-label="Title"]')).toHaveValue('Movie 0')
  await expect(page.getByText('movie.mp4')).toBeVisible()
})

test('right-clicking a bundle deletes it via the context menu', async ({ page }) => {
  await mockApi(page)
  let deleted: string | null = null
  await page.route('**/bundles/b0', (r) => {
    if (r.request().method() === 'DELETE') {
      deleted = 'b0'
      return r.fulfill({ status: 204, body: '' })
    }
    return r.fallback()
  })
  // The delete action asks for confirmation first; accept it.
  page.on('dialog', (d) => d.accept())

  await page.goto('/')
  await page.locator('.card').first().click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Delete bundle' }).click()

  await expect.poll(() => deleted).toBe('b0')
})

test('layout choice persists across reload', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'List' }).click()
  await expect(page.getByText('Dimensions')).toBeVisible() // list header column

  await page.reload()
  // Still in list layout after reload (persisted to localStorage).
  await expect(page.getByText('Dimensions')).toBeVisible()
})
