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
  deletes: () => string[]
  createdTags: () => Record<string, unknown>[]
  createdGroups: () => Record<string, unknown>[]
  groupWrites: () => Record<string, unknown>[]
}> {
  let lastBrowsePost: Record<string, unknown> | null = null
  const patched: string[] = []
  const reorders: Record<string, unknown>[] = []
  const deletes: string[] = []
  const createdTags: Record<string, unknown>[] = []
  const createdGroups: Record<string, unknown>[] = []
  const groupWrites: Record<string, unknown>[] = []

  const tags = [tag('p', 'parent'), tag('c', 'child', 'p'), tag('leaf', 'leaf')]
  const groups = [{ id: 'g1', name: 'Genre', sort_order: 0, created_at: 'x', updated_at: 'x' }]
  // Group id → member tag ids, so a group created mid-test starts empty rather
  // than inheriting the fixture group's membership.
  const members: Record<string, string[]> = { g1: ['c'] }

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
      json: { all: 3, recent: 3, uncategorized: 3, untagged: 1, missing: 0, unbundled: 0 },
    }),
  )
  await page.route('**/collections?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/collections/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/smart-collections', (r) => r.fulfill({ json: [] }))
  await page.route('**/tag-groups?*', (r) =>
    r.fulfill({ json: { items: groups, next_cursor: null } }),
  )
  await page.route('**/tag-groups/*/tags', async (r) => {
    const groupId = r.request().url().split('/tag-groups/')[1]!.split('/')[0]!
    if (r.request().method() === 'PUT') {
      const body = r.request().postDataJSON() as { tag_ids: string[] }
      groupWrites.push({ groupId, tag_ids: body.tag_ids })
      members[groupId] = body.tag_ids
    }
    await r.fulfill({ json: { group_id: groupId, tag_ids: members[groupId] ?? [] } })
  })
  // Collection routes, matched without a query string so the paginated GETs
  // above still win: creating a tag or a group POSTs to the bare path.
  await page.route('**/libraries/*/tags', async (r) => {
    if (r.request().method() !== 'POST') {
      await r.fallback()
      return
    }
    const body = r.request().postDataJSON() as { name: string; parent_id?: string | null }
    createdTags.push({ name: body.name, parent_id: body.parent_id ?? null })
    const created = tag(`new${createdTags.length}`, body.name, body.parent_id ?? null)
    tags.push(created)
    await r.fulfill({ status: 201, json: created })
  })
  await page.route('**/libraries/*/tag-groups', async (r) => {
    if (r.request().method() !== 'POST') {
      await r.fallback()
      return
    }
    const body = r.request().postDataJSON() as { name: string }
    createdGroups.push({ name: body.name })
    const created = {
      id: `g${groups.length + 1}`,
      name: body.name,
      sort_order: groups.length,
      created_at: 'x',
      updated_at: 'x',
    }
    groups.push(created)
    members[created.id] = []
    await r.fulfill({ status: 201, json: created })
  })
  await page.route('**/tags/counts', (r) =>
    r.fulfill({ json: { counts: { p: 1, c: 2, leaf: 0 } } }),
  )
  await page.route('**/tags/reorder', async (r) => {
    reorders.push(r.request().postDataJSON() as Record<string, unknown>)
    await r.fulfill({ json: tags })
  })
  await page.route('**/tags/*/delete-impact', async (r) => {
    // 'parent' has one child; the leaf has nothing hanging off it.
    const id = r.request().url().split('/tags/')[1]!.split('/')[0]!
    await r.fulfill({ json: id === 'p' ? { tags: 2, bundles: 3 } : { tags: 1, bundles: 0 } })
  })
  await page.route('**/tags/*', async (r) => {
    const method = r.request().method()
    if (method === 'PATCH') {
      const id = r.request().url().split('/tags/')[1]!.split('?')[0]!
      patched.push(id)
      await r.fulfill({ json: { ...tag(id, 'renamed'), version: 2 } })
    } else if (method === 'DELETE') {
      deletes.push(r.request().url().split('/tags/')[1]!)
      await r.fulfill({ status: 204, body: '' })
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
    deletes: () => deletes,
    createdTags: () => createdTags,
    createdGroups: () => createdGroups,
    groupWrites: () => groupWrites,
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
  await expect(page.locator('.alltags__nav', { hasText: 'All' })).toBeVisible()
  await expect(page.locator('.alltags__nav', { hasText: 'Uncategorized' })).toBeVisible()
  await expect(page.locator('.alltags__nav', { hasText: 'Genre' })).toBeVisible()

  // Top level shows the two roots (parent, leaf); the child is nested under
  // "parent" (collapsed by default), so only two tiles render.
  await expect(page.locator('.tagtile')).toHaveCount(2)
  await expect(page.locator('.tagtile__name', { hasText: 'parent' })).toBeVisible()
  await expect(page.locator('.tagtile__name', { hasText: 'leaf' })).toBeVisible()

  // Type a search so we can prove double-click clears it.
  await page.getByRole('searchbox', { name: 'Search tags' }).fill('leaf')
  await expect(page.locator('.tagtile')).toHaveCount(1)

  // Double-click the leaf → navigate to All bundles with a global Equal/direct
  // tag filter, and the toolbar search is cleared.
  await page.locator('.tagtile__head', { hasText: 'leaf' }).dblclick()
  await expect(page.locator('.toolbar__title')).toHaveText('All')
  await expect(page.locator('.filter-chip__badge')).toHaveText('1')
  await expect
    .poll(() => JSON.stringify(lastBrowsePost()?.filter ?? null))
    .toContain('"include_descendants":false')
})

test('All Tags: right-click rename, and a parent deletes with its children once confirmed', async ({
  page,
}) => {
  const { patched, deletes } = await mockApi(page)
  await openAllTags(page)

  // Right-click the leaf → Rename Tag → commit via Enter → PATCH fires.
  await page.locator('.tagtile__head', { hasText: 'leaf' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename Tag' }).click()
  await page.locator('.tagtile__rename').fill('renamed leaf')
  await page.locator('.tagtile__rename').press('Enter')
  await expect.poll(() => patched()).toContain('leaf')

  // Deleting a parent asks first, in a rendered dialog — `window.confirm` is a
  // no-op in the desktop webview, which is why this cannot be a native prompt.
  // The prompt states what the delete costs, from the server's own count.
  await page.locator('.tagtile__head', { hasText: 'parent' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete Tag' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete Tag and Its Children' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('1 child tag')
  await expect(dialog).toContainText('3 bundles')
  expect(deletes()).toEqual([])

  // Confirming cascades — the whole point: a parent used to be undeletable.
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect.poll(() => deletes()).toEqual(['p?cascade=true'])
})

test('All Tags: a tag on nothing deletes without a prompt', async ({ page }) => {
  const { deletes } = await mockApi(page)
  await openAllTags(page)

  // No children, no bundles: there is nothing to warn about, so asking would be
  // ceremony. The impact lookup is what licenses skipping the prompt.
  await page.locator('.tagtile__head', { hasText: 'leaf' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete Tag' }).click()
  await expect.poll(() => deletes()).toEqual(['leaf'])
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('All Tags: makes a nested tag, a group, and files a tag into that group', async ({ page }) => {
  const { createdTags, createdGroups, groupWrites } = await mockApi(page)
  await openAllTags(page)

  // A slash in one prompt makes the whole chain, so a new branch does not need
  // two trips through the dialog.
  await page.getByRole('button', { name: 'New Tag', exact: true }).click()
  await page.getByLabel(/^Name/).fill('imprint/series')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect
    .poll(() => createdTags())
    .toEqual([
      { name: 'imprint', parent_id: null },
      { name: 'series', parent_id: 'new1' },
    ])

  // A group is created from the side rail and becomes the open panel, because
  // the next thing anyone does with a new group is put something in it.
  await page.getByRole('button', { name: 'New tag group' }).click()
  await page.getByLabel('Name').fill('Format')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect.poll(() => createdGroups()).toEqual([{ name: 'Format' }])
  await expect(page.locator('.alltags__title')).toHaveText('Format')

  // Membership is a whole-list PUT, so the request has to carry the members the
  // group already had; here that is nothing, and 'leaf' is added to it.
  await page.locator('.alltags__nav', { hasText: 'All' }).first().click()
  await page.locator('.tagtile__head', { hasText: 'leaf' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add to Format' }).click()
  await expect.poll(() => groupWrites()).toEqual([{ groupId: 'g2', tag_ids: ['leaf'] }])
  await expect(page.locator('.alltags__nav', { hasText: 'Format' })).toContainText('1')
})

test('All Tags: expands and collapses the whole hierarchy in one action', async ({ page }) => {
  await mockApi(page)
  await openAllTags(page)

  // Only the two roots to start with; 'child' is folded under 'parent'.
  await expect(page.locator('.tagtile')).toHaveCount(2)
  await page.getByRole('button', { name: 'Expand all' }).click()
  await expect(page.locator('.tagtile__name', { hasText: 'child' })).toBeVisible()
  await page.getByRole('button', { name: 'Collapse all' }).click()
  await expect(page.locator('.tagtile')).toHaveCount(2)
})

// NOTE: reparent-by-drag isn't driven here — native HTML5 DnD is unreliable in
// Playwright. It's exercised against the live app in the browser preview, and its
// validity rules (no self, no cycle, cache count updates) plus pinyin bucketing
// are covered by unit tests + the backend update_tag reparent/cycle tests.
