import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test('catalog selection retains exact bulk reviews across navigation, response loss and reload @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-selection-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.catalog_fixture import create_disposable; from cairndex.replicas.catalog.conversion import prepare_disposable; print(prepare_disposable(create_disposable(parent=Path(sys.argv[1]),bundles=65)).package)',
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
    const bundles = page.getByRole('listbox', { name: 'Bundles', exact: true })
    const first = bundles.getByRole('option').filter({ hasText: 'Synthetic bundle 1 雪' })
    const second = bundles.getByRole('option').filter({ hasText: 'Synthetic bundle 2 雪' })
    await first.click()
    const single = page.getByRole('complementary', { name: 'Bundle inspector' })
    await single.getByRole('textbox', { name: 'Note', exact: true }).fill('Private single draft')
    await second.click({ modifiers: ['ControlOrMeta'] })
    const bulk = page.getByRole('complementary', { name: 'Selected bundles inspector' })
    await expect(bulk.getByRole('heading', { name: '2 bundles selected' })).toBeVisible()
    await bulk.getByRole('textbox', { name: 'Bulk title' }).fill('Selected synthetic title')
    await bulk.getByRole('button', { name: 'Review bulk change' }).click()
    await expect(bulk.getByRole('button', { name: 'Apply bulk change' })).toBeEnabled()
    await page.getByRole('button', { name: 'Recent', exact: true }).click()
    await expect(bulk.getByRole('heading', { name: '0 bundles selected' })).toBeVisible()
    await expect(bulk.getByText('2 bundles in this retained review.')).toBeVisible()
    const requests: string[] = []
    let lose = true
    await page.route('**/replica/catalog/jobs', async (route) => {
      const request = route.request()
      const body = request.postDataJSON()
      if (body.action !== 'commit_preview') {
        await route.fallback()
        return
      }
      requests.push(request.postData()!)
      const response = await fetch(backend.baseUrl + new URL(request.url()).pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: request.postData()!,
      })
      if (lose) {
        lose = false
        await route.abort()
        return
      }
      await route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: await response.text(),
      })
    })
    await bulk.getByRole('button', { name: 'Apply bulk change' }).click()
    await expect(bulk.getByRole('button', { name: 'Retry bulk save' })).toBeEnabled()
    await page.reload()
    await page.getByRole('button', { name: /^Bulk changes/ }).click()
    await bulk.getByRole('button', { name: 'Retry bulk save' }).click()
    await expect(bulk.getByText('Saved here', { exact: true })).toBeVisible()
    expect(requests).toHaveLength(2)
    expect(requests[0]).toBe(requests[1])
    const base = `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog`
    const entity = async (id: string) =>
      (await fetch(`${base}/entities/asset_bundles/${id}`)).json()
    expect((await entity('bundle-000001')).fields.title.value).toBe('"Selected synthetic title"')
    expect((await entity('bundle-000002')).fields.title.value).toBe('"Selected synthetic title"')
    expect((await entity('bundle-000003')).fields.title.value).not.toBe(
      '"Selected synthetic title"',
    )
    await bulk.getByRole('button', { name: 'Close bulk editor' }).click()
    const changed = bundles.getByRole('option').filter({ hasText: 'Selected synthetic title' })
    await changed.first().click()
    await expect(single.getByRole('textbox', { name: 'Note', exact: true })).toHaveValue(
      'Private single draft',
    )
    await changed.last().click({ modifiers: ['ControlOrMeta'] })
    const memberships = bulk.getByRole('region', { name: 'Bulk membership' })
    await memberships.getByRole('searchbox').fill('child')
    await memberships.getByRole('button', { name: 'Add to all' }).click()
    await bulk.getByRole('button', { name: 'Apply bulk change' }).click()
    await expect(memberships.getByText('Synthetic child · 2/2')).toBeVisible()
    await memberships.getByRole('button', { name: 'Remove from all' }).click()
    await bulk.getByRole('button', { name: 'Apply bulk change' }).click()
    await expect(memberships.getByText('Synthetic child · 0/2')).toBeVisible()
    await bulk.getByRole('combobox', { name: 'Bulk field' }).selectOption('rating')
    await bulk.getByRole('combobox', { name: 'Bulk rating' }).selectOption('3.5')
    await bulk.getByRole('button', { name: 'Review bulk change' }).click()
    await bulk.getByRole('button', { name: 'Apply bulk change' }).click()
    await expect(bulk.getByText('Saved here', { exact: true })).toBeVisible()
    await expect.poll(async () => (await entity('bundle-000002')).fields.rating.value).toBe('3.5')
    await bulk.getByRole('button', { name: 'Close bulk editor' }).click()
    await page.getByRole('button', { name: 'List', exact: true }).click()
    await bundles.focus()
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+ArrowDown')
    await expect(bulk.getByRole('heading', { name: '2 bundles selected' })).toBeVisible()
    await page.screenshot({ path: '/tmp/cairndex-selection-proof.png' })
    await page.keyboard.press('Escape')
    await expect(bundles.locator('[aria-selected="true"]')).toHaveCount(0)
    await bundles.focus()
    await page.keyboard.press('ControlOrMeta+a')
    await expect(bulk.getByRole('heading', { name: '50 bundles selected' })).toBeVisible()
    await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('64')
    await expect(bulk.getByRole('heading', { name: '0 bundles selected' })).toBeVisible()
    await expect(bundles.getByRole('option')).toHaveCount(1)
    await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('')
    await page.getByRole('button', { name: 'Random', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Reshuffle' })).toBeVisible()
    await page.getByRole('button', { name: 'Reshuffle' }).click()
    await page.getByRole('button', { name: 'Missing Files', exact: true }).click()
    await expect(page.getByText(/Last recorded local checks/)).toBeVisible()
    await page.getByRole('button', { name: 'Unbundled', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Unbundled files' })).toBeVisible()
    await expect(page.getByText('No unbundled files match this search.')).toBeVisible()
    await page.screenshot({ path: join(scratch, 'unbundled.png') })
    // Older servers do not receive the new reads or view requests.
    await page.route('**/replica/status', async (route) => {
      const response = await fetch(backend.baseUrl + new URL(route.request().url()).pathname)
      const body = await response.json()
      delete body.selection_version
      delete body.system_views_version
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
    })
    await page.reload()
    await expect(
      page.getByText('Update the server to use multiple selection and bulk metadata changes.'),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Random', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Bulk changes/ })).toHaveCount(0)
  } finally {
    await context.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})

test('unbundled files search the complete catalog and retain private local checks @fullstack', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-unbundled-'))
  const script = `
from pathlib import Path
import sqlite3, sys
from cairndex.devtools.catalog_fixture import create_disposable, insert_row
from cairndex.replicas.catalog.conversion import prepare_disposable
fixture = create_disposable(parent=Path(sys.argv[1]), bundles=3)
with sqlite3.connect(fixture.source / '.cairndex/library.db') as db:
    db.row_factory = sqlite3.Row
    template = dict(db.execute("SELECT * FROM asset_files WHERE id='file-video'").fetchone())
    for index in range(60):
        insert_row(db, 'asset_files', template | {'id': f'staged-{index:03}', 'relative_path': f'Unbundled/clip-{index:03}.mp4', 'sequence': index + 10})
    db.execute("UPDATE asset_bundles SET grouping_state='PROVISIONAL', grouping_source='SCAN_SUGGESTION' WHERE id='bundle-000000'")
print(prepare_disposable(fixture).package)
`
  const root = execFileSync('uv', ['run', 'python', '-c', script, scratch], {
    cwd: fileURLToPath(new URL('../../server/', import.meta.url)),
  })
    .toString()
    .trim()
  const backend = await startBackend(join(scratch, 'private'))
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const page = await context.newPage()
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('button', { name: 'Unbundled', exact: true }).click()
    const files = page.getByRole('region', { name: 'Unbundled files' })
    await expect(files.getByRole('listitem')).toHaveCount(50)
    await files.getByRole('button', { name: 'More files' }).click()
    await expect(
      files.getByRole('button', { name: 'Unbundled/clip-059.mp4', exact: true }),
    ).toBeVisible()
    await files.getByRole('searchbox').fill('clip-059')
    await expect(files.getByRole('listitem')).toHaveCount(1)
    await files.getByRole('button', { name: 'Unbundled/clip-059.mp4', exact: true }).click()
    await expect(
      page.getByRole('complementary', { name: 'Unbundled file inspector' }),
    ).toContainText('Unavailable on this device')
    await page.getByRole('button', { name: 'Missing Files', exact: true }).click()
    await expect(page.getByRole('listbox', { name: 'Bundles' }).getByRole('option')).toHaveCount(0)
    // A recorded unavailable provisional file never appears as a confirmed bundle.
    const base = `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog`
    const response = await fetch(`${base}/bundles/browse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect((await response.json()).total).toBe(2)
    await page.getByRole('button', { name: 'Unbundled', exact: true }).click()
    await page.screenshot({ path: '/tmp/cairndex-unbundled-proof.png' })
  } finally {
    await context.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
