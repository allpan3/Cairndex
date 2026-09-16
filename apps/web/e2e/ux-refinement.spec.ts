import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

let scratch: string
let backend: Awaited<ReturnType<typeof startBackend>>
let bundleId: string
let base: string
const folderName = 'ObservatoryFieldNotesAndReferenceImagesWithoutSpacesForNarrowWindowVerification'
const longTitle =
  'Observatory study with a deliberately long descriptive title for a narrow inspector'

// Every case uses invented metadata and generated image bytes on an isolated server
test.beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'cairndex-ux-'))
  backend = await startBackend(join(scratch, 'server'), {
    UV_NO_SYNC: '1',
    UV_CACHE_DIR: join(scratch, 'uv'),
  })
  const root = join(scratch, 'library')
  const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/create', {
    root_path: root,
    display_name: 'Observatory studies',
    create_if_missing: true,
  })
  base = `/api/v1/libraries/${library.id}`
  await mkdir(join(root, folderName))
  await fetch(`${backend.baseUrl}${base}/write-mode`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  })
  execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from PIL import Image; from pathlib import Path; import sys; p=Path(sys.argv[1]); Image.new("RGB", (320,180), "steelblue").save(p/"Study.png"); Image.new("RGB", (320,180), "orange").save(p/"Horizon.png")',
      join(root, folderName),
    ],
    {
      cwd: fileURLToPath(new URL('../../server/', import.meta.url)),
      env: { ...process.env, UV_NO_SYNC: '1' },
    },
  )
  const result = await apiPost<{ bundle_id: string }>(
    backend.baseUrl,
    `${base}/manual-bundling/create-bundle`,
    {
      relative_paths: [`${folderName}/Study.png`],
      title: longTitle,
    },
  )
  bundleId = result.bundle_id
  await apiPost(backend.baseUrl, `${base}/manual-bundling/create-bundle`, {
    relative_paths: [`${folderName}/Horizon.png`],
    title: 'Amber horizon',
  })
})

test.afterAll(async () => {
  if (backend) await stopBackend(backend.child)
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

// Open the real client at a constrained size, optionally with oversized saved panels
async function open(page: Page, width = 960, widePanels = false) {
  await page.setViewportSize({ width, height: 640 })
  if (widePanels)
    await page.addInitScript(() => {
      localStorage.setItem('cairndex.sidebarW', '400')
      localStorage.setItem('cairndex.inspectorW', '480')
    })
  await proxyApi(page, backend.baseUrl)
  await page.goto('/')
  await expect(page.getByRole('option', { name: new RegExp(longTitle) })).toBeVisible()
}

// Assert painted bounds, not just DOM visibility, for controls that used to be clipped
async function toolbarFits(page: Page) {
  const bar = page.locator('.center .toolbar').first()
  expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  for (const name of ['View options', 'Toggle Inspector', 'Sort']) {
    const control = page.getByRole('button', { name, exact: true })
    await expect(control).toBeInViewport({ ratio: 1 })
  }
}

for (const width of [800, 960, 1200]) {
  test(`keeps narrow controls reachable at ${width}px and restores saved panel widths`, async ({
    page,
  }) => {
    await open(page, width, true)
    await toolbarFits(page)
    await page.getByRole('option', { name: new RegExp(longTitle) }).click()
    const selected = page.getByRole('option', { name: new RegExp(longTitle) })
    await page.getByRole('button', { name: 'View options', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'View options' })
    await dialog.getByRole('combobox', { name: 'Layout', exact: true }).selectOption('list')
    await dialog.getByLabel('Item size').focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: 'View options', exact: true })).toBeFocused()
    await expect(selected).toHaveAttribute('aria-selected', 'true')
    const name = selected.locator('.list-row__title')
    expect(await name.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(
      180,
    )
    await expect(name).toBeInViewport({ ratio: 1 })
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect
      .poll(() => page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width))
      .toBe(400)
    await expect
      .poll(() => page.locator('.inspector').evaluate((el) => el.getBoundingClientRect().width))
      .toBe(480)
    expect(
      await page.evaluate(() => [
        localStorage.getItem('cairndex.sidebarW'),
        localStorage.getItem('cairndex.inspectorW'),
      ]),
    ).toEqual(['400', '480'])
  })
}

