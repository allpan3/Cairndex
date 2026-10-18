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
  let releaseNextPage: (() => void) | undefined
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
    // The first commit's reply is lost; the retained save retries the same request
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
    const title = bulk.getByRole('textbox', { name: 'Title', exact: true })
    await title.fill('Selected synthetic title')
    await title.press('Enter')
    await expect(bulk.getByRole('button', { name: 'Retry bulk save' })).toBeEnabled()
    // The interrupted save outlives the selection, and then a reload
    await page.getByRole('button', { name: /^Recent( \d+)?$/ }).click()
    await expect(bulk.getByRole('heading', { name: '0 bundles selected' })).toBeVisible()
    await expect(bulk.getByText(/did not finish saving/)).toContainText('for 2 bundles')
    await page.reload()
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
    await bulk.getByRole('button', { name: 'Clear', exact: true }).click()
    const changed = bundles.getByRole('option').filter({ hasText: 'Selected synthetic title' })
    await changed.first().click()
    await expect(single.getByRole('textbox', { name: 'Note', exact: true })).toHaveValue(
      'Private single draft',
    )
    await changed.last().click({ modifiers: ['ControlOrMeta'] })
    // A chip adds to or removes from every selected bundle at once
    const tags = bulk.locator('[data-section="tags"]')
    const tagged = async () =>
      (
        await apiPost<{ items: { name: string; assigned_count: number }[] }>(
          backend.baseUrl,
          `/api/v1/libraries/${library.id}/replica/catalog/bundles/selection/memberships`,
          { ids: ['bundle-000001', 'bundle-000002'], family: 'tags', q: 'child' },
        )
      ).items.find((item) => item.name === 'Synthetic child')?.assigned_count
    await tags.getByRole('button', { name: '+ Tag', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Choose tags' })
    await picker.getByRole('textbox', { name: 'Search tags' }).fill('child')
    await picker.getByRole('button', { name: /Synthetic child/ }).click()
    await page.keyboard.press('Escape')
    await expect(tags.getByRole('button', { name: 'Remove Synthetic child' })).toBeEnabled()
    await expect.poll(tagged).toBe(2)
    await tags.getByRole('button', { name: 'Remove Synthetic child' }).click()
    await expect(tags.getByRole('button', { name: 'Remove Synthetic child' })).toHaveCount(0)
    await expect.poll(tagged).toBe(0)
    // The stars show the rating the selected bundles share
    await expect(bulk.getByRole('radio', { name: '3½ stars' })).toBeChecked()
    await bulk.getByRole('radio', { name: '4½ stars' }).click()
    await expect(bulk.getByText('Saved here', { exact: true })).toBeVisible()
    await expect.poll(async () => (await entity('bundle-000002')).fields.rating.value).toBe('4.5')
    await bulk.getByRole('button', { name: 'Clear', exact: true }).click()
    await page.close()
    const keyboardPage = await context.newPage()
    await proxyApi(keyboardPage, backend.baseUrl)
    // Select-all applies to loaded pages. Hold later pages to fix the tested boundary.
    const nextPage = new Promise<void>((resolve) => {
      releaseNextPage = resolve
    })
    await keyboardPage.route('**/replica/catalog/bundles/browse', async (route) => {
      if (route.request().postDataJSON().offset > 0) await nextPage
      await route.fallback()
    })
    await keyboardPage.goto('/')
    const keyboardBundles = keyboardPage.getByRole('listbox', { name: 'Bundles', exact: true })
    const keyboardBulk = keyboardPage.getByRole('complementary', {
      name: 'Selected bundles inspector',
    })
    await keyboardPage.getByRole('button', { name: 'List', exact: true }).click()
    await keyboardBundles.focus()
    await keyboardPage.keyboard.press('Home')
    await keyboardPage.keyboard.press('Shift+ArrowDown')
    await expect(keyboardBulk.getByRole('heading', { name: '2 bundles selected' })).toBeVisible()
    await keyboardPage.screenshot({ path: '/tmp/cairndex-selection-proof.png' })
    await keyboardPage.keyboard.press('Escape')
    await expect(keyboardBundles.locator('[aria-selected="true"]')).toHaveCount(0)
    await keyboardBundles.focus()
    await keyboardPage.keyboard.press('ControlOrMeta+a')
    await expect(keyboardBulk.getByRole('heading', { name: '50 bundles selected' })).toBeVisible()
    releaseNextPage?.()
    await keyboardPage.getByRole('searchbox', { name: 'Search', exact: true }).fill('64')
    await expect(keyboardBulk.getByRole('heading', { name: '0 bundles selected' })).toBeVisible()
    await expect(keyboardBundles.getByRole('option')).toHaveCount(1)
    await keyboardPage.getByRole('searchbox', { name: 'Search', exact: true }).fill('')
    await keyboardPage.getByRole('button', { name: /^Random( \d+)?$/ }).click()
    await expect(keyboardPage.getByRole('button', { name: 'Reshuffle' })).toBeVisible()
    await keyboardPage.getByRole('button', { name: 'Reshuffle' }).click()
    await keyboardPage.getByRole('button', { name: /^Missing Files( \d+)?$/ }).click()
    await expect(keyboardPage.locator('.toolbar__title')).toHaveText('Missing Files')
    await keyboardPage.getByRole('button', { name: /^Unbundled( \d+)?$/ }).click()
    await expect(
      keyboardPage.getByText('Nothing to bundle — every file is already in a bundle.'),
    ).toBeVisible()
    await keyboardPage.screenshot({ path: join(scratch, 'unbundled.png') })
    // Older servers do not receive the new reads or view requests.
    await keyboardPage.route('**/replica/status', async (route) => {
      const response = await fetch(backend.baseUrl + new URL(route.request().url()).pathname)
      const body = await response.json()
      delete body.selection_version
      delete body.album_version
      delete body.system_views_version
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
    })
    await keyboardPage.reload()
    await expect(keyboardBundles.getByRole('option').first()).toBeVisible()
    await keyboardBundles.focus()
    await keyboardPage.keyboard.press('Home')
    await keyboardPage.keyboard.press('Shift+ArrowDown')
    await expect(keyboardBundles.locator('[aria-selected="true"]')).toHaveCount(1)
    await expect(keyboardPage.getByRole('button', { name: /^Random( \d+)?$/ })).toHaveCount(0)
    await expect(keyboardBulk).toHaveCount(0)
  } finally {
    releaseNextPage?.()
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
    for index in range(120):
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
    await page.getByRole('button', { name: /^Unbundled( \d+)?$/ }).click()
    const files = page.getByRole('grid', { name: 'Files', exact: true })
    const rows = files.locator('[data-relpath]')
    // The queue pages from the server in path order: one page, then the rest
    await expect(rows).toHaveCount(100)
    await page.getByRole('button', { name: 'Load more', exact: true }).click()
    // The 120 staged files and the provisional bundle's two
    await expect(rows).toHaveCount(122)
    await page.getByRole('searchbox', { name: 'Search files', exact: true }).fill('clip-119')
    await expect(rows).toHaveCount(1)
    await files.getByRole('row', { name: /clip-119\.mp4/ }).click()
    await expect(page.getByRole('complementary', { name: 'File inspector' })).toContainText(
      'Unavailable on this device',
    )
    await page.getByRole('button', { name: /^Missing Files( \d+)?$/ }).click()
    await expect(page.getByRole('listbox', { name: 'Bundles' }).getByRole('option')).toHaveCount(0)
    // A recorded unavailable provisional file never appears as a confirmed bundle.
    const base = `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog`
    const response = await fetch(`${base}/bundles/browse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect((await response.json()).total).toBe(2)
    await page.getByRole('button', { name: /^Unbundled( \d+)?$/ }).click()
    await page.screenshot({ path: '/tmp/cairndex-unbundled-proof.png' })
  } finally {
    await context.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
