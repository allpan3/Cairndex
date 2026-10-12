import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { proxyApi, startBackend, stopBackend } from './realBackend'

test('legacy review survives a lost reply and retains later edits through Undo @fullstack', async ({
  page,
}) => {
  test.setTimeout(120_000)
  page.setDefaultTimeout(15_000)
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'cairndex-conversion-e2e-')))
  const server = fileURLToPath(new URL('../../server/', import.meta.url))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from tests.test_legacy_conversion import _legacy; print(_legacy(Path(sys.argv[1])))',
      scratch,
    ],
    { cwd: server },
  )
    .toString()
    .trim()
  const original = await readFile(join(root, '.cairndex/library.db'))
  const media = await readFile(join(root, 'Synthetic/clip.mp4'))
  const backend = await startBackend(join(scratch, 'private'), { CAIRNDEX_WORKER_ENABLED: 'true' })
  try {
    await proxyApi(page, backend.baseUrl)
    let lost = false
    await page.route('**/libraries/conversions/tasks', async (route) => {
      const body = route.request().postDataJSON() as { action: string }
      if (body.action !== 'activate' || lost) return route.fallback()
      lost = true
      const accepted = await fetch(backend.baseUrl + '/api/v1/libraries/conversions/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: route.request().postData(),
      })
      expect(accepted.status).toBe(202)
      await route.abort('connectionreset')
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    await page.getByLabel('Library path').fill(root)
    await page.getByRole('button', { name: 'Add library', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Convert old library' })).toBeVisible()
    await page.getByRole('button', { name: 'Inspect library', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Converts', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Prepare conversion', exact: true }).click()
    const convert = page.getByRole('button', { name: 'Convert library', exact: true })
    await expect(convert).toBeDisabled()
    expect(await readFile(join(root, '.cairndex/library.db'))).toEqual(original)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Resume conversion', exact: true }).click()
    await page.getByLabel(/^I stopped every old app/).check()
    await convert.click()
    await expect(page.getByText('Conversion completed.', { exact: true })).toBeVisible()
    expect(lost).toBe(true)
    const published = JSON.parse(await readFile(join(root, '.cairndex/manifest.json'), 'utf8')) as {
      format: string
    }
    expect(published.format).toBe('cairndex.replica-library')
    await page.getByRole('button', { name: 'Open converted library', exact: true }).click()
    await page.getByRole('button', { name: 'Metadata review', exact: true }).click()
    const title = page.getByRole('textbox', { name: 'Title', exact: true })
    await title.fill('Saved after synthetic conversion')
    await page.getByRole('button', { name: 'Save catalog changes', exact: true }).click()
    await expect(page.getByText('Saved here', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    await page.getByRole('button', { name: 'Resume conversion', exact: true }).click()
    await page.getByRole('button', { name: 'Release converted library', exact: true }).click()
    const undo = page.getByRole('button', { name: 'Undo conversion', exact: true })
    await expect(undo).toBeDisabled()
    await page.getByLabel(/^I released the library on every server/).check()
    await undo.click()
    await expect(page.getByText('The old library is restored.', { exact: true })).toBeVisible()
    expect(await readFile(join(root, '.cairndex/library.db'))).toEqual(original)
    expect(await readFile(join(root, 'Synthetic/clip.mp4'))).toEqual(media)
    const retained = (await readdir(root)).find((name) => name.startsWith('.cairndex-converted-'))
    expect(retained).toBeTruthy()
    const verify = execFileSync(
      'uv',
      [
        'run',
        'python',
        '-c',
        'from pathlib import Path; import sys; from tests.test_legacy_conversion import _join,_rows; root=Path(sys.argv[1]); stage=Path(sys.argv[2]); stage.mkdir(); (stage/".cairndex").symlink_to(root/next(p.name for p in root.iterdir() if p.name.startswith(".cairndex-converted-")),target_is_directory=True); store=_join(stage,Path(sys.argv[3])); assert any(row["title"]=="Saved after synthetic conversion" for row in _rows(store,"asset_bundles").values())',
        root,
        join(scratch, 'check-root'),
        join(scratch, 'check-private'),
      ],
      { cwd: server },
    )
    expect(verify.toString()).toBe('')
    const identities = await page.evaluate(() =>
      Object.entries(localStorage).filter(
        ([key]) => key.startsWith('cairndex.libraryConversion:') && !key.endsWith(':visible'),
      ),
    )
    expect(identities.length).toBe(1)
    expect(identities[0][1]).not.toContain(root)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: 'Libraries', exact: true })).toBeVisible()
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
