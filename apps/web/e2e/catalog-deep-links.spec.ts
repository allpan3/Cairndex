import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopBridge } from './desktopBridge'
import { startBackend, stopBackend } from './realBackend'

// A cold-start link opens its bundle, and the card menu copies a link that names it
test('a cairndex:// link opens its portable bundle and Copy URI names it @fullstack', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-deep-link-e2e-'))
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.replica_media_fixture import create_playable; print(create_playable(parent=Path(sys.argv[1]),duration=20))',
      scratch,
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
  const backend = await startBackend(join(scratch, 'private'), {
    CAIRNDEX_CORS_EXTRA_ORIGINS: baseURL!,
  })
  try {
    const response = await fetch(`${backend.baseUrl}/api/v1/libraries/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root_path: root }),
    })
    const library = (await response.json()) as { id: string }
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await desktopBridge(page, [backend.baseUrl], {
      kind: 'bundle',
      id: 'bundle-000001',
      libraryId: library.id,
    })
    await page.goto('/')
    const inspector = page.getByRole('complementary', { name: 'Bundle inspector' })
    await expect(inspector.getByRole('textbox', { name: 'Title' })).toHaveValue(
      'Synthetic playback',
    )
    const card = page.getByRole('option').filter({ hasText: 'Synthetic playback' })
    await expect(card).toHaveAttribute('aria-selected', 'true')
    await card.click({ button: 'right' })
    await page.getByRole('menu').getByRole('menuitem', { name: 'Copy URI' }).click()
    await expect(page.getByText('Bundle URI copied.')).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `cairndex://bundle/bundle-000001?library=${library.id}`,
    )
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
