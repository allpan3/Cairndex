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

function jobRead(over: Record<string, unknown>) {
  return {
    id: 'job',
    library_id: 'lib1',
    job_type: 'scan',
    status: 'running',
    phase: null,
    message: null,
    payload: {},
    processed: 0,
    total: null,
    result: null,
    error: null,
    cancel_requested: false,
    created_at: '2026-06-25T00:00:00Z',
    started_at: '2026-06-25T00:00:00Z',
    finished_at: null,
    ...over,
  }
}

test('Update surfaces live job progress with phase and counts', async ({ page }) => {
  await mockApi(page)
  // Scan job: enqueue returns a running snapshot, then polling completes it.
  let scanPolls = 0
  await page.route('**/jobs/scan', (r) =>
    r.fulfill({
      json: jobRead({ id: 'job-scan', phase: 'discovering', processed: 42, total: 100 }),
    }),
  )
  await page.route('**/jobs/probe', (r) =>
    r.fulfill({
      json: jobRead({ id: 'job-probe', job_type: 'probe', status: 'succeeded', result: {} }),
    }),
  )
  await page.route('**/api/v1/jobs/job-scan', (r) => {
    scanPolls += 1
    const done = scanPolls >= 2
    r.fulfill({
      json: jobRead({
        id: 'job-scan',
        status: done ? 'succeeded' : 'running',
        phase: done ? null : 'discovering',
        processed: done ? 100 : 42,
        total: 100,
        result: done ? { grouping_proposal_count: 0 } : null,
        finished_at: done ? '2026-06-25T00:01:00Z' : null,
      }),
    })
  })
  await page.route('**/api/v1/jobs/job-probe', (r) =>
    r.fulfill({
      json: jobRead({ id: 'job-probe', job_type: 'probe', status: 'succeeded', result: {} }),
    }),
  )

  await page.goto('/')
  await page.getByRole('button', { name: /Update/ }).click()

  // The progress bar with the current phase + determinate count is visible while running.
  await expect(page.getByRole('progressbar')).toBeVisible()
  await expect(page.getByText('Discovering files')).toBeVisible()
  await expect(page.getByText('42/100')).toBeVisible()
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

  await page.goto('/')
  await page.locator('.card').first().click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Delete Bundle' }).click()

  // Confirm in the styled dialog; the "delete files" box is off by default.
  const dialog = page.getByRole('dialog', { name: 'Delete bundle' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('checkbox')).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Delete' }).click()

  await expect.poll(() => deleted).toBe('b0')
})

test('deleting a collection offers a subcollections choice', async ({ page }) => {
  await mockApi(page)
  const collections = [
    { id: 'c1', name: 'Movies', parent_id: null },
    { id: 'c2', name: 'Action', parent_id: 'c1' },
  ]
  await page.route('**/collections?*', (r) =>
    r.fulfill({ json: { items: collections, next_cursor: null } }),
  )
  await page.route('**/collections/counts', (r) =>
    r.fulfill({ json: { counts: { c1: 2, c2: 1 } } }),
  )
  let deleteUrl: string | null = null
  await page.route('**/collections/c1*', (r) => {
    if (r.request().method() === 'DELETE') {
      deleteUrl = r.request().url()
      return r.fulfill({ status: 204, body: '' })
    }
    return r.fallback()
  })

  await page.goto('/')
  await page.getByText('Movies').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete Collection' }).click()

  const dialog = page.getByRole('dialog', { name: 'Delete Collection' })
  await expect(dialog).toBeVisible()
  // The subcollections checkbox is offered and checked by default.
  await expect(dialog.getByRole('checkbox')).toBeChecked()
  await dialog.getByRole('button', { name: 'Delete' }).click()

  // Confirming with the box checked cascades to subcollections.
  await expect.poll(() => deleteUrl).toContain('cascade=true')
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
