import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

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
  try {
    await apiPost(backend.baseUrl, '/api/v1/libraries/register', { root_path: root })
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    await page.getByRole('button', { name: 'Access and backups', exact: true }).click()
    await page.getByLabel('New passphrase', { exact: true }).fill('Synthetic guard')
    await page.getByLabel('Confirm passphrase', { exact: true }).fill('Synthetic guard')
    await page.getByRole('button', { name: 'Set passphrase', exact: true }).click()
    await expect(page.getByText('Passphrase protection is on.', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Lock', exact: true }).click()
    await page.getByRole('dialog').getByLabel('Owner passphrase', { exact: true }).fill('Incorrect')
    await page.getByRole('dialog').getByRole('button', { name: 'Unlock', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Incorrect passphrase.' })).toBeVisible()
    await page
      .getByRole('dialog')
      .getByLabel('Owner passphrase', { exact: true })
      .fill('Synthetic guard')
    await page.getByRole('dialog').getByRole('button', { name: 'Unlock', exact: true }).click()
    await page.getByRole('button', { name: 'Create private snapshot', exact: true }).click()
    await expect(page.getByText('backup: succeeded', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Use this snapshot', exact: true }).click()
    await page.getByRole('button', { name: 'Verify snapshot', exact: true }).click()
    await expect(page.getByText('verify: succeeded', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Release library', exact: true }).click()
    await page.getByRole('button', { name: 'Lock', exact: true }).click()
    await page.reload()
    await page.getByLabel('Owner passphrase', { exact: true }).fill('Synthetic guard')
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Prepare separate recovery', exact: true }),
    ).toBeEnabled()
    await page.getByRole('button', { name: 'Prepare separate recovery', exact: true }).click()
    await expect(page.getByText('prepare: succeeded', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Review this recovery', exact: true }).click()
    await expect(page.getByText('review: succeeded', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'I reviewed this recovery', exact: true }).click()
    await page.getByRole('button', { name: 'Activate reviewed recovery', exact: true }).click()
    await expect(page.getByText('activate: succeeded', { exact: true })).toBeVisible()
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
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'cairndex-normal-create-')))
  const root = join(scratch, 'Library')
  await mkdir(root)
  await writeFile(join(root, 'example.txt'), 'Synthetic source')
  const backend = await startBackend(join(scratch, 'private'))
  try {
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    await page.getByLabel('Library path').fill(root)
    await page.getByRole('button', { name: 'Add library', exact: true }).click()
    await page.getByLabel('Library name').fill('Synthetic portable library')
    await page.getByRole('button', { name: 'Create library', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Library', exact: true })).toContainText(
      'Synthetic portable library',
    )
    const manifest = JSON.parse(await readFile(join(root, '.cairndex', 'manifest.json'), 'utf8'))
    expect(manifest.format).toBe('cairndex.replica-library')
    expect(manifest.format_version).toBe(3)
    expect(await readdir(join(root, '.cairndex'))).not.toContain('library.db')
    expect(await readFile(join(root, 'example.txt'), 'utf8')).toBe('Synthetic source')
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
