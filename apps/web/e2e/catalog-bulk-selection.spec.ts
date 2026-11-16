import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

const TOTAL = 130
const IDS = Array.from({ length: TOTAL }, (_, index) => `bundle-${String(index).padStart(6, '0')}`)

type Selection = { items: { id: string; title: string | null }[] }

// Select All takes every matching bundle without loading the grid's later pages
async function selectAll(page: Page) {
  const listing = page.getByRole('listbox', { name: 'Bundles', exact: true })
  await listing.getByRole('option').first().click()
  await page.keyboard.press('ControlOrMeta+A')
  await expect(page.locator('.toolbar__count').first()).toContainText(`${TOTAL} selected`, {
    timeout: 30_000,
  })
}

test('a selection above 100 bundles changes title, tags and deletion in batches @fullstack', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-bulk-selection-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      `from pathlib import Path; import sys; from cairndex.devtools.catalog_fixture import create_disposable; from cairndex.replicas.catalog.conversion import prepare_disposable; print(prepare_disposable(create_disposable(parent=Path(sys.argv[1]),bundles=${TOTAL})).package)`,
      scratch,
    ],
    { cwd: fileURLToPath(new URL('../../server/', import.meta.url)) },
  )
    .toString()
    .trim()
  const backend = await startBackend(join(scratch, 'private'))
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const catalog = `/api/v1/libraries/${library.id}/replica/catalog`
    const titles = async () =>
      (
        await Promise.all(
          [IDS.slice(0, 100), IDS.slice(100)].map((ids) =>
            apiPost<Selection>(backend.baseUrl, `${catalog}/bundles/selection`, { ids }),
          ),
        )
      ).flatMap((page) => page.items.map((item) => item.title))
    const page = await context.newPage()
    // Which grid pages the browser loaded, and whether Select All read identities
    const offsets: number[] = []
    let identityReads = 0
    page.on('request', (request) => {
      if (request.url().endsWith('/bundles/browse'))
        offsets.push((request.postDataJSON() as { offset: number }).offset)
      if (request.url().endsWith('/bundles/browse/ids')) identityReads += 1
    })
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await selectAll(page)
    // The grid pages 50 bundles at a time and never reached its last page
    expect(identityReads).toBeGreaterThan(0)
    expect(Math.max(...offsets)).toBeLessThan(100)
    const bulk = page.getByRole('complementary', { name: 'Selected bundles inspector' })
    await expect(bulk.getByRole('heading', { name: `${TOTAL} bundles selected` })).toBeVisible()
    await expect(bulk.getByText('Select up to 100 bundles')).toHaveCount(0)

    // One title for all of them, saved in two batches
    const title = bulk.getByRole('textbox', { name: 'Title', exact: true })
    await expect(title).toBeEnabled()
    await title.fill('Shelved synthetic title')
    await title.press('Enter')
    await expect(bulk.getByText('Saved here', { exact: true })).toBeVisible({ timeout: 60_000 })
    expect(new Set(await titles())).toEqual(new Set(['Shelved synthetic title']))

    // A tag picked in the inspector reaches every selected bundle
    const tagged = async () => {
      let count = 0
      for (const ids of [IDS.slice(0, 100), IDS.slice(100)]) {
        const page = await apiPost<{ items: { assigned_count: number }[] }>(
          backend.baseUrl,
          `${catalog}/bundles/selection/memberships`,
          { ids, family: 'tags', target: 'tags-child' },
        )
        count += page.items[0]?.assigned_count ?? 0
      }
      return count
    }
    const tags = bulk.locator('[data-section="tags"]')
    await tags.getByRole('button', { name: '+ Tag', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Choose tags' })
    await picker.getByRole('button', { name: /^Synthetic root\/Synthetic child/ }).click()
    await page.keyboard.press('Escape')
    await expect.poll(tagged, { timeout: 30_000 }).toBe(TOTAL)
    await expect(tags.getByRole('button', { name: 'Remove Synthetic child' })).toBeEnabled()

    // The Tags submenu keeps the server's large-selection capability after copying.
    const first = page
      .getByRole('listbox', { name: 'Bundles', exact: true })
      .getByRole('option')
      .first()
    await first.click()
    await first.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Tags', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Copy Tags', exact: true }).click()
    await expect(page.getByText(/Copied \d+ tags?\./)).toBeVisible()
    await selectAll(page)
    await first.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Tags', exact: true }).click()
    const paste = page.getByRole('menuitem', { name: 'Paste Tags', exact: true })
    await expect(paste).toBeEnabled()
    await paste.click()
    await expect(page.getByText(/Pasted \d+ tags? onto 130 bundles\./)).toBeVisible({
      timeout: 60_000,
    })

    // Another device rates one bundle after the inspector read it; the bulk rating
    // leaves that bundle as it was and offers to select it for review
    const peer = IDS[120]!
    const entity = (await (
      await fetch(`${backend.baseUrl}${catalog}/entities/asset_bundles/${peer}`)
    ).json()) as {
      parents: string[]
      fields: Record<string, { unit: string; basis: string[] }>
    }
    await apiPost(backend.baseUrl, `${catalog}/jobs`, {
      operation: 'peer-rating',
      action: 'save',
      body: {
        changes: [
          { unit: entity.fields.rating!.unit, value: '1', basis: entity.fields.rating!.basis },
          { unit: entity.fields.$alive!.unit, value: 'true', basis: entity.fields.$alive!.basis },
        ],
        parents: entity.parents,
        resolve: false,
        recover: false,
      },
    })
    await expect
      .poll(async () => {
        const job = await fetch(`${backend.baseUrl}${catalog}/jobs/peer-rating`)
        return ((await job.json()) as { state: string }).state
      })
      .toBe('succeeded')
    await bulk.getByRole('radio', { name: '4½ stars' }).click()
    const alert = bulk.getByRole('alert')
    await expect(alert).toContainText(`Changed ${TOTAL - 1} of ${TOTAL} bundles`, {
      timeout: 60_000,
    })
    await alert.getByRole('button', { name: 'Select Unchanged' }).click()
    await expect(page.getByRole('complementary', { name: 'Bundle inspector' })).toBeVisible()
    await selectAll(page)

    // Delete Bundles from the card menu returns every file to Unbundled
    const listing = page.getByRole('listbox', { name: 'Bundles', exact: true })
    await listing.getByRole('option', { selected: true }).first().click({ button: 'right' })
    await page
      .getByRole('menu')
      .getByRole('menuitem', { name: `Delete ${TOTAL} Bundles` })
      .click()
    await page
      .getByRole('dialog', { name: /Delete/ })
      .getByRole('button', { name: 'Delete', exact: true })
      .click()
    await expect(page.getByText(`${TOTAL} bundles deleted.`)).toBeVisible({ timeout: 60_000 })
    await expect.poll(async () => (await titles().catch(() => null)) === null).toBe(true)
  } finally {
    await context.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
