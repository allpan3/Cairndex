import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test.use({ actionTimeout: 15_000 })

test('local opening history and observed sizes restore Recent and complete sorts @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-history-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.discovery_fixture import create_discovery; print(create_discovery(parent=Path(sys.argv[1]),playable=True))',
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
    const page = await context.newPage()
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    const cards = page.getByRole('listbox', { name: 'Bundles', exact: true })
    const card = page.locator('[data-bundle-id="bundle-000001"]')
    await card.click()
    const inspector = page.getByRole('complementary', { name: 'Bundle inspector' })
    await expect(inspector.getByText('Unknown on this device')).toBeVisible()
    const bulk = page.getByRole('complementary', { name: 'Selected bundles inspector' })
    const secondCard = page.locator('[data-bundle-id="bundle-000002"]')
    await secondCard.click({ modifiers: ['ControlOrMeta'] })
    await expect(bulk.getByText('Unknown on this device', { exact: true })).toBeVisible()
    await card.click()
    const base = `${backend.baseUrl}/api/v1/libraries/${library.id}/replica`
    const browse = async (sort: string, order = 'desc') =>
      apiPost<{
        items: {
          id: string
          total_size: number | null
          date_opened: string | null
          date_modified: string | null
        }[]
      }>(backend.baseUrl, `/api/v1/libraries/${library.id}/replica/catalog/bundles/browse`, {
        sort,
        order,
        limit: 100,
      })
    expect((await browse('date_opened')).items.every((item) => item.date_opened === null)).toBe(
      true,
    )
    await card.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open Bundle', exact: true }).click()
    await expect(page.getByRole('list', { name: 'Album items' })).toBeVisible()
    await expect.poll(async () => (await browse('date_opened')).items[0].id).toBe('bundle-000001')
    const opened = (await browse('date_opened')).items[0].date_opened
    // Metadata polling and album pagination are reads, not new openings.
    await fetch(`${base}/media/bundles/bundle-000001/album?offset=0&limit=1`)
    await fetch(`${base}/media/bundles/bundle-000001/album?offset=1&limit=1`)
    expect((await browse('date_opened')).items[0].date_opened).toBe(opened)
    await page.getByRole('button', { name: 'Back to library', exact: true }).click()
    await page.getByRole('button', { name: /^Recent( \d+)?$/ }).click()
    await page.getByRole('button', { name: 'Sort', exact: true }).click()
    await page.getByRole('button', { name: 'Date Opened', exact: true }).click()
    await page.getByRole('button', { name: /Descending ↓/ }).click()
    await page.keyboard.press('Escape')
    await expect(cards.getByRole('option').first()).toHaveAttribute(
      'data-bundle-id',
      'bundle-000001',
    )
    await page.reload()
    await page.getByRole('button', { name: /^Recent( \d+)?$/ }).click()
    await expect(page.getByRole('button', { name: 'Sort', exact: true })).toContainText(
      'Date Opened',
    )
    await page.locator('[data-bundle-id="bundle-000002"]').click()
    await inspector
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('Synthetic edited bundle')
    await inspector.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(inspector.getByText('Saved here', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Sort', exact: true }).click()
    await page.getByRole('button', { name: 'Date Modified', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(cards.getByRole('option').first()).toHaveAttribute(
      'data-bundle-id',
      'bundle-000002',
    )
    expect((await browse('date_opened')).items[0].date_opened).toBe(opened)
    await page.getByRole('button', { name: 'Update', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await browse('size')).items.find((item) => item.id === 'bundle-000001')?.total_size,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0)
    await page.getByRole('button', { name: /^All( \d+)?$/ }).click()
    await page.getByRole('button', { name: 'Sort', exact: true }).click()
    await page.getByRole('button', { name: 'Size', exact: true }).click()
    await page.getByRole('button', { name: /Descending ↓/ }).click()
    await page.keyboard.press('Escape')
    await expect(cards.getByRole('option').first()).toHaveAttribute(
      'data-bundle-id',
      'bundle-000001',
    )
    await card.click()
    await expect(inspector.getByText('Unknown on this device')).toHaveCount(0)
    const size = await inspector
      .locator('.prop')
      .filter({ has: page.getByText('Size', { exact: true }) })
      .locator('.prop__v')
      .innerText()
    await secondCard.click({ modifiers: ['ControlOrMeta'] })
    await expect(
      bulk
        .locator('.prop')
        .filter({ has: page.getByText('Size', { exact: true }) })
        .locator('.prop__v'),
    ).toHaveText(size)
    await page.mouse.move(0, 0)
    await page.screenshot({ path: test.info().outputPath('synthetic-bulk-size.png') })
    await card.click()
    // Servers without this contract keep their supported sort menu.
    await page.route('**/replica/status', async (route) => {
      const response = await fetch(backend.baseUrl + new URL(route.request().url()).pathname)
      const body = await response.json()
      body.browse_version = 10
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
    })
    await page.reload()
    await page.getByRole('button', { name: 'Sort', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Size', exact: true })).toHaveCount(0)
  } finally {
    try {
      await context.close()
    } finally {
      await stopBackend(backend.child)
      await rm(scratch, { recursive: true, force: true })
    }
  }
})
