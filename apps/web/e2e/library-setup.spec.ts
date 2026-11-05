import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

// Hold real status snapshots so preparation remains inspectable on fast machines.
test('server preparation and initial scan survive a browser refresh @fullstack', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-setup-ui-'))
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
  const backend = await startBackend(join(scratch, 'private'))
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const base = `/api/v1/libraries/${library.id}/replica`
    const read = async (path: string) => (await fetch(backend.baseUrl + base + path)).json()
    await expect.poll(async () => (await read('/status')).ready).toBe(true)
    await proxyApi(page, backend.baseUrl)
    let preparing = true
    await page.route('**/replica/status', async (route) => {
      const status = await read('/status')
      await route.fulfill({ json: preparing ? { ...status, ready: false } : status })
    })
    await page.goto('/')
    await expect(
      page.getByText('Preparing this library on the server', { exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('progressbar', { name: 'Preparing library metadata' }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try Again', exact: true })).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('synthetic-server-preparation.png') })
    await page.getByText('Why setup is needed', { exact: true }).click()
    await expect(page.getByText(/Other browsers using this server share them/)).toBeVisible()
    preparing = false
    await expect(
      page.getByText('Files not scanned on this server yet', { exact: true }),
    ).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('synthetic-initial-scan-idle.png') })
    // The enqueue response is a genuine running snapshot. Keep displaying it until inspected.
    let heldRun: unknown = null
    await page.route('**/replica/discovery/runs', async (route) => {
      const response = await fetch(backend.baseUrl + base + '/discovery/runs', {
        method: 'POST',
        headers: route.request().headers(),
        body: route.request().postData(),
      })
      heldRun = await response.json()
      await route.fulfill({ status: response.status, json: heldRun })
    })
    await page.route('**/replica/discovery/status', async (route) => {
      await route.fulfill({ json: heldRun ?? (await read('/discovery/status')) })
    })
    await page.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Initial scan…', exact: true })).toBeVisible()
    await expect(page.getByText('Initial library scan', { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByText('Initial library scan', { exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('synthetic-initial-scan-running.png') })
    heldRun = null
    await expect(page.getByText('Initial library scan', { exact: true })).toHaveCount(0)
    await expect.poll(async () => (await read('/discovery/status')).state).toBe('succeeded')
    await page.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Updating…', exact: true })).toBeVisible()
    await expect(page.getByText('About initial setup', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('synthetic-ordinary-update.png') })
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
