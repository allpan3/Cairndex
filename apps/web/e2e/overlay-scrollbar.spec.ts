import { expect, test, type Page } from '@playwright/test'

/**
 * The side panels' scrollbar lies over the content instead of beside it.
 *
 * Only a real browser can check this: it is entirely layout — how much width the
 * panel loses to its scrollbar, and where a thumb sits as you scroll — and jsdom
 * has neither a scrollbar nor scroll geometry.
 */

async function mockApi(page: Page) {
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
      json: { all: 0, recent: 0, uncategorized: 0, untagged: 0, missing: 0, unbundled: 0 },
    }),
  )
  await page.route('**/collections/counts', (r) => r.fulfill({ json: { counts: {} } }))
  // Enough collections to push the sidebar past a short window.
  await page.route('**/collections?*', (r) =>
    r.fulfill({
      json: {
        items: Array.from({ length: 40 }, (_unused, index) => ({
          id: `c${index}`,
          name: `Collection ${index}`,
          parent_id: null,
          note: null,
          cover_bundle_id: null,
        })),
        next_cursor: null,
      },
    }),
  )
  await page.route('**/smart-collections', (r) => r.fulfill({ json: [] }))
  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({ json: { items: [], total: 0, offset: 0, limit: 100 } }),
  )
}

test('the sidebar scrollbar costs the panel no width', async ({ page }) => {
  // The complaint it answers: a native bar appears when the content outgrows the
  // window and shoves everything sideways to make room for itself.
  await mockApi(page)
  await page.setViewportSize({ width: 1000, height: 420 })
  await page.goto('/')
  const sidebar = page.locator('.sidebar')
  await expect(sidebar).toBeVisible()

  const geometry = await sidebar.evaluate((el) => ({
    reserved: el.offsetWidth - el.clientWidth,
    overflowing: el.scrollHeight > el.clientHeight,
  }))
  expect(geometry.overflowing).toBe(true)
  // A border can account for a pixel; a scrollbar cannot.
  expect(geometry.reserved).toBeLessThanOrEqual(1)
})

test('the thumb overlays the panel and follows the scroll', async ({ page }) => {
  await mockApi(page)
  await page.setViewportSize({ width: 1000, height: 420 })
  await page.goto('/')
  const sidebar = page.locator('.sidebar')
  const thumb = sidebar.locator('.oscroll__thumb')
  await expect(thumb).toBeVisible()

  const start = await thumb.evaluate((el) => el.getBoundingClientRect().top)
  const inside = await sidebar.evaluate((el) => {
    const panel = el.getBoundingClientRect()
    const bar = el.querySelector('.oscroll__thumb')!.getBoundingClientRect()
    return bar.right <= panel.right + 1 && bar.left > panel.left
  })
  expect(inside).toBe(true)

  await sidebar.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect
    .poll(async () => thumb.evaluate((el) => el.getBoundingClientRect().top))
    .toBeGreaterThan(start + 20)
})

test('a panel that fits draws no thumb at all', async ({ page }) => {
  await mockApi(page)
  // A *short* collection list, not merely a tall window: the shared mock returns
  // forty, which overflows even 1400px, so this used to assert "no thumb" in the
  // moment before those rows arrived and passed or failed on that race
  // (flaky before this branch too; the taller title strip only shifted the odds).
  await page.route('**/collections?*', (r) =>
    r.fulfill({
      json: {
        items: Array.from({ length: 3 }, (_unused, index) => ({
          id: `c${index}`,
          name: `Collection ${index}`,
          parent_id: null,
          note: null,
          cover_bundle_id: null,
        })),
        next_cursor: null,
      },
    }),
  )
  await page.setViewportSize({ width: 1000, height: 1000 })
  await page.goto('/')
  await expect(page.locator('.sidebar')).toBeVisible()
  // The rows are on screen, so the panel is at its full height when asked.
  await expect(page.locator('.sidebar').getByText('Collection 2')).toBeVisible()
  await expect
    .poll(() => page.locator('.sidebar').evaluate((el) => el.scrollHeight <= el.clientHeight))
    .toBe(true)
  await expect(page.locator('.sidebar .oscroll__thumb')).toHaveCount(0)
})

test('the bundle inspector gets one too', async ({ page }) => {
  // Owner-reported: "the scroll bar is completely gone". It was — the sidebar
  // had one and the inspector did not, because the panel that actually carries
  // content is a different `<aside>` from the loading state beside it, and only
  // the loading state had been given the scrollbar. Every inspector variant is
  // its own root element, so this asserts the one that matters.
  await mockApi(page)
  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({
      json: {
        items: [
          {
            id: 'b0',
            title: 'A bundle',
            rating: null,
            cover_file_id: null,
            file_count: 30,
            total_bytes: 1000,
            updated_at: '2026-08-29T00:00:00Z',
            created_at: '2026-08-29T00:00:00Z',
            grouping_state: 'confirmed',
            missing_count: 0,
          },
        ],
        total: 1,
        offset: 0,
        limit: 100,
      },
    }),
  )
  // Registered first: Playwright tries the most recent match, so this
  // catch-all must not shadow the two specific routes below it.
  await page.route('**/bundles/b0**', (r) =>
    r.fulfill({
      json: {
        id: 'b0',
        title: 'A bundle',
        notes: [],
        rating: null,
        cover_file_id: null,
        resume_file_id: null,
        grouping_state: 'confirmed',
        grouping_source: 'manual',
        created_at: '2026-08-29T00:00:00Z',
        imported_at: '2026-08-29T00:00:00Z',
        updated_at: '2026-08-29T00:00:00Z',
        version: 1,
      },
    }),
  )
  await page.route('**/bundles/b0/directory-members', (r) => r.fulfill({ json: [] }))
  // Nothing marked in this fixture; the bundle catch-all above would otherwise
  // answer this list request with the bundle detail object (plan 7).
  await page.route('**/bundles/b0/moments', (r) => r.fulfill({ json: [] }))
  await page.route('**/bundles/b0/files', (r) =>
    r.fulfill({
      json: Array.from({ length: 30 }, (_unused, index) => ({
        id: `f${index}`,
        bundle_id: 'b0',
        relative_path: `clip${index}.mp4`,
        original_filename: `clip${index}.mp4`,
        display_title: `clip${index}.mp4`,
        role: 'primary_video',
        media_kind: 'video',
        mime_type: 'video/mp4',
        sequence: index,
        size_bytes: 1000,
        availability: 'available',
        supported: true,
        tech_metadata: {},
        created_at: '2026-08-29T00:00:00Z',
        updated_at: '2026-08-29T00:00:00Z',
        version: 1,
      })),
    }),
  )
  await page.setViewportSize({ width: 1100, height: 500 })
  await page.goto('/')
  await page.locator('.card').first().click()

  const inspector = page.locator('.inspector')
  await expect(inspector).toBeVisible()
  // Names the failure precisely: the bug was an inspector that scrolled while
  // carrying no scrollbar at all, not a thumb that was merely misplaced.
  expect(await inspector.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  await expect(inspector.locator('.oscroll__thumb')).toBeVisible()
  expect(await inspector.evaluate((el) => el.offsetWidth - el.clientWidth)).toBeLessThanOrEqual(1)
})
