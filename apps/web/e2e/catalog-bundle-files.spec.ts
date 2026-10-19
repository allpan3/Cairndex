import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test.use({ actionTimeout: 15_000 })

test('ordinary bundle files reorder, collapse, page, expand and return to Unbundled @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-bundle-files-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys,shutil; from cairndex.devtools.album_fixture import prepare_album; from cairndex.replicas.catalog.conversion import prepare_disposable; f=prepare_album(parent=Path(sys.argv[1])); p=prepare_disposable(f,format_version=3).package; [shutil.copytree(f.source/n,p/n) for n in ("Loose","Gallery","Gallery2")]; print(p)',
      scratch,
    ],
    { cwd: fileURLToPath(new URL('../../server/', import.meta.url)), encoding: 'utf8' },
  ).trim()
  const original = await readFile(join(root, 'Loose/frame061.png'))
  const backend = await startBackend(join(scratch, 'private'))
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const base = `${backend.baseUrl}/api/v1/libraries/${library.id}/replica`
    const album = async () =>
      (await fetch(`${base}/media/bundles/bundle-000001/album?limit=30`)).json()
    const page = await context.newPage()
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.locator('[data-bundle-id="bundle-000001"]').click()
    const rail = page
      .getByRole('complementary', { name: 'Bundle inspector' })
      .locator('[data-section="files"]')
    const loose = rail.locator('[data-member-id="loose-000"]')
    await expect(loose).toBeVisible({ timeout: 30_000 })
    await loose.focus()
    await loose.press('Alt+ArrowUp')
    await expect
      .poll(async () => (await album()).items[0].id, { timeout: 30_000 })
      .toBe('loose-000')
    const grip = rail.getByRole('button', { name: 'Reorder Gallery2/frame000.png', exact: true })
    await expect(grip).toBeEnabled({ timeout: 30_000 })
    await grip.scrollIntoViewIfNeeded()
    const from = await grip.boundingBox()
    const to = await rail.locator('[data-member-id="album-folder"]').boundingBox()
    if (!from || !to) throw new Error('Synthetic file controls are not laid out')
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width / 2, to.y + to.height - 2, { steps: 8 })
    await page.mouse.up()
    await expect
      .poll(async () => (await album()).items.slice(0, 3).map((item: { id: string }) => item.id), {
        timeout: 30_000,
      })
      .toEqual(['loose-000', 'album-folder', 'gallery2-000'])
    await rail.getByRole('button', { name: 'Actions for Loose/frame000.png', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Collapse “Loose” into One Row', exact: true }).click()
    const folder = rail.getByRole('button', { name: 'Show files in Loose', exact: true })
    await expect(folder).toBeVisible({ timeout: 30_000 })
    await expect(folder).toContainText('62 files')
    await folder.click()
    const nested = rail.getByRole('list', { name: 'Files in folder', exact: true })
    await expect(nested.locator('[data-member-id="loose-000"]')).toBeVisible({ timeout: 30_000 })
    await page.mouse.move(0, 0)
    await page.screenshot({ path: test.info().outputPath('synthetic-bundle-file-controls.png') })
    const nestedPage = nested.locator('..')
    await nestedPage.getByRole('button', { name: 'More files', exact: true }).click()
    await expect(nested.locator('[data-member-id="loose-030"]')).toBeVisible({ timeout: 30_000 })
    await nestedPage.getByRole('button', { name: 'More files', exact: true }).click()
    await expect(nested.locator('[data-member-id="loose-061"]')).toBeVisible({ timeout: 30_000 })
    await nested
      .getByRole('button', { name: 'Actions for Loose/frame061.png', exact: true })
      .click()
    let acknowledgeRemoval = () => {}
    const removalAcknowledgement = new Promise<void>((resolve) => {
      acknowledgeRemoval = resolve
    })
    // A polled count can change before the save acknowledgement reaches this window.
    await page.route('**/catalog/drafts/*?revision=*', async (route) => {
      if (route.request().method() === 'DELETE') await removalAcknowledgement
      await route.fallback()
    })
    try {
      await page.getByRole('menuitem', { name: 'Remove from Bundle', exact: true }).click()
      await expect
        .poll(
          async () => {
            const entity = await (
              await fetch(`${base}/catalog/entities/asset_files/loose-061`)
            ).json()
            const bundle = await (
              await fetch(`${base}/catalog/entities/asset_bundles/bundle-000001`)
            ).json()
            return {
              alive: JSON.parse(entity.fields.$alive.value),
              removed: !JSON.parse(bundle.fields.$members.value).some(
                (member: { id: string }) => member.id === 'loose-061',
              ),
            }
          },
          { timeout: 30_000 },
        )
        .toEqual({ alive: true, removed: true })
      await expect(
        rail.getByRole('button', { name: 'Hide files in Loose', exact: true }),
      ).toContainText('61 files', { timeout: 30_000 })
      await expect(rail.getByRole('button', { name: 'Reorder Loose', exact: true })).toBeDisabled()
      await expect(
        rail.getByRole('button', { name: 'Retry file change', exact: true }),
      ).toBeVisible()
    } finally {
      acknowledgeRemoval()
    }
    await expect(rail.getByRole('button', { name: 'Reorder Loose', exact: true })).toBeEnabled({
      timeout: 30_000,
    })
    await expect(rail.getByRole('button', { name: 'Retry file change', exact: true })).toHaveCount(
      0,
    )
    await page.reload()
    await page.locator('[data-bundle-id="bundle-000001"]').click()
    await rail.getByRole('button', { name: 'Show files in Loose', exact: true }).dblclick()
    await expect(page.getByRole('grid', { name: 'Files', exact: true })).toContainText(
      'frame061.png',
      { timeout: 30_000 },
    )
    await page.getByRole('button', { name: /^All( \d+)?$/ }).click()
    await page.locator('[data-bundle-id="bundle-000001"]').click()
    await rail.getByRole('button', { name: 'Play Gallery2/frame000.png', exact: true }).click()
    await expect(page.locator('.media-viewer')).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Show bundle inspector', exact: true }).click()
    await rail.getByRole('button', { name: 'Actions for Loose', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Open in File Browser', exact: true }).click()
    await expect(page.locator('.media-viewer')).toHaveCount(0)
    await expect(page.getByRole('grid', { name: 'Files', exact: true })).toContainText(
      'frame061.png',
      { timeout: 30_000 },
    )
    await page.getByRole('button', { name: /^All( \d+)?$/ }).click()
    await page.locator('[data-bundle-id="bundle-000001"]').click()
    await expect(rail.getByRole('button', { name: 'Reorder Loose', exact: true })).toBeEnabled({
      timeout: 30_000,
    })
    await rail.getByRole('button', { name: 'Actions for Loose', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Expand Folder into Files', exact: true }).click()
    await expect(
      rail.getByRole('button', { name: 'Show files in Loose', exact: true }),
    ).toHaveCount(0, { timeout: 30_000 })
    await expect(rail.locator('[data-member-id="loose-000"]')).toBeVisible({ timeout: 30_000 })
    const boundary = async () =>
      (
        await (await fetch(`${base}/media/bundles/bundle-000001/album?offset=29&limit=2`)).json()
      ).items.map((item: { id: string }) => item.id) as string[]
    const beforeBoundary = await boundary()
    await rail.getByRole('button', { name: 'More files', exact: true }).click()
    const crossing = rail.locator(`[data-member-id="${beforeBoundary[1]}"]`)
    await expect(crossing).toBeVisible({ timeout: 30_000 })
    await crossing.focus()
    await crossing.press('Alt+ArrowUp')
    await expect.poll(boundary, { timeout: 30_000 }).toEqual([...beforeBoundary].reverse())
    await expect(crossing).toBeFocused({ timeout: 30_000 })
    await expect(crossing.getByRole('button', { name: /^Reorder / })).toBeEnabled({
      timeout: 30_000,
    })
    await crossing.press('Alt+ArrowDown')
    await expect.poll(boundary, { timeout: 30_000 }).toEqual(beforeBoundary)
    await expect(crossing).toBeFocused({ timeout: 30_000 })
    await expect(crossing.getByRole('button', { name: /^Reorder / })).toBeEnabled({
      timeout: 30_000,
    })
    await crossing.getByRole('button', { name: /^Actions for / }).click()
    await page.getByRole('menuitem', { name: 'Move to Beginning', exact: true }).click()
    await expect
      .poll(async () => (await album()).items[0].id, { timeout: 30_000 })
      .toBe(beforeBoundary[1])
    await expect(crossing).toBeVisible({ timeout: 30_000 })
    await expect(crossing.getByRole('button', { name: /^Reorder / })).toBeEnabled({
      timeout: 30_000,
    })
    await crossing.getByRole('button', { name: /^Actions for / }).click()
    await page.getByRole('menuitem', { name: 'Move to End', exact: true }).click()
    await expect
      .poll(
        async () => {
          const total = (await album()).total
          return (
            await (
              await fetch(`${base}/media/bundles/bundle-000001/album?offset=${total - 1}&limit=1`)
            ).json()
          ).items[0].id
        },
        { timeout: 30_000 },
      )
      .toBe(beforeBoundary[1])
    await expect(crossing).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: /^Unbundled\b/ }).click()
    await expect(page.getByRole('grid', { name: 'Files', exact: true })).toContainText(
      'frame061.png',
      { timeout: 30_000 },
    )
    expect(await readFile(join(root, 'Loose/frame061.png'))).toEqual(original)
  } finally {
    await context.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
