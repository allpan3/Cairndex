import { expect, test, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
  let backendOutput = ''
  backend.child.stdout.on('data', (chunk: Buffer) => {
    backendOutput += chunk.toString()
  })
  backend.child.stderr.on('data', (chunk: Buffer) => {
    backendOutput += chunk.toString()
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
      await writeFile(test.info().outputPath('backend.log'), backendOutput)
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
  return ((await response.json()) as { operations: Receipt[] }).operations
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
  await browseFolder(page, folder)
}

// Re-enter the directory after startup resets the workspace to Bundles
async function browseFolder(page: Page, folder: string) {
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
    await browseFolder(page, 'Destination')
    await expect(
      page.locator('.file-browser__body').getByText('Amber.png', { exact: true }),
    ).toBeVisible()
    const receipt = (await receipts(f.base)).find(
      (r) => r.payload.destination === 'Destination/Amber.png',
    )!
    await apiPost(f.base, `/file-ops/${receipt.id}/undo`)
    await page.reload()
    await browseFolder(page, 'Destination')
    await expect(
      page.locator('.file-browser__body').getByText('Amber.png', { exact: true }),
    ).toHaveCount(0)
    expect(await readdir(join(f.root, 'Destination'))).toEqual(['Blue.png'])
    expect((await receipts(f.base)).find((r) => r.id === receipt.id)?.status).toBe('undone')
    expect(catalog(f.root).filter((file) => file.bundle_id === f.source.bundle_id)).toEqual(
      original,
    )
  } finally {
    await page.close()
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
        if (choice === 'Keep both') {
          await apiPost(f.base, '/manual-bundling/add-files', {
            target_bundle_id: f.target.id,
            relative_paths: [destination],
          })
          const copy = catalog(f.root).find((file) => file.relative_path === destination)!
          expect(copy.bundle_id).toBe(f.target.id)
          expect(original.some((file) => file.id === copy.id)).toBe(false)
        } else {
          expect(catalog(f.root)).toEqual(original)
        }
        await apiPost(f.base, `/file-ops/${receipt.id}/undo`)
        expect(catalog(f.root).filter((file) => file.bundle_id === f.source.bundle_id)).toEqual(
          original,
        )
      }
      expect(await readFile(f.paths[0]!)).toEqual(bytes)
    } finally {
      await page.close()
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
      await dialog
        .getByRole('list')
        .getByRole('button', { name: /Source$/ })
        .click()
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
      await page.close()
      await f.cleanup()
    }
  })

// Different bytes replace the destination's media while its visible bundle metadata stays put
test('Replace and toast Undo retain metadata and refresh the cover @fullstack', async ({
  page,
}) => {
  const f = await fixture()
  try {
    const original = catalog(f.root)
    const destination = original.find((file) => file.relative_path === 'Source/Amber.png')!
    const detailUrl = `${f.base}/bundles/${f.source.bundle_id}`
    const detail = (await (await fetch(detailUrl)).json()) as { version: number }
    const basis = (await (await fetch(`${f.base}/metadata`)).json()) as { basis: string }
    expect(
      (
        await fetch(detailUrl, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-Cairndex-Basis': basis.basis,
            'X-Cairndex-Operation': crypto.randomUUID(),
          },
          body: JSON.stringify({
            version: detail.version,
            notes: ['Destination annotation'],
            rating: 4.5,
            cover_file_id: destination.id,
          }),
        })
      ).ok,
    ).toBe(true)
    const thumbnailUrl = `${detailUrl}/thumbnail`
    const before = Buffer.from(await (await fetch(thumbnailUrl)).arrayBuffer())
    await openFolder(page, f, 'Source')
    const picker = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add Files Here' }).click()
    await (
      await picker
    ).setFiles({ name: 'Amber.png', mimeType: 'image/png', buffer: await readFile(f.paths[1]!) })
    await page
      .getByRole('dialog', { name: 'Name already in use' })
      .getByRole('button', { name: 'Replace', exact: true })
      .click()
    await expect
      .poll(
        async () =>
          (await receipts(f.base)).filter((r) => r.op === 'import' && r.status === 'done').length,
      )
      .toBe(1)
    expect(catalog(f.root)).toEqual(original)
    expect(await readFile(f.paths[0]!)).toEqual(await readFile(f.paths[1]!))
    const after = Buffer.from(await (await fetch(thumbnailUrl)).arrayBuffer())
    expect(after.equals(before)).toBe(false)
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await receipts(f.base)).filter((r) => r.op === 'import' && r.status === 'undone').length,
      )
      .toBe(1)
    expect(catalog(f.root)).toEqual(original)
    expect(Buffer.from(await (await fetch(thumbnailUrl)).arrayBuffer()).equals(before)).toBe(true)
    await page.reload()
    await page.locator(`[data-bundle-id="${f.source.bundle_id}"]`).first().click()
    await expect(
      page.locator('aside.inspector').getByText('Destination annotation', { exact: true }),
    ).toBeVisible()
    const restored = (await (await fetch(detailUrl)).json()) as {
      rating: number
      cover_file_id: string
    }
    expect(restored.rating).toBe(4.5)
    expect(restored.cover_file_id).toBe(destination.id)
    await page.screenshot({ path: test.info().outputPath('replace-undo.png') })
  } finally {
    await page.close()
    await f.cleanup()
  }
})

