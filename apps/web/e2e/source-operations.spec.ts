import { expect as playwrightExpect, test, type Locator, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

// Opt-in mounted runs exercise asynchronous storage under real network load.
// Match the HTTP acceptance bound; ordinary local assertions keep their budget.
const mounted = Boolean(process.env.CAIRNDEX_SOURCE_TEST_PARENT)
const expect = playwrightExpect.configure({ timeout: mounted ? 90_000 : 20_000 })

async function fixture(prefix: string) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const parent = process.env.CAIRNDEX_SOURCE_TEST_PARENT
  const root = parent
    ? await realpath(await mkdtemp(join(parent, 'cairndex-synthetic-source-browser-')))
    : join(scratch, 'Library')
  await mkdir(root, { recursive: true })
  return { scratch, root }
}

const exists = (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  )

async function createLibrary(page: Page, root: string, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
  await page.getByLabel('Library path').fill(root)
  await page.getByRole('button', { name: 'Add library', exact: true }).click()
  await page.getByLabel('Library name').fill(name)
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/libraries/create' &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Create library', exact: true }).click()
  expect((await created).status()).toBe(201)
  await expect(page.getByRole('combobox', { name: 'Library', exact: true })).toContainText(name)
  // Write mode is switched in Libraries and nowhere else
  await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
  const manager = page.getByRole('dialog', { name: 'Libraries', exact: true })
  const toggle = manager.getByRole('button', { name: `Write mode for ${name}` })
  await toggle.click()
  await manager.getByRole('button', { name: 'Turn on', exact: true }).click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await manager.getByRole('button', { name: 'Close', exact: true }).click()
}

// A real HTML File drop, as the browser delivers one from the desktop
async function drop(target: Locator, files: { name: string; text: string }[]) {
  await target.evaluate((element, list) => {
    const data = new DataTransfer()
    for (const file of list)
      data.items.add(new File([file.text], file.name, { type: 'text/plain' }))
    element.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }),
    )
  }, files)
}

