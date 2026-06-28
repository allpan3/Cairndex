import { expect, test, type Page } from '@playwright/test'

// Hermetic mock for the read-only File View: switch surfaces, list the active
// library's files, see openable/unsupported/linked badges, and navigate into a
// directory. No backend required (ADR-0008: File View is library-scoped).

function entry(name: string, over: Record<string, unknown> = {}) {
  return {
    name,
    relative_path: name,
    kind: 'file',
    size_bytes: 1024,
    modified_at: '2026-06-25T00:00:00Z',
    extension: name.split('.').pop(),
    mime_type: null,
    media_kind: null,
    supported: false,
    linked: false,
    bundle_id: null,
    ...over,
  }
}

async function mockApi(page: Page) {
  await page.route('**/api/v1/libraries', (r) =>
    r.fulfill({
      json: [{ id: 'lib1', name: 'NAS Media', root_path: '/mnt/media', status: 'available' }],
    }),
  )
  // Collection-View endpoints the shell loads on mount.
  await page.route('**/bundles/counts**', (r) =>
    r.fulfill({ json: { all: 0, recent: 0, uncategorized: 0, untagged: 0, missing: 0 } }),
  )
  await page.route('**/collections?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/collections/counts**', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/smart-collections', (r) => r.fulfill({ json: [] }))
  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({ json: { items: [], total: 0, offset: 0, limit: 100 } }),
  )

  await page.route('**/file-view/entries**', (r) => {
    const url = new URL(r.request().url())
    const path = url.searchParams.get('path') ?? ''
    if (path === 'Show') {
      r.fulfill({
        json: {
          path: 'Show',
          entries: [
            entry('clip.mp4', {
              relative_path: 'Show/clip.mp4',
              kind: 'file',
              media_kind: 'video',
              supported: true,
            }),
          ],
        },
      })
    } else {
      r.fulfill({
        json: {
          path: '',
          entries: [
            entry('Show', { relative_path: 'Show', kind: 'directory', size_bytes: null }),
            entry('poster.jpg', { media_kind: 'image', supported: true, linked: true }),
            entry('notes.txt', { supported: false }),
          ],
        },
      })
    }
  })
}

test('browses a library read-only with badges and breadcrumbs', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  // Switch to the File View surface.
  await page.getByRole('tab', { name: 'Files' }).click()

  // The shared library selector (in the sidebar) + entries with badges.
  await expect(page.locator('.sidebar__library-select')).toHaveValue('lib1')
  await expect(page.locator('.file-row__name', { hasText: 'Show' })).toBeVisible()
  await expect(page.locator('.file-row', { hasText: 'poster.jpg' })).toContainText('openable')
  await expect(page.locator('.file-row', { hasText: 'poster.jpg' })).toContainText('linked')
  await expect(page.locator('.file-row', { hasText: 'notes.txt' })).toContainText('unsupported')

  // No destructive controls in this milestone.
  await expect(page.getByRole('button', { name: /delete|rename|move/i })).toHaveCount(0)

  // Navigate into a directory; breadcrumb updates and the nested file shows.
  await page.locator('.file-row__name', { hasText: 'Show' }).click()
  await expect(page.locator('.file-view__crumbs')).toContainText('Show')
  await expect(page.locator('.file-row__name', { hasText: 'clip.mp4' })).toBeVisible()

  // Selecting the file shows its details in the inspector (not the bundle one).
  await page.locator('.file-row__name', { hasText: 'clip.mp4' }).click()
  await expect(page.locator('.inspector')).toContainText('Openable')
})
