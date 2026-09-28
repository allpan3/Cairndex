import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test.use({ actionTimeout: 15_000 })

test('catalog album pages, folders, selection, missing media and draft return @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-album-e2e-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.album_fixture import create_album; print(create_album(parent=Path(sys.argv[1])))',
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
    const mutations: string[] = []
    page.on('request', (request) => {
      if (
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) &&
        /\/api\/v1\/.+(?:\/files\/|\/bundles\/)/.test(request.url()) &&
        !request.url().includes('/replica/')
      )
        mutations.push(request.url())
    })
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('option').filter({ hasText: 'Synthetic album' }).click()
    const inspector = page.getByRole('complementary', { name: 'Bundle inspector' })
    const note = inspector.getByRole('textbox', { name: 'Note', exact: true })
    await note.fill('Album draft remains available')
    await inspector.getByRole('button', { name: 'Browse bundle files' }).click()
    const listing = page.getByRole('list', { name: 'Album items' })
    await expect(listing.locator('[data-file-id="album-folder"]')).toBeVisible()
    await expect(listing.locator('[data-file-id="gallery-000"]')).toHaveCount(0)
    await listing.locator('[data-file-id="album-folder"]').dblclick()
    await expect(page.getByRole('button', { name: 'Back to bundle', exact: true })).toBeVisible()
    await expect(listing.locator('[data-file-id="gallery-000"]')).toBeVisible()
    await page.getByRole('button', { name: 'Load more album items' }).click()
    await page.getByRole('button', { name: 'Load more album items' }).click()
    await expect(page.getByRole('button', { name: 'Load more album items' })).toHaveCount(0)
    await expect(page.getByText('125 of 125 items', { exact: true })).toBeVisible()
    await listing.focus()
    await listing.press('End')
    const last = listing.locator('[data-file-id="gallery-124"]')
    await expect(last).toBeFocused()
    await expect(last).toHaveAttribute('aria-pressed', 'true')
    expect(await listing.locator('[data-file-id]').count()).toBeLessThan(60)
    const scroll = await listing.evaluate((element) => element.scrollTop)
    expect(scroll).toBeGreaterThan(0)
    await last.press('Enter')
    await expect(page.locator('img.mv-image')).toBeVisible()
    await expect
      .poll(() =>
        page.locator('img.mv-image').evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0)
    await expect(page.getByRole('button', { name: 'Next file', exact: true })).toBeDisabled()
    await expect(page.locator('.media-viewer')).toContainText('frame124.png')
    await page.getByRole('button', { name: 'Previous file', exact: true }).click()
    await expect(page.locator('.media-viewer')).toContainText('frame123.png')
    await page.locator('.media-viewer').press('Escape')
    await expect(last).toHaveAttribute('aria-pressed', 'true')
    expect(await listing.evaluate((element) => element.scrollTop)).toBe(scroll)
    await expect(note).toHaveValue('Album draft remains available')
    await rename(join(root, 'Gallery/frame124.png'), join(root, 'Gallery/held.png'))
    await last.dblclick()
    await expect(page.locator('.media-viewer')).toContainText(/unavailable|missing/i)
    await rename(join(root, 'Gallery/held.png'), join(root, 'Gallery/frame124.png'))
    await page.getByRole('button', { name: 'Retry local media' }).click()
    await expect(page.locator('img.mv-image')).toBeVisible()
    await page.locator('.media-viewer').press('Escape')
    await page.getByRole('button', { name: 'Back to bundle', exact: true }).click()
    await listing.locator('[data-file-id="empty-folder"]').dblclick()
    await expect(listing).toContainText('This directory member has no cataloged files.')
    await page.getByRole('button', { name: 'Back to bundle', exact: true }).click()
    await listing.locator('[data-file-id="loose-000"]').dblclick()
    await expect(page.locator('img.mv-image')).toBeVisible()
    await page.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(page.locator('.media-viewer')).toContainText('frame001.png')
    await expect
      .poll(async () => {
        const data = await (
          await fetch(
            `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/media/bundles/bundle-000001`,
          )
        ).json()
        return data.cursor
      })
      .toBe('loose-001')
    await page.locator('.media-viewer').press('Escape')
    await page.getByRole('button', { name: 'Back to library', exact: true }).click()
    await expect(note).toHaveValue('Album draft remains available')
    await inspector.getByRole('button', { name: 'Browse bundle files' }).click()
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    await page.getByRole('row').filter({ hasText: 'Synthetic' }).dblclick()
    await page.getByRole('row').filter({ hasText: '雪.mp4' }).click()
    await page.getByRole('button', { name: 'Locate in Bundle Browser', exact: true }).click()
    await expect(page.getByRole('list', { name: 'Album items' })).toHaveCount(0)
    await expect(inspector.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('')
    await page.getByRole('option').filter({ hasText: 'Synthetic album' }).click()
    await expect(note).toHaveValue('Album draft remains available')
    expect(mutations).toEqual([])
  } finally {
    try {
      await context.close()
    } finally {
      await stopBackend(backend.child)
    }
    await rm(scratch, { recursive: true, force: true })
  }
})

