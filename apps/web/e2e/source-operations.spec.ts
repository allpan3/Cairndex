import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test('portable source reviews retain lost replies, collisions and Undo @fullstack', async ({
  page,
}) => {
  test.setTimeout(150_000)
  page.setDefaultTimeout(20_000)
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'cairndex-source-browser-')))
  const root = join(scratch, 'Library')
  await mkdir(root)
  await writeFile(join(root, 'amber.txt'), 'Synthetic amber')
  await writeFile(join(root, 'blue.txt'), 'Synthetic blue')
  const backend = await startBackend(join(scratch, 'private'), { CAIRNDEX_WORKER_ENABLED: 'true' })
  try {
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    await page.getByLabel('Library path').fill(root)
    await page.getByRole('button', { name: 'Add library', exact: true }).click()
    await page.getByLabel('Library name').fill('Synthetic source operations')
    await page.getByRole('button', { name: 'Create library', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Library', exact: true })).toContainText(
      'Synthetic source operations',
    )
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    await page.getByRole('row').filter({ hasText: 'amber.txt' }).click()
    await page.getByRole('button', { name: 'Copy, Rename and Move', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'File operations and recovery' })
    await dialog.getByRole('button', { name: 'Enable file operations', exact: true }).click()
    await dialog.getByRole('button', { name: 'Copy selected file', exact: true }).click()
    await dialog.getByLabel('Destination path', { exact: true }).fill('copied.txt')
    let lost = false
    let operation = ''
    await page.route('**/source-operations', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      const request = route.request().postDataJSON() as { operation: string }
      operation = request.operation
      if (lost) return route.fallback()
      lost = true
      const url = new URL(route.request().url())
      await apiPost(backend.baseUrl, url.pathname, request)
      await route.abort('connectionclosed')
    })
    await dialog.getByRole('button', { name: 'Prepare operation', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText(/fetch|network/i)
    await page.reload()
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    await page.getByRole('button', { name: 'Copy, Rename and Move', exact: true }).click()
    await expect(dialog.getByLabel('Destination path', { exact: true })).toHaveValue('copied.txt')
    const firstOperation = operation
    await dialog.getByRole('button', { name: 'Prepare operation', exact: true }).click()
    expect(operation).toBe(firstOperation)
    await dialog.getByRole('button', { name: 'Apply reviewed operation', exact: true }).click()
    await expect(
      dialog.getByText('Saved here. Delivery to other copies is not confirmed.'),
    ).toBeVisible()
    expect(await readFile(join(root, 'copied.txt'), 'utf8')).toBe('Synthetic amber')
    await dialog.getByRole('button', { name: 'Undo copy', exact: true }).click()
    await dialog.getByRole('button', { name: 'Apply reviewed operation', exact: true }).click()
    await expect(
      dialog.getByRole('heading', { name: 'undo: succeeded', exact: true }),
    ).toBeVisible()
    await expect
      .poll(() =>
        readFile(join(root, 'copied.txt')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('row').filter({ hasText: 'amber.txt' }).click()
    await page.getByRole('button', { name: 'Copy, Rename and Move', exact: true }).click()
    await dialog.getByRole('button', { name: 'Copy selected file', exact: true }).click()
    await dialog.getByLabel('Destination path', { exact: true }).fill('blue.txt')
    await dialog.getByRole('button', { name: 'Prepare operation', exact: true }).click()
    await dialog.getByRole('button', { name: 'Replace', exact: true }).click()
    await dialog.getByRole('button', { name: 'Prepare operation', exact: true }).click()
    await dialog.getByRole('button', { name: 'Apply reviewed operation', exact: true }).click()
    await expect(
      dialog.getByRole('heading', { name: 'copy: succeeded', exact: true }),
    ).toBeVisible()
    expect(await readFile(join(root, 'blue.txt'), 'utf8')).toBe('Synthetic amber')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Trash and Undo', exact: true }).click()
    await dialog.press('Escape')
    await expect(dialog).toBeHidden()
  } catch (error) {
    console.error(await page.locator('body').innerText())
    throw error
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})

test('portable folder recovery and picker Copy use normal reviews @fullstack', async ({ page }) => {
  test.setTimeout(150_000)
  page.setDefaultTimeout(20_000)
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'cairndex-source-folder-browser-')))
  const root = join(scratch, 'Library')
  await mkdir(join(root, 'Folder', 'Empty'), { recursive: true })
  await writeFile(join(root, 'Folder', 'example.txt'), 'Synthetic folder bytes')
  const backend = await startBackend(join(scratch, 'private'), { CAIRNDEX_WORKER_ENABLED: 'true' })
  try {
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    await page.getByLabel('Library path').fill(root)
    await page.getByRole('button', { name: 'Add library', exact: true }).click()
    await page.getByLabel('Library name').fill('Synthetic folder operations')
    await page.getByRole('button', { name: 'Create library', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Library', exact: true })).toContainText(
      'Synthetic folder operations',
    )
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    await page.getByRole('row').filter({ hasText: 'Folder' }).click()
    await page.getByRole('button', { name: 'Copy, Rename and Move', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'File operations and recovery' })
    async function apply(action: string) {
      await dialog.getByRole('button', { name: 'Prepare operation', exact: true }).click()
      await dialog.getByRole('button', { name: 'Apply reviewed operation', exact: true }).click()
      await expect(
        dialog.getByRole('heading', { name: `${action}: succeeded`, exact: true }),
      ).toBeVisible()
    }
    await dialog.getByRole('button', { name: 'Enable file operations', exact: true }).click()
    await dialog.getByRole('button', { name: 'Rename', exact: true }).click()
    await dialog.getByLabel('Destination path', { exact: true }).fill('Renamed')
    await apply('rename')
    expect(await readFile(join(root, 'Renamed', 'example.txt'), 'utf8')).toBe(
      'Synthetic folder bytes',
    )
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('row').filter({ hasText: 'Renamed' }).click()
    await page.getByRole('button', { name: 'Trash and Undo', exact: true }).click()
    await dialog.getByRole('button', { name: 'Move to Trash', exact: true }).click()
    await apply('trash')
    await dialog.getByRole('button', { name: 'Undo trash', exact: true }).click()
    await dialog.getByRole('button', { name: 'Apply reviewed operation', exact: true }).click()
    await expect(
      dialog.getByRole('heading', { name: 'undo: succeeded', exact: true }),
    ).toBeVisible()
    expect(await readFile(join(root, 'Renamed', 'example.txt'), 'utf8')).toBe(
      'Synthetic folder bytes',
    )
    await dialog.locator('input[type=file]').setInputFiles({
      name: 'picked.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Synthetic picked bytes'),
    })
    await dialog.getByRole('button', { name: 'Apply reviewed operation', exact: true }).click()
    await expect(
      dialog.getByRole('heading', { name: 'copy: succeeded', exact: true }),
    ).toBeVisible()
    expect(await readFile(join(root, 'picked.txt'), 'utf8')).toBe('Synthetic picked bytes')
    await page.screenshot({ path: '/tmp/cairndex-source-operations-synthetic.png' })
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