test('file facts, actions, optional details and narrow view controls remain accessible', async ({
  page,
}) => {
  await open(page)
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await page.getByRole('row', { name: new RegExp(folderName) }).dblclick()
  await page.getByRole('row', { name: /Study.png/ }).click()
  await toolbarFits(page)
  const filename = page.getByRole('row', { name: /Study.png/ }).locator('.file-row__name')
  expect(await filename.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(
    180,
  )
  await expect(filename).toBeInViewport({ ratio: 1 })
  const inspector = page.locator('.inspector')
  await expect(inspector.getByRole('button', { name: 'Locate in Bundle Browser' })).toBeInViewport({
    ratio: 1,
  })
  const details = inspector.locator('summary', { hasText: 'More details' })
  await details.focus()
  await page.keyboard.press('Enter')
  await expect(inspector.getByText('Path', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'View options', exact: true }).click()
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Add Files Here' }),
  ).toBeVisible()
  await page
    .getByRole('dialog')
    .getByRole('combobox', { name: 'Layout', exact: true })
    .selectOption('grid')
  await page.keyboard.press('Escape')
  await expect(inspector.locator('.inspector__title')).toHaveText('Study.png')
  expect(await inspector.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
})

test('help is keyboard reachable, traps focus, and returns to its opener without changing selection', async ({
  page,
}) => {
  await open(page)
  await page.getByRole('option', { name: new RegExp(longTitle) }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click()
  const reference = page.getByRole('region', { name: 'Keyboard shortcuts' })
  await expect(reference.getByText('Space / K')).toBeVisible()
  await reference.focus()
  await page.keyboard.press('End')
  await expect(reference.getByText('Playback · Next File')).toBeInViewport()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
  await expect(page.getByRole('option', { name: new RegExp(longTitle) })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const title = page.getByRole('textbox', { name: 'Title', exact: true })
  await title.focus()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('ArrowLeft')
  await expect(title).toHaveValue(longTitle)
  await expect(
    page.getByRole('listbox', { name: 'Bundles' }).getByRole('option', { selected: true }),
  ).toHaveCount(1)
})

test('single, multiple, empty, loading and failed inspector states retain usable controls', async ({
  page,
}) => {
  await open(page)
  await expect(page.getByText('Select a bundle or collection to see its details.')).toBeVisible()
  await page.getByRole('option', { name: /Amber horizon/ }).click()
  await page
    .getByRole('option', { name: new RegExp(longTitle) })
    .click({ modifiers: ['ControlOrMeta'] })
  await expect(page.getByText('2 bundles selected')).toBeVisible()
  await expect(
    page.locator('.inspector').getByRole('button', { name: '+ Collection', exact: true }),
  ).toBeInViewport()
  await page.locator('.inspector').getByRole('button', { name: 'Clear', exact: true }).click()
  let release: () => void = () => undefined
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**${base}/bundles/${bundleId}/files`, async (route) => {
    await pending
    await route.fulfill({ status: 503, json: { detail: 'Synthetic unavailable response' } })
  })
  await page.getByRole('option', { name: new RegExp(longTitle) }).click()
  await expect(
    page.locator('.inspector').getByText('Loading…', { exact: true }).first(),
  ).toBeVisible()
  release()
  await expect(
    page.locator('.inspector').getByRole('button', { name: /Retry/ }).first(),
  ).toBeVisible({ timeout: 20000 })
  await page.unroute(`**${base}/bundles/${bundleId}/files`)
  await page.locator('.inspector').getByRole('button', { name: /Retry/ }).first().click()
  await expect(page.locator('.inspector').getByText('Study.png', { exact: true })).toBeVisible()
})
