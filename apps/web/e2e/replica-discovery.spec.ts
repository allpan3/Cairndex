import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

// Independent servers use real queues/catalog events; only synthetic bytes are copied between roots
test('Update reviews private discoveries, preserves drafts and repairs a moved file @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'cairndex-discovery-ui-')))
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  const original = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.discovery_fixture import create_discovery; print(create_discovery(parent=Path(sys.argv[1]), playable=True))',
      scratch,
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
  const roots = [join(scratch, 'A'), join(scratch, 'B')]
  for (const root of roots) {
    await cp(original, root, { recursive: true, preserveTimestamps: true })
    await mkdir(join(root, 'Novel'))
    await cp(join(original, 'Playback/picture.png'), join(root, 'Novel/new-picture.png'), {
      preserveTimestamps: true,
    })
  }
  const before = await readFile(join(roots[0], 'Novel/new-picture.png'))
  const backends = [
    await startBackend(join(scratch, 'private-A')),
    await startBackend(join(scratch, 'private-B')),
  ]
  const contexts = [await browser.newContext(), await browser.newContext()]
  try {
    const libraries = await Promise.all(
      backends.map((backend, index) =>
        apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
          root_path: roots[index],
        }),
      ),
    )
    const pages = await Promise.all(contexts.map((context) => context.newPage()))
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index]
      await proxyApi(page, backends[index].baseUrl)
      await page.goto('/')
      await expect(
        page.getByRole('heading', { name: 'Library catalog', exact: true }),
      ).toBeVisible()
      const existingTitle = page.getByRole('textbox', { name: 'Title', exact: true })
      await page
        .getByRole('group', { name: 'Title', exact: true })
        .getByRole('checkbox', { name: 'Not set' })
        .uncheck()
      await existingTitle.fill('Unrelated private catalog draft')
      await page.getByRole('button', { name: 'Update', exact: true }).click()
      await expect(page.getByText(/Update complete/)).toBeVisible({ timeout: 30_000 })
      await expect(existingTitle).toHaveValue('Unrelated private catalog draft')
      await page
        .getByRole('navigation', { name: 'Discovery suggestions' })
        .getByRole('button')
        .first()
        .click()
      const choice = page.getByRole('region', { name: 'Discovery grouping choice' })
      await choice.getByLabel('Bundle title', { exact: true }).fill('Synthetic discovery')
      await page.getByRole('button', { name: 'Close discovery review', exact: true }).click()
      await page.getByRole('button', { name: 'Review discoveries', exact: true }).click()
      await expect(choice.getByLabel('Bundle title', { exact: true })).toHaveValue(
        'Synthetic discovery',
      )
      await choice.getByRole('button', { name: 'Prepare grouping review', exact: true }).click()
      await expect(page.getByText('Ready for your confirmation', { exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await expect(
        page
          .getByRole('navigation', { name: 'Bundles', exact: true })
          .getByRole('button', { name: 'Synthetic discovery', exact: true }),
      ).toHaveCount(0)
      if (index === 0) {
        // Restore a prepared review through the supported command and recover it in the shared UI
        const command = (args: string[]) =>
          JSON.parse(
            execFileSync(
              'uv',
              [
                'run',
                'python',
                '-m',
                'cairndex.replicas.recovery_cli',
                '--library',
                roots[index],
                '--data-dir',
                join(scratch, 'private-A'),
                ...args,
              ],
              { cwd: serverDir, encoding: 'utf8' },
            ),
          ) as { id: string; receipt: string }
        const checkpoint = join(scratch, 'prepared-backup')
        command(['backup', '--output', checkpoint])
        const restore = command(['prepare', '--backup', checkpoint])
        await apiPost(
          backends[index].baseUrl,
          `/api/v1/libraries/${libraries[index].id}/ownership/release`,
          {},
        )
        command(['activate', '--recovery', restore.id, '--receipt', restore.receipt])
        await apiPost(
          backends[index].baseUrl,
          `/api/v1/libraries/${libraries[index].id}/ownership/reopen`,
          {},
        )
        await page.reload()
        await page.getByText('Saved discovery reviews', { exact: true }).click()
        await page
          .getByRole('button', { name: 'Synthetic discovery · failed', exact: true })
          .click()
        await page.getByRole('button', { name: 'Revalidate saved review', exact: true }).click()
        await expect(page.getByText('Ready for your confirmation', { exact: true })).toBeVisible({
          timeout: 20_000,
        })
      }
      await page.getByRole('button', { name: 'Accept reviewed changes', exact: true }).click()
      await expect(page.getByText(/Reviewed changes saved here/)).toBeVisible({ timeout: 20_000 })
      await expect(existingTitle).toHaveValue('Unrelated private catalog draft')
      await page.getByRole('button', { name: 'Back to discoveries', exact: true }).click()
      await expect(
        page
          .getByRole('navigation', { name: 'Bundles', exact: true })
          .getByRole('button', { name: 'Synthetic discovery', exact: true }),
      ).toBeVisible()
    }
    // Both accepted the same discovered bytes/group; exchange converges without duplicate objects
    await cp(
      join(roots[0], '.cairndex/replica/objects'),
      join(roots[1], '.cairndex/replica/objects'),
      { recursive: true },
    )
    await cp(
      join(roots[1], '.cairndex/replica/objects'),
      join(roots[0], '.cairndex/replica/objects'),
      { recursive: true },
    )
    for (const page of pages) {
      await page.getByRole('button', { name: 'Update', exact: true }).click()
      await expect(page.getByText(/Update complete/)).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('No new files or identity choices on this page.')).toBeVisible()
    }
    const catalogFiles = await Promise.all(
      libraries.map(async (library, index) => {
        const response = await fetch(
          `${backends[index].baseUrl}/api/v1/libraries/${library.id}/replica/catalog/entities/asset_files?limit=50`,
        )
        expect(response.ok).toBe(true)
        return (await response.json()) as { items: { id: string; has_conflicts: boolean }[] }
      }),
    )
    expect(catalogFiles[0].items.map((file) => file.id)).toEqual(
      catalogFiles[1].items.map((file) => file.id),
    )
    expect(catalogFiles.every((page) => page.items.every((file) => !file.has_conflicts))).toBe(true)
    const a = pages[0]
    await a
      .getByRole('navigation', { name: 'Bundles', exact: true })
      .getByRole('button', { name: 'Synthetic discovery', exact: true })
      .click()
    await a.getByRole('button', { name: 'Open media on this device', exact: true }).click()
    await expect(a.locator('.media-viewer img').first()).toBeVisible({ timeout: 15_000 })
    await a.locator('.media-viewer').press('Escape')
    await rename(join(roots[0], 'Novel/new-picture.png'), join(roots[0], 'Novel/moved-picture.png'))
    await a.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(a.getByText(/Update complete.*1 links repaired/)).toBeVisible({ timeout: 30_000 })
    await a.getByRole('button', { name: 'Open media on this device', exact: true }).click()
    await expect(a.locator('.media-viewer img').first()).toBeVisible({ timeout: 15_000 })
    expect(await readFile(join(roots[0], 'Novel/moved-picture.png'))).toEqual(before)
    expect(await readFile(join(roots[1], 'Novel/new-picture.png'))).toEqual(before)
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()))
    for (const backend of backends) await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})

