import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test('portable maintenance prepares local media without authoring metadata @fullstack', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-maintenance-'))
  const server = fileURLToPath(new URL('../../server/', import.meta.url))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      `
from pathlib import Path
import sys
from cairndex.devtools.discovery_fixture import create_discovery
print(create_discovery(parent=Path(sys.argv[1]),playable=True))
`,
      scratch,
    ],
    { cwd: server, encoding: 'utf8' },
  ).trim()
  const sourceDigest = () =>
    execFileSync(
      'uv',
      [
        'run',
        'python',
        '-c',
        `
from pathlib import Path
import hashlib,json,sys
root=Path(sys.argv[1]) / 'Playback'
print(json.dumps({str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()},sort_keys=True))
`,
        root,
      ],
      { cwd: server, encoding: 'utf8' },
    ).trim()
  const beforeBytes = sourceDigest()
  const backend = await startBackend(join(scratch, 'private'))
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const base = `/api/v1/libraries/${library.id}/replica`
    const read = async (path: string) => (await fetch(backend.baseUrl + base + path)).json()
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await expect(page.getByRole('listbox', { name: 'Bundles', exact: true })).toBeVisible()
    const before = await read('/catalog/entities/asset_files/media-direct')
    await page.getByRole('button', { name: 'More library actions', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Scan new files', exact: true })).toBeVisible()
    await expect(
      page.getByRole('menuitem', { name: 'Suggest grouping…', exact: true }),
    ).toBeVisible()
    await page.getByRole('menuitem', { name: 'Collect metadata', exact: true }).click()
    await expect
      .poll(async () => (await read('/media/maintenance')).job?.state, {
        timeout: 60_000,
      })
      .toBe('succeeded')
    await expect(page.getByText(/Metadata complete · \d+ files checked/)).toBeVisible({
      timeout: 10_000,
    })
    await page.getByRole('button', { name: 'More library actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Generate storyboards', exact: true }).click()
    await expect
      .poll(
        async () => {
          const state = await read('/media/maintenance')
          return state.kind === 'storyboards' ? state.job?.state : null
        },
        { timeout: 120_000 },
      )
      .toBe('succeeded')
    const pass = await read('/media/maintenance')
    expect(pass.job.result.completed).toBe(pass.job.result.total)
    expect(pass.job.result.failed).toBe(0)
    const local = await read('/media/files/media-direct')
    const storyboard = await apiPost<{ state: string }>(
      backend.baseUrl,
      base + '/media/files/media-direct/storyboard',
      {
        generation: local.generation,
      },
    )
    expect(storyboard.state).toBe('ready')
    expect(await read('/catalog/entities/asset_files/media-direct')).toEqual(before)
    expect(sourceDigest()).toBe(beforeBytes)
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
