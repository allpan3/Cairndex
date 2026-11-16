import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

// Eagle-style interaction polish over synthetic portable libraries
test.use({ actionTimeout: 15_000 })
const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))

/** A disposable converted library of `bundles` synthetic bundles, served by its own backend. */
async function openLibrary(page: Page, bundles: number) {
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-interaction-e2e-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.catalog_fixture import create_disposable; from cairndex.replicas.catalog.conversion import prepare_disposable; print(prepare_disposable(create_disposable(parent=Path(sys.argv[1]),bundles=int(sys.argv[2]))).package)',
      scratch,
      String(bundles),
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
  const backend = await startBackend(join(scratch, 'private'))
  const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
    root_path: root,
  })
  await proxyApi(page, backend.baseUrl)
  await page.goto('/')
  return {
    base: `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog`,
    close: async () => {
      await page.close()
      await stopBackend(backend.child)
      await rm(scratch, { recursive: true, force: true })
    },
  }
}

test('a dragged zoom scales the grid and lays it out once around the selected card @fullstack', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  const library = await openLibrary(page, 65)
  try {
    const grid = page.getByRole('listbox', { name: 'Bundles', exact: true })
    const card = grid.getByRole('option').filter({ hasText: 'Synthetic bundle 9 雪' })
    await card.click()
    const before = (await card.boundingBox())!
    const slider = page.getByRole('slider', { name: 'Zoom' })
    const track = (await slider.boundingBox())!
    // The thumb sits at the stored zoom (200) along 140–640
    const startX = track.x + (track.width * (200 - 140)) / (640 - 140)
    await page.mouse.move(startX, track.y + track.height / 2)
    await page.mouse.down()
    await page.mouse.move(startX + 20, track.y + track.height / 2, { steps: 5 })
    // Mid-drag the cards are scaled, not laid out again: same slot widths, a
    // transformed grid, and the selected card held where it was
    await expect(grid).toHaveClass(/browser--zooming/)
    const slot = card.locator('xpath=..')
    // Numerically: engines round the serialized width differently (268.667px)
    const slotWidth = await slot.evaluate((element) => parseFloat(element.style.width))
    expect(Math.abs(slotWidth - before.width)).toBeLessThan(0.5)
    const during = (await card.boundingBox())!
    expect(during.width).toBeGreaterThan(before.width)
    expect(Math.abs(during.y + during.height / 2 - (before.y + before.height / 2))).toBeLessThan(2)
    await page.mouse.up()
    await expect(grid).not.toHaveClass(/browser--zooming/)
    // One real layout: larger cards, the selected one still where it was
    await expect.poll(async () => (await card.boundingBox())!.width).toBeGreaterThan(before.width)
    const after = (await card.boundingBox())!
    expect(Math.abs(after.y + after.height / 2 - (before.y + before.height / 2))).toBeLessThan(2)

    // A list has no cheaper stand-in: its rows take their real height as the
    // slider moves, still around the selected row (growing, so the grid has
    // room to scroll; at the very top a shrinking list can only move up)
    await page.getByRole('button', { name: 'List', exact: true }).click()
    const row = grid.getByRole('option').filter({ hasText: 'Synthetic bundle 9 雪' })
    // A layout switch keeps the scroll offset, not the item; bring it back
    await row.scrollIntoViewIfNeeded()
    const listBefore = (await row.boundingBox())!
    const value = Number(await slider.inputValue())
    const listX = track.x + (track.width * (value - 140)) / (640 - 140)
    await page.mouse.move(listX, track.y + track.height / 2)
    await page.mouse.down()
    await page.mouse.move(listX + 12, track.y + track.height / 2, { steps: 5 })
    await expect(grid).not.toHaveClass(/browser--zooming/)
    await expect
      .poll(async () => (await row.boundingBox())!.height)
      .toBeGreaterThan(listBefore.height)
    const listDuring = (await row.boundingBox())!
    expect(
      Math.abs(listDuring.y + listDuring.height / 2 - (listBefore.y + listBefore.height / 2)),
    ).toBeLessThan(2)
    await page.mouse.up()
    expect(Number(await slider.inputValue())).toBeGreaterThan(value)
  } finally {
    await library.close()
  }
})
