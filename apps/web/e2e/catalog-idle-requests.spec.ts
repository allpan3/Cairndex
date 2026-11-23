import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))

// An idle browser must not keep re-reading a catalog that has not changed: the owner
// measured the desktop sidecar at ~10% CPU while nothing happened (2026-11-23).
test('an idle portable browser re-reads nothing until the catalog changes @fullstack', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-idle-e2e-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.catalog_fixture import create_disposable; from cairndex.replicas.catalog.conversion import prepare_disposable; print(prepare_disposable(create_disposable(parent=Path(sys.argv[1]),bundles=240)).package)',
      scratch,
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
  const backend = await startBackend(join(scratch, 'private'))
  try {
    await apiPost(backend.baseUrl, '/api/v1/libraries/register', { root_path: root })
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    const grid = page.getByRole('listbox', { name: 'Bundles', exact: true })
    await expect(grid.getByRole('option').first()).toBeVisible()
    // Load several browse pages, then select one bundle so its inspector is open too
    for (let i = 0; i < 6; i++) {
      await grid.hover()
      await page.mouse.wheel(0, 2_000)
      await page.waitForTimeout(400)
    }
    await grid.getByRole('option').first().click()
    await page.waitForTimeout(3_000)

    const seen = new Map<string, number>()
    const count = (url: string) => {
      const path = new URL(url).pathname
      if (!path.startsWith('/api/v1/')) return
      const key = path
        .replace(/^\/api\/v1\/libraries\/[^/]+/, '')
        .replace(/\/[\w-]*\d[\w-]*/g, '/:id')
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    page.on('request', (request) => count(request.url()))
    await page.waitForTimeout(10_000)
    page.removeAllListeners('request')
    const total = [...seen.values()].reduce((a, b) => a + b, 0)
    // One status read a second plus slow auth checks; catalog reads wait for a revision
    expect(Object.fromEntries(seen)).not.toHaveProperty('/replica/catalog/bundles/browse')
    expect(total, JSON.stringify(Object.fromEntries(seen))).toBeLessThanOrEqual(20)
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
