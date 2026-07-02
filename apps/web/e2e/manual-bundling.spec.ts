import { expect, test, type Page } from '@playwright/test'

// Hermetic e2e for the file-first manual bundling flow. The API is mocked so the
// Unbundled Files surface, badges, file inspector, and context-menu dialogs can
// be exercised in a real browser without a running backend.

function fileEntry(over: Record<string, unknown>) {
  return {
    name: 'x',
    relative_path: 'x',
    kind: 'file',
    size_bytes: 1000,
    modified_at: '2026-06-25T00:00:00Z',
    extension: 'mp4',
    mime_type: 'video/mp4',
    media_kind: 'video',
    supported: true,
    linked: true,
    bundle_id: 'u0',
    unbundled: true,
    ...over,
  }
}

async function mockApi(page: Page) {
  await page.route('**/api/v1/libraries', (r) =>
    r.fulfill({
      json: [{ id: 'lib1', name: 'Test Library', root_path: '/srv/lib', status: 'available' }],
    }),
  )
  await page.route('**/auth/status', (r) =>
    r.fulfill({ json: { protected: false, unlocked: true } }),
  )
  await page.route('**/bundles/counts', (r) =>
    r.fulfill({
      json: { all: 0, recent: 0, uncategorized: 0, untagged: 0, missing: 0, unbundled: 2 },
    }),
  )
  await page.route('**/collections/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/collections?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/smart-collections', (r) => r.fulfill({ json: [] }))
  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({ json: { items: [], total: 0, offset: 0, limit: 100 } }),
  )
}

test('Unbundled opens the Files surface as a file list and creates a bundle', async ({ page }) => {
  await mockApi(page)
  await page.route('**/manual-bundling/unbundled-files**', (r) =>
    r.fulfill({
      json: {
        items: [
          fileEntry({ name: 'feature.mp4', relative_path: 'movie/feature.mp4' }),
          fileEntry({
            name: 'notes.txt',
            relative_path: 'movie/notes.txt',
            extension: 'txt',
            media_kind: null,
            supported: false,
          }),
        ],
        total: 2,
        offset: 0,
        limit: 200,
      },
    }),
  )

  let draftPaths: string[] = []
  await page.route('**/manual-bundling/suggest-bundle', (r) => {
    draftPaths = r.request().postDataJSON().relative_paths
    r.fulfill({ json: { proposed_title: 'feature', roles: [], additional: [] } })
  })
  let createBody: { relative_paths: string[]; title: string | null } | null = null
  await page.route('**/manual-bundling/create-bundle', (r) => {
    createBody = r.request().postDataJSON()
    r.fulfill({
      json: {
        bundle_id: 'new',
        files_added: 1,
        bundles_removed: 0,
        subtitles_linked: 0,
        created: true,
      },
    })
  })

  await page.goto('/')

  // Click the Unbundled system view → the Files surface (file-first, not cards).
  await page.getByRole('button', { name: /Unbundled/ }).click()
  await expect(page.locator('.toolbar__title')).toHaveText('Unbundled')
  await expect(page.locator('.toolbar__count')).toHaveText('2 items')
  const row = page.locator('.file-row', { hasText: 'feature.mp4' })
  await expect(row).toBeVisible()
  await expect(row.getByText('unbundled')).toBeVisible()
  await expect(row.getByText('openable')).toBeVisible()

  // Selecting a file shows FILE metadata (Status), not bundle metadata.
  await row.click()
  const status = page.locator('.file-meta__row', { hasText: 'Status' })
  await expect(status).toContainText('Unbundled')

  // Right-click → Create Bundle… seeds the dialog with the file's path.
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Create Bundle/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Create bundle' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Title')).toHaveValue('feature')
  expect(draftPaths).toEqual(['movie/feature.mp4'])

  await dialog.getByRole('button', { name: 'Create bundle' }).click()
  await expect(page.getByText(/Created a bundle/)).toBeVisible()
  expect(createBody).not.toBeNull()
  expect(createBody!.relative_paths).toEqual(['movie/feature.mp4'])
})

