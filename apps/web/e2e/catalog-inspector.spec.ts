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
    const note = inspector.getByRole('textbox', { name: 'Note', exact: true })
    const section = (family: string) => inspector.locator(`[data-section="${family}"]`)
    const choose = async (family: 'tags' | 'collections', name: string) => {
      await section(family)
        .getByRole('button', { name: family === 'tags' ? '+ Tag' : '+ Collection' })
        .click()
      const picker = page.getByRole('dialog', { name: `Choose ${family}` })
      await picker.getByRole('textbox', { name: `Search ${family}` }).fill(name)
      await picker.getByRole('button', { name: new RegExp(name) }).click()
      await page.keyboard.press('Escape')
    }
    // A chip saves at once, and the unsaved note draft stays as it was
    for (const family of ['tags', 'collections'] as const) {
      await choose(family, 'Synthetic child')
      await expect(
        section(family).getByRole('button', { name: 'Remove Synthetic child', exact: true }),
      ).toBeEnabled()
      await expect(note).toHaveValue('Retained inspector draft')
    }
    await section('tags').getByRole('button', { name: 'Remove Synthetic child' }).click()
    await expect(
      section('tags').getByRole('button', { name: 'Remove Synthetic child' }),
    ).toHaveCount(0)
    await page.reload()
    await page.getByRole('option').filter({ hasText: 'Synthetic playback' }).click()
    await expect(
      section('collections').getByRole('button', { name: 'Remove Synthetic child' }),
    ).toBeEnabled()
    await expect(
      section('tags').getByRole('button', { name: 'Remove Synthetic child' }),
    ).toHaveCount(0)
    await choose('tags', 'Synthetic child')
    await expect(
      section('tags').getByRole('button', { name: 'Remove Synthetic child' }),
    ).toBeEnabled()
    const files = inspector.locator('[data-section="files"]')
    await files.getByRole('button', { name: /^movie\.mp4/ }).click()
    const facts = files.getByRole('region', { name: 'Local file details' })
    await expect(facts).toContainText('320 × 180')
    await expect(facts).toContainText('Observed on this device')
    // In a short window the inspector scrolls to the file list, and Save stays in view
    await page.setViewportSize({ width: 1200, height: 640 })
    await files.getByRole('button', { name: 'Set Playback/movie.mp4 as cover' }).click()
    await expect(
      inspector.getByRole('button', { name: 'Save changes', exact: true }),
    ).toBeInViewport()
    await inspector.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(inspector.locator('.catalog-inspector-actions [role="status"]')).toHaveText(
      'Saved here',
    )
    await page.setViewportSize({ width: 1200, height: 900 })
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
    // The current cover's ★ returns to the automatic cover
    await files.getByRole('button', { name: 'Set Playback/movie.mp4 as cover' }).click()
    await inspector.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect
      .poll(async () => (await (await fetch(entityUrl)).json()).fields.cover_file_id.value)
      .toBe('null')
    await files.getByRole('button', { name: /^movie\.mp4/ }).click()
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
    await facts.getByRole('button', { name: 'Check Again' }).click()
    await expect(facts).toContainText('Unavailable on this device')
    await rename(
      join(root, 'Playback/temporarily-unavailable.mp4'),
      join(root, 'Playback/movie.mp4'),
    )
    await facts.getByRole('button', { name: 'Check Again' }).click()
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
    await expect(section('tags')).toHaveCount(0)
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
