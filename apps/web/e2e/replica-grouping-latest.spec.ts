import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, openMetadataReview, proxyApi, startBackend, stopBackend } from './realBackend'

test('a new Update opens current evidence and retains earlier edited drafts @fullstack', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-latest-grouping-'))
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
  await mkdir(join(root, 'scene'))
  const file = join(root, 'scene', 'scene.mp4')
  const bytes = Buffer.from('synthetic grouping source')
  await writeFile(file, bytes)
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
    await dialog.getByRole('button', { name: 'scene', exact: true }).dblclick()
    const rename = dialog.getByRole('textbox', { name: 'Rename suggestion scene' })
    await rename.fill('Saved earlier choice')
    await rename.press('Enter')
    await expect(
      dialog.getByRole('button', { name: 'Saved earlier choice', exact: true }),
    ).toBeVisible()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()

    // Change only the synthetic file's generation. The saved draft is now
    // stale, while a new Update obtains current evidence for the same bytes.
    const before = await stat(file)
    await utimes(file, before.atime, new Date(before.mtimeMs + 10_000))
    await page.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await expect(dialog.getByRole('button', { name: 'scene', exact: true })).toBeVisible()
    await expect(
      dialog.getByRole('button', { name: 'Saved earlier choice', exact: true }),
    ).toHaveCount(0)

    // The earlier draft and its title are still reachable, with its age clear.
    await dialog.getByText('Other drafts', { exact: true }).click()
    await dialog.getByRole('button', { name: '1 / 1 files', exact: true }).click()
    await expect(
      dialog.getByRole('button', { name: 'Saved earlier choice', exact: true }),
    ).toBeVisible()
    await expect(
      dialog.getByRole('status').filter({ hasText: 'This draft is from an earlier Update.' }),
    ).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('synthetic-earlier-draft.png') })
    await dialog.getByRole('button', { name: 'Open latest Update', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'scene', exact: true })).toBeVisible()
    await expect(
      dialog.getByRole('status').filter({ hasText: 'This draft is from an earlier Update.' }),
    ).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Accept selected', exact: true }).click()
    await expect(dialog.getByText('0 / 0 files selected · 0 bundles', { exact: true })).toBeVisible(
      { timeout: 30_000 },
    )
    const response = await fetch(
      `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog/entities/asset_bundles?limit=50`,
    )
    expect(response.ok).toBe(true)
    expect(
      (await response.json()).items.some(
        (item: { fields: { title?: { value: string } } }) => item.fields.title?.value === '"scene"',
      ),
    ).toBe(true)
    expect(await readFile(file)).toEqual(bytes)
  } finally {
    await context.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
