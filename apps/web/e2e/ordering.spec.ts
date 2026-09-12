import { expect, test, type Page } from '@playwright/test'

// Hermetic mocks for the collection/bundle ordering features: the sort-control
// popover (Manual default + per-collection scope), the folder-card context menu,
// the flatten-on-show-contents toggle, and the bundle "Clean up…" context-menu
// action. No backend required — API calls are intercepted; sort params and
// cleanup requests are captured to prove the UI wires through.

function summary(id: string, title: string) {
  return {
    id,
    title,
    rating: null,
    file_count: 1,
    total_size: 0,
    has_missing: false,
    has_cover: false,
    cover_key: null,
    media_kind: null,
    width: null,
    height: null,
    duration: null,
    extension: 'mp4',
    date_added: '2026-06-25T00:00:00Z',
    grouping_state: 'confirmed',
  }
}

function coll(id: string, name: string, parentId: string | null, sortOrder: number) {
  return {
    id,
    parent_id: parentId,
    name,
    note: null,
    cover_bundle_id: null,
    sort_order: sortOrder,
    created_at: 'x',
    updated_at: 'x',
    version: 1,
  }
}

interface Captured {
  bundleCleanup: Array<Record<string, unknown>>
  sorts: string[]
}

async function mockApi(page: Page, count = 3): Promise<Captured> {
  const captured: Captured = { bundleCleanup: [], sorts: [] }

  // Two roots; the first has two subcollections, the deeper one has a grandchild
  // (so flattening a subtree surfaces more than the direct children).
  const collections = [
    coll('root-a', 'Root A', null, 0),
    coll('root-b', 'Root B', null, 1),
    coll('sub-a1', 'Sub A1', 'root-a', 0),
    coll('sub-a2', 'Sub A2', 'root-a', 1),
    coll('sub-a1x', 'Sub A1 Child', 'sub-a1', 0),
  ]

  await page.route('**/api/v1/libraries', (r) =>
    r.fulfill({
      json: [{ id: 'lib1', name: 'Test Library', root_path: '/srv/lib', status: 'available' }],
    }),
  )
  await page.route('**/auth/status', (r) =>
    r.fulfill({ json: { protected: false, unlocked: true } }),
  )
  await page.route('**/ownership', (r) => r.fulfill({ json: { state: 'own', mountable: true } }))
  await page.route('**/bundles/counts', (r) =>
    r.fulfill({
      json: { all: 3, recent: 3, uncategorized: 3, untagged: 3, missing: 0, unbundled: 0 },
    }),
  )
  await page.route('**/collections?*', (r) =>
    r.fulfill({ json: { items: collections, next_cursor: null } }),
  )
  await page.route('**/collections/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/collections/cleanup-order', (r) => r.fulfill({ status: 204, body: '' }))
  await page.route('**/collections/reorder', (r) => r.fulfill({ json: [] }))
  await page.route('**/tags?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))

  await page.route('**/bundles/cleanup-order', async (r) => {
    captured.bundleCleanup.push(r.request().postDataJSON() as Record<string, unknown>)
    await r.fulfill({ status: 204, body: '' })
  })

  await page.route('**/bundles/browse**', (r) => {
    const sort = new URL(r.request().url()).searchParams.get('sort')
    if (sort) captured.sorts.push(sort)
    r.fulfill({
      json: {
        items: Array.from({ length: count }, (_, i) => summary(`b${i}`, `Bundle ${i}`)),
        total: count,
        offset: 0,
        limit: 100,
      },
    })
  })
  await page.route('**/smart-collections', (r) => r.fulfill({ json: [] }))

  return captured
}

test('sort control defaults to Manual and changes the sort', async ({ page }) => {
  const captured = await mockApi(page)
  await page.goto('/')
  await expect(page.locator('.toolbar__title')).toHaveText('All')

  // The sort button shows the active sort — Manual by default.
  const sortBtn = page.getByRole('button', { name: 'Sort' })
  await expect(sortBtn).toContainText('Manual')

  // Open the pane and switch to Title → a browse request goes out with sort=title.
  await sortBtn.click()
  await page.locator('.sortctl__opt', { hasText: 'Title' }).click()
  await expect.poll(() => captured.sorts.includes('title')).toBe(true)
  await expect(sortBtn).toContainText('Title')
})

test('a list-view column header sorts by that column', async ({ page }) => {
  const captured = await mockApi(page)
  await page.goto('/')
  await expect(page.locator('.toolbar__title')).toHaveText('All')

  await page.getByRole('button', { name: 'List' }).click()
  // Clicking a header is the file-manager gesture for "sort by this" (owner,
  // 2026-09-01); it drives the same preference the toolbar control shows.
  await page.getByRole('button', { name: 'Sort by Name' }).click()
  await expect.poll(() => captured.sorts.includes('title')).toBe(true)
  // `exact`, because the column headers are named "Sort by …" too.
  await expect(page.getByRole('button', { name: 'Sort', exact: true })).toContainText('Title')

  // Clicking the same column again reverses it.
  await page.getByRole('button', { name: 'Sort by Name' }).click()
  await expect(
    page.getByRole('button', { name: 'Sort by Name' }).locator('xpath=..'),
  ).toHaveAttribute('aria-sort', 'descending')
})

test('sort pane offers a per-collection scope toggle', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  await page.getByRole('button', { name: 'Sort' }).click()
  const scope = page.getByLabel('Remember sort per collection')
  await expect(scope).not.toBeChecked()
  await scope.check()
  await expect(scope).toBeChecked()
})

