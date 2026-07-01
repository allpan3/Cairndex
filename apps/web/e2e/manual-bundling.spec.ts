import { expect, test, type Page } from '@playwright/test'

// Hermetic e2e for the manual bundling assistant (Unbundled staging). The API is
// mocked so the Unbundled view, context-menu actions, and dialogs can be
// exercised in a real browser without a running backend.

function unbundledBundle(i: number) {
  return {
    id: `u${i}`,
    title: `clip${i}`,
    rating: null,
    file_count: 1,
    total_size: 1000,
    has_missing: false,
    has_cover: false,
    media_kind: 'video',
    width: null,
    height: null,
    duration: null,
    extension: 'mp4',
    date_added: '2026-06-25T00:00:00Z',
    grouping_state: 'provisional',
  }
}

async function mockApi(page: Page) {
  const unbundled = [unbundledBundle(0), unbundledBundle(1)]

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
      json: { all: 3, recent: 3, uncategorized: 3, untagged: 3, missing: 0, unbundled: 2 },
    }),
  )
  await page.route('**/collections/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/collections?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/smart-collections', (r) => r.fulfill({ json: [] }))

  // Browse: return the unbundled cards only for the Unbundled view.
  await page.route('**/bundles/browse**', (r) => {
    const url = r.request().url()
    const items = url.includes('view=unbundled') ? unbundled : []
    r.fulfill({ json: { items, total: items.length, offset: 0, limit: 100 } })
  })

  // Each unbundled card is a one-file provisional bundle; its files endpoint
  // resolves the file id the manual bundling service acts on.
  await page.route('**/bundles/u0/files', (r) =>
    r.fulfill({ json: [{ id: 'f0', bundle_id: 'u0', relative_path: 'movie/clip0.mp4' }] }),
  )
  await page.route('**/bundles/u1/files', (r) =>
    r.fulfill({ json: [{ id: 'f1', bundle_id: 'u1', relative_path: 'movie/clip1.mp4' }] }),
  )
  await page.route('**/bundles/u0', (r) =>
    r.fulfill({
      json: {
        id: 'u0',
        title: 'clip0',
        note: null,
        rating: null,
        cover_file_id: null,
        primary_file_id: null,
        grouping_state: 'provisional',
        version: 1,
        created_at: '2026-06-25T00:00:00Z',
        imported_at: '2026-06-25T00:00:00Z',
        updated_at: '2026-06-25T00:00:00Z',
      },
    }),
  )
}

test('Unbundled view lists staged files and creates a bundle from them', async ({ page }) => {
  await mockApi(page)

  const draftCalls: unknown[] = []
  await page.route('**/manual-bundling/suggest-bundle', (r) => {
    draftCalls.push(r.request().postDataJSON())
    r.fulfill({
      json: {
        proposed_title: 'clip0',
        roles: [
          { file_id: 'f0', relative_path: 'movie/clip0.mp4', role: 'primary_video', sequence: 0 },
        ],
        additional: [
          {
            file_id: 'f1',
            relative_path: 'movie/clip1.mp4',
            media_kind: 'video',
            confidence: 0.8,
            reason: 'same folder',
          },
        ],
      },
    })
  })
  let createBody: { file_ids: string[]; title: string | null } | null = null
  await page.route('**/manual-bundling/create-bundle', (r) => {
    createBody = r.request().postDataJSON()
    r.fulfill({
      json: {
        bundle_id: 'new',
        files_added: 2,
        bundles_removed: 1,
        subtitles_linked: 0,
        created: true,
      },
    })
  })

  await page.goto('/')

  // The Unbundled system view is present with its count and lists the files.
  const unbundledNav = page.getByRole('button', { name: /Unbundled/ })
  await expect(unbundledNav).toBeVisible()
  await unbundledNav.click()
  await expect(page.getByText('clip0')).toBeVisible()
  await expect(page.getByText('clip1')).toBeVisible()

  // Right-click a card → Create Bundle… opens the dialog with the suggestion.
  await page.locator('[data-bundle-id="u0"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Create Bundle/ }).click()

  const dialog = page.getByRole('dialog', { name: 'Create bundle' })
  await expect(dialog).toBeVisible()
  // Proposed title seeded from the draft.
  await expect(dialog.getByLabel('Title')).toHaveValue('clip0')
  // The nearby file is offered as an addition; include it.
  const extra = dialog.getByText('clip1.mp4')
  await expect(extra).toBeVisible()
  await extra.click()

  await dialog.getByRole('button', { name: 'Create bundle' }).click()

  // Applied explicitly: create-bundle called with the seed + the checked extra.
  await expect(page.getByText(/Created a bundle/)).toBeVisible()
  expect(createBody).not.toBeNull()
  expect(createBody!.file_ids).toEqual(expect.arrayContaining(['f0', 'f1']))
})

test('Add to Bundle dialog shows a suggested target and applies', async ({ page }) => {
  await mockApi(page)

  await page.route('**/manual-bundling/suggest-targets', (r) =>
    r.fulfill({
      json: {
        suggestions: [
          { bundle_id: 'target', title: 'Existing Movie', confidence: 0.9, reason: 'same folder' },
        ],
      },
    }),
  )
  let addBody: { target_bundle_id: string; file_ids: string[] } | null = null
  await page.route('**/manual-bundling/add-files', (r) => {
    addBody = r.request().postDataJSON()
    r.fulfill({
      json: {
        bundle_id: 'target',
        files_added: 1,
        bundles_removed: 1,
        subtitles_linked: 0,
        created: false,
      },
    })
  })

  await page.goto('/')
  await page.getByRole('button', { name: /Unbundled/ }).click()
  await expect(page.getByText('clip0')).toBeVisible()

  await page.locator('[data-bundle-id="u0"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Add to Bundle/ }).click()

  const dialog = page.getByRole('dialog', { name: 'Add to bundle' })
  await expect(dialog).toBeVisible()
  // The suggested target renders with its reason; pick it.
  await expect(dialog.getByText('Existing Movie')).toBeVisible()
  await dialog.getByText('Existing Movie').click()
  await dialog.getByRole('button', { name: 'Add to bundle' }).click()

  await expect(page.getByText(/Added 1 file/)).toBeVisible()
  expect(addBody).not.toBeNull()
  expect(addBody!.target_bundle_id).toBe('target')
  expect(addBody!.file_ids).toEqual(['f0'])
})
