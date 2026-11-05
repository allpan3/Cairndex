import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, openMetadataReview, proxyApi, startBackend, stopBackend } from './realBackend'

test('Widen keeps a subject title below its retained collection @fullstack', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-grouping-titles-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.discovery_fixture import create_discovery; print(create_discovery(parent=Path(sys.argv[1])))',
      scratch,
    ],
    { cwd: fileURLToPath(new URL('../../server/', import.meta.url)), encoding: 'utf8' },
  ).trim()
  await mkdir(join(root, 'Contributor'))
  const paths = ['SCENE-204 - edit.mp4', 'SCENE-204-cover.jpg', 'SCENE-204.srt'].map((name) =>
    join(root, 'Contributor', name),
  )
  for (const path of paths) await writeFile(path, 'synthetic grouping source')
  const before = await Promise.all(paths.map((path) => readFile(path)))
  const backend = await startBackend(join(scratch, 'private'))
  const context = await browser.newContext()
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const page = await context.newPage()
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await openMetadataReview(page)
    await page.getByRole('button', { name: 'Update', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Grouping review' })
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await dialog
      .getByRole('button', { name: 'Convert to collection: Contributor', exact: true })
      .click()
    await expect(
      dialog.getByRole('button', { name: 'Prepare selected grouping', exact: true }),
    ).toBeEnabled()
    await dialog.getByRole('button', { name: 'Expand suggestion Contributor', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'SCENE', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Show files', exact: true }).click()
    const cover = dialog.getByRole('checkbox', {
      name: 'Accept file Contributor/SCENE-204-cover.jpg',
      exact: true,
    })
    await cover.uncheck()
    await expect(dialog.getByText('2 / 3 files selected · 1 bundle', { exact: true })).toBeVisible()
    for (const direction of ['Widen', 'Narrow']) {
      await dialog
        .getByRole('button', {
          name: `${direction} the filename match in Contributor`,
          exact: true,
        })
        .click()
      await expect(
        dialog.getByRole('button', { name: 'Prepare selected grouping', exact: true }),
      ).toBeEnabled()
      await expect(dialog.getByRole('button', { name: 'SCENE', exact: true })).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Contributor', exact: true })).toHaveCount(1)
      await expect(cover).not.toBeChecked()
    }
    await page.screenshot({ path: test.info().outputPath('synthetic-widen-title.png') })
    await dialog.getByRole('button', { name: 'Prepare selected grouping', exact: true }).click()
    const prepared = dialog.getByRole('region', { name: 'Prepared grouping review' })
    await expect(prepared.getByRole('status')).toHaveText('Ready for your confirmation', {
      timeout: 30_000,
    })
    await dialog.getByRole('button', { name: 'Accept reviewed grouping', exact: true }).click()
    await expect(dialog.getByText('0 / 1 files selected · 1 bundle', { exact: true })).toBeVisible({
      timeout: 30_000,
    })
    const response = await fetch(
      `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog/entities/asset_bundles?limit=50`,
    )
    expect(response.ok).toBe(true)
    expect(
      (await response.json()).items.some(
        (item: { fields: { title?: { value: string } } }) => item.fields.title?.value === '"SCENE"',
      ),
    ).toBe(true)
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before)
  } finally {
    await context.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
