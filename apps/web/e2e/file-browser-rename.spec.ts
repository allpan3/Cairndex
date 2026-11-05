import { expect, test } from '@playwright/test'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proxyApi, startBackend, stopBackend } from './realBackend'

test('Write Mode immediately enables reviewed file and folder renames @fullstack', async ({
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
    const review = page.getByRole('dialog', { name: 'Review rename', exact: true })
    const apply = review.getByRole('button', { name: 'Apply reviewed operation', exact: true })
    await expect(apply).toBeEnabled({ timeout: 20_000 })
    expect(await readFile(join(root, 'Folder/amber.txt'), 'utf8')).toBe('Synthetic amber')
    await apply.click()
    await expect(review.getByRole('heading', { name: 'rename: succeeded' })).toBeVisible({
      timeout: 20_000,
    })
    await review.getByRole('button', { name: 'Close', exact: true }).click()
    await files.getByRole('row').filter({ hasText: 'Renamed' }).dblclick()
    const amber = files.getByRole('row').filter({ hasText: 'amber.txt' })
    await amber.click()
    const inspector = page.getByRole('complementary', { name: 'File inspector' })
    await inspector.getByText('amber.txt', { exact: true }).dblclick()
    const name = inspector.getByRole('textbox', { name: 'Rename amber.txt' })
    await name.fill('gold.txt')
    await name.press('Enter')
    await expect(apply).toBeEnabled({ timeout: 20_000 })
    expect(await readFile(join(root, 'Renamed/amber.txt'), 'utf8')).toBe('Synthetic amber')
    await apply.click()
    await expect(review.getByRole('heading', { name: 'rename: succeeded' })).toBeVisible({
      timeout: 20_000,
    })
    await review.getByRole('button', { name: 'Close', exact: true }).click()
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
    await expect(review).toHaveCount(0)
    await access(join(root, 'Renamed/gold.txt'))
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
