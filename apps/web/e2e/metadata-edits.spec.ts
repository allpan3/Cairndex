import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

// Every test owns a disposable server and library; both browser contexts use actual HTTP writes
async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-shared-edits-'))
  const backend = await startBackend(join(scratch, 'server'))
  const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/create', {
    root_path: join(scratch, 'library'),
    display_name: 'Synthetic shared edits',
    create_if_missing: true,
  })
  const base = `${backend.baseUrl}/api/v1/libraries/${library.id}`
  const bundle = await apiPost<{ id: string; version: number }>(base, '/bundles', {
    title: 'Amber',
    notes: ['Opening note'],
  })
  return {
    ...backend,
    base,
    library,
    bundle,
    root: join(scratch, 'library'),
    cleanup: async () => {
      await stopBackend(backend.child)
      await rm(scratch, { recursive: true, force: true })
    },
  }
}

// Read exactly once for an independent synthetic client operation
async function edit(base: string, path: string, body: unknown, method = 'PATCH') {
  const { basis } = (await (await fetch(`${base}/metadata`)).json()) as { basis: string }
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Cairndex-Basis': basis,
      'X-Cairndex-Operation': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  })
}

// Open the same bundle in an isolated browser session
async function open(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  await proxyApi(page, f.baseUrl)
  await page.goto('/')
  await page.locator('.card').filter({ hasText: 'Amber' }).first().click()
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Amber')
}

test('ordinary LAN HTTP saves without secure-context APIs @fullstack', async ({
  browser,
  baseURL,
}) => {
  const f = await fixture()
  const page = await browser.newPage()
  try {
    // Serve the real app at a synthetic insecure origin without altering browser capabilities
    await page.route('http://cairndex.invalid/**', async (route) => {
      const url = new URL(route.request().url())
      const response = await route.fetch({ url: `${baseURL}${url.pathname}${url.search}` })
      await route.fulfill({ response })
    })
    await proxyApi(page, f.baseUrl)
    await page.goto('http://cairndex.invalid')
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false)
    expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined')
    await page.locator('.card').filter({ hasText: 'Amber' }).first().click()
    await page.getByLabel('Title', { exact: true }).fill('LAN edit')
    await page.getByLabel('Title', { exact: true }).press('Enter')
    await expect
      .poll(async () => (await (await fetch(`${f.base}/bundles/${f.bundle.id}`)).json()).title)
      .toBe('LAN edit')
    await page.reload()
    await expect(page.locator('.card').filter({ hasText: 'LAN edit' })).toBeVisible()
  } finally {
    await page.close()
    await f.cleanup()
  }
})

test('two clients preserve disjoint drafts and exact conflict choices @fullstack', async ({
  browser,
}) => {
  test.setTimeout(90_000)
  const f = await fixture()
  const first = await browser.newPage()
  const second = await browser.newPage()
  try {
    await open(first, f)
    await open(second, f)
    await second.getByLabel('Title', { exact: true }).fill('Retained proposal')
    await first.getByLabel('Title', { exact: true }).fill('First client title')
    await first.getByLabel('Title', { exact: true }).press('Enter')
    await expect
      .poll(async () => (await (await fetch(`${f.base}/bundles/${f.bundle.id}`)).json()).title)
      .toBe('First client title')
    // The poll refreshes the bundle while the second title remains a private draft
    await expect(second.locator('.card').filter({ hasText: 'First client title' })).toBeVisible({
      timeout: 12_000,
    })
    await expect(second.getByLabel('Title', { exact: true })).toHaveValue('Retained proposal')
    await second.getByLabel('Title', { exact: true }).press('Enter')
    const review = second.getByRole('dialog', { name: 'Review metadata edit' })
    await expect(review).toContainText('First client title')
    await expect(review).toContainText('Retained proposal')
    await second.screenshot({ path: '/tmp/cairndex-metadata-review.png' })
    expect((await edit(f.base, `/bundles/${f.bundle.id}`, { title: 'Third arrival' })).ok).toBe(
      true,
    )
    await review.getByRole('button', { name: 'Use my value' }).click()
    await expect(review).toContainText('Third arrival')
    await review.getByRole('button', { name: 'Keep draft' }).click()
    await second.reload()
    await second.locator('.card').filter({ hasText: 'Third arrival' }).click()
    await expect(second.getByLabel('Title', { exact: true })).toHaveValue('Retained proposal')
    await second.getByRole('button', { name: 'Review unsaved edit 1' }).click()
    await second.getByRole('button', { name: 'Use my value' }).click()
    await expect(second.getByRole('dialog', { name: 'Review metadata edit' })).toHaveCount(0)
    await expect
      .poll(async () => (await (await fetch(`${f.base}/bundles/${f.bundle.id}`)).json()).title)
      .toBe('Retained proposal')
    await expect
      .poll(() =>
        second.evaluate(
          () =>
            Object.keys(localStorage).filter((key) => key.startsWith('cairndex.bundleDraft:'))
              .length,
        ),
      )
      .toBe(0)
  } finally {
    await first.close()
    await second.close()
    await f.cleanup()
  }
})

