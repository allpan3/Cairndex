import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'
import type { FilePatch, FileRead } from '../src/api/client'

// Real HTTP and app client modules use only disposable synthetic source bytes
async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-file-metadata-'))
  const backend = await startBackend(join(scratch, 'server'))
  const root = join(scratch, 'library')
  const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/create', {
    root_path: root,
    display_name: 'Synthetic file metadata',
    create_if_missing: true,
  })
  const filePath = join(root, 'actual-name.txt')
  await writeFile(filePath, 'Synthetic unchanged source')
  const base = `${backend.baseUrl}/api/v1/libraries/${library.id}`
  const bundle = await apiPost<{ id: string }>(base, '/bundles', { title: 'Amber files' })
  const file = await apiPost<FileRead>(base, `/bundles/${bundle.id}/files`, {
    relative_path: 'actual-name.txt',
    role: 'attachment',
    media_kind: 'other',
    note: 'Opening file note',
    source: '  ed2k:opening-origin\n原文  ',
  })
  return {
    ...backend,
    bundle,
    file,
    cleanup: async () => {
      await stopBackend(backend.child)
      const bytes = await readFile(filePath, 'utf8')
      await rm(scratch, { recursive: true, force: true })
      expect(bytes).toBe('Synthetic unchanged source')
    },
  }
}

// Open the actual bundle inspector rather than adding a test-only editor surface
async function open(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  await proxyApi(page, f.baseUrl)
  await page.goto('/')
  await page.locator('.card').filter({ hasText: 'Amber files' }).click()
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Amber files')
  await expect(
    page.locator('.file-row__title').filter({ hasText: 'actual-name.txt' }),
  ).toBeVisible()
}

// Wait for library restoration before invoking scoped client functions after navigation
async function reload(page: Page) {
  await page.reload()
  await expect(page.locator('.card').filter({ hasText: 'Amber files' })).toBeVisible()
}

// Retain the same read object basis that existing app mutations consume
async function snapshot(page: Page, bundleId: string) {
  return page.evaluate(async (id) => {
    const clientPath = '/src/api/client.ts'
    const basisPath = '/src/api/editBasis.ts'
    const client = await import(clientPath)
    const { basisOf } = await import(basisPath)
    const [file] = await client.fetchBundleFiles(id)
    return { file, basis: basisOf(file) } as { file: FileRead; basis: string }
  }, bundleId)
}

// Exercise the shipped API client and review dialog; no file note/source editor exists
async function save(page: Page, bundleId: string, fileId: string, patch: FilePatch, basis: string) {
  return page.evaluate(
    async (args) => {
      const clientPath = '/src/api/client.ts'
      const { updateFile } = await import(clientPath)
      try {
        const file = (await updateFile(...args)) as FileRead
        return { file, error: null }
      } catch (error) {
        return { file: null, error: String(error) }
      }
    },
    [bundleId, fileId, patch, basis] as const,
  )
}

// Inspect only this test's retained API request, including its unchanged body and retry identity
async function retained(page: Page) {
  return page.evaluate(async () => {
    const modulePath = '/src/api/metadataEdits.ts'
    const { pendingEdits } = await import(modulePath)
    const [edit] = pendingEdits()
    return edit ? { body: edit.body, basis: edit.basis, operation: edit.operation } : null
  })
}

test('file client saves, reloads and clears metadata while the inspector shows its filename @fullstack', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await open(page, f)
    const initial = await snapshot(page, f.bundle.id)
    expect(initial.file.note).toBe('Opening file note')
    expect(initial.file.source).toBe(f.file.source)
    const edited = await save(
      page,
      f.bundle.id,
      f.file.id,
      { note: '  Revised\n原文  ' },
      initial.basis,
    )
    expect(edited.file).toMatchObject({ note: '  Revised\n原文  ', source: f.file.source })
    await reload(page)
    const reopened = await snapshot(page, f.bundle.id)
    expect(reopened.file).toMatchObject({
      id: f.file.id,
      note: '  Revised\n原文  ',
      source: f.file.source,
    })
    const cleared = await save(
      page,
      f.bundle.id,
      f.file.id,
      { note: null, source: null, display_title: 'actual-name.txt' },
      reopened.basis,
    )
    expect(cleared.file).toMatchObject({
      note: null,
      source: null,
      display_title: 'actual-name.txt',
    })
    await reload(page)
    expect((await snapshot(page, f.bundle.id)).file).toMatchObject({
      id: f.file.id,
      note: null,
      source: null,
    })
    await page.locator('.card').filter({ hasText: 'Amber files' }).click()
    await expect(
      page.locator('.file-row__title').filter({ hasText: 'actual-name.txt' }),
    ).toBeVisible()
  } finally {
    await page.close()
    await f.cleanup()
  }
})

