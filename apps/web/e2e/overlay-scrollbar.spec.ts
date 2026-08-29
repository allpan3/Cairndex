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
  await page.setViewportSize({ width: 1000, height: 1400 })
  await page.goto('/')
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.locator('.sidebar .oscroll__thumb')).toHaveCount(0)
})
