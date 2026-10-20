import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test.use({ actionTimeout: 15_000 })

test('folder and bundle keys share the displayed layout and preserve virtual navigation @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-mixed-navigation-'))
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
    const arbor = page.locator('.collhead [data-collection-id="collections-arbor"]')
    const birch = page.locator('.collhead [data-collection-id="collections-birch"]')
    const lastFolder = page.locator('.collhead [data-collection-id="collections-root"]')
    const bundles = page.getByRole('listbox', { name: 'Bundles', exact: true })
    const first = page.locator(`[data-bundle-id="${expected.items[0]!.id}"]`)
    await arbor.click()
    await page.keyboard.press('ArrowRight')
    await expect(birch).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(arbor).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowUp')
    await expect(arbor).toBeFocused()
    await lastFolder.click()
    await page.keyboard.press('ArrowRight')
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(lastFolder).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('.toolbar__title')).toHaveText('Synthetic root')
    await page.getByRole('button', { name: /^All( \d+)?$/ }).click()
    await page.getByRole('button', { name: 'Contents (75)', exact: true }).click()
    await expect(bundles).toHaveCount(0)
    await lastFolder.click()
    await page.keyboard.press('ArrowRight')
    await expect(lastFolder).toBeFocused()
    await page.getByRole('button', { name: 'Contents (75)', exact: true }).click()
    await page.getByRole('button', { name: 'Collections (3)', exact: true }).click()
    await page.getByRole('button', { name: 'List', exact: true }).click()
    await bundles.focus()
    await page.keyboard.press('Home')
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowUp')
    await expect(first).toHaveAttribute('aria-selected', 'true')
    for (let index = 0; index < 40; index++) await page.keyboard.press('ArrowDown')
    const current = page.locator(`[data-bundle-id="${expected.items[40]!.id}"]`)
    await expect(current).toHaveAttribute('aria-selected', 'true')
    await expect(current).toBeVisible()
    await expect(bundles).toHaveAttribute(
      'aria-activedescendant',
      `bundle-option-${expected.items[40]!.id}`,
    )
    expect(await bundles.getByRole('option').count()).toBeLessThan(75)
  } finally {
    await context.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
