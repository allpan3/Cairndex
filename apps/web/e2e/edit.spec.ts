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

function bundleDetail(id: string, title: string) {
  return {
    id,
    title,
    notes: [] as string[],
    source_url: null as string | null,
    rating: 0 as number | null,
    cover_file_id: null,
    primary_file_id: null,
    created_at: '2026-06-25T00:00:00Z',
    imported_at: '2026-06-25T00:00:00Z',
    updated_at: '2026-06-25T00:00:00Z',
  }
}

async function mockApi(page: Page) {
  const state = {
    bundle: bundleDetail('b0', 'Movie 0'),
    bundleB1: bundleDetail('b1', 'Movie 1'),
    tagIds: [] as string[],
  }

  await page.route('**/api/v1/libraries', (r) =>
    r.fulfill({
      json: [{ id: 'lib1', name: 'Test Library', root_path: '/srv/lib', status: 'available' }],
    }),
  )
  await page.route('**/bundles/counts', (r) =>
    r.fulfill({ json: { all: 2, recent: 2, uncategorized: 2, untagged: 2, missing: 0 } }),
  )
  // Reads titles/ratings from `state` at request time (not just at mockApi
  // setup) so a PATCH made via the inspector is reflected on refetch — the
  // multi-select bulk-rename test asserts the grid picks up the new titles.
  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({
      json: {
        items: [
          { ...summary('b0', state.bundle.title ?? 'Movie 0'), rating: state.bundle.rating },
          { ...summary('b1', state.bundleB1.title ?? 'Movie 1'), rating: state.bundleB1.rating },
        ],
        total: 2,
        offset: 0,
        limit: 100,
      },
    }),
  )
  await page.route('**/collections?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/collections/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/tags?*', (r) =>
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
  await page.route('**/tag-groups?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/tags/counts', (r) => r.fulfill({ json: { counts: { t1: 0 } } }))

  await page.route('**/bundles/b0/files', (r) => r.fulfill({ json: [] }))
  await page.route('**/bundles/b0/collections', (r) =>
    r.fulfill({ json: { bundle_id: 'b0', collection_ids: [] } }),
  )
  await page.route('**/bundles/b0/tags', async (r) => {
    if (r.request().method() === 'PUT') {
      state.tagIds = (r.request().postDataJSON() as { ids: string[] }).ids
    }
    await r.fulfill({ json: { bundle_id: 'b0', tag_ids: state.tagIds } })
  })
  await page.route('**/bundles/b0', async (r) => {
    if (r.request().method() === 'PATCH') {
      Object.assign(state.bundle, r.request().postDataJSON())
    }
    await r.fulfill({ json: state.bundle })
  })

  // b1 mirrors b0 (empty tags/collections) so the multi-bundle inspector's
  // per-bundle queries resolve deterministically in the multi-select test.
  await page.route('**/bundles/b1/files', (r) => r.fulfill({ json: [] }))
  await page.route('**/bundles/b1/collections', (r) =>
    r.fulfill({ json: { bundle_id: 'b1', collection_ids: [] } }),
  )
  await page.route('**/bundles/b1/tags', (r) =>
    r.fulfill({ json: { bundle_id: 'b1', tag_ids: [] } }),
  )
  await page.route('**/bundles/b1', async (r) => {
    if (r.request().method() === 'PATCH') {
      Object.assign(state.bundleB1, r.request().postDataJSON())
    }
    await r.fulfill({ json: state.bundleB1 })
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

test('the plus affordance adds a second note box and both persist', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.locator('.card').first().click()

  // Starts with a single note box under the "NOTES" heading.
  await expect(page.locator('.note-row')).toHaveCount(1)
  await page.locator('.note-row textarea').first().fill('First block')

  // "+" appends a second note box below the first.
  await page.getByRole('button', { name: 'Add note' }).click()
  await expect(page.locator('.note-row')).toHaveCount(2)

  // Fill the second box and blur to commit the whole list. Match the PATCH that
  // carries the second block specifically — clicking "+" already fired a PATCH
  // for the first block, whose response can still be in flight.
  const patched = page.waitForResponse((r) => {
    if (!r.url().includes('/bundles/b0') || r.request().method() !== 'PATCH') return false
    const notes = (r.request().postDataJSON() as { notes?: string[] }).notes ?? []
    return notes.includes('Second block')
  })
  const second = page.locator('.note-row textarea').nth(1)
  await second.fill('Second block')
  await second.blur()
  const body = (await patched).request().postDataJSON() as { notes: string[] }
  expect(body.notes).toEqual(['First block', 'Second block'])
})

test('assigning a tag adds a chip', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.locator('.card').first().click()
  await page.getByRole('button', { name: '+ Tag' }).click()
  await page.locator('.picker__panel .pick-row', { hasText: 'Action' }).click()
  await expect(page.locator('.inspector .chip')).toContainText('Action')
})

test('tag and collection pickers match Chinese names by pinyin', async ({ page }) => {
  await mockApi(page)
  await page.route('**/tags?*', (route) =>
    route.fulfill({
      json: {
        items: [
          { id: 't1', parent_id: null, name: '摄影', color: null, sort_order: 0 },
          { id: 't2', parent_id: null, name: '音乐', color: null, sort_order: 1 },
        ],
        next_cursor: null,
      },
    }),
  )
  await page.route('**/collections?*', (route) =>
    route.fulfill({
      json: {
        items: [
          { id: 'c1', name: '电影', parent_id: null },
          { id: 'c2', name: '文档', parent_id: null },
        ],
        next_cursor: null,
      },
    }),
  )

  await page.goto('/')
  await page.locator('.card').first().click()

  await page.getByRole('button', { name: '+ Tag' }).click()
  await page.getByRole('textbox', { name: 'Search tags' }).fill('sheying')
  await expect(page.locator('.picker__panel .pick-row', { hasText: '摄影' })).toBeVisible()
  await expect(page.locator('.picker__panel .pick-row', { hasText: '音乐' })).toHaveCount(0)

  await page.locator('.inspector .field-label', { hasText: 'Collections' }).click()
  await page.getByRole('button', { name: '+ Collection' }).click()
  await page.getByRole('textbox', { name: 'Search collections' }).fill('dianying')
  await expect(page.locator('.picker__panel .pick-row', { hasText: '电影' })).toBeVisible()
  await expect(page.locator('.picker__panel .pick-row', { hasText: '文档' })).toHaveCount(0)
})

test('the collection picker assigns, surfaces recent, and filters to selected', async ({
  page,
}) => {
  await mockApi(page)
  // Two collections (parent + child) and a stateful membership route.
  await page.route('**/collections?*', (r) =>
    r.fulfill({
      json: {
        items: [
          { id: 'c1', name: 'Movies', parent_id: null },
          { id: 'c2', name: 'Docs', parent_id: 'c1' },
        ],
        next_cursor: null,
      },
    }),
  )
  let memberIds: string[] = []
  await page.route('**/bundles/b0/collections', async (r) => {
    if (r.request().method() === 'PUT') {
      memberIds = (r.request().postDataJSON() as { ids: string[] }).ids
    }
    await r.fulfill({ json: { bundle_id: 'b0', collection_ids: memberIds } })
  })

  await page.goto('/')
  // Start from a clean recent list so the Recent section is deterministic.
  await page.evaluate(() => localStorage.removeItem('cairndex.recentCollections'))
  await page.locator('.card').first().click()
  await page.getByRole('button', { name: '+ Collection' }).click()

  const panel = page.locator('.picker__panel')
  await expect(panel).toBeVisible()
  // Assigning a collection adds a chip and populates the Recent section.
  await panel.locator('.pick-row', { hasText: 'Docs' }).click()
  await expect(page.locator('.inspector .chip')).toContainText('Docs')
  await expect(panel).toContainText('Recent')

  // The "show only selected" filter narrows the list to assigned collections.
  await page.getByRole('button', { name: 'Show only selected' }).click()
  await expect(panel.locator('.pick-row')).toHaveCount(1)
  await expect(panel.locator('.pick-row')).toContainText('Docs')
})

test('typing an unmatched search offers to create a new tag', async ({ page }) => {
  await mockApi(page)
  const tags = [
    { id: 't1', parent_id: null, name: 'Action', color: null, sort_order: 0 },
  ] as Record<string, unknown>[]
  await page.route('**/tags?*', (r) => r.fulfill({ json: { items: tags, next_cursor: null } }))
  await page.route('**/tags', async (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    const body = r.request().postDataJSON() as { name: string }
    const created = { id: 'new-tag', parent_id: null, color: null, sort_order: 0, ...body }
    tags.push(created)
    await r.fulfill({ status: 201, json: created })
  })

  await page.goto('/')
  await page.locator('.card').first().click()
  await page.getByRole('button', { name: '+ Tag' }).click()
  await page.locator('.picker__search').fill('Thriller')

  const createRow = page.locator('.pick-row--create')
  await expect(createRow).toContainText('Create')
  await expect(createRow).toContainText('Thriller')
  await createRow.click()

  // The new tag is created and assigned to the bundle immediately.
  await expect(page.locator('.inspector .chip')).toContainText('Thriller')
})

test('a search that partially matches an existing tag still offers to create the exact text', async ({
  page,
}) => {
  await mockApi(page)
  const tags = [
    { id: 't1', parent_id: null, name: 'Action', color: null, sort_order: 0 },
  ] as Record<string, unknown>[]
  await page.route('**/tags?*', (r) => r.fulfill({ json: { items: tags, next_cursor: null } }))
  await page.route('**/tags', async (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    const body = r.request().postDataJSON() as { name: string }
    const created = { id: 'new-tag', parent_id: null, color: null, sort_order: 0, ...body }
    tags.push(created)
    await r.fulfill({ status: 201, json: created })
  })

  await page.goto('/')
  await page.locator('.card').first().click()
  await page.getByRole('button', { name: '+ Tag' }).click()
  // "Act" is a substring of the seeded "Action" tag — both the partial match
  // and a "Create" offer for the exact typed text should show.
  await page.locator('.picker__search').fill('Act')

  await expect(page.locator('.picker__panel .pick-row', { hasText: 'Action' })).toBeVisible()
  const createRow = page.locator('.pick-row--create')
  await expect(createRow).toContainText('Create')
  await expect(createRow).toContainText('Act')
  await createRow.click()

  // The new "Act" tag is assigned; the pre-existing "Action" tag is untouched
  // (creating doesn't collide with or reuse the partial match).
  const chips = page.locator('.inspector .chip')
  await expect(chips.filter({ hasText: 'Act' })).toHaveCount(1)
  await expect(chips.filter({ hasText: 'Action' })).toHaveCount(0)
})

test('typing an unmatched search offers to create a new collection', async ({ page }) => {
  await mockApi(page)
  const collections = [{ id: 'c1', name: 'Movies', parent_id: null }] as Record<string, unknown>[]
  await page.route('**/collections?*', (r) =>
    r.fulfill({ json: { items: collections, next_cursor: null } }),
  )
  await page.route('**/collections', async (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    const body = r.request().postDataJSON() as { name: string; parent_id: string | null }
    const created = { id: 'new-col', note: null, cover_bundle_id: null, ...body }
    collections.push(created)
    await r.fulfill({ status: 201, json: created })
  })
  let memberIds: string[] = []
  await page.route('**/bundles/b0/collections', async (r) => {
    if (r.request().method() === 'PUT') {
      memberIds = (r.request().postDataJSON() as { ids: string[] }).ids
    }
    await r.fulfill({ json: { bundle_id: 'b0', collection_ids: memberIds } })
  })

  await page.goto('/')
  await page.locator('.card').first().click()
  await page.getByRole('button', { name: '+ Collection' }).click()
  await page.locator('.picker__search').fill('Documentaries')

  const createRow = page.locator('.pick-row--create')
  await expect(createRow).toContainText('Create')
  await expect(createRow).toContainText('Documentaries')
  await createRow.click()

  await expect(page.locator('.inspector .chip')).toContainText('Documentaries')
})

test('multi-select shows a bulk editor in the right panel, not a top bar', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.locator('.card').nth(0).click()
  await page
    .locator('.card')
    .nth(1)
    .click({ modifiers: ['Meta'] })

  await expect(page.locator('.inspector__multi-head')).toContainText('2 bundles selected')
  await expect(page.locator('.batchbar')).toHaveCount(0)

  // Renaming overwrites the title on every selected bundle (a PATCH per id).
  const patchedB0 = page.waitForResponse(
    (r) => r.url().includes('/bundles/b0') && r.request().method() === 'PATCH',
  )
  const patchedB1 = page.waitForResponse(
    (r) => r.url().includes('/bundles/b1') && r.request().method() === 'PATCH',
  )
  await page.getByLabel('Title').fill('Renamed All')
  await page.getByLabel('Title').press('Enter')
  await patchedB0
  await patchedB1

  // Both cards pick up the new title once the browse grid refetches.
  await expect(page.locator('.card__title')).toHaveText(['Renamed All', 'Renamed All'])
})
