import { expect, test, type Locator } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, openMetadataReview, proxyApi, startBackend, stopBackend } from './realBackend'

type Entity = { id: string; fields: Record<string, { value: string } | undefined> }

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

// A second Update finds a sidecar for an accepted bundle, two new bundles in its
// folder and one folder of 100 subjects. The sidecar is listed above the tree and
// keeps its own selection; converting the 100 subjects is timed both ways.
test('additions list above the tree, keep their selection and join their bundle intact @fullstack', async ({
  browser,
}) => {
  test.setTimeout(420_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-grouping-sections-'))
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
  async function write(path: string) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), `synthetic ${path}`)
    paths.push(path)
  }
  await write('Series/Alpha/feature.mp4')
  await write('Series/Beta/feature.mp4')
  const backend = await startBackend(join(scratch, 'private'))
  const context = await browser.newContext()
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const base = `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog/entities`
    async function entity(family: string, id: string) {
      const response = await fetch(`${base}/${family}/${id}`)
      expect(response.ok).toBe(true)
      return (await response.json()) as Entity
    }
    async function list(family: string) {
      const response = await fetch(`${base}/${family}?limit=50`)
      expect(response.ok).toBe(true)
      return ((await response.json()) as { items: Entity[] }).items
    }
    async function members(bundle: string) {
      const value = (await entity('asset_bundles', bundle)).fields.$members!.value
      return (JSON.parse(value) as { id: string; family: string; sequence: number }[])
        .filter((item) => item.family === 'asset_files')
        .sort((a, b) => a.sequence - b.sequence)
        .map((item) => item.id)
    }
    const page = await context.newPage()
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await openMetadataReview(page)
    await page.getByRole('button', { name: 'Update', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Grouping review' })
    const tree = dialog.getByRole('tree', { name: 'Grouping suggestions' })
    const summary = (text: string) => dialog.getByText(text, { exact: true })
    const ready = dialog.getByRole('button', { name: 'Prepare selected grouping' })
    const accept = dialog.getByRole('button', { name: 'Accept reviewed grouping', exact: true })

    // First Update: accept the suggested collection of two bundles
    await expect(summary('2 / 2 files selected · 2 bundles')).toBeVisible({ timeout: 60_000 })
    await ready.click()
    await expectPrepared(dialog)
    await accept.click()
    await expect(summary('0 / 0 files selected · 0 bundles')).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const bundles = await list('asset_bundles')
    const titled = (title: string) =>
      bundles.find((item) => item.fields.title?.value === JSON.stringify(title))!.id
    const alpha = titled('Alpha')
    const beta = titled('Beta')
    const alphaBefore = await members(alpha)
    const betaBefore = await members(beta)
    expect(alphaBefore).toHaveLength(1)
    expect(betaBefore).toHaveLength(1)
    const placements = (await list('asset_bundle_collections'))
      .map((item) => item.id)
      .filter((id) => id.startsWith(`${alpha}~`) || id.startsWith(`${beta}~`))
    expect(placements).toHaveLength(2)

    // Second Update: a subtitle for Alpha, two new bundles beside it, and one
    // folder of 100 subjects, each a video with its subtitle
    await write('Series/Alpha/feature.srt')
    await write('Series/Gamma/feature.mp4')
    await write('Series/Delta/feature.mp4')
    for (let index = 1; index <= 100; index++) {
      const subject = `Shows/episode${String(index).padStart(3, '0')}`
      await write(`${subject}.mp4`)
      await write(`${subject}.srt`)
    }
    // The run's own success and the review it reopens are timed apart, within
    // one 120 s budget, polled every 50 ms
    const discovery = `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/discovery`
    const latestRun = async () =>
      (await (await fetch(`${discovery}/status`)).json()) as { id?: string; state: string }
    const earlier = (await latestRun()).id
    const updating = performance.now()
    const remaining = () => Math.max(1, 120_000 - (performance.now() - updating))
    await page.getByRole('button', { name: 'Update', exact: true }).click()
    await expect
      .poll(
        async () => {
          const run = await latestRun()
          return run.id === earlier ? 'not started' : run.state
        },
        { intervals: [50], timeout: remaining() },
      )
      .toBe('succeeded')
    const updated = performance.now()
    await expect
      .poll(() => summary('203 / 203 files selected · 103 bundles').isVisible(), {
        intervals: [50],
        timeout: remaining(),
      })
      .toBe(true)
    const update = {
      files: 203,
      runMs: Math.round(updated - updating),
      reopenMs: Math.round(performance.now() - updated),
    }
    const row = (name: string) =>
      tree
        .getByRole('treeitem')
        .filter({ has: page.getByRole('checkbox', { name: `Accept ${name}`, exact: true }) })
    const check = (name: string) =>
      row(name).getByRole('checkbox', { name: `Accept ${name}`, exact: true })
    const heading = (title: string) =>
      tree.getByRole('treeitem').filter({ has: page.getByText(title, { exact: true }) })
    const top = async (locator: Locator) => (await locator.boundingBox())!.y
    const additions = heading('Add to existing bundles')
    const suggestions = heading('New bundles and collections')
    await expect(additions).toHaveAttribute('aria-level', '1')
    await expect(row('Alpha')).toHaveAttribute('aria-level', '2')
    await expect(row('Alpha').getByText('1 new file', { exact: true })).toBeVisible()
    expect(await top(additions)).toBeLessThan(await top(row('Alpha')))
    expect(await top(row('Alpha'))).toBeLessThan(await top(suggestions))
    for (const name of ['Series', 'Shows'])
      expect(await top(suggestions)).toBeLessThan(await top(row(name)))
    await page.mouse.move(0, 0)
    await page.screenshot({ path: test.info().outputPath('synthetic-grouping-sections.png') })

    // Wall time from the click until the saved edit's summary shows and Prepare
    // is offered again. Polling every 50 ms keeps the assertions' back-off out
    // of the measurement.
    const latency: { interaction: string; ms: number; summary: string }[] = []
    async function timed(interaction: string, act: () => Promise<void>, text: string) {
      const started = performance.now()
      await act()
      await expect
        .poll(async () => (await summary(text).isVisible()) && (await ready.isEnabled()), {
          intervals: [50],
          timeout: 120_000,
        })
        .toBe(true)
      latency.push({ interaction, ms: Math.round(performance.now() - started), summary: text })
    }
    await timed(
      'Clear the Series collection',
      () => check('Series').uncheck(),
      '201 / 203 files selected · 103 bundles',
    )
    // The branch leaves the separately listed addition selected
    await expect(check('Alpha')).toBeChecked()
    const shows = (kind: 'bundle' | 'collection') =>
      tree
        .locator(`.grp-row--${kind}`)
        .filter({ has: page.getByRole('button', { name: 'Shows', exact: true }) })
    await timed(
      'Convert the 100-subject collection to a bundle',
      () => dialog.getByRole('button', { name: 'Convert to bundle: Shows', exact: true }).click(),
      '201 / 203 files selected · 4 bundles',
    )
    await expect(
      shows('bundle').getByText('200 files · video, subtitle', { exact: true }),
    ).toBeVisible()
    await timed(
      'Convert the 200-file bundle back to a collection',
      () =>
        dialog.getByRole('button', { name: 'Convert to collection: Shows', exact: true }).click(),
      '201 / 203 files selected · 103 bundles',
    )
    await expect(shows('collection').getByText('100 bundles', { exact: true })).toBeVisible()
    const receipt = { update, subjects: 100, files: 200, interactions: latency }
    console.log(JSON.stringify({ groupingSectionsLatency: receipt }))
    await test.info().attach('grouping-sections-latency', {
      body: JSON.stringify(receipt, null, 2),
      contentType: 'application/json',
    })
    // Draft edits author nothing
    expect(await members(alpha)).toEqual(alphaBefore)

    // Accept only the addition; the rest stays in the draft
    await check('Shows').uncheck()
    await expect(summary('1 / 203 files selected · 103 bundles')).toBeVisible({
      timeout: 60_000,
    })
    await expect(ready).toBeEnabled({ timeout: 60_000 })
    await ready.click()
    await expectPrepared(dialog)
    await accept.click()
    await expect(summary('0 / 202 files selected · 102 bundles')).toBeVisible({
      timeout: 60_000,
    })
    // The accepted video keeps its identity and the subtitle joins it
    const alphaAfter = await members(alpha)
    expect(alphaAfter).toEqual(expect.arrayContaining(alphaBefore))
    expect(alphaAfter).toHaveLength(alphaBefore.length + 1)
    const added = alphaAfter.find((id) => !alphaBefore.includes(id))!
    const relative = (await entity('asset_files', added)).fields.relative_path!.value
    expect(JSON.parse(relative)).toBe('Series/Alpha/feature.srt')
    expect(await members(beta)).toEqual(betaBefore)
    for (const id of placements)
      expect((await entity('asset_bundle_collections', id)).fields.$alive?.value).toBe('true')
    for (const path of paths)
      expect(await readFile(join(root, path), 'utf8')).toBe(`synthetic ${path}`)
  } finally {
    await Promise.allSettled([context.close(), stopBackend(backend.child)])
    await rm(scratch, { recursive: true, force: true })
  }
})
