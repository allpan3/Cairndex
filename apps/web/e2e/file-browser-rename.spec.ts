import { expect, test } from '@playwright/test'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proxyApi, startBackend, stopBackend } from './realBackend'

test('write mode enables file and folder renames that apply on Enter @fullstack', async ({
  page,
}) => {
  test.setTimeout(150_000)
  page.setDefaultTimeout(15_000)
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'cairndex-inline-rename-')))
  const root = join(scratch, 'Library')
  await mkdir(join(root, 'Folder'), { recursive: true })
  await writeFile(join(root, 'Folder', 'amber.txt'), 'Synthetic amber')
  const backend = await startBackend(join(scratch, 'private'), { CAIRNDEX_WORKER_ENABLED: 'true' })
  try {
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    await page.getByLabel('Library path').fill(root)
    await page.getByRole('button', { name: 'Add library', exact: true }).click()
    await page.getByLabel('Library name').fill('Synthetic rename')
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/libraries/create' &&
        response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Create library', exact: true }).click()
    expect((await created).status()).toBe(201)
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    const files = page.getByRole('grid', { name: 'Files', exact: true })
    const folder = files.getByRole('row').filter({ hasText: 'Folder' })
    await folder.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Rename…', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')

    const setWriteMode = async (enabled: boolean) => {
      await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
      const manager = page.getByRole('dialog', { name: 'Libraries', exact: true })
      const toggle = manager.getByRole('button', { name: 'Write mode for Synthetic rename' })
      await toggle.click()
      if (enabled) await manager.getByRole('button', { name: 'Turn on', exact: true }).click()
      await expect(toggle).toHaveAttribute('aria-pressed', String(enabled))
      await manager.getByRole('button', { name: 'Close', exact: true }).click()
    }
    await setWriteMode(true)
    await folder.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Rename…', exact: true })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click()
    await page.getByRole('textbox', { name: 'Rename Folder', exact: true }).fill('Renamed')
    await page.getByRole('textbox', { name: 'Rename Folder', exact: true }).press('Enter')
    // Enter is the approval: the rename runs as one journaled operation, with Undo
    await expect(page.getByText('Renamed “Folder” to “Renamed”.')).toBeVisible({
      timeout: 20_000,
    })
    expect(await readFile(join(root, 'Renamed/amber.txt'), 'utf8')).toBe('Synthetic amber')
    await files.getByRole('row').filter({ hasText: 'Renamed' }).dblclick()
    const amber = files.getByRole('row').filter({ hasText: 'amber.txt' })
    await amber.click()
    const inspector = page.getByRole('complementary', { name: 'File inspector' })
    await inspector.getByText('amber.txt', { exact: true }).dblclick()
    const name = inspector.getByRole('textbox', { name: 'Rename amber.txt' })
    await name.fill('gold.txt')
    await name.press('Enter')
    await expect(page.getByText('Renamed “amber.txt” to “gold.txt”.')).toBeVisible({
      timeout: 20_000,
    })
    expect(await readFile(join(root, 'Renamed/gold.txt'), 'utf8')).toBe('Synthetic amber')
    await expect(files.getByRole('row').filter({ hasText: 'gold.txt' })).toBeVisible()

    await setWriteMode(false)
    await files.getByRole('row').filter({ hasText: 'gold.txt' }).click()
    await files.press('F2')
    await expect(page.getByRole('textbox', { name: 'Rename gold.txt' })).toHaveCount(0)
    await inspector.getByText('gold.txt', { exact: true }).dblclick()
    await expect(page.getByRole('textbox', { name: 'Rename gold.txt' })).toHaveCount(0)
    await setWriteMode(true)
    await files.getByRole('row').filter({ hasText: 'gold.txt' }).click()
    await files.press('F2')
    const keyboardName = files.getByRole('textbox', { name: 'Rename gold.txt' })
    await keyboardName.fill('cancelled.txt')
    await keyboardName.press('Escape')
    await expect(page.getByText('Renaming “gold.txt”')).toHaveCount(0)
    await access(join(root, 'Renamed/gold.txt'))
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
