import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, openMetadataReview, proxyApi, startBackend, stopBackend } from './realBackend'

test('grouping summaries, keyboard selection, stem controls, kind, placement and file drags retain private choices @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-grouping-interactions-'))
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
  const paths: string[] = []
  for (const folder of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
    await mkdir(join(root, 'Series', folder), { recursive: true })
    for (const suffix of ['mp4', 'srt']) paths.push(`Series/${folder}/feature.${suffix}`)
  }
  await mkdir(join(root, 'Renditions'))
  paths.push('Renditions/scene.720p.mp4', 'Renditions/scene.1080p.mp4')
  for (const path of paths) await writeFile(join(root, path), `synthetic ${path}`)
  const before = await Promise.all(paths.map((path) => readFile(join(root, path))))
  const backend = await startBackend(join(scratch, 'private'))
  const context = await browser.newContext()
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await openMetadataReview(page)
    await page.getByRole('button', { name: 'Update', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Grouping review' })
    const tree = dialog.getByRole('tree', { name: 'Grouping suggestions' })
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await expect(
      dialog.getByText('10 / 10 files selected · 5 bundles', { exact: true }),
    ).toBeVisible()
    const ready = dialog.getByRole('button', { name: 'Prepare selected grouping' })
    await dialog
      .getByRole('button', { name: 'Narrow the filename match in Renditions', exact: true })
      .click()
    await expect(
      dialog.getByText('10 / 10 files selected · 6 bundles', { exact: true }),
    ).toBeVisible({ timeout: 30_000 })
    await expect(ready).toBeEnabled()
    await dialog
      .getByRole('button', { name: 'Widen the filename match in Renditions', exact: true })
      .first()
      .click()
    await expect(
      dialog.getByText('10 / 10 files selected · 5 bundles', { exact: true }),
    ).toBeVisible()
    await expect(ready).toBeEnabled()
    await dialog.getByRole('button', { name: 'Expand suggestion Series', exact: true }).click()
    await expect(
      dialog.getByText('4 bundles, same shape · each 2 files · video, subtitle', { exact: true }),
    ).toBeVisible()
    await page.mouse.move(0, 0)
    await page.screenshot({ path: test.info().outputPath('synthetic-grouping-summary.png') })
    const rolled = tree
      .getByRole('treeitem')
      .filter({ has: page.getByRole('checkbox', { name: /^Accept 4 suggestions from / }) })
    await rolled.focus()
    await rolled.press(' ')
    await expect(
      dialog.getByText('2 / 10 files selected · 5 bundles', { exact: true }),
    ).toBeVisible()
    await rolled.press('ArrowRight')
    await expect(dialog.getByRole('button', { name: 'Alpha', exact: true })).toBeVisible()
    const alphaCheck = tree.getByRole('checkbox', { name: 'Accept Alpha', exact: true })
    await expect(alphaCheck).toBeEnabled({ timeout: 30_000 })
    await alphaCheck.focus()
    await alphaCheck.press('ArrowDown')
    const beta = tree
      .getByRole('treeitem')
      .filter({ has: page.getByRole('button', { name: 'Beta', exact: true }) })
    await expect(beta).toBeFocused()
    await beta.press(' ')
    await expect(
      dialog.getByText('4 / 10 files selected · 5 bundles', { exact: true }),
    ).toBeVisible()
    await dialog.getByRole('button', { name: 'Fold 4 back into one row', exact: true }).click()
    const rollCheck = tree.getByRole('checkbox', { name: /^Accept 4 suggestions from / })
    await expect(rollCheck).toHaveJSProperty('indeterminate', true)
    await rollCheck.click()
    await expect(
      dialog.getByText('10 / 10 files selected · 5 bundles', { exact: true }),
    ).toBeVisible()
    await dialog.getByRole('button', { name: 'Show files', exact: true }).click()
    await expect(rollCheck).toHaveCount(0)
    const file = tree.locator('[data-grouping-file]').filter({
      has: page.getByRole('checkbox', {
        name: 'Accept file Series/Alpha/feature.mp4',
        exact: true,
      }),
    })
    const target = tree
      .locator('[data-grouping-node]')
      .filter({ has: page.getByRole('button', { name: 'Beta', exact: true }) })
    await file.dragTo(target)
    await expect(target.getByText('3 files · video, subtitle', { exact: true })).toBeVisible()
    await expect(ready).toBeEnabled()
    await dialog.getByRole('button', { name: 'Hide files', exact: true }).click()
    const series = tree.locator('[data-grouping-node]').filter({
      has: page.getByRole('button', { name: 'Series', exact: true }),
    })
    await target.dragTo(series)
    await expect
      .poll(() => tree.locator('[data-grouping-node] .grp-title').allTextContents())
      .toEqual(['Renditions', 'Series', 'Alpha', 'Delta', 'Gamma', 'Beta'])
    const seriesRow = tree.getByRole('treeitem').filter({
      has: page.getByRole('button', { name: 'Series', exact: true }),
    })
    await seriesRow.focus()
    await seriesRow.press('ArrowLeft')
    await expect(dialog.getByRole('button', { name: 'Beta', exact: true })).toHaveCount(0)
    await seriesRow.press('ArrowRight')
    await expect(dialog.getByRole('button', { name: 'Beta', exact: true })).toBeVisible()
    // Type and placement controls operate on the same retained draft. The kind
    // glyph converts; the row's context menu offers the same conversion.
    for (const kind of ['bundle', 'collection', 'bundle']) {
      if (kind === 'collection') {
        await tree
          .getByRole('treeitem')
          .filter({ has: page.getByRole('button', { name: 'Renditions', exact: true }) })
          .click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Convert to collection', exact: true }).click()
      } else
        await dialog
          .getByRole('button', { name: `Convert to ${kind}: Renditions`, exact: true })
          .click()
      await expect(
        tree
          .locator(`.grp-row--${kind}`)
          .filter({ has: page.getByRole('button', { name: 'Renditions', exact: true }) }),
      ).toBeVisible()
      await expect(ready).toBeEnabled()
    }
    await dialog
      .getByRole('button', { name: 'Placement for bundle suggestion Renditions', exact: true })
      .click()
    const child = page.getByRole('option', {
      name: 'Synthetic root / Synthetic child',
      exact: true,
    })
    const parent = page.getByRole('option', { name: 'Synthetic root', exact: true })
    await child.focus()
    await child.press('ArrowUp')
    await expect(parent).toBeFocused()
    await parent.press('ArrowDown')
    await expect(child).toBeFocused()
    await child.press('Enter')
    await expect(ready).toBeEnabled()
    const base = `${backend.baseUrl}/api/v1/libraries/${library.id}/replica`
    const workspaces = (await (await fetch(`${base}/discovery/grouping/workspaces`)).json()) as {
      items: { id: string }[]
    }
    const workspace = workspaces.items[0]!.id
    const status = (await (
      await fetch(`${base}/discovery/grouping/workspaces/${workspace}`)
    ).json()) as { revision: number }
    const roots = (await (
      await fetch(
        `${base}/discovery/grouping/workspaces/${workspace}/nodes?revision=${status.revision}`,
      )
    ).json()) as { items: { id: string; collection: string | null }[] }
    expect(roots.items.some((node) => node.collection === 'collections-root')).toBe(true)
    const authored = (await (
      await fetch(`${base}/catalog/entities/asset_files?limit=50`)
    ).json()) as { items: { id: string }[] }
    expect(authored.items).toHaveLength(2)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Bundle Browser', exact: true }).click()
    await page.getByRole('button', { name: 'More library actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Suggest grouping…', exact: true }).click()
    await expect(
      dialog.getByText('10 / 10 files selected · 5 bundles', { exact: true }),
    ).toBeVisible()
    await dialog
      .getByRole('button', { name: 'Expand suggestion Synthetic root', exact: true })
      .click()
    await dialog
      .getByRole('button', { name: 'Expand suggestion Synthetic child', exact: true })
      .click()
    await expect(dialog.getByRole('button', { name: 'Renditions', exact: true })).toBeVisible()
    // An existing collection is context only: its glyph is not a control
    await expect(
      dialog.getByRole('button', { name: 'Convert to bundle: Synthetic root', exact: true }),
    ).toHaveCount(0)
    // Nothing needs a look, so the filter is not offered
    await expect(dialog.getByRole('button', { name: /needs? a look$/ })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Renditions', exact: true })).toBeVisible()
    for (let index = 0; index < paths.length; index++)
      expect(await readFile(join(root, paths[index]!))).toEqual(before[index])
  } finally {
    await Promise.allSettled([context.close(), stopBackend(backend.child)])
    await rm(scratch, { recursive: true, force: true })
  }
})