// Failure, cancellation and persisted invalid nested drafts use visible recovery controls
// Every fixture and backend is disposable; no browser request substitutes a catalog mutation
test('Update cancellation, retry, malformed drafts and library switching @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-discovery-retry-'))
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  const make = () =>
    execFileSync(
      'uv',
      [
        'run',
        'python',
        '-c',
        'from pathlib import Path; import sys; from cairndex.devtools.discovery_fixture import create_discovery; print(create_discovery(parent=Path(sys.argv[1])))',
        scratch,
      ],
      { cwd: serverDir },
    )
      .toString()
      .trim()
  const roots = [make(), make()]
  const backend = await startBackend(join(scratch, 'private'))
  const context = await browser.newContext()
  try {
    const libraries = []
    for (const root of roots)
      libraries.push(
        await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
          root_path: root,
        }),
      )
    const page = await context.newPage()
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('combobox', { name: 'Library', exact: true }).selectOption(libraries[0].id)
    await mkdir(join(roots[0], 'Temporary'))
    await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        writeFile(join(roots[0], `Temporary/frame-${i}.png`), 'synthetic disposable scan'),
      ),
    )
    await page.getByRole('button', { name: 'Update', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel Update', exact: true }).click()
    await expect(page.getByText('Update cancelled. Run Update to retry.')).toBeVisible()
    await rm(join(roots[0], 'Temporary'), { recursive: true })
    const parked = join(scratch, 'parked')
    await rename(roots[0], parked)
    await page.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(
      page.getByRole('region', { name: 'Library Update' }).getByRole('alert'),
    ).toContainText('manifest.json')
    await rename(parked, roots[0])
    await writeFile(join(roots[0], 'new.png'), 'synthetic retry image')
    await page.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(page.getByText(/Update complete/)).toBeVisible({ timeout: 30_000 })
    await page
      .getByRole('navigation', { name: 'Discovery suggestions' })
      .getByRole('button')
      .first()
      .click()
    const choice = page.getByRole('region', { name: 'Discovery grouping choice' })
    await choice.getByLabel('Bundle title', { exact: true }).fill('Retained discovery choice')
    await page.getByRole('combobox', { name: 'Library', exact: true }).selectOption(libraries[1].id)
    await expect(choice).toHaveCount(0)
    await page.getByRole('combobox', { name: 'Library', exact: true }).selectOption(libraries[0].id)
    await page
      .getByRole('navigation', { name: 'Discovery suggestions' })
      .getByRole('button')
      .first()
      .click()
    await expect(choice.getByLabel('Bundle title', { exact: true })).toHaveValue(
      'Retained discovery choice',
    )
    // Inject only malformed synthetic browser storage, then reload through the real application
    const corrupt = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((key) => key.includes(':discovery/'))!
      const value = JSON.parse(localStorage.getItem(key)!)
      value.body.files = '{invalid synthetic selection'
      const raw = JSON.stringify(value)
      localStorage.setItem(key, raw)
      return { key, raw }
    })
    await page.reload()
    await page
      .getByRole('navigation', { name: 'Discovery suggestions' })
      .getByRole('button')
      .first()
      .click()
    await expect(choice.getByRole('alert')).toContainText('stored bytes are retained')
    await choice.getByLabel('Bundle title', { exact: true }).fill('Recovered valid selection')
    expect(
      await page.evaluate((key) => localStorage.getItem(`${key}.unreadable`), corrupt.key),
    ).toBe(corrupt.raw)
    await choice.getByRole('button', { name: 'Prepare grouping review', exact: true }).click()
    const prepared = page.getByRole('region', { name: 'Prepared discovery review' })
    await expect(prepared.getByText('Ready for your confirmation')).toBeVisible({ timeout: 20_000 })
    await prepared.getByRole('button', { name: 'Cancel this review', exact: true }).click()
    await expect(
      prepared.getByText('Review retained; prepare again before applying.'),
    ).toBeVisible()
    await prepared.getByRole('button', { name: 'Revalidate saved review', exact: true }).click()
    await expect(prepared.getByText('Ready for your confirmation')).toBeVisible()
    await page.reload()
    await page.getByText('Saved discovery reviews', { exact: true }).click()
    await page
      .getByRole('button', { name: 'Recovered valid selection · ready', exact: true })
      .click()
    await expect(prepared.getByText('Ready for your confirmation')).toBeVisible()
    await prepared.getByRole('button', { name: 'Accept reviewed changes', exact: true }).click()
    await expect(prepared.getByText(/Reviewed changes saved here/)).toBeVisible({ timeout: 20_000 })
  } finally {
    await context.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})

