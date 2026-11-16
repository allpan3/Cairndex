import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test.use({ actionTimeout: 15_000 })

const TOTAL = 450
const name = (index: number) => `clip-${String(index).padStart(3, '0')}.mp4`

// Unbundled is a window over the whole queue: each fetched file is checked on
// disk, so a jump down the list fetches only the page it lands on, and Select All
// reads keys instead of rows.
test('Unbundled fetches the window a jump lands on and Select All takes every file @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-unbundled-window-'))
  const server = fileURLToPath(new URL('../../server/', import.meta.url))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      `
from pathlib import Path
import sys
from cairndex.devtools.discovery_fixture import create_discovery
root=create_discovery(parent=Path(sys.argv[1]))
for index in range(${TOTAL}):
    path=root/'Window'/f'clip-{index:03}.mp4'
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(f'synthetic window clip {index}'.encode())
print(root)
`,
      scratch,
    ],
    { cwd: server, encoding: 'utf8' },
  ).trim()
  const backend = await startBackend(join(scratch, 'private'))
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const base = `/api/v1/libraries/${library.id}/replica`
    const read = async (path: string) => (await fetch(backend.baseUrl + base + path)).json()
    // Which queue pages the browser fetched, and whether Select All read keys
    const offsets: number[] = []
    let keyReads = 0
    page.on('request', (request) => {
      if (request.url().endsWith('/files/unbundled'))
        offsets.push((request.postDataJSON() as { offset: number }).offset)
      if (request.url().endsWith('/files/unbundled/ids')) keyReads += 1
    })
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await expect(page.getByRole('listbox', { name: 'Bundles', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'More library actions', exact: true }).click()
    // The item stays disabled until the window has read the library's scan state,
    // which can take longer than a click's own wait on a loaded runner
    const scan = page.getByRole('menuitem', { name: 'Scan new files', exact: true })
    await expect(scan).toBeEnabled({ timeout: 60_000 })
    await scan.click()
    await expect
      .poll(async () => (await read('/discovery/status')).state, { timeout: 60_000 })
      .toBe('succeeded')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: /^Unbundled( \d+)?$/ }).click()
    await page.getByRole('button', { name: 'List', exact: true }).click()

    const listing = page.getByRole('grid', { name: 'Files' })
    await expect(page.locator('.file-browser .toolbar__count')).toContainText(`${TOTAL} items`)
    await expect(listing).toHaveAttribute('aria-rowcount', String(TOTAL + 1))
    await expect(listing.locator(`[data-relpath="Window/${name(0)}"]`)).toBeVisible()
    await expect.poll(() => Math.max(...offsets)).toBe(100)
    expect(await listing.locator('[data-relpath]').count()).toBeLessThan(100)

    // Dragging the scrollbar to the end lands on the last page without the ones between
    await listing.evaluate((element) => (element.scrollTop = element.scrollHeight))
    await expect(listing.locator(`[data-relpath="Window/${name(TOTAL - 1)}"]`)).toBeVisible()
    expect(offsets).toContain(400)
    expect(offsets).not.toContain(200)
    expect(offsets).not.toContain(300)

    // Select All takes every queued file, reading keys for the pages never fetched
    await listing.locator(`[data-relpath="Window/${name(TOTAL - 1)}"]`).click()
    await page.keyboard.press('ControlOrMeta+A')
    await expect(page.locator('.file-browser .toolbar__count')).toContainText(`${TOTAL} selected`)
    expect(keyReads).toBeGreaterThan(0)
    expect(offsets).not.toContain(200)
    expect(offsets).not.toContain(300)

    // The middle of the list fetches the page it lands on, and its rows show selected
    await listing.evaluate((element) => (element.scrollTop = element.scrollHeight / 2))
    await expect(listing.locator(`[data-relpath="Window/${name(225)}"]`)).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(offsets).toContain(200)
    await page.screenshot({ path: test.info().outputPath('synthetic-unbundled-window.png') })

    // Bundling takes 1 to 100 files per step, so the menu says why it is unavailable
    await listing.locator(`[data-relpath="Window/${name(225)}"]`).click({ button: 'right' })
    const create = page.getByRole('menuitem', {
      name: new RegExp(`Create Bundle from ${TOTAL} Files`),
    })
    await expect(create).toBeDisabled()
    await expect(create).toContainText('Select up to 100 files to bundle them.')
    await page.keyboard.press('Escape')

    // Keyboard End moves to the last row even when it is not drawn yet
    await listing.locator(`[data-relpath="Window/${name(225)}"]`).click()
    await page.keyboard.press('End')
    await expect(listing.locator(`[data-relpath="Window/${name(TOTAL - 1)}"]`)).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await page.keyboard.press('Home')
    await expect(listing.locator(`[data-relpath="Window/${name(0)}"]`)).toHaveAttribute(
      'aria-selected',
      'true',
    )
  } finally {
    await context.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
