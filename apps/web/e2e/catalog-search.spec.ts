import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test('portable search finds file, source and membership names beyond the first page @fullstack', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-search-fields-'))
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
fixture=create_disposable(parent=Path(sys.argv[1]),bundles=65)
with connect_writable(fixture.source / '.cairndex/library.db') as db:
    insert_row(db,'asset_files',synthetic_row('asset_files','search-file',bundle_id='bundle-000064',relative_path='CometPath/feature.mp4',directory_path='CometPath',original_filename='OriginalComet.mp4',display_title='DisplayOrbit',source='https://example.invalid/OriginBeacon',media_kind='VIDEO',role='PRIMARY_VIDEO'))
    insert_row(db,'tags',synthetic_row('tags','search-tag',name='FacetAmber',parent_id=None))
    insert_row(db,'collections',synthetic_row('collections','search-collection',name='ShelfIndigo',parent_id=None))
    insert_row(db,'asset_bundle_tags',{'bundle_id':'bundle-000064','tag_id':'search-tag'})
    insert_row(db,'asset_bundle_collections',{'bundle_id':'bundle-000064','collection_id':'search-collection','sort_order':1})
print(prepare_disposable(fixture,format_version=3).package)
`,
      scratch,
    ],
    { cwd: fileURLToPath(new URL('../../server/', import.meta.url)), encoding: 'utf8' },
  ).trim()
  const backend = await startBackend(join(scratch, 'private'))
  try {
    await apiPost(backend.baseUrl, '/api/v1/libraries/register', { root_path: root })
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    const search = page.getByRole('searchbox', { name: 'Search', exact: true })
    await expect(search).toHaveAttribute('title', /files.*sources.*tags.*collections/)
    const bundle = page.locator('[data-bundle-id="bundle-000064"]')
    for (const query of [
      'CometPath',
      'OriginalComet',
      'DisplayOrbit',
      'OriginBeacon',
      'FacetAmber',
      'ShelfIndigo',
      'video CometPath',
    ]) {
      await search.fill(query)
      await expect(bundle).toBeVisible({ timeout: 15_000 })
      await expect(
        page.getByRole('listbox', { name: 'Bundles', exact: true }).getByRole('option'),
      ).toHaveCount(1)
    }
    await search.fill('NoSyntheticMatch')
    await expect(bundle).toHaveCount(0)
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
