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
  await page.route('**/jobs/storyboards', (r) =>
    r.fulfill({
      json: jobRead({
        id: 'job-storyboard',
        job_type: 'storyboard',
        status: 'succeeded',
        result: {},
      }),
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
  await page.route('**/api/v1/jobs/job-storyboard', (r) =>
    r.fulfill({
      json: jobRead({
        id: 'job-storyboard',
        job_type: 'storyboard',
        status: 'succeeded',
        result: {},
      }),
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

test('drag-selects multiple bundles with a marquee', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  const cards = page.locator('.card')
  await expect(cards.first()).toBeVisible()

  const browserBox = await page.locator('.browser').boundingBox()
  const target = await cards.nth(1).boundingBox()
  if (!browserBox || !target) throw new Error('missing bounding box')

  // Drag from the empty gutter left of the grid (just right of the sidebar's
  // resizer handle), through card 0, into card 1.
  const gutterX = browserBox.x + 8
  await page.mouse.move(gutterX, browserBox.y + 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 })
  await page.mouse.up()

  await expect(cards.nth(0)).toHaveClass(/card--selected/)
  await expect(cards.nth(1)).toHaveClass(/card--selected/)
  await expect(page.locator('.inspector__multi-head')).toContainText('2 bundles selected')

  // A plain click on empty space (no drag) clears the selection.
  await page.mouse.click(gutterX, browserBox.y + 2)
  await expect(page.locator('.inspector__multi-head')).toHaveCount(0)
})

test('toolbar search queries the whole library, not just the loaded page', async ({ page }) => {
  await mockApi(page)
  // A q-aware browse route: with ?q=gem it returns a bundle that is NOT in the
  // default first page (proving search hits the backend, not the loaded window).
  const gem = { ...bundle(0), id: 'gem', title: 'Hidden Gem' }
  await page.route('**/bundles/browse**', (r) => {
    const url = new URL(r.request().url())
    const q = url.searchParams.get('q')
    if (q && q.toLowerCase().includes('gem')) {
      return r.fulfill({ json: { items: [gem], total: 1, offset: 0, limit: 100 } })
    }
    const items = Array.from({ length: 40 }, (_, i) => bundle(i))
    return r.fulfill({ json: { items, total: items.length, offset: 0, limit: 100 } })
  })

  await page.goto('/')
  await expect(page.getByText('Movie 0')).toBeVisible()
  await expect(page.getByText('Hidden Gem')).toHaveCount(0) // not in the first page

  await page.getByRole('searchbox', { name: 'Search' }).fill('gem')
  await expect(page.getByText('Hidden Gem')).toBeVisible() // found via backend search
  await expect(page.getByText('Movie 0')).toHaveCount(0)
})

test('a protected library shows a lock screen and unlocks with the passphrase', async ({
  page,
}) => {
  await mockApi(page)
  let unlocked = false
  await page.route('**/auth/status', (r) => r.fulfill({ json: { protected: true, unlocked } }))
  await page.route('**/auth/unlock', (r) => {
    unlocked = true
    return r.fulfill({ json: { protected: true, unlocked: true } })
  })

  await page.goto('/')
  // Locked: the passphrase screen is shown and no bundle content is rendered.
  await expect(page.getByText(/is locked/)).toBeVisible()
  await expect(page.getByText('Movie 0')).toHaveCount(0)

  await page.getByLabel('Owner passphrase').fill('open-sesame')
  await page.getByRole('button', { name: 'Unlock' }).click()

  // After unlocking, the workspace mounts and content loads.
  await expect(page.getByText('Movie 0')).toBeVisible()
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
  await page.locator('.sidebar .collection-row', { hasText: 'Movies' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete Collection' }).click()

  const dialog = page.getByRole('dialog', { name: 'Delete Collection' })
  await expect(dialog).toBeVisible()
  // The subcollections checkbox is offered and checked by default.
  await expect(dialog.getByRole('checkbox')).toBeChecked()
  await dialog.getByRole('button', { name: 'Delete' }).click()

  // Confirming with the box checked cascades to subcollections.
  await expect.poll(() => deleteUrl).toContain('cascade=true')
})

test('the sidebar "+" creates a collection with an inline rename box', async ({ page }) => {
  await mockApi(page)
  const state: { collections: Array<{ id: string; name: string; parent_id: string | null }> } = {
    collections: [],
  }
  let nextId = 1
  await page.route('**/collections?*', (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({ json: { items: state.collections, next_cursor: null } })
  })
  // Mirror the backend: every collection appears in counts (0 when empty).
  await page.route('**/collections/counts', (r) =>
    r.fulfill({
      json: { counts: Object.fromEntries(state.collections.map((c) => [c.id, 0])) },
    }),
  )
  await page.route('**/collections', (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    const body = r.request().postDataJSON() as { name: string; parent_id: string | null }
    const created = { id: `c${nextId++}`, name: body.name, parent_id: body.parent_id }
    state.collections.push(created)
    return r.fulfill({ status: 201, json: created })
  })
  await page.route('**/collections/c1', (r) => {
    if (r.request().method() !== 'PATCH') return r.fallback()
    const body = r.request().postDataJSON() as { name: string }
    const target = state.collections.find((c) => c.id === 'c1')
    if (target) target.name = body.name
    return r.fulfill({ json: target })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'New collection' }).click()

  // Created at the top level (no collection open), with the rename box
  // focused and its placeholder name pre-selected for immediate typing.
  const input = page.getByRole('textbox', { name: 'Rename New Collection' })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('New Collection')
  await input.fill('Documentaries')
  await input.press('Enter')

  // The renamed collection stays visible in the sidebar tree, even with no
  // bundles in it yet, and shows a 0 count.
  const row = page.locator('.sidebar .collection-row', { hasText: 'Documentaries' })
  await expect(row).toBeVisible()
  await expect(row.locator('.nav-item__count')).toHaveText('0')

  // It persists across a reload — an empty collection is not pruned from the
  // sidebar (regression: previously vanished on refresh).
  await page.reload()
  await expect(page.locator('.sidebar .collection-row', { hasText: 'Documentaries' })).toBeVisible()
})

test('a collection shows a subcollections strip and a direct/descendant toggle', async ({
  page,
}) => {
  await mockApi(page)
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
  await page.route('**/collections/counts', (r) =>
    r.fulfill({ json: { counts: { c1: 1, c2: 2 } } }),
  )
  await page.route('**/collections/c2/stats', (r) =>
    r.fulfill({ json: { direct_bundles: 2, total_bundles: 2, subcollections: 0 } }),
  )
  // Browse varies by collection_id + include_descendants: Movies has 1 direct
  // bundle, 3 with descendants included.
  await page.route('**/bundles/browse**', (r) => {
    const url = new URL(r.request().url())
    const cid = url.searchParams.get('collection_id')
    const withDesc = url.searchParams.get('include_descendants') === 'true'
    if (cid === 'c1') {
      const items = withDesc ? [bundle(0), bundle(1), bundle(2)] : [bundle(0)]
      return r.fulfill({ json: { items, total: items.length, offset: 0, limit: 100 } })
    }
    const items = Array.from({ length: 40 }, (_, i) => bundle(i))
    return r.fulfill({ json: { items, total: items.length, offset: 0, limit: 100 } })
  })

  await page.goto('/')
  await page.locator('.sidebar .collection-row', { hasText: 'Movies' }).click()

  // Collection header: a "Subcollections" section with a folder tile for the
  // child, a "Contents" section, and only the direct bundle in the grid.
  await expect(page.locator('.collhead')).toContainText('Subcollections (1)')
  await expect(page.locator('.collhead')).toContainText('Contents (1)')
  await expect(page.locator('.collcard', { hasText: 'Docs' })).toBeVisible()
  await expect(page.locator('.toolbar__count')).toHaveText('1 items')

  // Toggling "Show subcollection contents" pulls in descendant bundles.
  await page.getByRole('checkbox', { name: 'Show subcollection contents' }).check()
  await expect(page.locator('.toolbar__count')).toHaveText('3 items')

  // Folding "Contents" hides the bundle grid.
  await page.getByRole('button', { name: /Contents \(/ }).click()
  await expect(page.locator('.browser')).toHaveCount(0)
  await page.getByRole('button', { name: /Contents \(/ }).click() // re-expand

  // Single-clicking a subcollection tile selects it → the collection inspector
  // shows its editable title and counts (it does NOT navigate).
  await page.locator('.collcard', { hasText: 'Docs' }).click()
  await expect(page.locator('.inspector input[aria-label="Collection title"]')).toHaveValue('Docs')
  await expect(page.locator('.inspector')).toContainText('Subcollections')
  await expect(page.locator('.toolbar__title')).toHaveText('Movies') // still in Movies

  // Double-clicking navigates into it (no subcollections of its own).
  await page.locator('.collcard', { hasText: 'Docs' }).dblclick()
  await expect(page.locator('.toolbar__title')).toHaveText('Docs')
  await expect(page.locator('.collhead')).toHaveCount(0)
})

test('drag-selects subcollection cards with a marquee, and empty space deselects', async ({
  page,
}) => {
  await mockApi(page)
  await page.route('**/collections?*', (r) =>
    r.fulfill({
      json: {
        items: [
          { id: 'c1', name: 'Movies', parent_id: null },
          { id: 'c2', name: 'Docs', parent_id: 'c1' },
          { id: 'c3', name: 'Shorts', parent_id: 'c1' },
        ],
        next_cursor: null,
      },
    }),
  )
  await page.route('**/collections/counts', (r) =>
    r.fulfill({ json: { counts: { c1: 1, c2: 2, c3: 1 } } }),
  )
  await page.route('**/bundles/browse**', (r) => {
    const url = new URL(r.request().url())
    const cid = url.searchParams.get('collection_id')
    if (cid === 'c1') {
      return r.fulfill({ json: { items: [bundle(0)], total: 1, offset: 0, limit: 100 } })
    }
    const items = Array.from({ length: 40 }, (_, i) => bundle(i))
    return r.fulfill({ json: { items, total: items.length, offset: 0, limit: 100 } })
  })

  await page.goto('/')
  await page.locator('.sidebar .collection-row', { hasText: 'Movies' }).click()

  const cards = page.locator('.collcard')
  await expect(cards).toHaveCount(2)
  const grid = page.locator('.collcard__grid')
  const gridBox = await grid.boundingBox()
  const second = await cards.nth(1).boundingBox()
  if (!gridBox || !second) throw new Error('missing bounding box')

  // Drag from the grid's empty top-left corner, through both cards.
  await page.mouse.move(gridBox.x + 2, gridBox.y + 2)
  await page.mouse.down()
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2, { steps: 5 })
  await page.mouse.up()

  await expect(cards.nth(0)).toHaveClass(/collcard--selected/)
  await expect(cards.nth(1)).toHaveClass(/collcard--selected/)
  // Multi-collection selection replaces the single-collection inspector with a
  // simple summary, and never selects bundles at the same time.
  await expect(page.locator('.inspector')).toContainText('2 collections selected')

  // A plain click on empty space (no drag) clears the subcollection selection,
  // same as it does for bundles.
  await page.mouse.click(gridBox.x + 2, gridBox.y + 2)
  await expect(page.locator('.collcard--selected')).toHaveCount(0)
})

test('right-click a bundle in a collection sets it as the collection cover', async ({ page }) => {
  await mockApi(page)
  await page.route('**/collections?*', (r) =>
    r.fulfill({
      json: { items: [{ id: 'c1', name: 'Movies', parent_id: null }], next_cursor: null },
    }),
  )
  await page.route('**/collections/counts', (r) => r.fulfill({ json: { counts: { c1: 1 } } }))
  await page.route('**/bundles/browse**', (r) => {
    const cid = new URL(r.request().url()).searchParams.get('collection_id')
    if (cid === 'c1') {
      return r.fulfill({ json: { items: [bundle(0)], total: 1, offset: 0, limit: 100 } })
    }
    const items = Array.from({ length: 40 }, (_, i) => bundle(i))
    return r.fulfill({ json: { items, total: items.length, offset: 0, limit: 100 } })
  })
  let coverPatch: { cover_bundle_id?: string } | null = null
  await page.route('**/collections/c1', (r) => {
    if (r.request().method() !== 'PATCH') return r.fallback()
    coverPatch = r.request().postDataJSON() as { cover_bundle_id?: string }
    return r.fulfill({ json: { id: 'c1', name: 'Movies', parent_id: null, cover_bundle_id: 'b0' } })
  })

  await page.goto('/')
  await page.locator('.sidebar .collection-row', { hasText: 'Movies' }).click()
  await page.locator('[data-bundle-id="b0"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Set as collection cover' }).click()

  await expect.poll(() => coverPatch?.cover_bundle_id).toBe('b0')
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