test('dropped files become a bundle, join a bundle or land in a folder @fullstack', async ({
  page,
}) => {
  test.setTimeout(mounted ? 600_000 : 150_000)
  page.setDefaultTimeout(mounted ? 90_000 : 20_000)
  const { scratch, root } = await fixture('cairndex-source-incoming-')
  await mkdir(join(root, 'Trips'), { recursive: true })
  await writeFile(join(root, 'Trips', 'poster.jpg'), 'Synthetic poster')
  const backend = await startBackend(join(scratch, 'private'), { CAIRNDEX_WORKER_ENABLED: 'true' })
  try {
    await proxyApi(page, backend.baseUrl)
    await createLibrary(page, root, 'Synthetic incoming')
    const layout = page.locator('.catalog-ordinary-layout')

    // The Bundle Browser: the files become one new bundle, in the folder chosen
    await drop(layout, [
      { name: 'Harbor at dusk.mp4', text: 'Synthetic video bytes' },
      { name: 'Harbor at dusk.srt', text: 'Synthetic subtitles' },
    ])
    const bundle = page.getByRole('dialog', { name: 'Add 2 files as a new bundle' })
    await expect(bundle.getByLabel('Bundle name')).toHaveValue('Harbor at dusk')
    await bundle.getByRole('button', { name: 'Change…', exact: true }).click()
    await bundle.getByRole('button', { name: 'Trips', exact: true }).click()
    expect(await exists(join(root, 'Trips', 'Harbor at dusk.mp4'))).toBe(false)
    await bundle.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect(bundle).toBeHidden()
    await expect(page.getByText('Created “Harbor at dusk” with 2 files.')).toBeVisible()
    expect(await readFile(join(root, 'Trips', 'Harbor at dusk.srt'), 'utf8')).toBe(
      'Synthetic subtitles',
    )

    // A bundle card: the file joins that bundle, beside its other files
    const card = page.locator('[data-file-drop-bundle]').filter({ hasText: 'Harbor at dusk' })
    await expect(card).toBeVisible()
    await drop(card, [{ name: 'Harbor at dusk.en.srt', text: 'Synthetic English subtitles' }])
    const joining = page.getByRole('dialog', { name: 'Add 1 file to “Harbor at dusk”' })
    await expect(joining.getByRole('button', { name: 'Trips', exact: true })).toHaveAttribute(
      'aria-current',
      'location',
    )
    await joining.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect(page.getByText('Added 1 file to “Harbor at dusk”.')).toBeVisible()
    expect(await exists(join(root, 'Trips', 'Harbor at dusk.en.srt'))).toBe(true)
    // A bundled copy's Undo goes through the Trash; the bundle keeps its other files
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(page.getByText('Moved 1 file to the Trash.')).toBeVisible()
    expect(await exists(join(root, 'Trips', 'Harbor at dusk.en.srt'))).toBe(false)
    expect(await exists(join(root, 'Trips', 'Harbor at dusk.mp4'))).toBe(true)

    // The File Browser: the open folder; an occupied name waits in the sidebar
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    const files = page.getByRole('grid', { name: 'Files', exact: true })
    await files.getByRole('row').filter({ hasText: 'Trips' }).dblclick()
    await expect(files.getByRole('row').filter({ hasText: 'poster.jpg' })).toBeVisible()
    await drop(layout, [{ name: 'poster.jpg', text: 'New poster' }])
    const copy = page.getByRole('dialog', { name: 'Copy 1 file to Trips' })
    await copy.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect(copy).toBeHidden()
    const question = page.getByRole('group', { name: 'poster.jpg' })
    await expect(question).toContainText('“poster.jpg” already exists in Trips.')
    await question.getByRole('button', { name: 'Keep Both', exact: true }).click()
    await expect(page.getByText('Copied 1 file to Trips.')).toBeVisible()
    expect(await readFile(join(root, 'Trips', 'poster.jpg'), 'utf8')).toBe('Synthetic poster')
    expect(await readFile(join(root, 'Trips', 'poster (2).jpg'), 'utf8')).toBe('New poster')
    // Undo removes the copy and nothing else
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(page.getByText('Undone.')).toBeVisible()
    await expect.poll(() => exists(join(root, 'Trips', 'poster (2).jpg'))).toBe(false)
    expect(await exists(join(root, 'Trips', 'poster.jpg'))).toBe(true)
    await page.screenshot({ path: '/tmp/cairndex-source-operations-synthetic.png' })
  } catch (error) {
    console.error(await page.locator('body').innerText())
    throw error
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})

test('library files copy, move, trash and come back as single actions @fullstack', async ({
  page,
}) => {
  test.setTimeout(mounted ? 600_000 : 150_000)
  page.setDefaultTimeout(mounted ? 90_000 : 20_000)
  const { scratch, root } = await fixture('cairndex-source-actions-')
  await mkdir(join(root, 'Drafts'), { recursive: true })
  await mkdir(join(root, 'Archive'), { recursive: true })
  await writeFile(join(root, 'Drafts', 'example.txt'), 'Synthetic example')
  const backend = await startBackend(join(scratch, 'private'), { CAIRNDEX_WORKER_ENABLED: 'true' })
  try {
    await proxyApi(page, backend.baseUrl)
    await createLibrary(page, root, 'Synthetic actions')
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    const files = page.getByRole('grid', { name: 'Files', exact: true })
    await files.getByRole('row').filter({ hasText: 'Drafts' }).dblclick()
    const example = files.getByRole('row').filter({ hasText: 'example.txt' })

    // A lost reply repeats the same operation; Try Again makes no second one
    let lost = false
    const operations: string[] = []
    await page.route('**/source-operations', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      const request = route.request().postDataJSON() as { operation: string }
      operations.push(request.operation)
      if (lost) return route.fallback()
      lost = true
      await apiPost(backend.baseUrl, new URL(route.request().url()).pathname, request)
      await route.abort('connectionclosed')
    })
    await example.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy to…', exact: true }).click()
    const copyTo = page.getByRole('dialog', { name: /^Copy “example\.txt” to/ })
    await copyTo.getByRole('button', { name: 'Library', exact: true }).click()
    await copyTo.getByRole('button', { name: 'Archive', exact: true }).click()
    await copyTo.getByRole('button', { name: 'Copy', exact: true }).click()
    await page.getByRole('button', { name: 'Try Again', exact: true }).click()
    await expect(page.getByText('Copied “example.txt” to Archive.')).toBeVisible()
    expect(operations).toHaveLength(2)
    expect(operations[1]).toBe(operations[0])
    expect(await readFile(join(root, 'Archive', 'example.txt'), 'utf8')).toBe('Synthetic example')
    await page.unroute('**/source-operations')

    // Move to…, then its Undo
    await example.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click()
    const moveTo = page.getByRole('dialog', { name: /^Move “example\.txt” to/ })
    await expect(moveTo.getByRole('button', { name: 'Move', exact: true })).toBeDisabled()
    await moveTo.getByRole('button', { name: 'Library', exact: true }).click()
    await moveTo.getByRole('button', { name: 'Move', exact: true }).click()
    await expect(page.getByText('Moved “example.txt” to Library.')).toBeVisible()
    expect(await readFile(join(root, 'example.txt'), 'utf8')).toBe('Synthetic example')
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(page.getByText('Undone.')).toBeVisible()
    await expect.poll(() => exists(join(root, 'Drafts', 'example.txt'))).toBe(true)

    // Move to Trash, then Put Back from the sidebar's Trash
    await example.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to Trash', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Move “example.txt” to the Trash?' })
      .getByRole('button', { name: 'Move to Trash', exact: true })
      .click()
    await expect(page.getByText('Moved “example.txt” to the Trash.')).toBeVisible()
    await expect.poll(() => exists(join(root, 'Drafts', 'example.txt'))).toBe(false)
    await page.getByRole('button', { name: 'Trash', exact: true }).click()
    const trash = page.getByRole('list', { name: 'Trash', exact: true })
    await expect(trash).toContainText('example.txt')
    await expect(trash).toContainText('From Drafts')
    await trash.getByRole('button', { name: 'Put Back', exact: true }).click()
    await expect(page.getByText('Put back “example.txt” in Drafts.')).toBeVisible()
    await expect.poll(() => exists(join(root, 'Drafts', 'example.txt'))).toBe(true)
    await expect(page.getByText('The Trash is empty.')).toBeVisible()
  } catch (error) {
    console.error(await page.locator('body').innerText())
    throw error
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})

