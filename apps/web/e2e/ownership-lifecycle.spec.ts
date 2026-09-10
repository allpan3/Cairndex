import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBackend, stopBackend, proxyApi, apiPost } from './realBackend'

test('release and reopen through the real server without automatic reacquisition @fullstack', async ({
  page,
}) => {
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-ownership-e2e-'))
  const backend = await startBackend(join(scratch, 'state'))
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/create', {
      root_path: join(scratch, 'library'),
      display_name: 'Synthetic Lifecycle',
      create_if_missing: true,
    })
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('button', { name: 'Manage libraries' }).click()
    await page.getByRole('button', { name: 'Release', exact: true }).click()
    await expect(page.getByText('Released on this server', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByText('Library released on this server', { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByText('Library released on this server', { exact: true })).toBeVisible()
    const browse = `${backend.baseUrl}/api/v1/libraries/${library.id}/bundles/browse`
    expect((await fetch(browse)).status).toBe(409)
    await page.getByRole('button', { name: 'Reopen', exact: true }).click()
    await expect(
      page.getByText('Library released on this server', { exact: true }),
    ).not.toBeVisible()
    expect((await fetch(browse)).status).toBe(200)
    // Closing a remote client must not issue a server release
    await page.goto('about:blank')
    const status = await fetch(`${backend.baseUrl}/api/v1/libraries/${library.id}/ownership`)
    expect((await status.json()).state).toBe('own')
  } finally {
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
