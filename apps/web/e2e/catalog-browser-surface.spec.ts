import { expect, test, type Locator } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test.use({ actionTimeout: 15_000 })

async function box(locator: Locator) {
  const found = await locator.boundingBox()
  if (!found) throw new Error('Element is not visible')
  return found
}

test('collections and bundles scroll as one surface that a band crosses without a frame @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-browser-surface-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.catalog_fixture import create_disposable,insert_row,synthetic_row; from cairndex.persistence.sqlite_durability import connect_writable; from cairndex.replicas.catalog.conversion import prepare_disposable; f=create_disposable(parent=Path(sys.argv[1]),bundles=75); db=connect_writable(f.source/".cairndex/library.db"); [insert_row(db,"collections",synthetic_row("collections",identity,name=name)) for identity,name in (("collections-arbor","Arbor"),("collections-birch","Birch"))]; db.commit(); db.close(); print(prepare_disposable(f,format_version=3).package)',
      scratch,
    ],
    { cwd: fileURLToPath(new URL('../../server/', import.meta.url)), encoding: 'utf8' },
  ).trim()
  const backend = await startBackend(join(scratch, 'private'))
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const browse = () =>
      apiPost<{ items: { id: string }[] }>(
        backend.baseUrl,
        `/api/v1/libraries/${library.id}/replica/catalog/bundles/browse`,
        { sort: 'manual', limit: 50 },
      )
    await expect.poll(async () => (await browse()).items.length, { timeout: 30_000 }).toBe(50)
    const expected = await browse()
    const page = await context.newPage()
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    const header = page.locator('.collhead')
    const bundles = page.getByRole('listbox', { name: 'Bundles', exact: true })
    const arbor = header.locator('[data-collection-id="collections-arbor"]')
    const first = page.locator(`[data-bundle-id="${expected.items[0]!.id}"]`)
    const contents = header.locator('.collsec__row[data-band="bundles"]')
    const titleRow = header.locator('.collsec__row').first()
    const marquee = page.locator('.marquee')
    await expect(first).toBeVisible()

    // One scroll area holds both sections, so the header scrolls away with the bundles
    const scroller = page.locator('.browser')
    await expect(scroller.locator('.collhead')).toHaveCount(1)
    await expect(scroller.getByRole('listbox', { name: 'Bundles' })).toHaveCount(1)

    // Clicking empty space focuses the listing without framing it
    const row = await box(contents)
    await page.mouse.click(row.x + row.width - 20, row.y + row.height / 2)
    for (const listing of [bundles, header]) {
      await listing.focus()
      expect(await listing.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
        'none',
      )
    }

    // A band from just above the bundles selects them and draws on into the
    // collections, selecting none of those
    const card = await box(first)
    const folder = await box(arbor)
    await page.mouse.move(row.x + row.width - 20, row.y + row.height / 2)
    await page.mouse.down()
    await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2, { steps: 8 })
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await page.mouse.move(folder.x + folder.width / 2, folder.y + folder.height / 2, { steps: 8 })
    expect((await box(marquee)).y).toBeLessThan(row.y)
    await expect(arbor).not.toHaveClass(/collcard--selected/)
    await page.mouse.up()

    // A band from the collections reaches past the Contents row and picks only
    // collections. Focusing scrolls the listing into view, so scroll back first.
    await bundles.focus()
    await page.keyboard.press('Escape')
    await scroller.evaluate((element) => element.scrollTo(0, 0))
    const title = await box(titleRow)
    const below = await box(contents)
    const target = await box(first)
    const origin = await box(arbor)
    await page.mouse.move(title.x + title.width - 20, title.y + title.height / 2)
    await page.mouse.down()
    await page.mouse.move(origin.x + origin.width / 2, target.y + target.height / 2, { steps: 8 })
    const band = await box(marquee)
    expect(band.y + band.height).toBeGreaterThan(below.y + below.height)
    await expect(arbor).toHaveClass(/collcard--selected/)
    await expect(first).toHaveAttribute('aria-selected', 'false')
    await page.mouse.up()
  } finally {
    await context.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
