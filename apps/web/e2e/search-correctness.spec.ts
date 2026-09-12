import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

// Seed only disposable metadata; no owner library or source files are opened
async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-search-e2e-'))
  const root = join(scratch, 'library')
  execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      `
from pathlib import Path
from datetime import UTC, datetime, timedelta
import sys
from sqlalchemy.orm import Session
from cairndex.registry.library_package import create_package, db_path
from cairndex.persistence.engine import create_app_engine
from cairndex.domain.enums import FileRole, MediaKind, GroupingSource, GroupingState
from cairndex.services import bundles
root = Path(sys.argv[1])
root.mkdir()
create_package(root, 'Synthetic search')
engine = create_app_engine(database_url=f'sqlite:///{db_path(root)}')
with Session(engine) as session:
    bundles.create_bundle(session, title='Amber', notes=['Firstnote', 'Secondnote'], rating=5)
    bundles.create_bundle(session, title='Blue', rating=1)
    staged = bundles.create_bundle(session, title='Staging')
    staged.grouping_state = GroupingState.PROVISIONAL
    staged.grouping_source = GroupingSource.SCAN_SUGGESTION
    for i in range(231):
        name = f'clip-{i:03d}.mp4' if i < 230 else 'zz-needle.mp4'
        f = bundles.add_file(session, staged.id, relative_path=name,
                             role=FileRole.PRIMARY_VIDEO, media_kind=MediaKind.VIDEO)
        f.size_bytes = i + 1
        f.mtime = datetime(2026, 1, 1, tzinfo=UTC) + timedelta(seconds=i)
    session.commit()
engine.dispose()
`,
      root,
    ],
    {
      cwd: fileURLToPath(new URL('../../server/', import.meta.url)),
      env: { ...process.env, CAIRNDEX_DATA_DIR: join(scratch, 'seed-data') },
    },
  )
  const backend = await startBackend(join(scratch, 'server'))
  const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
    root_path: root,
  })
  return {
    ...backend,
    library,
    scratch,
    base: `${backend.baseUrl}/api/v1/libraries/${library.id}`,
    cleanup: async () => {
      await stopBackend(backend.child)
      await rm(scratch, { recursive: true, force: true })
    },
  }
}

