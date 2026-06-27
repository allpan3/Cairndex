import { expect, test, type Page } from '@playwright/test'

// Hermetic, stateful mock so editing flows (rating, tag assignment, multi-
// select) can be exercised end-to-end without a backend.

function summary(id: string, title: string) {
  return {
    id,
    title,
    rating: 0,
    file_count: 0,
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
  const state = {
    bundle: {
      id: 'b0',
      title: 'Movie 0',
      note: null as string | null,
      source_url: null as string | null,
      rating: 0 as number | null,
      cover_file_id: null,
      primary_file_id: null,
      created_at: '2026-06-25T00:00:00Z',
      imported_at: '2026-06-25T00:00:00Z',
      updated_at: '2026-06-25T00:00:00Z',
    },
    tagIds: [] as string[],
  }

  await page.route('**/api/v1/bundles/counts', (r) =>
    r.fulfill({ json: { all: 2, recent: 2, uncategorized: 2, untagged: 2, missing: 0 } }),
  )
  await page.route('**/api/v1/bundles/browse**', (r) =>
    r.fulfill({
      json: {
        items: [summary('b0', 'Movie 0'), summary('b1', 'Movie 1')],
        total: 2,
        offset: 0,
        limit: 100,
      },
    }),
  )
  await page.route('**/api/v1/collections?*', (r) =>
    r.fulfill({ json: { items: [], next_cursor: null } }),
  )
  await page.route('**/api/v1/collections/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/api/v1/tags?*', (r) =>
    r.fulfill({
      json: {
        items: [
          {
            id: 't1',
            parent_id: null,
            name: 'Action',
            color: null,
            sort_order: 0,
            created_at: 'x',
            updated_at: 'x',
          },
        ],
        next_cursor: null,
      },
    }),
  )
  await page.route('**/api/v1/tag-groups?*', (r) =>
    r.fulfill({ json: { items: [], next_cursor: null } }),
  )
  await page.route('**/api/v1/tags/counts', (r) => r.fulfill({ json: { counts: { t1: 0 } } }))

  await page.route('**/api/v1/bundles/b0/files', (r) => r.fulfill({ json: [] }))
  await page.route('**/api/v1/bundles/b0/collections', (r) =>
    r.fulfill({ json: { bundle_id: 'b0', collection_ids: [] } }),
  )
  await page.route('**/api/v1/bundles/b0/tags', async (r) => {
    if (r.request().method() === 'PUT') {
      state.tagIds = (r.request().postDataJSON() as { ids: string[] }).ids
    }
    await r.fulfill({ json: { bundle_id: 'b0', tag_ids: state.tagIds } })
  })
  await page.route('**/api/v1/bundles/b0', async (r) => {
    if (r.request().method() === 'PATCH') {
      Object.assign(state.bundle, r.request().postDataJSON())
    }
    await r.fulfill({ json: state.bundle })
  })
}

test('editing the rating persists', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.locator('.card').first().click()
  await page.getByRole('button', { name: '4 stars' }).click()
  // After the PATCH + refetch the 4th star is filled.
  await expect(page.getByRole('button', { name: '4 stars' })).toHaveText('★')
  await expect(page.getByRole('button', { name: '5 stars' })).toHaveText('☆')
})

test('assigning a tag adds a chip', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.locator('.card').first().click()
  await page.getByRole('button', { name: '+ Tag' }).click()
  await page.locator('.picker__panel .pick-row', { hasText: 'Action' }).click()
  await expect(page.locator('.inspector .chip')).toContainText('Action')
})

test('multi-select shows the batch bar', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.locator('.card').nth(0).click()
  await page
    .locator('.card')
    .nth(1)
    .click({ modifiers: ['Meta'] })
  await expect(page.locator('.batchbar')).toContainText('2 selected')
})
