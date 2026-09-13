import { expect, test } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

// A fresh browser/device recovers server-received work through the supported local command
test('private backup activates a new device and preserves recoverable drafts @fullstack', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'cairndex-recovery-e2e-')))
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  const seed = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.catalog_fixture import create_disposable; from cairndex.replicas.catalog.conversion import prepare_disposable; print(prepare_disposable(create_disposable(parent=Path(sys.argv[1]),bundles=3)).package)',
      scratch,
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
  const roots = [join(scratch, 'package-a'), join(scratch, 'package-b')]
  const data = [join(scratch, 'private-a'), join(scratch, 'private-b')]
  for (const root of roots) await cp(seed, root, { recursive: true })
  const first = await startBackend(data[0])
  const backends = [first]
  const contexts = [await browser.newContext(), await browser.newContext()]
  // CLI paths are explicit administrator arguments and only reference this disposable fixture
  const command = (index: number, args: string[]) =>
    spawnSync(
      'uv',
      [
        'run',
        'python',
        '-m',
        'cairndex.replicas.recovery_cli',
        '--library',
        roots[index],
        '--data-dir',
        data[index],
        ...args,
      ],
      { cwd: serverDir, encoding: 'utf8' },
    )
  try {
    await apiPost(first.baseUrl, '/api/v1/libraries/register', { root_path: roots[0] })
    const a = await contexts[0].newPage()
    await proxyApi(a, first.baseUrl)
    await a.goto('/')
    const title = a.getByRole('textbox', { name: 'Title', exact: true })
    await a
      .getByRole('group', { name: 'Title', exact: true })
      .getByRole('checkbox', { name: 'Not set' })
      .uncheck()
    await title.fill('Saved before recovery')
    await a.getByRole('button', { name: 'Save catalog changes', exact: true }).click()
    await expect(a.getByText('Saved here', { exact: true })).toBeVisible()
    const delivered = a.waitForResponse(
      (response) =>
        response.url().includes('/drafts/asset_bundles/') &&
        response.request().method() === 'PUT' &&
        response.status() === 204,
    )
    await title.fill('Server-received private draft')
    await delivered
    const backupPath = join(scratch, 'backup')
    const backup = command(0, ['backup', '--output', backupPath])
    expect(backup.status, backup.stderr).toBe(0)
    expect(JSON.parse(backup.stdout).coverage.client_drafts).toContain('browser-only')
    const prepared = command(1, ['prepare', '--backup', backupPath])
    expect(prepared.status, prepared.stderr).toBe(0)
    const review = JSON.parse(prepared.stdout) as {
      id: string
      receipt: string
      state: string
      backup_only_events: number
    }
    expect(review.state).toBe('prepared')
    expect(review.backup_only_events).toBeGreaterThan(0)
    const rejected = command(1, ['activate', '--recovery', review.id, '--receipt', 'wrong'])
    expect(rejected.status).toBe(2)
    const activated = command(1, ['activate', '--recovery', review.id, '--receipt', review.receipt])
    expect(activated.status, activated.stderr).toBe(0)
    const second = await startBackend(data[1])
    backends.push(second)
    await apiPost(second.baseUrl, '/api/v1/libraries/register', { root_path: roots[1] })
    const b = await contexts[1].newPage()
    await proxyApi(b, second.baseUrl)
    await b.goto('/')
    await expect(b.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
      'Saved before recovery',
    )
    await b
      .getByRole('button', { name: /^Recover private draft/ })
      .first()
      .click()
    await expect(b.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
      'Server-received private draft',
    )
    // The original remains independently editable after the second device activates
    await title.fill('Original device returns')
    await a.getByRole('button', { name: 'Save catalog changes', exact: true }).click()
    await expect(a.getByText('Saved here', { exact: true })).toBeVisible()
    await b.getByRole('button', { name: 'Save catalog changes', exact: true }).click()
    await expect(b.getByText('Saved here', { exact: true })).toBeVisible()
    for (let i = 0; i < 3; i++) {
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
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    await expect(b.getByRole('button', { name: 'Review Title', exact: true })).toBeVisible()
    await b.getByRole('button', { name: 'Review Title', exact: true }).click()
    const conflict = b.getByRole('region', { name: 'Complete conflict review' })
    await expect(conflict.getByText('Original device returns', { exact: true })).toBeVisible()
    await expect(conflict.getByText('Server-received private draft', { exact: true })).toBeVisible()
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
    await Promise.all(backends.map((backend) => stopBackend(backend.child)))
    await rm(scratch, { recursive: true, force: true })
  }
})