test('nested rules retain membership through rename, cancel and stale save @fullstack', async ({
  page,
}) => {
  const f = await fixture()
  try {
    const filter = {
      version: 1,
      root: {
        op: 'not',
        child: {
          op: 'or',
          children: [
            { field: 'rating', operator: 'lt', value: 4 },
            { op: 'and', children: [{ field: 'title', operator: 'contains', value: 'Blue' }] },
          ],
        },
      },
    }
    const saved = await apiPost<{ id: string; filter: unknown; version: number }>(
      f.base,
      '/smart-collections',
      { name: 'Nested rules', filter },
    )
    const patches: unknown[] = []
    page.on('request', (request) => {
      if (request.method() === 'PATCH' && request.url().endsWith(`/smart-collections/${saved.id}`))
        patches.push(request.postDataJSON())
    })
    await proxyApi(page, f.baseUrl)
    await page.goto('/')
    await page.getByRole('button', { name: 'Edit Nested rules', exact: true }).click()
    await expect(page.getByRole('note')).toContainText('only the name')
    await expect(page.locator('.modal__preview')).toHaveText('1 matching bundle')
    await page.getByLabel('Smart collection name').fill('Discard me')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(patches).toEqual([])
    await page.getByRole('button', { name: 'Edit Nested rules', exact: true }).click()
    await expect(page.getByLabel('Smart collection name')).toHaveValue('Nested rules')
    await page.getByLabel('Smart collection name').fill('Renamed rules')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(patches).toEqual([{ name: 'Renamed rules' }])
    const renamed = await (await fetch(`${f.base}/smart-collections/${saved.id}`)).json()
    expect(renamed.filter).toEqual(saved.filter)
    await expect(page.locator('.toolbar__count')).toContainText('1 items')
    await page.getByRole('button', { name: 'Edit Renamed rules', exact: true }).click()
    const newer = await fetch(`${f.base}/smart-collections/${saved.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': String(renamed.version) },
      body: JSON.stringify({ filter: { version: 1, root: null } }),
    })
    expect(newer.ok).toBe(true)
    await page.getByLabel('Smart collection name').fill('Stale rename')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    expect(
      (await (await fetch(`${f.base}/smart-collections/${saved.id}`)).json()).filter.root,
    ).toBeNull()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Edit Renamed rules', exact: true }).click()
    await expect(page.getByLabel('Field')).toBeVisible()
    await expect(page.locator('.modal__preview')).toHaveText('2 matching bundles')
  } finally {
    await page.close()
    await f.cleanup()
  }
})

test('Unbundled searches all rows, sorts globally and fences slow searches and libraries @fullstack', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const f = await fixture()
  try {
    const peer = await apiPost<{ id: string }>(f.baseUrl, '/api/v1/libraries/create', {
      root_path: join(f.scratch, 'other'),
      display_name: 'Other synthetic',
      create_if_missing: true,
    })
    await proxyApi(page, f.baseUrl)
    await page.goto('/')
    await page.getByRole('combobox', { name: 'Library', exact: true }).selectOption(f.library.id)
    await page.locator('.nav-item').filter({ hasText: 'Unbundled' }).click()
    const rows = page.locator('.file-row[data-relpath]')
    await expect(rows.first()).toBeVisible()
    const search = page.getByLabel('Search files', { exact: true })
    await search.fill('needle')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toHaveAttribute('data-relpath', 'zz-needle.mp4')
    await search.fill('absent')
    await expect(page.getByText('No files match “absent”.')).toBeVisible()
    await search.fill('')
    await page.getByRole('button', { name: 'Sort by Size', exact: true }).click()
    await page.getByRole('button', { name: 'Sort by Size', exact: true }).click()
    await expect(rows.first()).toHaveAttribute('data-relpath', 'zz-needle.mp4')
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    await page.route('**/manual-bundling/unbundled-files?**', async (route) => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('q') === 'slow') {
        entered()
        await pending
        await route.fulfill({ json: { items: [], total: 0, offset: 0, limit: 200 } })
      } else await route.fallback()
    })
    await search.fill('slow')
    await started
    await expect(page.getByText('Loading…', { exact: true })).toBeVisible()
    await search.fill('needle')
    await expect(rows.first()).toHaveAttribute('data-relpath', 'zz-needle.mp4')
    await page.getByRole('combobox', { name: 'Library', exact: true }).selectOption(peer.id)
    release()
    await page.locator('.nav-item').filter({ hasText: 'Unbundled' }).click()
    await expect(page.getByLabel('Search files', { exact: true })).toHaveValue('')
    await expect(page.getByText('No indexed files awaiting bundling.')).toBeVisible()
    await expect(rows).toHaveCount(0)
    await page.getByRole('combobox', { name: 'Library', exact: true }).selectOption(f.library.id)
    await page.locator('.nav-item').filter({ hasText: 'Unbundled' }).click()
    let fail = true
    await page.route('**/manual-bundling/unbundled-files?**', async (route) => {
      if (fail)
        await route.fulfill({
          status: 503,
          json: { error: { code: 'UNAVAILABLE', message: 'Synthetic query outage' } },
        })
      else await route.fallback()
    })
    await page.getByLabel('Search files', { exact: true }).fill('clip-222')
    await expect(page.getByRole('button', { name: 'Retry files' })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('No files match “clip-222”.')).toHaveCount(0)
    fail = false
    await page.getByRole('button', { name: 'Retry files' }).click()
    await expect(rows.first()).toHaveAttribute('data-relpath', 'clip-222.mp4')
    await expect(rows).toHaveCount(1)
  } finally {
    await page.close()
    await f.cleanup()
  }
})
