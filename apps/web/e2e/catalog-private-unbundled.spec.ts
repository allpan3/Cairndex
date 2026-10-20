import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test.use({ actionTimeout: 15_000 })

test('fresh private discoveries work in Unbundled and paged manual choices @fullstack', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-private-unbundled-'))
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
root=create_discovery(parent=Path(sys.argv[1]))
paths=['Atlas/scene.mp4','Atlas/scene.en.srt']+[f'Aardvark/noise-{i:03}.mp4' for i in range(120)]
for relative in paths:
    path=root/relative
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(('synthetic media '+relative).encode())
print(root)
`,
      scratch,
    ],
    { cwd: server, encoding: 'utf8' },
  ).trim()
  const digest = () =>
    execFileSync(
      'uv',
      [
        'run',
        'python',
        '-c',
        `
import hashlib,json,sys
from pathlib import Path
root=Path(sys.argv[1])
print(json.dumps({str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest()
for folder in ('Atlas','Aardvark') for p in (root/folder).iterdir()},sort_keys=True))
`,
        root,
      ],
      { cwd: server, encoding: 'utf8' },
    ).trim()
  const beforeBytes = digest()
  const backend = await startBackend(join(scratch, 'private'))
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const base = `/api/v1/libraries/${library.id}/replica`
    const read = async (path: string) => (await fetch(backend.baseUrl + base + path)).json()
    const queue = async () =>
      apiPost<{ total: number; items: { id: string | null; relative_path: string }[] }>(
        backend.baseUrl,
        base + '/catalog/files/unbundled',
        { limit: 100 },
      )
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await expect(page.getByRole('listbox', { name: 'Bundles', exact: true })).toBeVisible()
    const before = await read('/catalog/entities/asset_files/file-video')
    await page.getByRole('button', { name: 'More library actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Scan new files', exact: true }).click()
    await expect
      .poll(async () => (await read('/discovery/status')).state, { timeout: 60_000 })
      .toBe('succeeded')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect((await queue()).items.every((file) => file.id === null)).toBe(true)
    expect((await queue()).total).toBe(122)
    expect(await read('/catalog/entities/asset_files/file-video')).toEqual(before)
    await page.getByRole('button', { name: /^Unbundled( \d+)?$/ }).click()
    await page.getByRole('searchbox', { name: 'Search files', exact: true }).fill('Atlas/scene.mp4')
    await page.getByRole('row', { name: /scene\.mp4/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Create Bundle…', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'Create bundle', exact: true })
    await expect(create.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('scene')
    await create.getByRole('checkbox', { name: /scene\.en\.srt/ }).check()
    await create.getByRole('button', { name: 'Create bundle', exact: true }).click()
    await expect(create).toHaveCount(0)
    await expect.poll(async () => (await queue()).total).toBe(120)
    await expect(page.getByRole('button', { name: 'Unbundled 120', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'All 4', exact: true })).toBeVisible()
    const found = await apiPost<{ items: { id: string; title: string }[] }>(
      backend.baseUrl,
      base + '/catalog/bundles/browse',
      { q: 'scene' },
    )
    const target = found.items.find((bundle) => bundle.title === 'scene')!.id
    await page.getByRole('button', { name: /^All( \d+)?$/ }).click()
    await page.locator(`[data-bundle-id="${target}"]`).click()
    await page.getByRole('button', { name: 'Add files to this bundle', exact: true }).click()
    const add = page.getByRole('dialog', { name: 'Add files to bundle', exact: true })
    // An empty recommendation result opens the complete queue automatically.
    await expect(
      add.getByRole('textbox', { name: 'Search Unbundled files', exact: true }),
    ).toBeVisible()
    await add.getByRole('checkbox', { name: /noise-000\.mp4/ }).check()
    await add.getByRole('button', { name: 'Load more Unbundled files', exact: true }).click()
    await add.getByRole('checkbox', { name: /noise-099\.mp4/ }).check()
    await add
      .getByRole('textbox', { name: 'Search Unbundled files', exact: true })
      .fill('noise-119')
    await add.getByRole('checkbox', { name: /noise-119\.mp4/ }).check()
    await expect(add.getByText('3 files selected', { exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('synthetic-private-unbundled.png') })
    await add.getByRole('button', { name: 'Add files', exact: true }).click()
    await expect(add).toHaveCount(0)
    await expect.poll(async () => (await queue()).total).toBe(117)
    await expect(page.getByRole('button', { name: 'Unbundled 117', exact: true })).toBeVisible()
    expect(digest()).toBe(beforeBytes)
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