// Explicit relocations carry the source bundle and leave the displaced catalog recoverable
for (const verb of ['rename', 'move'] as const)
  test(`${verb} Replace keeps source metadata and visible Undo restores both files @fullstack`, async ({
    page,
  }) => {
    const f = await fixture()
    try {
      const destinationPath = verb === 'rename' ? 'Source/Target.png' : 'Destination/Amber.png'
      await writeFile(join(f.root, destinationPath), await readFile(f.paths[1]!))
      const displaced = await apiPost<{ bundle_id: string }>(
        f.base,
        '/manual-bundling/create-bundle',
        {
          relative_paths: [destinationPath],
          title: 'Displaced bundle',
        },
      )
      const original = catalog(f.root)
      const a = original.find((row) => row.relative_path === 'Source/Amber.png')!
      const b = original.find((row) => row.relative_path === destinationPath)!
      // Use authored API edits so the test observes the same metadata contract as the inspector
      const annotate = async (id: string, note: string, rating: number, cover: string) => {
        const basis = (await (await fetch(`${f.base}/metadata`)).json()) as { basis: string }
        const detail = (await (await fetch(`${f.base}/bundles/${id}`)).json()) as {
          version: number
        }
        expect(
          (
            await fetch(`${f.base}/bundles/${id}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'X-Cairndex-Basis': basis.basis,
                'X-Cairndex-Operation': crypto.randomUUID(),
              },
              body: JSON.stringify({
                version: detail.version,
                notes: [note],
                rating,
                cover_file_id: cover,
              }),
            })
          ).ok,
        ).toBe(true)
      }
      await annotate(f.source.bundle_id, 'Mountain annotation', 5, a.id)
      await annotate(displaced.bundle_id, 'Beach annotation', 2, b.id)
      const thumbUrl = `${f.base}/bundles/${f.source.bundle_id}/thumbnail`
      const originalThumb = Buffer.from(await (await fetch(thumbUrl)).arrayBuffer())
      const sourceBytes = await readFile(f.paths[0]!)
      await openFolder(page, f, 'Source')
      await page
        .locator('.file-browser__body')
        .getByText('Amber.png', { exact: true })
        .click({ button: 'right' })
      await page
        .getByRole('menuitem', { name: verb === 'rename' ? 'Rename…' : 'Move to…', exact: true })
        .click()
      if (verb === 'rename') {
        await page.getByRole('textbox', { name: 'Rename Amber.png' }).fill('Target.png')
        await page.getByRole('textbox', { name: 'Rename Amber.png' }).press('Enter')
      } else {
        const picker = page.getByRole('dialog', { name: 'Move to', exact: true })
        await picker
          .getByRole('list')
          .getByRole('button', { name: /Destination$/ })
          .click()
        await picker.getByRole('button', { name: 'Move here', exact: true }).click()
      }
      const conflict = page.getByRole('dialog', { name: 'Name already in use' })
      await expect(conflict).toBeVisible()
      expect(catalog(f.root)).toEqual(original)
      await conflict.getByRole('button', { name: 'Replace', exact: true }).click()
      await expect
        .poll(() => catalog(f.root).find((row) => row.id === a.id)?.relative_path)
        .toBe(destinationPath)
      expect(catalog(f.root).find((row) => row.id === b.id)?.availability).toBe('TRASHED')
      expect(await readFile(join(f.root, destinationPath))).toEqual(sourceBytes)
      expect(Buffer.from(await (await fetch(thumbUrl)).arrayBuffer()).equals(originalThumb)).toBe(
        true,
      )
      await annotate(f.source.bundle_id, 'Mountain edited after move', 5, a.id)
      await page.getByRole('button', { name: 'Undo', exact: true }).click()
      await expect.poll(() => catalog(f.root)).toEqual(original)
      await page.reload()
      await page.locator(`[data-bundle-id="${f.source.bundle_id}"]`).first().click()
      await expect(
        page.locator('aside.inspector').getByText('Mountain edited after move', { exact: true }),
      ).toBeVisible()
      await page.locator(`[data-bundle-id="${displaced.bundle_id}"]`).first().click()
      await expect(
        page.locator('aside.inspector').getByText('Beach annotation', { exact: true }),
      ).toBeVisible()
      await page.screenshot({ path: test.info().outputPath(`${verb}-replace-undo.png`) })
    } finally {
      await page.close()
      await f.cleanup()
    }
  })
