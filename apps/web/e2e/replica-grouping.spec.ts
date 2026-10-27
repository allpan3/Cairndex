import { expect, test, type Locator } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, openMetadataReview, proxyApi, startBackend, stopBackend } from './realBackend'

// Prepared means the review's own status names that state and Accept is offered
async function expectPrepared(dialog: Locator) {
  const prepared = dialog.getByRole('region', { name: 'Prepared grouping review' })
  await expect(prepared.getByRole('status')).toHaveText('Ready for your confirmation', {
    timeout: 30_000,
  })
  await expect(
    dialog.getByRole('button', { name: 'Accept reviewed grouping', exact: true }),
  ).toBeEnabled()
}

test('editable grouping retains renamed drafts and accepts exact files after keyboard moves @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-editable-grouping-'))
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.discovery_fixture import create_discovery; print(create_discovery(parent=Path(sys.argv[1])))',
      scratch,
    ],
    { cwd: serverDir, encoding: 'utf8' },
  ).trim()
  const paths = []
  for (const folder of ['Alpha', 'Beta']) {
    await mkdir(join(root, 'Series', folder), { recursive: true })
    for (const name of ['feature.mp4', 'feature.srt', 'poster.png']) {
      const path = `Series/${folder}/${name}`
      paths.push(path)
      await writeFile(join(root, path), `synthetic grouping source ${path}`)
    }
  }
  const before = await Promise.all(paths.map((path) => readFile(join(root, path))))
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
    await dialog.getByRole('button', { name: 'Expand suggestion Series', exact: true }).click()
    await dialog.getByRole('button', { name: 'Alpha', exact: true }).dblclick()
    await dialog.getByRole('textbox', { name: 'Rename suggestion Alpha' }).fill('Reviewed Alpha')
    await dialog.getByRole('textbox', { name: 'Rename suggestion Alpha' }).press('Enter')
    await expect(dialog.getByRole('button', { name: 'Reviewed Alpha', exact: true })).toBeVisible()
    await page.mouse.move(0, 0)
    await page.screenshot({ path: test.info().outputPath('synthetic-grouping-review.png') })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.reload()
    await openMetadataReview(page)
    await page.getByRole('button', { name: 'Review discoveries', exact: true }).click()
    await dialog.getByRole('button', { name: 'Expand suggestion Series', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Reviewed Alpha', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Select none', exact: true }).click()
    await expect(
      dialog.getByText('0 / 6 files selected · 2 bundles', { exact: true }),
    ).toBeVisible()
    const alpha = dialog.getByRole('checkbox', { name: 'Accept Reviewed Alpha', exact: true })
    // check() skips its action when an old checked row is still disabled during refresh.
    await expect(alpha).not.toBeChecked()
    await expect(alpha).toBeEnabled()
    await alpha.check()
    await expect(
      dialog.getByText('3 / 6 files selected · 2 bundles', { exact: true }),
    ).toBeVisible()
    await dialog.getByRole('button', { name: 'Expand suggestion Beta', exact: true }).click()
    await dialog
      .getByRole('button', {
        name: 'Move file Series/Beta/feature.mp4 to another suggestion',
        exact: true,
      })
      .click()
    const move = page.getByRole('dialog', { name: 'Move grouping suggestion' })
    await move
      .getByRole('textbox', { name: 'Search suggestion destinations' })
      .fill('Reviewed Alpha')
    await move.getByRole('button', { name: /Reviewed Alpha/ }).click()
    await expect(move).toHaveCount(0)
    await dialog
      .getByRole('button', { name: 'Expand suggestion Reviewed Alpha', exact: true })
      .click()
    await dialog
      .getByRole('checkbox', { name: 'Accept file Series/Beta/feature.mp4', exact: true })
      .check()
    await expect(
      dialog.getByText('4 / 6 files selected · 2 bundles', { exact: true }),
    ).toBeVisible()
    await dialog
      .getByRole('checkbox', { name: 'Accept file Series/Alpha/feature.srt', exact: true })
      .uncheck()
    await expect(
      dialog.getByText('3 / 6 files selected · 2 bundles', { exact: true }),
    ).toBeVisible()
    await dialog
      .getByRole('button', { name: 'Move Series/Beta/feature.mp4 up', exact: true })
      .click()
    await expect(dialog.getByRole('button', { name: 'Prepare selected grouping' })).toBeEnabled()
    await dialog
      .getByRole('button', { name: 'Move Series/Beta/feature.mp4 up', exact: true })
      .click()
    await expect(dialog.getByRole('button', { name: 'Prepare selected grouping' })).toBeEnabled()
    await dialog.getByRole('checkbox', { name: 'Verify file contents' }).check()
    await dialog.getByRole('button', { name: 'Prepare selected grouping' }).click()
    await expectPrepared(dialog)
    await dialog.getByRole('button', { name: 'Accept reviewed grouping', exact: true }).click()
    await expect(dialog.getByText('0 / 3 files selected · 2 bundles', { exact: true })).toBeVisible(
      { timeout: 30_000 },
    )
    const response = await fetch(
      `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog/entities/asset_files?limit=50`,
    )
    expect(response.ok).toBe(true)
    const summaries = (await response.json()).items as { id: string }[]
    const files = await Promise.all(
      summaries.map(async (file) => {
        const detail = await fetch(
          `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog/entities/asset_files/${file.id}`,
        )
        expect(detail.ok).toBe(true)
        return (await detail.json()) as { id: string; fields: Record<string, { value: string }> }
      }),
    )
    const accepted = files.filter((file) => file.fields.relative_path?.value.startsWith('"Series/'))
    expect(accepted).toHaveLength(3)
    expect(accepted.map((file) => JSON.parse(file.fields.relative_path.value))).not.toContain(
      'Series/Alpha/feature.srt',
    )
    const bundlesResponse = await fetch(
      `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog/entities/asset_bundles?limit=50`,
    )
    const bundles = (await bundlesResponse.json()).items as {
      id: string
      fields: Record<string, { value: string }>
    }[]
    const bundle = bundles.find((item) => item.fields.title?.value === '"Reviewed Alpha"')!
    expect(bundle).toBeTruthy()
    const bundleResponse = await fetch(
      `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog/entities/asset_bundles/${bundle.id}`,
    )
    const detail = (await bundleResponse.json()) as { fields: Record<string, { value: string }> }
    const members = JSON.parse(detail.fields.$members.value) as {
      id: string
      family: string
      sequence: number
    }[]
    const byId = new Map(
      accepted.map((file) => [file.id, JSON.parse(file.fields.relative_path.value) as string]),
    )
    expect(
      members
        .filter((item) => item.family === 'asset_files')
        .sort((a, b) => a.sequence - b.sequence)
        .map((item) => byId.get(item.id)),
    ).toEqual(['Series/Alpha/feature.mp4', 'Series/Beta/feature.mp4', 'Series/Alpha/poster.png'])
    for (let index = 0; index < paths.length; index++)
      expect(await readFile(join(root, paths[index]))).toEqual(before[index])
  } finally {
    await Promise.allSettled([context.close(), stopBackend(backend.child)])
    await rm(scratch, { recursive: true, force: true })
  }
})

