import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test.use({ actionTimeout: 15_000 })

test('manual bundling ranks targets and nearby files and suggests a useful title @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-bundling-suggestions-'))
  const script = `
from pathlib import Path
import sys
from cairndex.devtools.catalog_fixture import create_disposable, insert_row, synthetic_row
from cairndex.replicas.catalog.conversion import prepare_disposable
from cairndex.persistence.sqlite_durability import connect_writable
fixture = create_disposable(parent=Path(sys.argv[1]), bundles=4)
with connect_writable(fixture.source / '.cairndex/library.db') as db:
    db.execute("UPDATE asset_bundles SET title='Synthetic atlas' WHERE id='bundle-000000'")
    db.execute("UPDATE asset_bundles SET grouping_state='CONFIRMED',grouping_source='MANUAL' WHERE id IN ('bundle-000000','bundle-000003')")
    db.execute("UPDATE asset_files SET relative_path='Atlas/scene.mp4',directory_path='Atlas' WHERE id='file-video'")
    db.execute("UPDATE asset_files SET relative_path='Atlas/scene.srt',directory_path='Atlas' WHERE id='file-subtitle'")
    db.execute("UPDATE asset_bundles SET grouping_state='PROVISIONAL',grouping_source='SCAN_SUGGESTION' WHERE id IN ('bundle-000001','bundle-000002')")
    for identity, path, owner, media in [
        ('staged-video','Atlas/scene-part02.mp4','bundle-000001','VIDEO'),
        ('staged-caption','Atlas/scene-part02.en.srt','bundle-000001','SUBTITLE'),
        ('staged-cover','Atlas/cover.jpg','bundle-000001','IMAGE'),
        ('nearby-caption','Atlas/scene-part02.zh.srt','bundle-000002','SUBTITLE'),
        ('remaining-caption','Atlas/scene-part02.fr.srt','bundle-000001','SUBTITLE'),
    ] + [(f'noise-{i:03}', f'Aardvark/noise-{i:03}.mp4', 'bundle-000001', 'VIDEO') for i in range(120)]:
        insert_row(db,'asset_files',synthetic_row('asset_files',identity,bundle_id=owner,relative_path=path,directory_path=path.rpartition('/')[0],original_filename=path.rpartition('/')[2],display_title=path.rpartition('/')[2],media_kind=media,role='OTHER'))
print(prepare_disposable(fixture).package)
`
  const root = execFileSync('uv', ['run', 'python', '-c', script, scratch], {
    cwd: fileURLToPath(new URL('../../server/', import.meta.url)),
  })
    .toString()
    .trim()
  const backend = await startBackend(join(scratch, 'private'))
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const page = await context.newPage()
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('button', { name: /^Unbundled( \d+)?$/ }).click()
    await page.getByRole('searchbox', { name: 'Search files', exact: true }).fill('scene-part02.en')
    const row = page.getByRole('row', { name: /scene-part02\.en\.srt/ })
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Add to Bundle…', exact: true }).click()
    const add = page.getByRole('dialog', { name: 'Add to bundle', exact: true })
    await expect(add.getByText('Suggested bundles', { exact: true })).toBeVisible()
    await add.getByRole('radio', { name: /Synthetic atlas/ }).check()
    await expect(add.getByText(/same folder/).first()).toBeVisible()
    await add.getByRole('button', { name: 'Add to bundle', exact: true }).click()
    await expect(add).toHaveCount(0)
    const media = `/api/v1/libraries/${library.id}/replica/media`
    const file = async (id: string) =>
      (await (await fetch(backend.baseUrl + `${media}/files/${id}`)).json()).file
    await expect.poll(async () => (await file('staged-caption')).bundle_id).toBe('bundle-000000')
    await page
      .getByRole('searchbox', { name: 'Search files', exact: true })
      .fill('scene-part02.mp4')
    await page.getByRole('row', { name: /scene-part02\.mp4/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^Create Bundle/ }).click()
    const create = page.getByRole('dialog', { name: 'Create bundle', exact: true })
    await expect(create.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
      'scene-part02',
    )
    await expect(create.getByText('noise-000.mp4', { exact: true })).toHaveCount(0)
    await create.getByRole('checkbox', { name: /scene-part02\.zh\.srt/ }).check()
    await create.getByRole('checkbox', { name: /cover\.jpg/ }).check()
    await create.getByRole('button', { name: 'Create bundle', exact: true }).click()
    await expect(create).toHaveCount(0)
    const target = (await file('staged-video')).bundle_id as string
    expect(target).not.toBe('bundle-000000')
    expect((await file('staged-cover')).bundle_id).toBe(target)
    expect((await file('nearby-caption')).bundle_id).toBe(target)
    expect((await file('noise-000')).bundle_id).toBe('bundle-000001')
    expect((await file('staged-cover')).role).toBe('cover')
    // Adding files to that result now offers related remaining files, not the first path page.
    await page.getByRole('button', { name: /^All( \d+)?$/ }).click()
    await page.locator(`[data-bundle-id="${target}"]`).click()
    await page.getByRole('button', { name: 'Add files to this bundle', exact: true }).click()
    const more = page.getByRole('dialog', { name: 'Add files to bundle', exact: true })
    await expect(more.getByText('Suggested unbundled files', { exact: true })).toBeVisible()
    await expect(more.getByRole('checkbox', { name: /scene-part02\.fr\.srt/ })).toBeVisible()
    await expect(more.getByText('noise-000.mp4', { exact: true })).toHaveCount(0)
    await more.getByRole('button', { name: 'Browse all Unbundled files', exact: true }).click()
    await more.getByRole('checkbox', { name: /noise-000\.mp4/ }).check()
    await more.getByRole('button', { name: 'Load more Unbundled files', exact: true }).click()
    await more.getByRole('checkbox', { name: /noise-099\.mp4/ }).check()
    await more
      .getByRole('textbox', { name: 'Search Unbundled files', exact: true })
      .fill('noise-119')
    await more.getByRole('checkbox', { name: /noise-119\.mp4/ }).check()
    await expect(more.getByText('3 files selected', { exact: true })).toBeVisible()
    await page.mouse.move(0, 0)
    await page.screenshot({ path: test.info().outputPath('synthetic-manual-file-picker.png') })
    await more.getByRole('button', { name: 'Add files', exact: true }).click()
    await expect(more).toHaveCount(0)
    expect((await file('noise-119')).bundle_id).toBe(target)
    expect((await file('noise-000')).bundle_id).toBe(target)
    expect((await file('noise-099')).bundle_id).toBe(target)
  } finally {
    try {
      await context.close()
    } finally {
      await stopBackend(backend.child)
      await rm(scratch, { recursive: true, force: true })
    }
  }
})

