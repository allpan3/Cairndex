import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test.use({ actionTimeout: 15_000 })

test('ordinary note dragging and tag chip actions survive saves and navigation @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-inspector-actions-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.replica_media_fixture import create_playable; print(create_playable(parent=Path(sys.argv[1]),duration=2))',
      scratch,
    ],
    { cwd: fileURLToPath(new URL('../../server/', import.meta.url)) },
  )
    .toString()
    .trim()
  const original = await readFile(join(root, 'Playback/movie.mp4'))
  const backend = await startBackend(join(scratch, 'private'))
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const page = await context.newPage()
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    const first = page.locator('[data-bundle-id="bundle-000001"]')
    const second = page.locator('[data-bundle-id="bundle-000002"]')
    const inspector = page.getByRole('complementary', { name: 'Bundle inspector' })
    await first.click()
    await inspector.getByRole('textbox', { name: 'Note', exact: true }).fill('First synthetic note')
    await inspector.getByRole('button', { name: 'Add note', exact: true }).click()
    await inspector
      .getByRole('textbox', { name: 'Note 2', exact: true })
      .fill('Second synthetic note')
    const grip = inspector.getByRole('button', { name: 'Reorder note 2', exact: true })
    await grip.scrollIntoViewIfNeeded()
    const from = await grip.boundingBox()
    const to = await inspector.getByRole('textbox', { name: 'Note 1', exact: true }).boundingBox()
    if (!from || !to) throw new Error('Synthetic note controls are not laid out')
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width / 2, to.y + 2, { steps: 8 })
    await page.mouse.up()
    await expect(inspector.getByRole('textbox', { name: 'Note 1', exact: true })).toHaveValue(
      'Second synthetic note',
    )
    await page.reload()
    await first.click()
    await expect(inspector.getByRole('textbox', { name: 'Note 1', exact: true })).toHaveValue(
      'Second synthetic note',
    )
    await inspector.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect
      .poll(
        async () => {
          const entity = await (
            await fetch(
              `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog/entities/asset_bundles/bundle-000001`,
            )
          ).json()
          return JSON.parse(JSON.parse(entity.fields.notes.value))
        },
        { timeout: 30_000 },
      )
      .toEqual(['Second synthetic note', 'First synthetic note'])

    const tags = inspector.locator('[data-section="tags"]')
    async function assign(name: string) {
      await tags.getByRole('button', { name: '+ Tag', exact: true }).click()
      const picker = page.getByRole('dialog', { name: 'Choose tags' })
      await picker.getByRole('textbox', { name: 'Search tags' }).fill(name)
      await picker.getByRole('button', { name: new RegExp(name) }).click()
      await page.keyboard.press('Escape')
      await expect(tags.getByRole('button', { name: `Remove ${name}`, exact: true })).toBeEnabled()
    }
    await assign('Synthetic child')
    await tags.getByRole('button', { name: 'Tag actions Synthetic child' }).click()
    await page.getByRole('menuitem', { name: 'Copy Tags', exact: true }).click()
    await expect(tags.getByRole('status')).toHaveText('Copied 1 tag.')
    await second.click()
    await assign('Synthetic root')
    await tags.getByRole('button', { name: 'Tag actions Synthetic root' }).click()
    await page.getByRole('menuitem', { name: 'Paste Tags', exact: true }).click()
    await expect(
      tags.getByRole('button', { name: 'Remove Synthetic child', exact: true }),
    ).toBeEnabled()
    await expect(
      tags.getByRole('button', { name: 'Remove Synthetic root', exact: true }),
    ).toBeEnabled()
    await tags.getByRole('button', { name: 'Tag actions Synthetic child' }).click()
    await page.getByRole('menuitem', { name: 'Rename Tag…', exact: true }).click()
    const rename = page.getByRole('dialog', { name: 'Rename Tag', exact: true })
    await rename.getByRole('textbox', { name: 'Tag name' }).fill('Synthetic renamed')
    await rename.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(rename).toHaveCount(0, { timeout: 30_000 })
    await expect(tags.getByRole('button', { name: 'Tag actions Synthetic renamed' })).toBeVisible()

    // A chip keeps the current search and includes descendants of a parent tag.
    const searched = page.waitForResponse(
      (response) =>
        response.url().includes('/bundles/browse') &&
        response.request().postDataJSON()?.q === 'Synthetic',
    )
    await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('Synthetic')
    await searched
    await second.click()
    await tags.getByRole('button', { name: 'Tag actions Synthetic root' }).click()
    const filtered = page.waitForResponse(
      (response) =>
        response.url().includes('/bundles/browse') &&
        JSON.stringify(response.request().postDataJSON()?.filter ?? null).includes('tags-root'),
    )
    await page
      .getByRole('menuitem', { name: 'Filter Items with “Synthetic root”', exact: true })
      .click()
    expect((await (await filtered).json()).items.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining(['bundle-000001', 'bundle-000002']),
    )
    await expect(page.getByRole('searchbox', { name: 'Search', exact: true })).toHaveValue(
      'Synthetic',
    )
    await expect(first).toBeVisible()
    await expect(second).toBeVisible()
    await first.click()
    await page.keyboard.press('ArrowRight')
    await expect(second).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(first).toHaveAttribute('aria-selected', 'true')

    await inspector.getByRole('button', { name: 'Play Playback/picture.png', exact: true }).click()
    await expect(page.locator('.media-viewer')).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Show bundle inspector', exact: true }).click()
    await tags.getByRole('button', { name: 'Tag actions Synthetic renamed' }).click()
    const viewerFiltered = page.waitForResponse(
      (response) =>
        response.url().includes('/bundles/browse') &&
        JSON.stringify(response.request().postDataJSON()?.filter ?? null).includes('tags-child'),
    )
    await page
      .getByRole('menuitem', { name: 'Filter Items with “Synthetic renamed”', exact: true })
      .click()
    expect((await viewerFiltered).request().postDataJSON().q).toBe('Synthetic')
    await expect(page.locator('.media-viewer')).toHaveCount(0)
    await expect(page.getByRole('searchbox', { name: 'Search', exact: true })).toHaveValue(
      'Synthetic',
    )
    await page.getByRole('button', { name: 'Filter by tags', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Any', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByRole('checkbox', { name: 'subtags', exact: true })).toBeChecked()
    await page.keyboard.press('Escape')

    // The viewer uses the same ordinary actions and the portable query scope.
    await first.click()
    const collections = inspector.locator('[data-section="collections"]')
    await collections.getByRole('button', { name: '+ Collection', exact: true }).click()
    const collectionPicker = page.getByRole('dialog', { name: 'Choose collections' })
    await collectionPicker
      .getByRole('textbox', { name: 'Search collections' })
      .fill('Synthetic child')
    await collectionPicker.getByRole('button', { name: /Synthetic child/ }).click()
    await page.keyboard.press('Escape')
    await expect(
      collections.getByRole('button', { name: 'Open collection Synthetic child', exact: true }),
    ).toBeEnabled()
    await inspector.getByRole('button', { name: 'Play Playback/picture.png', exact: true }).click()
    await expect(page.locator('.media-viewer')).toBeVisible({ timeout: 30_000 })
    const showInspector = page.getByRole('button', { name: 'Show bundle inspector', exact: true })
    if (await showInspector.isVisible()) await showInspector.click()
    await expect(inspector).toBeVisible()
    const unsupported = [] as string[]
    page.on('request', (request) => {
      if (
        /\/api\/v1\/libraries\/[^/]+\/(bundles\/[^/?]+(?:\?|$)|manual-bundling\b)/.test(
          request.url(),
        )
      )
        unsupported.push(request.url())
    })
    await inspector.getByRole('button', { name: 'Add files to this bundle', exact: true }).click()
    const add = page.getByRole('dialog', { name: 'Add files to bundle', exact: true })
    await expect(
      add.getByRole('textbox', { name: 'Search Unbundled files', exact: true }),
    ).toBeVisible()
    await expect(add.getByText('No matching unbundled files found.', { exact: true })).toBeVisible()
    expect(unsupported).toEqual([])
    await page.keyboard.press('Escape')
    await expect(add).toHaveCount(0)
    await expect(page.locator('.media-viewer')).toBeVisible()
    await expect(
      inspector.locator('.prop').filter({ has: page.getByText('Files', { exact: true }) }),
    ).toContainText('6')
    await expect(inspector.getByText('Date Added', { exact: true })).toBeVisible()
    await expect(inspector.getByText('Unknown on this device', { exact: true })).toBeVisible()
    await inspector
      .getByRole('button', { name: 'Open collection Synthetic child', exact: true })
      .click()
    await expect(page.locator('.media-viewer')).toHaveCount(0)
    await expect(first).toBeVisible({ timeout: 30_000 })
    await expect(second).toHaveCount(0)
    expect(await readFile(join(root, 'Playback/movie.mp4'))).toEqual(original)
  } finally {
    try {
      await context.close()
    } finally {
      await stopBackend(backend.child)
      await rm(scratch, { recursive: true, force: true })
    }
  }
})
