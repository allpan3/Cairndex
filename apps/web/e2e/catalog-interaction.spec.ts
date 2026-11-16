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

// Synthetic libraries: many media-less bundles, or a few with playable media
const FIXTURES = {
  bundles:
    'from pathlib import Path; import sys; from cairndex.devtools.catalog_fixture import create_disposable; from cairndex.replicas.catalog.conversion import prepare_disposable; print(prepare_disposable(create_disposable(parent=Path(sys.argv[1]),bundles=int(sys.argv[2]))).package)',
  playable:
    'from pathlib import Path; import sys; from cairndex.devtools.replica_media_fixture import create_playable; print(create_playable(parent=Path(sys.argv[1]),duration=int(sys.argv[2])))',
}

/** A disposable converted library, served by its own backend. */
async function openLibrary(page: Page, size: number, fixture: keyof typeof FIXTURES = 'bundles') {
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-interaction-e2e-'))
  const root = execFileSync(
    'uv',
    ['run', 'python', '-c', FIXTURES[fixture], scratch, String(size)],
    {
      cwd: serverDir,
    },
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

test('covers fade in as inert images over the card placeholder @fullstack', async ({ page }) => {
  test.setTimeout(120_000)
  const library = await openLibrary(page, 6, 'playable')
  try {
    const card = page
      .getByRole('listbox', { name: 'Bundles', exact: true })
      .getByRole('option')
      .filter({ hasText: 'Synthetic playback' })
    const cover = card.locator('img.cover-image')
    await expect(cover).toHaveClass(/cover-image--shown/, { timeout: 30_000 })
    expect(
      await cover.evaluate((image) => (image as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(0)
    // The card owns every gesture; the cover never starts a native image drag
    expect(
      await cover.evaluate((image) => {
        const style = getComputedStyle(image)
        return [style.pointerEvents, style.getPropertyValue('-webkit-user-drag')]
      }),
    ).toEqual(['none', 'none'])
    // Shown starts the fade; it ends fully opaque
    await expect(cover).toHaveCSS('opacity', '1')
  } finally {
    await library.close()
  }
})

test('Space looks at bundles in place, steps through the results and opens the viewer @fullstack', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const library = await openLibrary(page, 6, 'playable')
  // A look reads and streams, but never moves a bundle's current file
  const cursorWrites: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/cursor'))
      cursorWrites.push(request.url())
  })
  try {
    const grid = page.getByRole('listbox', { name: 'Bundles', exact: true })
    await grid.getByRole('option').filter({ hasText: 'Untitled' }).click()
    await page.keyboard.press(' ')
    const preview = page.getByRole('dialog', { name: 'Quick preview' })
    await expect(preview.getByLabel('Position in results')).toHaveText('1 / 3')
    await page.keyboard.press('ArrowRight')
    await expect(preview.getByLabel('Position in results')).toHaveText('2 / 3')
    await expect(preview).toContainText('Synthetic playback')
    // The selection follows the preview, and a video plays at once
    await expect(
      grid.getByRole('option').filter({ hasText: 'Synthetic playback' }),
    ).toHaveAttribute('aria-selected', 'true')
    const video = preview.locator('video')
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
      .toBeGreaterThan(0)
    // Space belongs to the preview, not the video's own controls
    await video.focus()
    await page.keyboard.press(' ')
    await expect(preview).toHaveCount(0)
    await expect(
      grid.getByRole('option').filter({ hasText: 'Synthetic playback' }),
    ).toHaveAttribute('aria-selected', 'true')
    expect(cursorWrites).toEqual([])
    // Enter opens the full viewer on the previewed bundle
    await page.keyboard.press(' ')
    await expect(preview).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(preview).toHaveCount(0)
    await expect(page.locator('.media-viewer')).toBeVisible()
  } finally {
    await library.close()
  }
})

test('the preview counts the whole result and pages in more as it steps @fullstack', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const library = await openLibrary(page, 65)
  try {
    const grid = page.getByRole('listbox', { name: 'Bundles', exact: true })
    await grid.getByRole('option').first().click()
    // End selects the last loaded bundle: the first page holds 50
    await page.keyboard.press('End')
    await page.keyboard.press(' ')
    const preview = page.getByRole('dialog', { name: 'Quick preview' })
    await expect(preview.getByLabel('Position in results')).toHaveText('50 / 65')
    await page.keyboard.press('ArrowRight')
    await expect(preview.getByLabel('Position in results')).toHaveText('51 / 65')
    await page.keyboard.press('Escape')
    await expect(preview).toHaveCount(0)
    await expect(grid.getByRole('option', { selected: true })).toHaveCount(1)
  } finally {
    await library.close()
  }
})

test('organizing offers Undo on its message and with ⌘Z, and the selection moves on @fullstack', async ({
  page,
}) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  const library = await openLibrary(page, 6)
  try {
    const grid = page.getByRole('listbox', { name: 'Bundles', exact: true })
    const card = (index: number) => grid.locator(`[data-bundle-id="bundle-00000${index}"]`)
    const row = (name: RegExp) => page.getByRole('treeitem', { name }).first()
    const toast = page.locator('.mb-toast')
    const items = (count: number) => page.getByText(`${count} items`, { exact: true })
    const addThree = async () => {
      await card(1).click()
      await card(2).click({ modifiers: ['ControlOrMeta'] })
      await card(3).click({ modifiers: ['ControlOrMeta'] })
      await card(1).dragTo(row(/Synthetic child/))
      await expect(toast).toContainText('Added 3 bundles to “Synthetic child”.')
    }

    // A drop's message undoes exactly what it added
    await addThree()
    await toast.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(toast).toContainText('Undone: Added 3 bundles to “Synthetic child”.')
    await row(/Synthetic child/).click()
    await expect(items(1)).toBeVisible()

    // Removed from the open collection, the card leaves and the selection moves on
    await page.locator('.nav-item').filter({ hasText: /^All/ }).first().click()
    await addThree()
    await row(/Synthetic child/).click()
    await expect(items(4)).toBeVisible()
    const order = await grid
      .locator('[data-bundle-id]')
      .evaluateAll((cards) => cards.map((element) => element.getAttribute('data-bundle-id')))
    const removed = order.indexOf('bundle-000002')
    const next = order[removed + 1] ?? order[removed - 1]!
    await card(2).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Remove from This Collection' }).click()
    await expect(toast).toContainText('Removed 1 bundle from “Synthetic child”.')
    await expect(items(3)).toBeVisible()
    await expect(grid.locator(`[data-bundle-id="${next}"]`)).toHaveAttribute(
      'aria-selected',
      'true',
    )
    // ⌘Z puts it back; a text field keeps its own ⌘Z first
    const search = page.getByRole('searchbox', { name: 'Search', exact: true })
    await search.focus()
    await page.keyboard.press('ControlOrMeta+z')
    // A negative: give a wrongly taken undo time to report before checking
    await page.waitForTimeout(500)
    await expect(toast).toContainText('Removed 1 bundle from “Synthetic child”.')
    await grid.locator(`[data-bundle-id="${next}"]`).click()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(toast).toContainText('Undone: Removed 1 bundle from “Synthetic child”.')
    await expect(items(4)).toBeVisible()

    // An inspector tag change offers Undo too
    const tags = page
      .getByRole('complementary', { name: 'Bundle inspector' })
      .locator('[data-section="tags"]')
    await tags.getByRole('button', { name: '+ Tag', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Choose tags' })
    await picker.getByRole('textbox', { name: 'Search tags' }).fill('Synthetic root')
    await picker.getByRole('button', { name: /Synthetic root/ }).click()
    await page.keyboard.press('Escape')
    const chip = tags.getByRole('button', { name: 'Remove Synthetic root', exact: true })
    await expect(chip).toBeEnabled()
    await expect(toast).toContainText('Added “Synthetic root” to 1 bundle.')
    await toast.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(chip).toHaveCount(0)
  } finally {
    await library.close()
  }
})

test('a bundle drag shows the dragged covers, or the label pill without one @fullstack', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const library = await openLibrary(page, 6, 'playable')
  try {
    const grid = page.getByRole('listbox', { name: 'Bundles', exact: true })
    const card = (index: number) => grid.locator(`[data-bundle-id="bundle-00000${index}"]`)
    const row = (name: RegExp) => page.getByRole('treeitem', { name }).first()
    await expect(card(1).locator('img.cover-image')).toHaveClass(/cover-image--shown/, {
      timeout: 30_000,
    })
    // What the engine is handed: the covers drawn, and the label beneath them
    await page.evaluate(() => {
      const original = DataTransfer.prototype.setDragImage
      DataTransfer.prototype.setDragImage = function (image, x, y) {
        const covers = [...image.querySelectorAll('canvas')]
        Object.assign(window, {
          dragImage: {
            painted: covers.map((canvas) =>
              canvas
                .getContext('2d')!
                .getImageData(0, 0, canvas.width, canvas.height)
                .data.some((value, index) => index % 4 === 3 && value > 0),
            ),
            label: image.querySelector('.drag-badge__pill')?.textContent,
          },
        })
        original.call(this, image, x, y)
      }
    })
    const dragImage = () =>
      page.evaluate(() => (window as unknown as { dragImage: unknown }).dragImage)
    await card(1).click()
    await card(2).click({ modifiers: ['ControlOrMeta'] })
    await card(1).dragTo(row(/Synthetic child/))
    expect(await dragImage()).toEqual({ painted: [true], label: '2 bundles' })
    // The cover itself stays inert: the card, not the image, starts the drag
    expect(
      await card(1)
        .locator('img.cover-image')
        .evaluate((image) => getComputedStyle(image).getPropertyValue('-webkit-user-drag')),
    ).toBe('none')
    await card(2).click()
    await card(2).dragTo(row(/Synthetic root/))
    expect(await dragImage()).toEqual({ painted: [], label: 'Synthetic bundle 2 雪' })
  } finally {
    await library.close()
  }
})
