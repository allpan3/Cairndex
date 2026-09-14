import { expect, test, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

// Persisted identity and membership, read independently of the UI cache
interface CatalogFile {
  id: string
  bundle_id: string
  relative_path: string
  availability: string
}

// Journal outcomes distinguish a skipped upload from a physical copy
interface Receipt {
  id: string
  op: string
  status: string
  payload: { destination?: string; skipped?: boolean; replaced_operation_id?: string }
}

// Each case owns synthetic image bytes, a registry and one writable library
async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-copy-imports-'))
  const root = join(scratch, 'library')
  const backend = await startBackend(join(scratch, 'server'), {
    UV_CACHE_DIR: join(scratch, 'uv-cache'),
    UV_NO_SYNC: '1',
  })
  const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/create', {
    root_path: root,
    display_name: 'Copy verification',
    create_if_missing: true,
  })
  const base = `${backend.baseUrl}/api/v1/libraries/${library.id}`
  expect(
    (
      await fetch(`${base}/write-mode`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
    ).ok,
  ).toBe(true)
  await mkdir(join(root, 'Source'))
  await mkdir(join(root, 'Destination'))
  execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from PIL import Image; from pathlib import Path; import sys; p=Path(sys.argv[1]); Image.new("RGB", (8,8), "orange").save(p/"Amber.png"); Image.new("RGB", (8,8), "blue").save(p/"Blue.png")',
      join(root, 'Source'),
    ],
    { cwd: fileURLToPath(new URL('../../server/', import.meta.url)) },
  )
  const source = await apiPost<{ bundle_id: string }>(base, '/manual-bundling/create-bundle', {
    relative_paths: ['Source/Amber.png', 'Source/Blue.png'],
    title: 'Source bundle',
  })
  const target = await apiPost<{ id: string }>(base, '/bundles', { title: 'Target bundle' })
  const paths = ['Amber.png', 'Blue.png'].map((name) => join(root, 'Source', name))
  return {
    ...backend,
    base,
    library,
    root,
    source,
    target,
    paths,
    cleanup: async () => {
      await stopBackend(backend.child)
      await rm(scratch, { recursive: true, force: true })
    },
  }
}

// Query committed SQLite state without borrowing the app's selected library
function catalog(root: string): CatalogFile[] {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        'import sqlite3,json,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); c.row_factory=sqlite3.Row; print(json.dumps([dict(r) for r in c.execute("select id,bundle_id,relative_path,availability from asset_files order by relative_path")]))',
        join(root, '.cairndex', 'library.db'),
      ],
      { encoding: 'utf8' },
    ),
  ) as CatalogFile[]
}

// Load actual journal receipts rather than inferring success from a toast
async function receipts(base: string): Promise<Receipt[]> {
  const response = await fetch(`${base}/file-ops`)
  expect(response.ok).toBe(true)
  return ((await response.json()) as { items: Receipt[] }).items
}

// Use the production picker entry point to exercise browser File uploads
async function pick(page: Page, paths: string[]) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Add Files Here' }).click()
  await (await chooser).setFiles(paths)
}

// Open a real directory in the shipping File Browser
async function openFolder(page: Page, f: Awaited<ReturnType<typeof fixture>>, folder: string) {
  await proxyApi(page, f.baseUrl)
  await page.goto('/')
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await page.locator('.file-browser__body').getByText(folder, { exact: true }).dblclick()
  await expect(page.getByRole('button', { name: 'Add Files Here' })).toBeVisible()
}

// Synthetic HTML events qualify shared routing only, never OS drag delivery
async function htmlDrop(target: Locator, paths: string[]) {
  const files = await Promise.all(
    paths.map(async (path) => ({
      name: basename(path),
      bytes: [...(await readFile(path))],
    })),
  )
  await target.evaluate((element, files) => {
    const transfer = new DataTransfer()
    files.forEach(({ name, bytes }) =>
      transfer.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/png' })),
    )
    for (const type of ['dragover', 'drop'])
      element.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
      )
  }, files)
}

test('same-library folder copies keep independent identities and journal Undo @fullstack', async ({
  page,
}) => {
  const f = await fixture()
  try {
    const original = catalog(f.root)
    await openFolder(page, f, 'Destination')
    await pick(page, f.paths)
    await expect
      .poll(
        async () =>
          (await receipts(f.base)).filter((r) => r.op === 'import' && r.status === 'done').length,
      )
      .toBe(2)
    for (const source of f.paths)
      expect(await readFile(join(f.root, 'Destination', basename(source)))).toEqual(
        await readFile(source),
      )
    await apiPost(f.base, '/manual-bundling/add-files', {
      target_bundle_id: f.target.id,
      relative_paths: ['Destination/Amber.png', 'Destination/Blue.png'],
    })
    const copied = catalog(f.root).filter((file) => file.bundle_id === f.target.id)
    expect(copied).toHaveLength(2)
    expect(copied.every((file) => !original.some((source) => source.id === file.id))).toBe(true)
    expect(catalog(f.root).filter((file) => file.bundle_id === f.source.bundle_id)).toEqual(
      original,
    )
    await page.reload()
    await expect(
      page.locator('.file-browser__body').getByText('Amber.png', { exact: true }),
    ).toBeVisible()
    const receipt = (await receipts(f.base)).find(
      (r) => r.payload.destination === 'Destination/Amber.png',
    )!
    await apiPost(f.base, `/file-ops/${receipt.id}/undo`)
    await page.reload()
    await expect(
      page.locator('.file-browser__body').getByText('Amber.png', { exact: true }),
    ).toHaveCount(0)
    expect(await readdir(join(f.root, 'Destination'))).toEqual(['Blue.png'])
    expect((await receipts(f.base)).find((r) => r.id === receipt.id)?.status).toBe('undone')
    expect(catalog(f.root).filter((file) => file.bundle_id === f.source.bundle_id)).toEqual(
      original,
    )
  } finally {
    await f.cleanup()
  }
})