test('Shift-click selects a range of bundles', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  const cards = page.locator('[data-bundle-id]')
  await cards.nth(0).click()
  await cards.nth(2).click({ modifiers: ['Shift'] })
  await expect(page.locator('.card--selected')).toHaveCount(3)
})

test('bundle selection survives sorting, prunes proven removal, and clears when filters change', async ({
  page,
}) => {
  await mockApi(page)
  let ids = ['b0', 'b1', 'b2']
  await page.route('**/bundles/browse**', (route) =>
    route.fulfill({
      json: {
        items: ids.map((id) => summary(id, `Bundle ${id}`)),
        total: ids.length,
        offset: 0,
        limit: 100,
      },
    }),
  )
  await page.goto('/')
  await page.locator('[data-bundle-id="b1"]').click()
  ids = ['b2', 'b1', 'b0']
  await page.getByRole('button', { name: 'List', exact: true }).click()
  await page.getByRole('button', { name: 'Sort by Name' }).click()
  await expect(page.locator('[data-bundle-id="b1"]')).toHaveAttribute('aria-selected', 'true')
  ids = ['b2', 'b0']
  await page.getByRole('button', { name: 'Sort by Name' }).click()
  await expect(page.locator('[data-bundle-id="b1"]')).toHaveCount(0)
  await expect(page.locator('[data-bundle-id][aria-selected="true"]')).toHaveCount(0)
  await page.locator('[data-bundle-id="b0"]').click()
  await page.getByLabel('Search', { exact: true }).fill('Bundle')
  await expect(page.locator('[data-bundle-id][aria-selected="true"]')).toHaveCount(0)
})

test('folder card has a Delete Collection context menu', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  await page.locator('.collcard__grid [data-collection-id]').first().click({ button: 'right' })
  await expect(page.locator('.context-menu__item', { hasText: 'Delete Collection' })).toBeVisible()
})

test('a folder card renames through the sidebar rename box', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  // Renaming a collection was reachable only in the seconds after creating one
  // (owner, 2026-08-23). The box itself is the sidebar's, so a rename asked for
  // in the grid has to unfold the tree and land there — the same route the
  // grid's "New Collection" already takes.
  const card = page.locator('.collcard__grid [data-collection-id]').first()
  const name = await card.locator('.collcard__name').innerText()
  await card.click({ button: 'right' })
  await page.locator('.context-menu__item', { hasText: 'Rename Collection' }).click()

  const input = page.getByRole('textbox', { name: `Rename ${name}` })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(name)
})

test('bundle "Clean up…" lives in the empty-space context menu', async ({ page }) => {
  const captured = await mockApi(page)
  await page.goto('/')

  // Enter a collection first — bundle "Clean Up Order" applies to a scoped list
  // (a collection's own bundles), not the flattened All view where it's disabled.
  await page.locator('.collcard__grid [data-collection-id]').first().dblclick()
  await expect(page.locator('[data-bundle-id]').first()).toBeVisible()
  // Right-click empty grid space (the .browser root, not a card) → Clean Up Order.
  await page.evaluate(() => {
    const el = document.querySelector('.browser') as HTMLElement
    const r = el.getBoundingClientRect()
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: r.left + 8,
        clientY: r.bottom - 8,
      }),
    )
  })
  await page.locator('.context-menu__item', { hasText: 'Clean Up Order' }).click()
  await page.getByLabel('Clean-up order').selectOption('title:desc')
  await page.getByRole('button', { name: 'Clean up', exact: true }).click()

  await expect.poll(() => captured.bundleCleanup.length).toBe(1)
  expect(captured.bundleCleanup[0]).toMatchObject({ sort: 'title', order: 'desc' })
})