test('New Folder creates in the current folder and Undo preserves later files @fullstack', async ({
  page,
}) => {
  test.setTimeout(150_000)
  const { scratch, root } = await fixture('cairndex-source-mkdir-')
  await mkdir(join(root, 'Parent'))
  const backend = await startBackend(join(scratch, 'private'), { CAIRNDEX_WORKER_ENABLED: 'true' })
  try {
    await proxyApi(page, backend.baseUrl)
    await createLibrary(page, root, 'Synthetic folders')
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    const files = page.getByRole('grid', { name: 'Files', exact: true })
    await files.getByRole('row').filter({ hasText: 'Parent' }).dblclick()
    await page.getByRole('button', { name: 'New Folder', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'New Folder', exact: true })).toHaveCount(0)
    const name = files.getByRole('textbox', { name: 'New folder name' })
    await expect(name).toHaveValue('Untitled')
    await expect(name).toBeFocused()
    expect(
      await name.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]),
    ).toEqual([0, 8])
    await page.screenshot({ path: test.info().outputPath('synthetic-inline-folder.png') })
    await name.press('Escape')
    await expect(name).toHaveCount(0)
    expect(await readdir(join(root, 'Parent'))).toEqual([])
    await files.click({ button: 'right', position: { x: 20, y: 20 } })
    await page.getByRole('menuitem', { name: 'New Folder', exact: true }).click()
    await expect(name).toBeFocused()
    await name.fill('../escape')
    await name.press('Enter')
    await expect(name).toBeVisible()
    await expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(await readdir(join(root, 'Parent'))).toEqual([])
    await name.fill('Child')
    await expect(files.getByRole('row').filter({ hasText: 'Child' })).toHaveCount(0)
    await name.press('Enter')
    await expect(name).toHaveCount(0)
    await expect(page.getByText('Created folder “Child”.')).toBeVisible()
    await expect(files.getByRole('row').filter({ hasText: 'Child' })).toBeVisible()
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(page.getByText('Undone.')).toBeVisible()
    await expect(files.getByRole('row').filter({ hasText: 'Child' })).toHaveCount(0)
    await files.click({ button: 'right', position: { x: 20, y: 20 } })
    await page.getByRole('menuitem', { name: 'New Folder', exact: true }).click()
    await name.fill('Kept')
    // Clicking outside confirms once, just like inline Rename.
    await files.click({ position: { x: 20, y: 70 } })
    await expect(page.getByText('Created folder “Kept”.')).toBeVisible()
    await writeFile(join(root, 'Parent', 'Kept', 'later.txt'), 'Synthetic later work')
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(
      page.getByText('Later source bytes differ; Undo will not overwrite them'),
    ).toBeVisible()
    expect(await readFile(join(root, 'Parent', 'Kept', 'later.txt'), 'utf8')).toBe(
      'Synthetic later work',
    )
    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Libraries', exact: true })
    await manager.getByRole('button', { name: 'Write mode for Synthetic folders' }).click()
    await manager.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByRole('button', { name: 'New Folder', exact: true })).toHaveCount(0)
  } finally {
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