// Plan loading and generation must establish the editable snapshot after the dialog opens
for (const remoteChange of [false, true])
  test(`newly generated grouping handles ${remoteChange ? 'remote changes' : 'own edits'} in the open app @fullstack`, async ({
    page,
  }) => {
    const f = await fixture()
    try {
      await apiPost(f.base, `/bundles/${f.bundle.id}/files`, {
        relative_path: 'Cosmos/cosmos.mp4',
        role: 'primary_video',
        media_kind: 'video',
      })
      execFileSync(
        'uv',
        [
          'run',
          'python',
          '-c',
          `
import sys
from pathlib import Path
from sqlalchemy.orm import Session
from cairndex.persistence.engine import create_app_engine
from cairndex.persistence.models import AssetBundle
from cairndex.registry.library_package import db_path
from cairndex.domain.enums import GroupingState, GroupingSource
engine = create_app_engine(database_url=f'sqlite:///{db_path(Path(sys.argv[1]))}')
with Session(engine) as session:
    row = session.get(AssetBundle, sys.argv[2])
    row.grouping_state = GroupingState.PROVISIONAL
    row.grouping_source = GroupingSource.SCAN_SUGGESTION
    session.commit()
engine.dispose()
`,
          f.root,
          f.bundle.id,
        ],
        {
          cwd: fileURLToPath(new URL('../../server/', import.meta.url)),
          env: { ...process.env, CAIRNDEX_DATA_DIR: join(f.root, '.seed-runtime') },
        },
      )
      await proxyApi(page, f.baseUrl)
      await page.goto('/')
      await page.getByRole('button', { name: 'More library actions' }).click()
      await page.getByRole('button', { name: 'Suggest grouping' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Suggest grouping' }).click()
      const title = page.locator('.grp-row--bundle [title="Double-click to rename"]').first()
      await expect(title).toBeVisible()
      await title.dblclick()
      const input = page.getByRole('textbox', { name: /suggestion title/i })
      await input.fill('Reviewed Cosmos')
      await input.press('Enter')
      await expect(title).toHaveText('Reviewed Cosmos')
      if (remoteChange) {
        const plans = (await (await fetch(`${f.base}/grouping/plans`)).json()) as { id: string }[]
        const plan = (await (await fetch(`${f.base}/grouping/plans/${plans[0]!.id}`)).json()) as {
          id: string
          proposals: { id: string }[]
        }
        expect(
          (
            await edit(f.base, `/grouping/plans/${plan.id}/proposals/${plan.proposals[0]!.id}`, {
              title: 'Remote Cosmos',
            })
          ).ok,
        ).toBe(true)
        await expect(title).toHaveText('Remote Cosmos', { timeout: 12_000 })
        await page.getByRole('button', { name: /^Accept / }).click()
        const review = page.getByRole('dialog', { name: 'Review metadata edit' })
        await expect(review).toBeVisible()
        await expect(review.getByRole('button', { name: 'Use my value' })).toHaveCount(0)
        await review.getByRole('button', { name: 'Keep draft' }).click()
        expect((await (await fetch(`${f.base}/grouping/plans/${plan.id}`)).json()).status).toBe(
          'open',
        )
      } else {
        await page.getByRole('button', { name: /^Accept / }).click()
        await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible()
        await expect(page.getByRole('dialog', { name: 'Review metadata edit' })).toHaveCount(0)
      }
    } finally {
      await page.close()
      await f.cleanup()
    }
  })

test('a dirty notes field survives another client title and safe membership changes @fullstack', async ({
  browser,
}) => {
  test.setTimeout(90_000)
  const f = await fixture()
  const first = await browser.newPage()
  const second = await browser.newPage()
  try {
    const aster = await apiPost<{ id: string }>(f.base, '/tags', { name: 'Aster' })
    await open(first, f)
    await open(second, f)
    await second.getByPlaceholder('Add a note…').fill('Independent note draft')
    await first.getByLabel('Title', { exact: true }).fill('Blue')
    await first.getByLabel('Title', { exact: true }).press('Enter')
    await expect(second.locator('.card').filter({ hasText: 'Blue' })).toBeVisible({
      timeout: 12_000,
    })
    await expect(second.getByPlaceholder('Add a note…')).toHaveValue('Independent note draft')
    await second.getByPlaceholder('Add a note…').blur()
    await expect
      .poll(async () => (await (await fetch(`${f.base}/bundles/${f.bundle.id}`)).json()).notes)
      .toEqual(['Independent note draft'])
    // An independent remote membership must survive a checkbox driven from the rendered picker
    await second.getByRole('button', { name: '+ Tag', exact: true }).click()
    const birch = await apiPost<{ id: string }>(f.base, '/tags', { name: 'Birch' })
    expect(
      (await edit(f.base, `/bundles/${f.bundle.id}/tags`, { add_ids: [birch.id] }, 'POST')).ok,
    ).toBe(true)
    await second.getByRole('option', { name: /Aster/ }).click()
    await expect
      .poll(async () =>
        (await (await fetch(`${f.base}/bundles/${f.bundle.id}/tags`)).json()).tag_ids.sort(),
      )
      .toEqual([aster.id, birch.id].sort())
  } finally {
    await first.close()
    await second.close()
    await f.cleanup()
  }
})

test('lost create response replays one receipt and historical drafts require review @fullstack', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const f = await fixture()
  try {
    await open(page, f)
    await page.getByRole('button', { name: 'New smart collection' }).click()
    await page.getByLabel('Smart collection name').fill('One retained create')
    let lost = false
    await page.route('**/smart-collections', async (route) => {
      if (route.request().method() !== 'POST' || lost) return route.fallback()
      lost = true
      const request = route.request()
      const saved = await fetch(`${f.base}/smart-collections`, {
        method: 'POST',
        headers: request.headers(),
        body: request.postData(),
      })
      expect(saved.status).toBe(201)
      await route.abort('failed')
    })
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.getByRole('button', { name: 'Retry save', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const rows = (await (await fetch(`${f.base}/smart-collections`)).json()) as { name: string }[]
    expect(rows.filter((row) => row.name === 'One retained create')).toHaveLength(1)
    await page.evaluate(
      ({ id, libraryId, version }) =>
        localStorage.setItem(
          `cairndex.bundleDraft:${id}:web:${libraryId}`,
          JSON.stringify({ version, patch: { title: 'Historical draft' } }),
        ),
      { id: f.bundle.id, libraryId: f.library.id, version: f.bundle.version },
    )
    await page.reload()
    await page.getByRole('button', { name: /^All \d+$/ }).click()
    await page.locator('.card').filter({ hasText: 'Amber' }).click()
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Historical draft')
    await page.getByLabel('Title', { exact: true }).focus()
    await page.getByLabel('Title', { exact: true }).press('Enter')
    const review = page.getByRole('dialog', { name: 'Review metadata edit' })
    await expect(review).toContainText('no safe opening version')
    await expect(review).toContainText('Amber')
    await review.getByRole('button', { name: 'Discard proposed edit' }).click()
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Amber')
  } finally {
    await page.close()
    await f.cleanup()
  }
})

// Repeated keyboard edits use the displayed file order despite older unrelated reads
test('successive keyboard file reorders keep their own read basis @fullstack', async ({ page }) => {
  test.setTimeout(60_000)
  const f = await fixture()
  try {
    for (const name of ['Aster.txt', 'Birch.txt']) {
      await apiPost(f.base, `/bundles/${f.bundle.id}/files`, {
        relative_path: name,
        role: 'attachment',
        media_kind: 'other',
      })
    }
    await open(page, f)
    const rows = page.locator('.files .file-row')
    const birch = rows.filter({ hasText: 'Birch.txt' })
    // Observe a committed response before each subsequent gesture
    for (const key of ['Alt+ArrowUp', 'Alt+ArrowDown', 'Alt+ArrowUp']) {
      const saved = page.waitForResponse((response) =>
        response.url().endsWith(`/bundles/${f.bundle.id}/files/order`),
      )
      await birch.press(key)
      expect((await saved).status()).toBe(200)
      await expect(rows.first()).toContainText(key === 'Alt+ArrowUp' ? 'Birch.txt' : 'Aster.txt')
      await expect(page.getByRole('dialog', { name: 'Review metadata edit' })).toHaveCount(0)
    }
    await page.reload()
    await page.locator('.card').filter({ hasText: 'Amber' }).first().click()
    await expect(rows.first()).toContainText('Birch.txt')
  } finally {
    await page.close()
    await f.cleanup()
  }
})

// Pointer reorders keep their actual drag-start snapshot through a remote arrangement change
test('stale file reorders retain the proposal without changing the new arrangement @fullstack', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const f = await fixture()
  try {
    const ids = []
    for (const name of ['Aster.txt', 'Birch.txt', 'Cedar.txt']) {
      const row = await apiPost<{ id: string }>(f.base, `/bundles/${f.bundle.id}/files`, {
        relative_path: name,
        role: 'attachment',
        media_kind: 'other',
      })
      ids.push(row.id)
    }
    await open(page, f)
    await page.setViewportSize({ width: 1280, height: 1100 })
    const first = page.locator('.files .file-row').filter({ hasText: 'Aster.txt' })
    const last = page.locator('.files .file-row').filter({ hasText: 'Cedar.txt' })
    const start = (await first.boundingBox())!
    await page.mouse.move(start.x + 70, start.y + start.height / 2)
    await page.mouse.down()
    await page.mouse.move(start.x + 75, start.y + start.height / 2)
    const remote = [ids[2]!, ids[1]!, ids[0]!]
    expect(
      (await edit(f.base, `/bundles/${f.bundle.id}/files/order`, { ordered_ids: remote }, 'PUT'))
        .ok,
    ).toBe(true)
    const target = (await last.boundingBox())!
    await page.mouse.move(target.x + 70, target.y + target.height - 2)
    await page.mouse.up()
    const review = page.getByRole('dialog', { name: 'Review metadata edit' })
    await expect(review).toBeVisible()
    await expect(review.getByRole('button', { name: 'Use my value' })).toHaveCount(0)
    await review.getByRole('button', { name: 'Keep draft' }).click()
    const rows = (await (await fetch(`${f.base}/bundles/${f.bundle.id}/files`)).json()) as {
      id: string
    }[]
    expect(rows.map((row) => row.id)).toEqual(remote)
    await expect(page.getByRole('button', { name: 'Review unsaved edit 1' })).toBeVisible()
  } finally {
    await page.close()
    await f.cleanup()
  }
})