test('File tree: an unlinked file is badged and can be added to a bundle', async ({ page }) => {
  await mockApi(page)
  await page.route('**/file-view/entries**', (r) =>
    r.fulfill({
      json: {
        path: '',
        entries: [
          fileEntry({
            name: 'loose.mp4',
            relative_path: 'loose.mp4',
            linked: false,
            bundle_id: null,
            unbundled: false,
          }),
        ],
      },
    }),
  )
  await page.route('**/manual-bundling/suggest-targets', (r) =>
    r.fulfill({
      json: {
        suggestions: [
          { bundle_id: 'target', title: 'Existing Movie', confidence: 0.9, reason: 'same folder' },
        ],
      },
    }),
  )
  let addBody: { target_bundle_id: string; relative_paths: string[] } | null = null
  await page.route('**/manual-bundling/add-files', (r) => {
    addBody = r.request().postDataJSON()
    r.fulfill({
      json: {
        bundle_id: 'target',
        files_added: 1,
        bundles_removed: 0,
        subtitles_linked: 0,
        created: false,
      },
    })
  })

  await page.goto('/')
  await page.getByRole('tab', { name: 'Files' }).click()

  const row = page.locator('.file-row', { hasText: 'loose.mp4' })
  await expect(row).toBeVisible()
  await expect(row.getByText('unlinked')).toBeVisible()

  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Add to Bundle/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Add to bundle' })
  await expect(dialog).toBeVisible()
  await dialog.getByText('Existing Movie').click()
  await dialog.getByRole('button', { name: 'Add to bundle' }).click()

  await expect(page.getByText(/Added 1 file/)).toBeVisible()
  expect(addBody).not.toBeNull()
  expect(addBody!.target_bundle_id).toBe('target')
  expect(addBody!.relative_paths).toEqual(['loose.mp4'])
})

test('File view grid layout supports drag-to-select', async ({ page }) => {
  await mockApi(page)
  await page.route('**/file-view/entries**', (r) =>
    r.fulfill({
      json: {
        path: '',
        entries: [
          fileEntry({ name: 'a.mp4', relative_path: 'a.mp4' }),
          fileEntry({ name: 'b.mp4', relative_path: 'b.mp4' }),
          fileEntry({ name: 'c.mp4', relative_path: 'c.mp4' }),
        ],
      },
    }),
  )

  await page.goto('/')
  await page.getByRole('tab', { name: 'Files' }).click()
  await page.getByRole('button', { name: 'Grid' }).click()

  const cards = page.locator('[data-relpath]')
  await expect(cards).toHaveCount(3)

  const wrapperBox = await page.locator('.file-view__wrapper').boundingBox()
  const lastCard = await cards.nth(2).boundingBox()
  if (!wrapperBox || !lastCard) throw new Error('missing bounding box')

  // Drag from the empty grid padding (past the sidebar's resizer handle),
  // through all three cards.
  const gutterX = wrapperBox.x + 8
  await page.mouse.move(gutterX, wrapperBox.y + 2)
  await page.mouse.down()
  await page.mouse.move(lastCard.x + lastCard.width / 2, lastCard.y + lastCard.height / 2, {
    steps: 5,
  })
  await page.mouse.up()

  await expect(cards.nth(0)).toHaveClass(/card--selected/)
  await expect(cards.nth(1)).toHaveClass(/card--selected/)
  await expect(cards.nth(2)).toHaveClass(/card--selected/)

  // The bundling context menu operates on the whole drag-selected set.
  await cards.nth(0).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Add 3 files to bundle…' })).toBeVisible()

  // A plain click on empty space (no drag) clears the selection.
  await page.mouse.click(gutterX, wrapperBox.y + 2)
  await expect(cards.nth(0)).not.toHaveClass(/card--selected/)
})