test('album rejects changed pages and ignores a late response after navigation @fullstack', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-album-order-e2e-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.album_fixture import create_album; print(create_album(parent=Path(sys.argv[1])))',
      scratch,
    ],
    { cwd: fileURLToPath(new URL('../../server/', import.meta.url)) },
  )
    .toString()
    .trim()
  const backend = await startBackend(join(scratch, 'private'))
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  let release = () => {}
  try {
    await apiPost(backend.baseUrl, '/api/v1/libraries/register', { root_path: root })
    const page = await context.newPage()
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('option').filter({ hasText: 'Synthetic album' }).dblclick()
    await expect(page.getByText('50 of 66 items', { exact: true })).toBeVisible()
    const inspector = page.getByRole('complementary', { name: 'Bundle inspector' })
    let received = () => {}
    const ready = new Promise<void>((resolve) => {
      received = resolve
    })
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(
      '**/replica/media/bundles/bundle-000001/album?offset=50&**',
      async (route) => {
        received()
        await hold
        const url = new URL(route.request().url())
        const response = await fetch(`${backend.baseUrl}${url.pathname}${url.search}`)
        await route.fulfill({
          status: response.status,
          contentType: 'application/json',
          body: await response.text(),
        })
      },
      { times: 1 },
    )
    await page.getByRole('button', { name: 'Load more album items' }).click()
    await ready
    await inspector
      .getByRole('textbox', { name: 'Note', exact: true })
      .fill('A reviewed album edit')
    // Save is an asynchronous catalog job. Wait for its receipt before checking the UI.
    const saved = page.waitForResponse(
      async (response) => {
        if (!response.url().includes('/replica/catalog/jobs') || !response.ok()) return false
        const job = await response.json()
        return job.action === 'save' && job.state === 'succeeded' && Boolean(job.result?.event)
      },
      { timeout: 30_000 },
    )
    await inspector.getByRole('button', { name: 'Save changes', exact: true }).click()
    await saved
    await expect(inspector.locator(':scope > [role="status"]')).toHaveText('Saved here')
    release()
    await expect(
      page.getByText('Album changed. Reload the album before loading more items.'),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Reload album' }).click()
    await expect(page.getByText('50 of 66 items', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Back to library', exact: true }).click()
    let arrived = () => {}
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const delayed = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(
      '**/replica/media/bundles/bundle-000001/album?offset=0&**',
      async (route) => {
        const url = new URL(route.request().url())
        const response = await fetch(`${backend.baseUrl}${url.pathname}${url.search}`)
        const body = await response.text()
        arrived()
        await delayed
        await route
          .fulfill({ status: response.status, contentType: 'application/json', body })
          .catch(() => {})
      },
      { times: 1 },
    )
    await inspector.getByRole('button', { name: 'Browse bundle files' }).click()
    await waiting
    await page.getByRole('button', { name: 'Back to library', exact: true }).click()
    await page.locator('[data-bundle-id="bundle-000002"]').dblclick()
    await expect(page.getByRole('list', { name: 'Album items' })).toContainText(
      'This bundle has no files or directory members.',
    )
    release()
    await expect(inspector.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
      'Synthetic bundle 2 雪',
    )
    await expect(page.getByRole('list', { name: 'Album items' })).toContainText(
      'This bundle has no files or directory members.',
    )
  } finally {
    release()
    try {
      await context.close()
    } finally {
      await stopBackend(backend.child)
    }
    await rm(scratch, { recursive: true, force: true })
  }
})
