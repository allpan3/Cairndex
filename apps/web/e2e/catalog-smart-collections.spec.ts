import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test('ordinary Smart Collections retain drafts, guard opening bases and keep advanced rules @fullstack', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-smart-controls-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      `
from pathlib import Path
import sys
from cairndex.devtools.catalog_fixture import create_disposable, insert_row, synthetic_row
from cairndex.persistence.sqlite_durability import connect_writable
from cairndex.replicas.catalog.conversion import prepare_disposable
fixture=create_disposable(parent=Path(sys.argv[1]),bundles=3)
with connect_writable(fixture.source / '.cairndex/library.db') as db:
    db.execute("UPDATE asset_bundles SET rating=NULL")
    db.execute("UPDATE asset_bundles SET rating=4 WHERE id IN ('bundle-000000','bundle-000001')")
    insert_row(db,'smart_folders',synthetic_row('smart_folders','advanced-smart',name='Advanced rules',filter_version=1,filter_json='{ "version": 1, "root": { "op": "not", "child": { "field": "title", "operator": "contains", "value": "AbsentComet" } } }'))
print(prepare_disposable(fixture,format_version=3).package)
`,
      scratch,
    ],
    { cwd: fileURLToPath(new URL('../../server/', import.meta.url)), encoding: 'utf8' },
  ).trim()
  const backend = await startBackend(join(scratch, 'private'))
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const base = `/api/v1/libraries/${library.id}/replica/catalog`
    const read = async (path: string) => (await fetch(backend.baseUrl + base + path)).json()
    const job = async (body: unknown) => {
      const operation = randomUUID().replaceAll('-', '')
      await apiPost(backend.baseUrl, base + '/jobs', { action: 'save', body, operation })
      await expect
        .poll(async () => (await read('/jobs/' + operation)).state, { timeout: 30_000 })
        .toBe('succeeded')
    }
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('button', { name: 'New smart collection', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: 'New Smart Collection', exact: true })
    await dialog.getByLabel('Smart collection name').fill('Rated discoveries')
    await dialog.getByLabel('Field', { exact: true }).selectOption('rating')
    await dialog.getByLabel('Operator', { exact: true }).selectOption('gte')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'New smart collection', exact: true }).click()
    await expect(dialog.getByLabel('Smart collection name')).toHaveValue('Rated discoveries')
    await expect(dialog.getByLabel('Field', { exact: true })).toHaveValue('rating')
    await expect(dialog.getByText('2 matching bundles', { exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('synthetic-smart-collection.png') })
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 30_000 })
    const list = page.getByRole('listbox', { name: 'Bundles', exact: true })
    await expect(list.getByRole('option')).toHaveCount(2)
    const navigation = await read('/navigation/smart_folders?limit=50')
    const created = navigation.items.find(
      (item: { name: string }) => item.name === 'Rated discoveries',
    )
    expect(created).toBeDefined()

    const advancedBefore = await read('/entities/smart_folders/advanced-smart')
    await page.getByRole('button', { name: 'Edit Advanced rules', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Edit Smart Collection', exact: true })
    await expect(dialog.getByRole('note')).toContainText('only the name')
    await dialog.getByLabel('Smart collection name').fill('Renamed advanced rules')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 30_000 })
    const advancedAfter = await read('/entities/smart_folders/advanced-smart')
    expect(advancedAfter.fields.$filter.value).toBe(advancedBefore.fields.$filter.value)

    await page.getByRole('button', { name: 'Edit Renamed advanced rules', exact: true }).click()
    await expect(dialog.getByLabel('Smart collection name')).toHaveValue('Renamed advanced rules')
    const opening = await read('/entities/smart_folders/advanced-smart')
    await job({
      changes: [
        {
          unit: opening.fields.name.unit,
          value: JSON.stringify('Later peer name'),
          basis: opening.fields.name.basis,
        },
        { unit: opening.fields.$alive.unit, value: 'true', basis: opening.fields.$alive.basis },
      ],
      parents: opening.parents,
      resolve: false,
      recover: false,
    })
    await dialog.getByLabel('Smart collection name').fill('Stale editor name')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog.getByRole('alert')).toBeVisible({ timeout: 30_000 })
    expect(
      JSON.parse((await read('/entities/smart_folders/advanced-smart')).fields.name.value),
    ).toBe('Later peer name')
    await dialog.getByRole('button', { name: 'Discard draft', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    await page.getByRole('button', { name: 'Edit Rated discoveries', exact: true }).click()
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(dialog.getByText(/bundles and source files stay/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete Smart Collection', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 30_000 })
    expect(
      (await read('/navigation/smart_folders?limit=50')).items.some(
        (item: { id: string }) => item.id === created.id,
      ),
    ).toBe(false)
    expect(
      (await apiPost<{ total: number }>(backend.baseUrl, base + '/bundles/browse', { limit: 50 }))
        .total,
    ).toBe(3)
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