for (const choice of ['Skip', 'Keep both', 'Replace'] as const)
  test(`same-directory File Browser ${choice} preserves its exact identity/Undo contract @fullstack`, async ({
    page,
  }) => {
    const f = await fixture()
    try {
      const original = catalog(f.root)
      const bytes = await readFile(f.paths[0]!)
      await openFolder(page, f, 'Source')
      await pick(page, [f.paths[0]!])
      const conflict = page.getByRole('dialog', { name: 'Name already in use' })
      await expect(conflict).toBeVisible()
      expect(catalog(f.root)).toEqual(original)
      expect(await readFile(f.paths[0]!)).toEqual(bytes)
      await conflict.getByRole('button', { name: choice, exact: true }).click()
      await expect
        .poll(
          async () =>
            (await receipts(f.base)).filter((r) => r.op === 'import' && r.status === 'done').length,
        )
        .toBe(1)
      const receipt = (await receipts(f.base)).find((r) => r.op === 'import')!
      expect(receipt.status).toBe('done')
      if (choice === 'Skip') {
        expect(receipt.payload.skipped).toBe(true)
        expect(catalog(f.root)).toEqual(original)
        expect(await readdir(join(f.root, 'Source'))).toEqual(['Amber.png', 'Blue.png'])
      } else {
        const destination = choice === 'Keep both' ? 'Source/Amber (2).png' : 'Source/Amber.png'
        expect(await readFile(join(f.root, destination))).toEqual(bytes)
        await apiPost(f.base, '/manual-bundling/add-files', {
          target_bundle_id: f.target.id,
          relative_paths: [destination],
        })
        const copy = catalog(f.root).find((file) => file.relative_path === destination)!
        expect(copy.bundle_id).toBe(f.target.id)
        expect(original.some((file) => file.id === copy.id)).toBe(false)
        if (choice === 'Replace') {
          const source = catalog(f.root).find((file) => file.id === original[0]!.id)!
          expect(source.availability.toLowerCase()).toBe('trashed')
          expect(source.relative_path).toContain('.cairndex/trash/')
        }
        await apiPost(f.base, `/file-ops/${receipt.id}/undo`)
        expect(catalog(f.root).filter((file) => file.bundle_id === f.source.bundle_id)).toEqual(
          original,
        )
      }
      expect(await readFile(f.paths[0]!)).toEqual(bytes)
    } finally {
      await f.cleanup()
    }
  })

for (const surface of ['card', 'inspector'] as const)
  test(`bundle ${surface} copies same-library files with Keep Both and links fresh identities @fullstack`, async ({
    page,
  }) => {
    const f = await fixture()
    try {
      const original = catalog(f.root)
      await proxyApi(page, f.baseUrl)
      await page.goto('/')
      const card = page.locator(`[data-bundle-id="${f.target.id}"]`).first()
      await card.click()
      await htmlDrop(surface === 'card' ? card : page.locator('aside.inspector'), f.paths)
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('heading', { name: 'Copy 2 files into…' })).toBeVisible()
      await dialog.getByRole('button', { name: 'Source', exact: true }).click()
      await dialog.getByRole('button', { name: 'Copy into Source', exact: true }).click()
      await expect
        .poll(() => catalog(f.root).filter((file) => file.bundle_id === f.target.id).length)
        .toBe(2)
      const copied = catalog(f.root).filter((file) => file.bundle_id === f.target.id)
      expect(copied.map((file) => file.relative_path)).toEqual([
        'Source/Amber (2).png',
        'Source/Blue (2).png',
      ])
      expect(copied.every((file) => !original.some((source) => source.id === file.id))).toBe(true)
      expect(catalog(f.root).filter((file) => file.bundle_id === f.source.bundle_id)).toEqual(
        original,
      )
      for (let i = 0; i < f.paths.length; i += 1)
        expect(await readFile(join(f.root, copied[i]!.relative_path))).toEqual(
          await readFile(f.paths[i]!),
        )
      expect(
        (await receipts(f.base)).filter((r) => r.op === 'import' && r.status === 'done'),
      ).toHaveLength(2)
      await page.reload()
      await page.locator(`[data-bundle-id="${f.target.id}"]`).first().click()
      await expect(
        page.locator('aside.inspector').getByText('Amber (2).png', { exact: true }),
      ).toBeVisible()
    } finally {
      await f.cleanup()
    }
  })
