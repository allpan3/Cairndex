import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test.use({ actionTimeout: 15_000 })
const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
async function openBundle(page: Page, title = 'Synthetic bundle 1 雪') {
  await page.getByRole('option').filter({ hasText: title }).click()
  await expect(page.getByRole('complementary', { name: 'Bundle inspector' })).toBeVisible()
}

test('ordinary catalog browse, continued edits, delayed delivery and conflict review @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-browse-e2e-'))
  const original = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.catalog_fixture import create_disposable; from cairndex.replicas.catalog.conversion import prepare_disposable; print(prepare_disposable(create_disposable(parent=Path(sys.argv[1]),bundles=65)).package)',
      scratch,
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
  const roots = [join(scratch, 'A'), join(scratch, 'B')]
  await Promise.all(roots.map((root) => cp(original, root, { recursive: true })))
  const backends = [
    await startBackend(join(scratch, 'private-A')),
    await startBackend(join(scratch, 'private-B')),
  ]
  const contexts = [await browser.newContext(), await browser.newContext()]
  try {
    const libraries = await Promise.all(
      backends.map((backend, index) =>
        apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
          root_path: roots[index],
        }),
      ),
    )
    const pages = await Promise.all(contexts.map((context) => context.newPage()))
    for (let i = 0; i < 2; i++) {
      await proxyApi(pages[i]!, backends[i]!.baseUrl)
      await pages[i]!.goto('/')
      await openBundle(pages[i]!)
    }
    const [a, b] = pages as [Page, Page]
    const inspector = a.getByRole('complementary', { name: 'Bundle inspector' })
    await expect(a.getByRole('button', { name: 'Filters', exact: true })).toBeEnabled()
    await a.getByRole('searchbox', { name: 'Search', exact: true }).fill('64')
    await expect(
      a.getByRole('listbox', { name: 'Bundles', exact: true }).getByRole('option'),
    ).toHaveCount(1)
    await expect(
      a.getByRole('listbox', { name: 'Bundles', exact: true }).getByRole('option'),
    ).toContainText('Synthetic bundle 64')
    await a.getByRole('searchbox', { name: 'Search', exact: true }).fill('')
    await openBundle(a)
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let reached = () => {}
    const responseHeld = new Promise<void>((resolve) => {
      reached = resolve
    })
    let delayed = false
    await a.route('**/replica/catalog/jobs/*', async (route) => {
      if (delayed || route.request().method() !== 'GET') return route.fallback()
      const url = new URL(route.request().url())
      const response = await fetch(backends[0]!.baseUrl + url.pathname)
      const body = await response.text()
      if (JSON.parse(body).state === 'succeeded') {
        delayed = true
        reached()
        await held
      }
      await route.fulfill({ status: response.status, contentType: 'application/json', body })
    })
    await inspector.getByRole('textbox', { name: 'Note', exact: true }).fill('First note')
    await inspector.getByRole('button', { name: 'Save changes', exact: true }).click()
    await responseHeld
    await inspector.getByRole('button', { name: 'Add note', exact: true }).click()
    await inspector.getByRole('textbox', { name: 'Note 2', exact: true }).fill('Second note')
    release()
    await expect(
      inspector.getByText('Saved here · newer draft retained', { exact: true }),
    ).toBeVisible()
    await inspector.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(inspector.getByText('Saved here', { exact: true })).toBeVisible()
    await expect(inspector.getByRole('alert')).toHaveCount(0)
    const base = `/api/v1/libraries/${libraries[0]!.id}/replica/catalog`
    const entity = async (index = 0) =>
      (
        await fetch(backends[index]!.baseUrl + base + '/entities/asset_bundles/bundle-000001')
      ).json()
    expect(JSON.parse(JSON.parse((await entity()).fields.notes.value))).toEqual([
      'First note',
      'Second note',
    ])
    const other = b.getByRole('complementary', { name: 'Bundle inspector' })
    await other.getByRole('textbox', { name: 'Title', exact: true }).fill('Blue title')
    await other.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(other.getByText('Saved here', { exact: true })).toBeVisible()
    const deliver = async () => {
      for (let index = 0; index < 2; index++)
        await expect
          .poll(
            async () =>
              (
                await (
                  await fetch(
                    backends[index]!.baseUrl +
                      `/api/v1/libraries/${libraries[index]!.id}/replica/status`,
                  )
                ).json()
              ).outbox,
          )
          .toBe(0)
      await cp(
        join(roots[0]!, '.cairndex/replica/objects'),
        join(roots[1]!, '.cairndex/replica/objects'),
        { recursive: true },
      )
      await cp(
        join(roots[1]!, '.cairndex/replica/objects'),
        join(roots[0]!, '.cairndex/replica/objects'),
        { recursive: true },
      )
    }
    await deliver()
    await expect(inspector.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
      'Blue title',
    )
    await expect(other.getByRole('textbox', { name: 'Note 2', exact: true })).toHaveValue(
      'Second note',
    )
    await expect.poll(async () => (await entity()).has_conflicts).toBe(false)
    await inspector.getByRole('textbox', { name: 'Title', exact: true }).fill('Amber conflict')
    await other.getByRole('textbox', { name: 'Title', exact: true }).fill('Blue conflict')
    await other.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(other.getByText('Saved here', { exact: true })).toBeVisible()
    await deliver()
    await expect
      .poll(async () => JSON.parse((await entity()).fields.title.value))
      .toBe('Blue conflict')
    await expect(inspector.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
      'Amber conflict',
    )
    await inspector.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(
      inspector.getByText('Competing metadata requires review.', { exact: true }),
    ).toBeVisible()
    await inspector
      .getByRole('button', { name: 'Review metadata and conflicts', exact: true })
      .click()
    await a.getByRole('button', { name: 'Review Title', exact: true }).click()
    const review = a.getByRole('region', { name: 'Complete conflict review', exact: true })
    await review.getByRole('radio', { name: /Amber conflict/ }).check()
    await review.getByRole('button', { name: 'Prepare choice', exact: true }).click()
    await a.getByRole('button', { name: 'Apply reviewed operation', exact: true }).click()
    await expect.poll(async () => (await entity()).has_conflicts).toBe(false)
    expect(JSON.parse(JSON.parse((await entity()).fields.notes.value))).toEqual([
      'First note',
      'Second note',
    ])
    await a.getByRole('button', { name: 'Bundle Browser', exact: true }).click()
    await openBundle(a, 'Amber conflict')
    await expect(a.getByRole('listbox', { name: 'Bundles' })).toHaveAttribute(
      'aria-multiselectable',
      'true',
    )
    await expect(a.getByText(/Select All includes/)).toBeVisible()
    await a.screenshot({ path: '/tmp/cairndex-catalog-browse.png' })
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
    await Promise.all(backends.map((backend) => stopBackend(backend.child)))
    await rm(scratch, { recursive: true, force: true })
  }
})