test('large editable grouping keeps later files in view through edits and partial acceptance @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-grouping-pages-'))
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.discovery_fixture import create_discovery; print(create_discovery(parent=Path(sys.argv[1])))',
      scratch,
    ],
    { cwd: serverDir, encoding: 'utf8' },
  ).trim()
  await mkdir(join(root, 'Gallery'))
  for (let index = 0; index < 201; index++)
    await writeFile(
      join(root, 'Gallery', `frame${String(index).padStart(3, '0')}.png`),
      `synthetic frame ${index}`,
    )
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
    await expect(page.getByText(/Update complete/)).toBeVisible({ timeout: 60_000 })
    const dialog = page.getByRole('dialog', { name: 'Grouping review' })
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Expand suggestion Gallery', exact: true }).click()
    const tree = dialog.getByRole('tree', { name: 'Grouping suggestions' })
    await tree.getByRole('button', { name: 'Show files in Gallery', exact: true }).click()
    await expect(
      tree.getByRole('checkbox', { name: 'Accept file Gallery/frame000.png', exact: true }),
    ).toBeVisible()
    for (let index = 0; index < 4; index++) {
      await tree.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      await tree.getByRole('button', { name: 'Show more files', exact: true }).click()
      await expect(
        tree.getByRole('checkbox', {
          name: `Accept file Gallery/frame${String((index + 1) * 50).padStart(3, '0')}.png`,
          exact: true,
        }),
      ).toBeVisible()
    }
    const last = tree.getByRole('checkbox', {
      name: 'Accept file Gallery/frame200.png',
      exact: true,
    })
    await last.uncheck()
    await expect(
      dialog.getByText('200 / 201 files selected · 1 bundle', { exact: true }),
    ).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Prepare selected grouping' })).toBeEnabled()
    await expect(last).toBeVisible()
    await expect(last).not.toBeChecked()
    await dialog.getByRole('button', { name: 'Prepare selected grouping' }).click()
    await expectPrepared(dialog)
    await dialog.getByText('Review prepared files and metadata', { exact: true }).click()
    await expect(dialog.getByText('200 selected files · 1 groups', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Accept reviewed grouping', exact: true }).click()
    await expect(dialog.getByText('0 / 1 files selected · 1 bundle', { exact: true })).toBeVisible({
      timeout: 30_000,
    })
    await expect(last).toBeVisible()
    await last.check()
    await dialog.getByRole('button', { name: 'Prepare selected grouping' }).click()
    await expectPrepared(dialog)
    await dialog.getByRole('button', { name: 'Accept reviewed grouping', exact: true }).click()
    await expect(dialog.getByText('0 / 0 files selected · 0 bundles', { exact: true })).toBeVisible(
      { timeout: 30_000 },
    )
    const base = `${backend.baseUrl}/api/v1/libraries/${library.id}/replica`
    const response = await fetch(`${base}/catalog/entities/asset_bundles?limit=50`)
    const bundles = (await response.json()).items as {
      id: string
      fields: Record<string, { value: string }>
    }[]
    const galleries = bundles.filter((item) => item.fields.title?.value === '"Gallery"')
    expect(galleries).toHaveLength(1)
    const detail = (await (
      await fetch(`${base}/catalog/entities/asset_bundles/${galleries[0]!.id}`)
    ).json()) as { fields: Record<string, { value: string }> }
    const members = JSON.parse(detail.fields.$members.value) as { id: string; family: string }[]
    expect(
      new Set(members.filter((item) => item.family === 'asset_files').map((item) => item.id)).size,
    ).toBe(201)
    expect((await (await fetch(`${base}/discovery/candidates`)).json()).items).toEqual([])
    expect(await readFile(join(root, 'Gallery/frame200.png'), 'utf8')).toBe('synthetic frame 200')
  } finally {
    await Promise.allSettled([context.close(), stopBackend(backend.child)])
    await rm(scratch, { recursive: true, force: true })
  }
})
