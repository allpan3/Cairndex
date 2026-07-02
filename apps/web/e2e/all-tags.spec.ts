import { expect, test, type Page } from '@playwright/test'

// Hermetic mock for the All Tags management page (Slice 3). Tag hierarchy:
//   parent → child (in group "Genre"), leaf (ungrouped)
// so we can assert groups + Uncategorized scoping, double-click-to-filter,
// rename, and the safe-delete block for a parent with children.

function tag(id: string, name: string, parentId: string | null = null) {
  return {
    id,
    parent_id: parentId,
    name,
    color: null,
    sort_order: 0,
    created_at: 'x',
    updated_at: 'x',
    version: 1,
  }
}

async function mockApi(page: Page): Promise<{
  lastBrowsePost: () => Record<string, unknown> | null
  patched: () => string[]
  reorders: () => Record<string, unknown>[]
}> {
  let lastBrowsePost: Record<string, unknown> | null = null
  const patched: string[] = []
  const reorders: Record<string, unknown>[] = []

  const tags = [tag('p', 'parent'), tag('c', 'child', 'p'), tag('leaf', 'leaf')]

  await page.route('**/api/v1/libraries', (r) =>
    r.fulfill({
      json: [{ id: 'lib1', name: 'Test Library', root_path: '/srv/lib', status: 'available' }],
    }),
  )
  await page.route('**/bundles/counts', (r) =>
    r.fulfill({
      json: { all: 3, recent: 3, uncategorized: 3, untagged: 1, missing: 0, unbundled: 0 },
    }),
  )
  await page.route('**/collections?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/collections/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/smart-collections', (r) => r.fulfill({ json: [] }))
  await page.route('**/tag-groups?*', (r) =>
    r.fulfill({
      json: {
        items: [{ id: 'g1', name: 'Genre', sort_order: 0, created_at: 'x', updated_at: 'x' }],
        next_cursor: null,
      },
    }),
  )
  await page.route('**/tag-groups/*/tags', (r) =>
    r.fulfill({ json: { group_id: 'g1', tag_ids: ['c'] } }),
  )
  await page.route('**/tags/counts', (r) =>
    r.fulfill({ json: { counts: { p: 1, c: 2, leaf: 0 } } }),
  )
  await page.route('**/tags/reorder', async (r) => {
    reorders.push(r.request().postDataJSON() as Record<string, unknown>)
    await r.fulfill({ json: tags })
  })
  await page.route('**/tags/*', async (r) => {
    if (r.request().method() === 'PATCH') {
      const id = r.request().url().split('/tags/')[1]!.split('?')[0]!
      patched.push(id)
      await r.fulfill({ json: { ...tag(id, 'renamed'), version: 2 } })
    } else {
      await r.fulfill({ status: 404, json: { message: 'not found' } })
    }
  })
  await page.route('**/tags?*', (r) => r.fulfill({ json: { items: tags, next_cursor: null } }))

  await page.route('**/bundles/browse**', (r) => {
    const filtered = r.request().method() === 'POST'
    if (filtered) lastBrowsePost = r.request().postDataJSON() as Record<string, unknown>
    r.fulfill({ json: { items: [], total: filtered ? 1 : 3, offset: 0, limit: 100 } })
  })

  return {
    lastBrowsePost: () => lastBrowsePost,
    patched: () => patched,
    reorders: () => reorders,
  }
}

async function openAllTags(page: Page) {
  await page.goto('/')
  await page.locator('aside.sidebar .nav-item', { hasText: 'All Tags' }).click()
}

test('All Tags: groups + Uncategorized, and double-click applies a global filter', async ({
  page,
}) => {
  const { lastBrowsePost } = await mockApi(page)
  await openAllTags(page)

  // Left panel shows All Tags, Uncategorized, and the group.
  await expect(page.locator('.alltags__nav', { hasText: 'All Tags' })).toBeVisible()
  await expect(page.locator('.alltags__nav', { hasText: 'Uncategorized' })).toBeVisible()
  await expect(page.locator('.alltags__nav', { hasText: 'Genre' })).toBeVisible()

  // The hierarchy shows parent, child, and the ungrouped leaf.
  await expect(page.locator('.alltags__row')).toHaveCount(3)

  // Type a search so we can prove double-click clears it.
  await page.getByRole('searchbox', { name: 'Search tags' }).fill('leaf')
  await expect(page.locator('.alltags__row')).toHaveCount(1)

  // Double-click the leaf → navigate to All bundles with a global Equal/direct
  // tag filter, and the toolbar search is cleared.
  await page.locator('.alltags__row', { hasText: 'leaf' }).dblclick()
  await expect(page.locator('.toolbar__title')).toHaveText('All')
  await expect(page.locator('.filter-chip__badge')).toHaveText('1')
  await expect
    .poll(() => JSON.stringify(lastBrowsePost()?.filter ?? null))
    .toContain('"include_descendants":false')
})

test('All Tags: right-click rename; parent-with-children delete is blocked', async ({ page }) => {
  const { patched } = await mockApi(page)
  await openAllTags(page)

  // Right-click the leaf → Rename Tag → commit via Enter → PATCH fires.
  await page.locator('.alltags__row', { hasText: 'leaf' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename Tag' }).click()
  await page.locator('.alltags__rename').fill('renamed leaf')
  await page.locator('.alltags__rename').press('Enter')
  await expect.poll(() => patched()).toContain('leaf')

  // Deleting a parent that has children is blocked client-side (a friendly
  // alert), so no DELETE is attempted.
  let alert = ''
  page.on('dialog', (d) => {
    alert = d.message()
    void d.dismiss()
  })
  await page.locator('.alltags__row', { hasText: 'parent' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete Tag' }).click()
  await expect.poll(() => alert).toContain('child tags')
})

// NOTE: the drag-reorder behavior (reorder among siblings only; no reparenting)
// is covered by a fast, deterministic unit test of the pure `planReorder`
// (src/app/AllTagsPage.reorder.test.ts) rather than a flaky native-HTML5-DnD
// Playwright drag, plus the backend `reorder_tags` sibling/cross-parent tests.