// Lost acknowledgements retain one exact operation across library switches and retries.
test('catalog saves retain retry identity across switching and same-server client edits @fullstack', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-browse-retry-'))
  const roots = JSON.parse(
    execFileSync(
      'uv',
      [
        'run',
        'python',
        '-c',
        'import json,sys; from pathlib import Path; from cairndex.devtools.catalog_fixture import create_disposable; from cairndex.replicas.catalog.conversion import prepare_disposable; print(json.dumps([str(prepare_disposable(create_disposable(parent=Path(sys.argv[1]),bundles=3)).package) for _ in range(2)]))',
        scratch,
      ],
      { cwd: serverDir },
    ).toString(),
  ) as string[]
  const backend = await startBackend(join(scratch, 'private'))
  const contexts = [await browser.newContext(), await browser.newContext()]
  try {
    const libraries = []
    for (const root of roots)
      libraries.push(
        await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
          root_path: root,
        }),
      )
    const [a, b] = (await Promise.all(contexts.map((context) => context.newPage()))) as [Page, Page]
    for (const page of [a, b]) {
      await proxyApi(page, backend.baseUrl)
      await page.goto('/')
      await page
        .getByRole('combobox', { name: 'Library', exact: true })
        .selectOption(libraries[0]!.id)
      await openBundle(page)
    }
    const panel = a.getByRole('complementary', { name: 'Bundle inspector' })
    const peer = b.getByRole('complementary', { name: 'Bundle inspector' })
    await panel.getByRole('textbox', { name: 'Title', exact: true }).fill('Retained client title')
    await peer.getByRole('textbox', { name: 'Title', exact: true }).fill('Other client title')
    await peer.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(peer.getByText('Saved here', { exact: true })).toBeVisible()
    const base = `/api/v1/libraries/${libraries[0]!.id}/replica/catalog`
    const read = async () =>
      (await fetch(backend.baseUrl + base + '/entities/asset_bundles/bundle-000001')).json()
    await expect
      .poll(async () => JSON.parse((await read()).fields.title.value))
      .toBe('Other client title')
    await expect(panel.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
      'Retained client title',
    )
    let acknowledge = () => {}
    const held = new Promise<void>((resolve) => {
      acknowledge = resolve
    })
    let committed = () => {}
    const saved = new Promise<void>((resolve) => {
      committed = resolve
    })
    const operations: string[] = []
    await a.route('**/replica/catalog/jobs', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      const body = route.request().postDataJSON() as { operation: string }
      operations.push(body.operation)
      const response = await fetch(backend.baseUrl + base + '/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: route.request().postData(),
      })
      const result = await response.text()
      if (operations.length === 1) {
        await expect
          .poll(
            async () =>
              (await (await fetch(backend.baseUrl + base + '/jobs/' + body.operation)).json())
                .state,
          )
          .toBe('succeeded')
        committed()
        await held
        await route.abort('failed')
      } else
        await route.fulfill({
          status: response.status,
          contentType: 'application/json',
          body: result,
        })
    })
    await panel.getByRole('button', { name: 'Save changes', exact: true }).click()
    await saved
    await a.getByRole('combobox', { name: 'Library', exact: true }).selectOption(libraries[1]!.id)
    acknowledge()
    await openBundle(a)
    await expect(panel.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
      'Synthetic bundle 1 雪',
    )
    await a.getByRole('combobox', { name: 'Library', exact: true }).selectOption(libraries[0]!.id)
    await openBundle(a, 'Other client title')
    await panel.getByRole('button', { name: 'Retry save', exact: true }).click()
    await expect(panel.getByText('Saved here', { exact: true })).toBeVisible()
    expect(operations).toHaveLength(2)
    expect(operations[0]).toBe(operations[1])
    const result = await read()
    expect(result.has_conflicts).toBe(true)
    expect(result.fields.title.candidates).toHaveLength(2)
    await expect(
      panel.getByText('Competing metadata requires review.', { exact: true }),
    ).toBeVisible()
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})