test('"Show subcollection contents" flattens descendant collections', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  // Into Root A (sidebar) → its two direct subcollections show.
  await page.locator('.collection-row', { hasText: 'Root A' }).first().click()
  await expect(page.locator('.collsec__title').first()).toContainText('Subcollections (2)')

  // Flatten: the grandchild (Sub A1 Child) now also surfaces → 3 folder cards.
  await page.getByText('Show subcollection contents').click()
  await expect(page.locator('.collsec__title').first()).toContainText('Subcollections (3)')
  await expect(page.locator('.collcard__name', { hasText: 'Sub A1 Child' })).toBeVisible()
})

// Range selection grows and shrinks from the same anchor without entering text controls
test('listing keyboard range and select-all stay inside the focused listing', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  const listing = page.getByRole('listbox', { name: 'Bundles', exact: true })
  await page.locator('[data-bundle-id="b0"]').click()
  await page.keyboard.press('Shift+ArrowRight')
  await expect(listing.locator('[aria-selected="true"]')).toHaveCount(2)
  await page.keyboard.press('Shift+ArrowRight')
  await expect(listing.locator('[aria-selected="true"]')).toHaveCount(3)
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(listing.locator('[aria-selected="true"]')).toHaveCount(2)
  await page.keyboard.press('Meta+a')
  await expect(listing.locator('[aria-selected="true"]')).toHaveCount(3)
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('')
  const search = page.getByRole('searchbox').first()
  await search.fill('Bundle')
  await search.press('Meta+a')
  expect(
    await search.evaluate((el: HTMLInputElement) => el.selectionEnd! - el.selectionStart!),
  ).toBe(6)
})

// A virtualized result must scroll to the actual target, including Home and End
test('keyboard movement reaches offscreen bundle rows', async ({ page }) => {
  await mockApi(page, 600)
  await page.goto('/')
  await page.locator('[data-bundle-id="b0"]').click()
  await page.keyboard.press('End')
  await expect(page.locator('[data-bundle-id="b599"]')).toBeVisible()
  await expect(page.locator('[data-bundle-id="b599"]')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Home')
  await expect(page.locator('[data-bundle-id="b0"]')).toBeVisible()
  await expect(page.locator('[data-bundle-id="b0"]')).toHaveAttribute('aria-selected', 'true')
})

// Smart Collection cancellation returns keyboard focus without saving a draft
test('Escape dismisses the smart collection dialog and returns focus', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  const trigger = page.getByRole('button', { name: 'New smart collection', exact: true })
  await trigger.click()
  await page.getByRole('textbox', { name: 'Smart collection name' }).fill('Draft only')
  await page.getByLabel('Field', { exact: true }).first().selectOption('collections')
  const picker = page.getByRole('button', { name: 'Choose collections…' })
  await picker.click()
  await expect(picker).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(picker).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('textbox', { name: 'Smart collection name' })).toHaveValue(
    'Draft only',
  )
  await page.keyboard.press('Escape')
  await expect(page.getByRole('textbox', { name: 'Smart collection name' })).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

// Cancel leaves no collection on the server; Create sends the entered name exactly once
test('collection creation persists only after confirmation', async ({ page }) => {
  await mockApi(page)
  const writes: unknown[] = []
  await page.route('**/collections', async (route) => {
    const payload = route.request().postDataJSON()
    writes.push(payload)
    await route.fulfill({
      status: 201,
      json: { ...coll('created', payload.name, payload.parent_id, 0) },
    })
  })
  await page.goto('/')
  const trigger = page.getByRole('button', { name: 'New collection', exact: true })
  await trigger.click()
  await page.getByRole('textbox', { name: 'Collection name' }).fill('Local draft')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'New Collection', exact: true })).toHaveCount(0)
  expect(writes).toEqual([])
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.getByRole('textbox', { name: 'Collection name' }).fill('Confirmed collection')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect.poll(() => writes).toEqual([{ name: 'Confirmed collection', parent_id: null }])
})
