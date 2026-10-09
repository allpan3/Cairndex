import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test.use({ actionTimeout: 15_000 })

test('ordinary inspector saves membership and covers while local facts stay private @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-inspector-e2e-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.replica_media_fixture import create_playable; print(create_playable(parent=Path(sys.argv[1]),duration=6))',
      scratch,
    ],
    { cwd: fileURLToPath(new URL('../../server/', import.meta.url)) },
  )
    .toString()
    .trim()
  const backend = await startBackend(join(scratch, 'private'))
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
  const hash = async () =>
    createHash('sha256')
      .update(await readFile(join(root, 'Playback/movie.mp4')))
      .digest('hex')
  const original = await hash()
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const page = await context.newPage()
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('option').filter({ hasText: 'Synthetic playback' }).click()
    const inspector = page.getByRole('complementary', { name: 'Bundle inspector' })
    await expect(inspector.getByRole('img', { name: 'Bundle cover' })).toBeVisible()
    await expect
      .poll(() =>
        inspector
          .getByRole('img', { name: 'Bundle cover' })
          .evaluate((node: HTMLImageElement) => node.naturalWidth),
      )
      .toBeGreaterThan(0)
    await inspector
      .getByRole('textbox', { name: 'Note', exact: true })
      .fill('Retained inspector draft')
    for (const family of ['Tags', 'Collections']) {
      const section = inspector.getByRole('region', { name: `${family} membership`, exact: true })
      await section.getByRole('checkbox').uncheck()
      await section.getByRole('searchbox').fill('child')
      await section.getByRole('button', { name: 'Add Synthetic child', exact: true }).click()
      await section.getByRole('button', { name: 'Apply membership change' }).click()
      await expect(
        section.getByRole('button', { name: 'Remove Synthetic child', exact: true }),
      ).toBeEnabled()
      await expect(inspector.getByRole('textbox', { name: 'Note', exact: true })).toHaveValue(
        'Retained inspector draft',
      )
    }
    const tags = inspector.getByRole('region', { name: 'Tags membership', exact: true })
    await tags.getByRole('button', { name: 'Remove Synthetic child' }).click()
    await expect(tags.getByRole('button', { name: 'Apply membership change' })).toBeEnabled()
    await page.reload()
    await page.getByRole('option').filter({ hasText: 'Synthetic playback' }).click()
    await tags.getByRole('button', { name: 'Apply membership change' }).click()
    await expect(tags.getByText('No matching tags.')).toBeVisible()
    await tags.getByRole('checkbox').uncheck()
    await tags.getByRole('searchbox').fill('child')
    await tags.getByRole('button', { name: 'Add Synthetic child' }).click()
    await tags.getByRole('button', { name: 'Apply membership change' }).click()
    await expect(tags.getByRole('button', { name: 'Remove Synthetic child' })).toBeEnabled()
    const files = inspector.getByRole('region', { name: 'Files in bundle', exact: true })
    await files.getByRole('button', { name: 'Playback/movie.mp4', exact: true }).click()
    const facts = files.getByRole('region', { name: 'Local file details' })
    await expect(facts).toContainText('320 × 180')
    await expect(facts).toContainText('Observed on this device')
    await files.getByRole('button', { name: 'Set Playback/movie.mp4 as cover' }).click()
    await inspector.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(inspector.locator(':scope > [role="status"]')).toHaveText('Saved here')
    const entityUrl = `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog/entities/asset_bundles/bundle-000001`
    await expect
      .poll(async () => (await (await fetch(entityUrl)).json()).fields.cover_file_id.value)
      .toBe('"media-direct"')
    await page.reload()
    await page.getByRole('option').filter({ hasText: 'Synthetic playback' }).click()
    await expect(
      files.getByRole('button', { name: 'Set Playback/movie.mp4 as cover' }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(inspector.getByRole('textbox', { name: 'Note', exact: true })).toHaveValue(
      'Retained inspector draft',
    )
    await files.getByRole('button', { name: 'Use automatic cover' }).click()
    await inspector.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect
      .poll(async () => (await (await fetch(entityUrl)).json()).fields.cover_file_id.value)
      .toBe('null')
    await files.getByRole('button', { name: 'Playback/movie.mp4', exact: true }).click()
    await expect(facts).toContainText('320 × 180')
    await inspector.screenshot({ path: test.info().outputPath('synthetic-inspector.png') })
    await inspector.evaluate((node) => {
      node.scrollTop = 0
    })
    await inspector.screenshot({ path: test.info().outputPath('synthetic-inspector-cover.png') })
    await rename(
      join(root, 'Playback/movie.mp4'),
      join(root, 'Playback/temporarily-unavailable.mp4'),
    )
    await facts.getByRole('button', { name: 'Retry local file details' }).click()
    await expect(facts).toContainText('Unavailable on this device')
    await rename(
      join(root, 'Playback/temporarily-unavailable.mp4'),
      join(root, 'Playback/movie.mp4'),
    )
    await facts.getByRole('button', { name: 'Retry local file details' }).click()
    await expect(facts).toContainText('Observed on this device')
    expect(await hash()).toBe(original)
    await page.route('**/replica/status', async (route) => {
      const response = await fetch(backend.baseUrl + new URL(route.request().url()).pathname)
      const status = await response.json()
      delete status.inspector_version
      await route.fulfill({ status: response.status, json: status })
    })
    await page.reload()
    await page.getByRole('option').filter({ hasText: 'Synthetic playback' }).click()
    await expect(
      inspector.getByText(
        'Additional inspector controls require a server update. Use Metadata review.',
      ),
    ).toBeVisible()
    await expect(inspector.getByRole('region', { name: 'Tags membership' })).toHaveCount(0)
    await expect(inspector.getByRole('textbox', { name: 'Note', exact: true })).toHaveValue(
      'Retained inspector draft',
    )
  } finally {
    try {
      await context.close()
    } finally {
      await stopBackend(backend.child)
      await rm(scratch, { recursive: true, force: true })
    }
  }
})