// One journey combines hierarchy, saved queries, drafts, local files and media.
test('ordinary collection filters and File Browser share one library journey @fullstack', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-navigation-e2e-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.replica_media_fixture import create_playable; print(create_playable(parent=Path(sys.argv[1]),duration=20))',
      scratch,
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
  const backend = await startBackend(join(scratch, 'private'))
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const base = `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog`
    await expect
      .poll(
        async () =>
          (
            await (
              await fetch(`${backend.baseUrl}/api/v1/libraries/${library.id}/replica/status`)
            ).json()
          ).ready,
      )
      .toBe(true)
    const before = await (await fetch(`${base}/entities/smart_folders/filter-one`)).json()
    const legacyRequests: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (request.method() === 'GET' && /\/bundles\/[^/]+\/thumbnail$/.test(url.pathname)) return
      // The shared thumbnail route validates catalog identity and local generation.
      if (
        request.method() === 'GET' &&
        /\/bundles\/[^/]+\/files\/[^/]+\/thumbnail$/.test(url.pathname) &&
        url.searchParams.has('source_generation')
      )
        return
      if (
        /\/api\/v1\/libraries\/[^/]+\/(bundles|tags|collections|filters|file-browser)/.test(
          request.url(),
        )
      )
        legacyRequests.push(request.url())
    })
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page
      .getByRole('treeitem', { name: /Synthetic root/ })
      .first()
      .click()
    await expect(page.getByText('1 items', { exact: true })).toBeVisible()
    await page.getByRole('checkbox', { name: 'Show subcollection contents' }).uncheck()
    await expect(page.getByText('0 items', { exact: true })).toBeVisible()
    await page.getByRole('checkbox', { name: 'Show subcollection contents' }).check()
    await page.getByRole('button', { name: 'All Tags', exact: true }).click()
    await page
      .getByRole('region', { name: 'Tags', exact: true })
      .getByRole('button', { name: 'Synthetic root', exact: true })
      .click()
    await expect(page.getByText('1 items', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Filter by tags', exact: true }).click()
    await expect(page.getByRole('group', { name: 'Tag match rule' })).toBeVisible()
    await page.getByRole('button', { name: 'Equal', exact: true }).click()
    await expect(page.getByText('0 items', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Clear all', exact: true }).click()
    await page
      .getByRole('button', { name: 'Synthetic name Edit Synthetic name', exact: true })
      .first()
      .click()
    await expect(page.getByRole('listbox', { name: 'Bundles', exact: true })).toBeVisible()
    const after = await (await fetch(`${base}/entities/smart_folders/filter-one`)).json()
    expect(after.fields.$filter.value).toBe(before.fields.$filter.value)
    const recentRequest = page.waitForRequest(
      (request) =>
        request.url().endsWith('/replica/catalog/bundles/browse') &&
        request.postDataJSON()?.view === 'recent',
    )
    await page.getByRole('button', { name: 'Recent', exact: true }).click()
    expect((await recentRequest).postDataJSON()).toMatchObject({
      sort: 'date_added',
      order: 'desc',
    })
    await page.getByRole('button', { name: 'All', exact: true }).click()
    await openBundle(page, 'Synthetic playback')
    const inspector = page.getByRole('complementary', { name: 'Bundle inspector' })
    await inspector
      .getByRole('textbox', { name: 'Note', exact: true })
      .fill('Retained navigation note')
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    await page.getByRole('row').filter({ hasText: 'Playback' }).dblclick()
    await page.getByRole('searchbox', { name: 'Search files', exact: true }).fill('movie')
    const movie = page.getByRole('row').filter({ hasText: 'movie.mp4' })
    await expect(movie).toContainText('Observed here')
    await page.getByRole('searchbox', { name: 'Search files', exact: true }).fill('')
    // Clearing the search refetches the listing, and rows ignore input until the
    // full listing replaces the filtered one, so repeat the click until it selects.
    await expect(async () => {
      await movie.click()
      await expect(movie).toHaveAttribute('aria-selected', 'true', { timeout: 1_000 })
    }).toPass()
    await page.getByRole('grid', { name: 'Files', exact: true }).press('Enter')
    await expect(page.locator('video')).toBeVisible()
    await expect
      .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0.5)
    // Pointer movement shows the player controls; pause before checking manual order.
    await page.mouse.move(300, 250)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await page.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(page.locator('img.mv-image')).toBeVisible()
    await expect(page.locator('.media-viewer')).toContainText('picture.png')
    await page.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(page.locator('img.mv-image')).toBeVisible()
    await expect(page.locator('.media-viewer')).toContainText('preview.tiff')
    await page.getByRole('button', { name: 'Previous file', exact: true }).click()
    await expect(page.locator('.media-viewer')).toContainText('picture.png')
    await page.getByRole('button', { name: 'Previous file', exact: true }).click()
    await expect(page.locator('video')).toBeVisible()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page
      .getByRole('complementary', { name: 'File inspector' })
      .getByRole('button', { name: 'Locate in Bundle Browser' })
      .click()
    await expect(inspector.getByRole('textbox', { name: 'Note', exact: true })).toHaveValue(
      'Retained navigation note',
    )
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    await rm(join(root, 'Playback/movie.mp4'))
    await expect(page.getByRole('row').filter({ hasText: 'movie.mp4' })).toContainText(
      'Unavailable here',
    )
    await expect(page.getByRole('complementary', { name: 'File inspector' })).toContainText(
      'Unavailable on this device',
    )
    expect(legacyRequests).toEqual([])
    await page.screenshot({ path: '/tmp/cairndex-catalog-integration.png' })
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})

// The legacy card menu: locate, collection cover and removal save without a review step
test('portable card menu locates files and organizes a collection @fullstack', async ({ page }) => {
  test.setTimeout(120_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-card-menu-e2e-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.replica_media_fixture import create_playable; print(create_playable(parent=Path(sys.argv[1]),duration=20))',
      scratch,
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
  const backend = await startBackend(join(scratch, 'private'))
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const base = `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog`
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page
      .getByRole('option')
      .filter({ hasText: 'Synthetic playback' })
      .click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem', { name: 'Set as Collection Cover' })).toHaveCount(0)
    await menu.getByRole('menuitem', { name: 'Locate in File Browser' }).click()
    await expect(page.getByRole('row').filter({ hasText: 'movie.mp4' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await page
      .getByRole('treeitem', { name: /Synthetic child/ })
      .first()
      .click()
    await page.getByRole('checkbox', { name: 'Show subcollection contents' }).uncheck()
    await expect(page.getByText('1 items', { exact: true })).toBeVisible()
    const card = page.getByRole('listbox', { name: 'Bundles', exact: true }).getByRole('option')
    await card.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Set as Collection Cover' }).click()
    await expect(page.getByText('Collection cover set.')).toBeVisible()
    const cover = async () =>
      (await (await fetch(`${base}/entities/collections/collections-child`)).json()).fields
        .cover_bundle_id.value
    expect(await cover()).toBe('"bundle-000000"')
    await card.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Remove from This Collection' }).click()
    await expect(page.getByText('0 items', { exact: true })).toBeVisible()
    // Leaving the collection also clears the cover that required the membership
    expect(await cover()).toBe('null')
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})

test('portable sidebar creates, renames, arranges and deletes collections @fullstack', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-collections-e2e-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.replica_media_fixture import create_playable; print(create_playable(parent=Path(sys.argv[1]),duration=5))',
      scratch,
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
  const backend = await startBackend(join(scratch, 'private'))
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const base = `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog`
    type Item = { id: string; parent_id: string | null; sort_order: number }
    const forest = async () =>
      JSON.parse(
        (await (await fetch(`${base}/entities/collections/_`)).json()).fields.$forest.value,
      ) as Item[]
    const level = async (parent: string | null) =>
      (await forest())
        .filter((item) => item.parent_id === parent)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((item) => item.id)
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    // The fixture names a tag and a collection alike; the collections section is first
    const row = (name: RegExp) => page.getByRole('treeitem', { name }).first()
    const menu = page.getByRole('menu')
    await expect(row(/Synthetic child/)).toBeVisible()

    await page.getByRole('button', { name: 'New collection' }).click()
    const prompt = page.getByRole('dialog', { name: 'New Collection' })
    await prompt.getByLabel('Collection name').fill('Zeta draft')
    await prompt.getByRole('button', { name: 'Create' }).click()
    await expect(row(/Zeta draft/)).toBeVisible()
    const fixture = ['collections-root', 'collections-child']
    const created = (await forest()).find((item) => !fixture.includes(item.id))!.id
    expect(await level(null)).toEqual(['collections-root', created])

    await row(/Zeta draft/).click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Rename Collection' }).click()
    const rename = page.getByRole('textbox', { name: 'Rename Zeta draft' })
    await rename.fill('Alpha')
    await rename.press('Enter')
    // The row names the typed value until the save lands and the field closes
    await expect(rename).toBeHidden()
    await expect(row(/Alpha/)).toBeVisible()

    await page.getByRole('button', { name: 'Collections', exact: true }).click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Clean Up Order…' }).click()
    await page
      .getByRole('dialog', { name: 'Clean up collection order' })
      .getByRole('button', { name: 'Clean up' })
      .click()
    await expect.poll(() => level(null)).toEqual([created, 'collections-root'])

    await row(/Alpha/).dragTo(row(/Synthetic child/))
    await expect.poll(() => level('collections-child')).toEqual([created])

    await row(/Synthetic child/).click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Delete Collection' }).click()
    const remove = page.getByRole('dialog', { name: 'Delete Collection' })
    await expect(remove.getByText('Subcollections move up one level.')).toBeVisible()
    await remove.getByRole('button', { name: 'Delete', exact: true }).click()
    // The deleted collection's child moves up, and its bundle stays in the catalog
    await expect.poll(() => level('collections-root')).toEqual([created])
    expect((await forest()).map((item) => item.id)).not.toContain('collections-child')
    const bundle = await (await fetch(`${base}/entities/asset_bundles/bundle-000000`)).json()
    expect(bundle.fields.$alive.value).toBe('true')
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})

test('portable cards drag into sidebar collections @fullstack', async ({ page }) => {
  test.setTimeout(120_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-card-drag-e2e-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.replica_media_fixture import create_playable; print(create_playable(parent=Path(sys.argv[1]),duration=5))',
      scratch,
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
  const backend = await startBackend(join(scratch, 'private'))
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const base = `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog`
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    const row = (name: RegExp) => page.getByRole('treeitem', { name }).first()
    const grid = page.getByRole('listbox', { name: 'Bundles', exact: true })
    const card = grid.getByRole('option').filter({ hasText: 'Synthetic playback' })
    // A drop from All bundles adds the card without removing it anywhere
    await card.dragTo(row(/Synthetic child/))
    await row(/Synthetic child/).click()
    await page.getByRole('checkbox', { name: 'Show subcollection contents' }).uncheck()
    await expect(page.getByText('2 items', { exact: true })).toBeVisible()
    // A plain drop out of an open collection moves the card
    await card.dragTo(row(/Synthetic root/))
    await expect(page.getByText('1 items', { exact: true })).toBeVisible()
    await row(/Synthetic root/).click()
    await expect(grid.getByRole('option')).toHaveCount(1)
    await expect(card).toBeVisible()

    // Empty space inside a collection names a subcollection of it
    const box = (await grid.boundingBox())!
    await grid.click({ button: 'right', position: { x: box.width - 12, y: box.height - 12 } })
    await page.getByRole('menu').getByRole('menuitem', { name: 'New Subcollection' }).click()
    const prompt = page.getByRole('dialog', { name: 'New Subcollection' })
    await prompt.getByLabel('Collection name').fill('Nested draft')
    await prompt.getByRole('button', { name: 'Create' }).click()
    await expect(row(/Nested draft/)).toBeVisible()
    const forest = JSON.parse(
      (await (await fetch(`${base}/entities/collections/_`)).json()).fields.$forest.value,
    ) as { id: string; parent_id: string | null }[]
    expect(
      forest.filter((item) => item.parent_id === 'collections-root').map((item) => item.id),
    ).toHaveLength(2)
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})

test('portable Delete Bundle returns its files to Unbundled @fullstack', async ({ page }) => {
  test.setTimeout(120_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-delete-bundle-e2e-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.replica_media_fixture import create_playable; print(create_playable(parent=Path(sys.argv[1]),duration=5))',
      scratch,
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
  const backend = await startBackend(join(scratch, 'private'))
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const base = `${backend.baseUrl}/api/v1/libraries/${library.id}/replica/catalog`
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    const card = page
      .getByRole('listbox', { name: 'Bundles', exact: true })
      .getByRole('option')
      .filter({ hasText: 'Synthetic playback' })
    await card.click({ button: 'right' })
    await page.getByRole('menu').getByRole('menuitem', { name: 'Delete Bundle' }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete bundle' })
    await expect(dialog).toContainText('Their files fall back into Unbundled')
    await expect(dialog).toContainText('The files stay where they are on disk.')
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByText('Bundle deleted.')).toBeVisible()
    await expect(card).toHaveCount(0)
    // Every file keeps its catalog identity in its own Unbundled staging bundle
    const staged = await apiPost<{ items: { id: string; bundle_id: string }[] }>(
      backend.baseUrl,
      `/api/v1/libraries/${library.id}/replica/catalog/files/unbundled`,
      {},
    )
    const playback = staged.items.filter((item) => item.id.startsWith('media-'))
    expect(playback.map((item) => item.id).sort()).toEqual([
      'media-direct',
      'media-fallback',
      'media-image',
      'media-preview',
      'media-remux',
      'media-subtitle',
    ])
    expect(new Set(playback.map((item) => item.bundle_id)).size).toBe(6)
    const bundle = await (await fetch(`${base}/entities/asset_bundles/bundle-000001`)).json()
    expect(bundle.fields.$alive.value).toBe('false')
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