test('file conflicts retain their basis and draft through refresh, reload and exact review @fullstack', async ({
  browser,
}) => {
  const f = await fixture()
  const first = await browser.newPage()
  const second = await browser.newPage()
  try {
    await open(first, f)
    await open(second, f)
    const initial = await snapshot(second, f.bundle.id)
    expect(
      (await save(first, f.bundle.id, f.file.id, { note: 'Peer file note' }, initial.basis)).file
        ?.note,
    ).toBe('Peer file note')
    expect(
      (
        await save(
          second,
          f.bundle.id,
          f.file.id,
          { source: 'magnet:independent-origin' },
          initial.basis,
        )
      ).file?.source,
    ).toBe('magnet:independent-origin')
    const pending = save(
      second,
      f.bundle.id,
      f.file.id,
      { note: 'Retained file note' },
      initial.basis,
    )
    const review = second.getByRole('dialog', { name: 'Review metadata edit' })
    await expect(review).toContainText('Peer file note')
    await expect(review).toContainText('Retained file note')
    await second.screenshot({ path: '/tmp/cairndex-file-metadata-review.png' })
    const before = await retained(second)
    await review.getByRole('button', { name: 'Keep draft' }).click()
    expect((await pending).error).toContain('MetadataEditError')
    // Fresh file reads do not advance the retained proposal's opening basis
    expect((await snapshot(second, f.bundle.id)).file.note).toBe('Peer file note')
    expect(await retained(second)).toEqual(before)
    await reload(second)
    expect(await retained(second)).toEqual(before)
    await second.locator('.card').filter({ hasText: 'Amber files' }).click()
    await second.getByRole('button', { name: 'Review unsaved edit 1' }).click()
    await review.getByRole('button', { name: 'Use my value' }).click()
    await expect(review).toHaveCount(0)
    expect((await snapshot(second, f.bundle.id)).file).toMatchObject({
      note: 'Retained file note',
      source: 'magnet:independent-origin',
    })
    expect(await retained(second)).toBeNull()
  } finally {
    await first.close()
    await second.close()
    await f.cleanup()
  }
})

test('a lost file-save response retries the exact receipt with both metadata fields @fullstack', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await open(page, f)
    const initial = await snapshot(page, f.bundle.id)
    let receipt: FileRead | null = null
    let operation: string | undefined
    await page.route(`**/bundles/${f.bundle.id}/files/${f.file.id}`, async (route) => {
      const request = route.request()
      if (request.method() !== 'PATCH') return route.fallback()
      if (receipt) {
        expect(request.headers()['x-cairndex-operation']).toBe(operation)
        return route.fallback()
      }
      operation = request.headers()['x-cairndex-operation']
      const saved = await fetch(`${f.baseUrl}${new URL(request.url()).pathname}`, {
        method: 'PATCH',
        headers: request.headers(),
        body: request.postData(),
      })
      expect(saved.status).toBe(200)
      receipt = (await saved.json()) as FileRead
      await route.abort('failed')
    })
    const pending = save(
      page,
      f.bundle.id,
      f.file.id,
      { note: 'Receipt note', source: 'magnet:receipt-origin' },
      initial.basis,
    )
    const review = page.getByRole('dialog', { name: 'Review metadata edit' })
    await review.getByRole('button', { name: 'Retry save' }).click()
    const result = await pending
    expect(result.file).toEqual(receipt)
    expect(result.file).toMatchObject({
      note: 'Receipt note',
      source: 'magnet:receipt-origin',
      version: initial.file.version + 1,
    })
    expect((await snapshot(page, f.bundle.id)).file).toEqual(receipt)
    expect(await retained(page)).toBeNull()
  } finally {
    await page.close()
    await f.cleanup()
  }
})

test('unsupported file names show an error and retain the exact unsaved request @fullstack', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await open(page, f)
    const initial = await snapshot(page, f.bundle.id)
    const pending = save(
      page,
      f.bundle.id,
      f.file.id,
      { display_title: 'Unsupported custom name', note: null },
      initial.basis,
    )
    const review = page.getByRole('dialog', { name: 'Review metadata edit' })
    await expect(review).toContainText('Custom file names are not supported')
    await expect(review.getByRole('button', { name: 'Use my value' })).toHaveCount(0)
    const before = await retained(page)
    await review.getByRole('button', { name: 'Keep draft' }).click()
    expect((await pending).error).toContain('Custom file names are not supported')
    await reload(page)
    expect(await retained(page)).toEqual(before)
    expect((await snapshot(page, f.bundle.id)).file).toEqual(initial.file)
    await page.getByRole('button', { name: 'Review unsaved edit 1' }).click()
    await review.getByRole('button', { name: 'Retry save' }).click()
    await expect(review).toContainText('Custom file names are not supported')
    expect(await retained(page)).toEqual(before)
    await review.getByRole('button', { name: 'Discard proposed edit' }).click()
    await expect(review).toHaveCount(0)
    expect(await retained(page)).toBeNull()
  } finally {
    await page.close()
    await f.cleanup()
  }
})
