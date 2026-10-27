import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, openMetadataReview, proxyApi, startBackend, stopBackend } from './realBackend'

test('access and private backup controls complete reviewed recovery @fullstack', async ({
  page,
}) => {
  test.setTimeout(120_000)
  page.setDefaultTimeout(15_000)
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'cairndex-private-controls-')))
  const server = fileURLToPath(new URL('../../server/', import.meta.url))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.catalog_fixture import create_disposable; from cairndex.replicas.catalog.conversion import prepare_disposable; print(prepare_disposable(create_disposable(parent=Path(sys.argv[1]),bundles=3)).package)',
      scratch,
    ],
    { cwd: server },
  )
    .toString()
    .trim()
  const backend = await startBackend(join(scratch, 'private'), { CAIRNDEX_WORKER_ENABLED: 'true' })
  // Durable recovery can outlast a UI assertion's default five-second budget.
  // Wait for a terminal job state, then fail immediately if it did not succeed.
  const completed = async (action: string) => {
    const result = page
      .getByRole('status')
      .filter({ hasText: new RegExp(`^${action}: (succeeded|failed|interrupted)$`) })
    await expect(result).toBeVisible({ timeout: 30_000 })
    expect(await result.textContent()).toBe(`${action}: succeeded`)
  }
  try {
    await apiPost(backend.baseUrl, '/api/v1/libraries/register', { root_path: root })
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    // A library's settings are their own dialog over the list, not a panel in it
    const settings = page.getByRole('dialog', { name: / settings$/ })
    await page.getByRole('button', { name: /^Settings for / }).click()
    await expect(page.getByRole('heading', { name: 'Libraries', exact: true })).toBeHidden()
    await settings.getByLabel('New passphrase', { exact: true }).fill('Synthetic guard')
    await settings.getByLabel('Confirm passphrase', { exact: true }).fill('Synthetic guard')
    await settings.getByRole('button', { name: 'Set passphrase', exact: true }).click()
    await expect(settings.getByText('Passphrase protection is on.', { exact: false })).toBeVisible()
    // Locking the open library changes the screen behind; the settings stay open
    await settings.getByRole('button', { name: 'Lock', exact: true }).click()
    await settings.getByLabel('Owner passphrase', { exact: true }).fill('Incorrect')
    await settings.getByRole('button', { name: 'Unlock', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Incorrect passphrase.' })).toBeVisible()
    await settings.getByLabel('Owner passphrase', { exact: true }).fill('Synthetic guard')
    await settings.getByRole('button', { name: 'Unlock', exact: true }).click()
    await page.getByRole('button', { name: 'Create private snapshot', exact: true }).click()
    await completed('backup')
    await page.getByRole('button', { name: 'Use this snapshot', exact: true }).click()
    await page.getByRole('button', { name: 'Verify snapshot', exact: true }).click()
    await completed('verify')
    await page.getByRole('button', { name: 'Release library', exact: true }).click()
    await page.getByRole('button', { name: 'Lock', exact: true }).click()
    await page.reload()
    await page.getByLabel('Owner passphrase', { exact: true }).fill('Synthetic guard')
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    // Settings were not remembered across the reload: the list comes first
    await expect(settings).toHaveCount(0)
    await page.getByRole('button', { name: /^Settings for / }).click()
    await expect(
      page.getByRole('button', { name: 'Prepare separate recovery', exact: true }),
    ).toBeEnabled()
    await page.getByRole('button', { name: 'Prepare separate recovery', exact: true }).click()
    await completed('prepare')
    await page.getByRole('button', { name: 'Review this recovery', exact: true }).click()
    await completed('review')
    await page.getByRole('button', { name: 'I reviewed this recovery', exact: true }).click()
    await page.getByRole('button', { name: 'Activate reviewed recovery', exact: true }).click()
    await completed('activate')
    await page.getByRole('button', { name: 'Reopen library', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Release library', exact: true })).toBeVisible()
    await expect(page.getByText('Passphrase protection is on.', { exact: false })).toBeVisible()
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})

test('normal Create preserves source bytes and opens one portable library @fullstack', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'cairndex-normal-create-')))
  const root = join(scratch, 'Library')
  await mkdir(root)
  await writeFile(join(root, 'example.txt'), 'Synthetic source')
  await writeFile(join(root, 'new-video.mp4'), 'Synthetic discovery bytes')
  const backend = await startBackend(join(scratch, 'private'))
  let admit: () => void = () => undefined
  const admission = new Promise<void>((resolve) => {
    admit = resolve
  })
  try {
    await proxyApi(page, backend.baseUrl)
    await page.route('**/replica/status', async (route) => {
      await admission
      await route.fallback()
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    await page.getByLabel('Library path').fill(root)
    await page.getByRole('button', { name: 'Add library', exact: true }).click()
    await page.getByLabel('Library name').fill('Synthetic portable library')
    await page.getByRole('button', { name: 'Create library', exact: true }).click()
    await expect
      .poll(async () => (await (await fetch(`${backend.baseUrl}/api/v1/libraries`)).json()).length)
      .toBe(1)
    const registrations = await (await fetch(`${backend.baseUrl}/api/v1/libraries`)).json()
    const base = `${backend.baseUrl}/api/v1/libraries/${registrations[0].id}/replica`
    expect((await (await fetch(`${base}/discovery/status`)).json()).state).toBe('idle')
    admit()
    await expect(page.getByRole('combobox', { name: 'Library', exact: true })).toContainText(
      'Synthetic portable library',
      { timeout: 30_000 },
    )
    const invalidDetails: string[] = []
    page.on('request', (request) => {
      if (/\/entities\/asset_bundles\/(undefined|null)(?:\?|$)/.test(request.url()))
        invalidDetails.push(request.url())
    })
    await expect(
      page.getByText('Select a bundle to see its details.', { exact: true }),
    ).toBeVisible()
    expect(registrations).toHaveLength(1)
    await expect
      .poll(async () => (await (await fetch(`${base}/discovery/status`)).json()).state, {
        timeout: 60_000,
      })
      .toBe('succeeded')
    const indexed = await (await fetch(`${base}/discovery/status`)).json()
    expect(indexed.observed).toBe(1)
    const candidates = await (await fetch(`${base}/discovery/candidates`)).json()
    expect(candidates.items).toHaveLength(1)
    expect(candidates.items[0].body.files[0].path).toBe('new-video.mp4')
    expect(
      (await (await fetch(`${base}/catalog/entities/asset_files?limit=50`)).json()).items,
    ).toEqual([])
    await expect(page.getByRole('dialog', { name: 'Grouping review' })).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeEnabled()
    expect((await (await fetch(`${base}/discovery/status`)).json()).id).toBe(indexed.id)
    // Metadata review's Refresh reloads its list and detail; an empty library has no detail
    await openMetadataReview(page)
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/replica/status')),
      page.getByRole('button', { name: 'Refresh catalog status', exact: true }).click(),
    ])
    expect(invalidDetails).toEqual([])
    const manifest = JSON.parse(await readFile(join(root, '.cairndex', 'manifest.json'), 'utf8'))
    expect(manifest.format).toBe('cairndex.replica-library')
    expect(manifest.format_version).toBe(3)
    expect(await readdir(join(root, '.cairndex'))).not.toContain('library.db')
    expect(await readFile(join(root, 'example.txt'), 'utf8')).toBe('Synthetic source')
    expect(await readFile(join(root, 'new-video.mp4'), 'utf8')).toBe('Synthetic discovery bytes')
  } finally {
    admit()
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