test('File Browser bundles unlinked paths directly and adds more without Update @fullstack', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-manual-paths-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      `
from pathlib import Path
import sys
from cairndex.devtools.catalog_fixture import create_disposable
from cairndex.replicas.catalog.conversion import prepare_disposable
print(prepare_disposable(create_disposable(parent=Path(sys.argv[1]), bundles=3), format_version=3).package)
`,
      scratch,
    ],
    { cwd: fileURLToPath(new URL('../../server/', import.meta.url)), encoding: 'utf8' },
  ).trim()
  const paths = ['atlas.mp4', 'atlas.en.srt', 'atlas-part02.mp4']
  for (const path of paths) await writeFile(join(root, path), `synthetic ${path}`)
  const before = await Promise.all(paths.map((path) => readFile(join(root, path))))
  const backend = await startBackend(join(scratch, 'private'))
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    const video = page.getByRole('row').filter({ hasText: 'atlas.mp4' })
    await video.click()
    await page
      .getByRole('row')
      .filter({ hasText: 'atlas.en.srt' })
      .click({ modifiers: ['ControlOrMeta'] })
    await video.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^Create Bundle/ }).click()
    const create = page.getByRole('dialog', { name: 'Create bundle', exact: true })
    await expect(create.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('atlas')
    await create.getByRole('button', { name: 'Create bundle', exact: true }).click()
    await expect
      .poll(async () => ({
        dialogs: await create.count(),
        errors: await create.locator('.mb-state--error').allTextContents(),
      }))
      .toEqual({ dialogs: 0, errors: [] })
    const base = `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog`
    const browse = await apiPost<{ items: { id: string; title: string }[] }>(
      backend.baseUrl,
      `${new URL(base).pathname}/bundles/browse`,
      { q: 'atlas' },
    )
    const bundle = browse.items.find((item) => item.title === 'atlas')!.id
    await page.getByRole('row').filter({ hasText: 'atlas-part02.mp4' }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Add to Bundle…', exact: true }).click()
    const add = page.getByRole('dialog', { name: 'Add to bundle', exact: true })
    await add.getByRole('radio', { name: /atlas/ }).check()
    await add.getByRole('button', { name: 'Add to bundle', exact: true }).click()
    await expect(add).toHaveCount(0)
    const response = await fetch(`${base}/entities/asset_bundles/${bundle}`)
    const entity = await response.json()
    expect(JSON.parse(entity.fields.$members.value)).toHaveLength(3)
    expect(await Promise.all(paths.map((path) => readFile(join(root, path))))).toEqual(before)
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
