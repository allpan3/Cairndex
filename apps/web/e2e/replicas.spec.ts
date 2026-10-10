import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBackend, stopBackend, proxyApi, apiPost } from './realBackend'

// Copy only immutable envelopes between offline replicas, never their private databases
async function deliver(a: string, b: string) {
  for (const [source, target] of [
    [a, b],
    [b, a],
  ]) {
    await cp(join(source, '.cairndex/replica/objects'), join(target, '.cairndex/replica/objects'), {
      recursive: true,
    })
  }
}

test('two independent replicas preserve offline edits, conflicts, drafts and retained values @fullstack', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-replica-e2e-'))
  const roots = [join(scratch, 'A'), join(scratch, 'B')]
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.replica_fixture import create_fixture; create_fixture(Path(sys.argv[1]))',
      roots[0],
    ],
    { cwd: serverDir },
  )
  await writeFile(join(roots[0], 'synthetic-source.txt'), 'Source stays unchanged')
  await cp(roots[0], roots[1], { recursive: true })
  const backends = [
    await startBackend(join(scratch, 'private-A')),
    await startBackend(join(scratch, 'private-B')),
  ]
  const contexts = [await browser.newContext(), await browser.newContext()]
  try {
    const libraries = await Promise.all(
      backends.map((backend, i) =>
        apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
          root_path: roots[i],
        }),
      ),
    )
    const pages = await Promise.all(contexts.map((context) => context.newPage()))
    const [a, b] = pages
    for (let i = 0; i < 2; i++) {
      await proxyApi(pages[i], backends[i].baseUrl)
      await pages[i].goto('/')
      await expect(
        pages[i].getByRole('region', { name: 'Metadata delivery status' }),
      ).toContainText('Saved here · available metadata published', { timeout: 30_000 })
      await expect(pages[i].getByLabel('Bundle title')).toBeVisible()
    }
    await a.getByLabel('Bundle title').fill('Amber title')
    await b.getByLabel('Bundle note 1', { exact: true }).fill('Blue note')
    await Promise.all(
      pages.map((page) => page.getByRole('button', { name: 'Save changes', exact: true }).click()),
    )
    await expect(a.getByText('Saved here', { exact: true })).toBeVisible()
    await expect(b.getByText('Saved here', { exact: true })).toBeVisible()
    await Promise.all(
      pages.map((page) =>
        page.getByRole('button', { name: 'Exchange metadata', exact: true }).click(),
      ),
    )
    await Promise.all(
      pages.map((page) =>
        expect(page.getByRole('button', { name: 'Exchange metadata', exact: true })).toBeEnabled(),
      ),
    )
    await deliver(roots[0], roots[1])
    await expect(b.getByLabel('Bundle title')).toHaveValue('Amber title')
    await expect(a.getByLabel('Bundle note 1', { exact: true })).toHaveValue('Blue note')
    // A duplicated tab inherits session storage but must keep independent draft identity
    const inheritedEditor = await a.evaluate(() =>
      sessionStorage.getItem('cairndex.replica.editor'),
    )
    const duplicate = await contexts[0].newPage()
    await duplicate.addInitScript((id) => {
      if (id) sessionStorage.setItem('cairndex.replica.editor', id)
    }, inheritedEditor)
    await proxyApi(duplicate, backends[0].baseUrl)
    await duplicate.goto('/')
    await expect(duplicate.getByLabel('Bundle title')).toBeVisible()
    expect(
      await duplicate.evaluate(() => sessionStorage.getItem('cairndex.replica.editor')),
    ).not.toBe(inheritedEditor)
    await a.getByLabel('Bundle note 1', { exact: true }).fill('Primary private draft')
    await duplicate.getByLabel('Bundle note 1', { exact: true }).fill('Duplicate private draft')
    await a.reload()
    await expect(a.getByLabel('Bundle note 1', { exact: true })).toHaveValue(
      'Primary private draft',
    )
    await expect(duplicate.getByLabel('Bundle note 1', { exact: true })).toHaveValue(
      'Duplicate private draft',
    )
    await a.getByRole('button', { name: 'Discard draft', exact: true }).click()
    await duplicate.getByRole('button', { name: 'Discard draft', exact: true }).click()
    await expect(a.getByLabel('Bundle note 1', { exact: true })).toHaveValue('Blue note')
    await duplicate.close()
    // Both devices save from the shared basis while delivery is disconnected
    await a.getByLabel('Bundle title').fill('Amber choice')
    await b.getByLabel('Bundle title').fill('Blue choice')
    await Promise.all(
      pages.map((page) => page.getByRole('button', { name: 'Save changes', exact: true }).click()),
    )
    await Promise.all(
      pages.map((page) => expect(page.getByText('Saved here', { exact: true })).toBeVisible()),
    )
    await Promise.all(
      pages.map((page) =>
        page.getByRole('button', { name: 'Exchange metadata', exact: true }).click(),
      ),
    )
    await Promise.all(
      pages.map((page) =>
        expect(page.getByRole('button', { name: 'Exchange metadata', exact: true })).toBeEnabled(),
      ),
    )
    await deliver(roots[0], roots[1])
    await expect(a.getByRole('heading', { name: 'Title conflict', exact: true })).toBeVisible()
    await expect(b.getByRole('heading', { name: 'Title conflict', exact: true })).toBeVisible()
    await a.getByRole('heading', { name: 'Title conflict', exact: true }).scrollIntoViewIfNeeded()
    await a.screenshot({ path: test.info().outputPath('replica-conflict.png'), fullPage: true })
    // Imports and a conflict choice cannot erase an unrelated unsaved note
    await a.getByLabel('Bundle note 1', { exact: true }).fill('Private unfinished note')
    await a.reload()
    await expect(a.getByLabel('Bundle note 1', { exact: true })).toHaveValue(
      'Private unfinished note',
    )
    const choose = a
      .getByLabel('Title versions')
      .locator('.replica-candidate')
      .filter({ hasText: 'Blue choice' })
      .getByRole('button')
    await choose.click()
    await expect(a.getByRole('dialog', { name: 'Review metadata choice' })).toBeVisible()
    await a.keyboard.press('Escape')
    await expect(a.getByRole('dialog', { name: 'Review metadata choice' })).not.toBeVisible()
    await choose.click()
    // An arrival after review must reject confirmation and keep the private draft
    const descriptor = JSON.parse(
      await readFile(join(roots[0], '.cairndex/manifest.json'), 'utf8'),
    ) as { genesis: string }
    await apiPost(
      backends[0].baseUrl,
      `/api/v1/libraries/${libraries[0].id}/replica/bundles/synthetic-bundle/edits`,
      {
        operation: 'review-arrival',
        changes: { title: { value: 'Later arrival', basis: [descriptor.genesis] } },
      },
    )
    await a.getByRole('button', { name: 'Confirm choice', exact: true }).click()
    await expect(a.getByRole('dialog').getByRole('alert')).toContainText('stale')
    await a.getByRole('button', { name: 'Cancel choice', exact: true }).click()
    await choose.click()
    await a.getByRole('button', { name: 'Confirm choice', exact: true }).click()
    await expect(a.getByRole('heading', { name: 'Title conflict', exact: true })).not.toBeVisible()
    await expect(a.getByLabel('Bundle title')).toHaveValue('Blue choice')
    await expect(a.getByLabel('Bundle note 1', { exact: true })).toHaveValue(
      'Private unfinished note',
    )
    await a.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(a.getByText('Saved here', { exact: true })).toBeVisible()
    await a.getByRole('button', { name: 'Exchange metadata', exact: true }).click()
    await Promise.all(
      pages.map((page) =>
        expect(page.getByRole('button', { name: 'Exchange metadata', exact: true })).toBeEnabled(),
      ),
    )
    await deliver(roots[0], roots[1])
    await expect(b.getByLabel('Bundle note 1', { exact: true })).toHaveValue(
      'Private unfinished note',
    )
    await expect(b.getByRole('heading', { name: 'Title conflict', exact: true })).not.toBeVisible()
    // Recover a rejected value explicitly while preserving the independent note
    await a.getByRole('button', { name: 'Title history', exact: true }).click()
    await a
      .getByLabel('Retained versions')
      .locator('.replica-candidate')
      .filter({ hasText: 'Amber choice' })
      .getByRole('button')
      .click()
    await a.getByRole('button', { name: 'Confirm choice', exact: true }).click()
    await expect(a.getByLabel('Bundle title')).toHaveValue('Amber choice')
    await expect(a.getByLabel('Bundle note 1', { exact: true })).toHaveValue(
      'Private unfinished note',
    )
    // A new browser recovers a server-backed draft after the replica process restarts
    await b.getByLabel('Bundle rating').selectOption('4')
    await expect(b.getByText('Draft saved on this device', { exact: true })).toBeVisible()
    await b.close()
    await stopBackend(backends[1].child)
    backends[1] = await startBackend(join(scratch, 'private-B'))
    const freshContext = await browser.newContext()
    contexts.push(freshContext)
    const fresh = await freshContext.newPage()
    await proxyApi(fresh, backends[1].baseUrl)
    await fresh.goto('/')
    await expect(fresh.getByRole('button', { name: 'Recover draft 1', exact: true })).toBeVisible()
    await fresh.getByRole('button', { name: 'Recover draft 1', exact: true }).click()
    await expect(fresh.getByLabel('Bundle rating')).toHaveValue('4')
    await fresh.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(fresh.getByText('Saved here', { exact: true })).toBeVisible()
    await a.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    await expect(a.getByRole('checkbox', { name: /write mode/i })).toHaveCount(0)
    for (const root of roots) {
      expect(await readFile(join(root, 'synthetic-source.txt'), 'utf8')).toBe(
        'Source stays unchanged',
      )
      const metadata = await readdir(join(root, '.cairndex'))
      expect(metadata).not.toContain('library.db')
      expect(metadata).not.toContain('locks')
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
    await Promise.all(backends.map((backend) => stopBackend(backend.child)))
    await rm(scratch, { recursive: true, force: true })
  }
})