// Concurrent replacement choices remain visible on both devices through the complete conflict UI
test('competing source identities are reviewable on both replicas @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-discovery-conflict-'))
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  const seed = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.discovery_fixture import create_discovery; print(create_discovery(parent=Path(sys.argv[1])))',
      scratch,
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
  const roots = [join(scratch, 'A'), join(scratch, 'B')]
  for (const root of roots) await cp(seed, root, { recursive: true })
  const backends = [
    await startBackend(join(scratch, 'private-A')),
    await startBackend(join(scratch, 'private-B')),
  ]
  const contexts = [await browser.newContext(), await browser.newContext()]
  try {
    const pages = []
    const libraries = []
    for (let i = 0; i < 2; i++) {
      const library = await apiPost<{ id: string }>(
        backends[i].baseUrl,
        '/api/v1/libraries/register',
        { root_path: roots[i] },
      )
      libraries.push(library)
      const page = await contexts[i].newPage()
      pages.push(page)
      page.setDefaultTimeout(15_000)
      await proxyApi(page, backends[i].baseUrl)
      await page.goto('/')
      await page.getByRole('button', { name: 'Update', exact: true }).click()
      await expect(page.getByText(/Update complete/)).toBeVisible({ timeout: 30_000 })
      await writeFile(join(roots[i], 'Synthetic/雪.mp4'), `synthetic competing source ${i}`)
      const enqueued = page.waitForResponse(
        (response) =>
          response.url().endsWith('/discovery/runs') && response.request().method() === 'POST',
      )
      await page.getByRole('button', { name: 'Update', exact: true }).click()
      await enqueued
      await expect(
        page.getByRole('navigation', { name: 'Discovery suggestions' }).getByRole('button'),
      ).toHaveCount(1, { timeout: 30_000 })
      await page
        .getByRole('navigation', { name: 'Discovery suggestions' })
        .getByRole('button')
        .click()
      await page
        .getByRole('checkbox', {
          name: 'Use these replacement bytes for the existing file identity and its metadata',
        })
        .check()
      await page.getByRole('button', { name: 'Prepare grouping review', exact: true }).click()
      await expect(page.getByText('Ready for your confirmation', { exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await page.getByRole('button', { name: 'Accept reviewed changes', exact: true }).click()
      await expect(page.getByText(/Reviewed changes saved here/)).toBeVisible({ timeout: 20_000 })
      await expect
        .poll(
          async () =>
            (
              await (
                await fetch(`${backends[i].baseUrl}/api/v1/libraries/${library.id}/replica/status`)
              ).json()
            ).outbox,
        )
        .toBe(0)
    }
    await cp(
      join(roots[0], '.cairndex/replica/objects'),
      join(roots[1], '.cairndex/replica/objects'),
      { recursive: true },
    )
    await cp(
      join(roots[1], '.cairndex/replica/objects'),
      join(roots[0], '.cairndex/replica/objects'),
      { recursive: true },
    )
    for (let i = 0; i < 2; i++) {
      const page = pages[i]
      await page
        .getByRole('navigation', { name: 'Catalog families' })
        .getByRole('button', { name: 'Files', exact: true })
        .click()
      await page
        .getByRole('navigation', { name: 'Files', exact: true })
        .getByRole('button', { name: /^雪\.mp4(?: · Review conflict)?$/ })
        .click()
      await page
        .getByRole('button', { name: 'Review content identity', exact: true })
        .click({ timeout: 20_000 })
      const review = page.getByRole('region', { name: 'Complete conflict review' })
      await expect(
        review
          .getByRole('group', { name: 'file-video · $content', exact: true })
          .getByRole('radio'),
      ).toHaveCount(2)
      await expect(review).toContainText('sha256')
      const response = await fetch(
        `${backends[i].baseUrl}/api/v1/libraries/${libraries[i].id}/replica/catalog/entities/asset_files/file-video`,
        { signal: AbortSignal.timeout(10_000) },
      )
      const entity = await response.json()
      expect(entity.fields.$content.candidates).toHaveLength(2)
      expect(await readFile(join(roots[i], 'Synthetic/雪.mp4'), 'utf8')).toBe(
        `synthetic competing source ${i}`,
      )
    }
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()))
    for (const backend of backends) await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
