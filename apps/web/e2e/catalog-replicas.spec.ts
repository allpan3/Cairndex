import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

// Complete disposable catalogs exercise shared application flows through independent real servers
test('complete catalogs preserve fields, drafts, structural operations and recovery @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-catalog-e2e-'))
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  const original = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.catalog_fixture import create_disposable; from cairndex.replicas.catalog.conversion import prepare_disposable; c=prepare_disposable(create_disposable(parent=Path(sys.argv[1]))); print(c.package)',
      scratch,
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
  const roots = [join(scratch, 'A'), join(scratch, 'B')]
  await cp(original, roots[0], { recursive: true })
  await cp(original, roots[1], { recursive: true })
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
    for (let index = 0; index < pages.length; index++) {
      await proxyApi(pages[index], backends[index].baseUrl)
      await pages[index].goto('/')
      // Baseline import is asynchronous; the editor is checked after readiness.
      await expect(
        pages[index].getByRole('region', { name: 'Metadata delivery status' }),
      ).toContainText('Saved here · available metadata published', { timeout: 30_000 })
      await pages[index].getByRole('button', { name: 'Metadata review', exact: true }).click()
      await expect(
        pages[index].getByRole('heading', { name: 'Library catalog', exact: true }),
      ).toBeVisible()
      await expect(pages[index].getByRole('group', { name: 'Title', exact: true })).toBeVisible()
    }
    const [a, b] = pages
    const title = a.getByRole('group', { name: 'Title', exact: true })
    await title.getByRole('checkbox', { name: 'Not set' }).uncheck()
    await a.getByRole('textbox', { name: 'Title', exact: true }).fill('Amber 雪 title')
    await a.getByRole('button', { name: 'Save catalog changes', exact: true }).click()
    await expect(a.getByText('Saved here', { exact: true })).toBeVisible()
    await b
      .getByRole('navigation', { name: 'Catalog families' })
      .getByRole('button', { name: 'Moments', exact: true })
      .click()
    await expect(b.getByRole('textbox', { name: 'Comment', exact: true })).toBeVisible()
    await b.getByRole('textbox', { name: 'Comment', exact: true }).fill('Blue moment comment')
    await b.getByRole('button', { name: 'Save catalog changes', exact: true }).click()
    await expect(b.getByText('Saved here', { exact: true })).toBeVisible()
    // Delivery copies only immutable package objects; drafts and SQLite stay private
    for (let i = 0; i < 3; i++) {
      await cp(
        join(roots[0], '.cairndex/replica/objects'),
        join(roots[1], '.cairndex/replica/objects'),
        { recursive: true },
      )
      await cp(
        join(roots[1], '.cairndex/replica/objects'),
        join(roots[0], '.cairndex/replica/objects'),
        { recursive: true },
      )
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    await a
      .getByRole('navigation', { name: 'Catalog families' })
      .getByRole('button', { name: 'Moments', exact: true })
      .click()
    await expect(a.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue(
      'Blue moment comment',
    )
    await a.getByRole('textbox', { name: 'Comment', exact: true }).fill('Private unsaved moment 雪')
    await a.reload()
    await a.getByRole('button', { name: 'Metadata review', exact: true }).click()
    await a
      .getByRole('navigation', { name: 'Catalog families' })
      .getByRole('button', { name: 'Moments', exact: true })
      .click()
    await expect(a.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue(
      'Private unsaved moment 雪',
    )
    await a.getByRole('button', { name: 'Save catalog changes', exact: true }).click()
    await expect(a.getByText('Saved here', { exact: true })).toBeVisible()
    await a.getByRole('button', { name: 'File Browser', exact: true }).click()
    await a
      .getByRole('region', { name: 'Library File Browser' })
      .getByRole('button', { name: 'Synthetic/', exact: true })
      .click()
    await a
      .getByRole('region', { name: 'Library File Browser' })
      .getByRole('button', { name: '雪.mp4', exact: true })
      .click()
    await expect(a.getByRole('textbox', { name: 'Source', exact: true })).toHaveValue(
      'magnet:?xt=urn:synthetic:test',
    )
    await a
      .getByRole('navigation', { name: 'Catalog families' })
      .getByRole('button', { name: 'Bundles', exact: true })
      .click()
    await expect(a.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
      'Amber 雪 title',
    )
    await a.getByLabel('Select directory-one', { exact: true }).check()
    await a.getByLabel('Transfer destination', { exact: true }).selectOption('bundle-000001')
    await a.getByRole('button', { name: 'Prepare transfer', exact: true }).click()
    await expect(a.getByRole('region', { name: 'Prepared catalog operation' })).toBeVisible()
    await a.getByRole('button', { name: 'Apply reviewed operation', exact: true }).click()
    await expect(a.getByLabel('Select directory-one', { exact: true })).toHaveCount(0)
    // Values beyond JavaScript's integer range survive an unrelated browser edit
    const response = await fetch(
      `${backends[0].baseUrl}/api/v1/libraries/${libraries[0].id}/replica/catalog/entities/asset_bundles/bundle-000000`,
    )
    const entity = (await response.json()) as { fields: Record<string, { value: string }> }
    expect(entity.fields.manual_order.value).toBe('9007199254740993')
    expect(entity.fields.extra_metadata.value).toContain('1.2345678901234567890123456789')
    await a
      .getByRole('navigation', { name: 'Catalog families' })
      .getByRole('button', { name: 'Tags', exact: true })
      .click()
    await a.getByRole('button', { name: 'Edit hierarchy and sibling order', exact: true }).click()
    await expect(a.getByRole('region', { name: 'Hierarchy arrangement' })).toBeVisible()
    await a.getByLabel('Parent of tags-child').selectOption('')
    await a.getByRole('button', { name: 'Apply reviewed operation', exact: true }).click()
    await expect(a.getByLabel('Parent of tags-child')).toHaveValue('')

    // Creation text is durable on the server and survives browser reload before preparation
    await a
      .getByRole('navigation', { name: 'Catalog families' })
      .getByRole('button', { name: 'Tag groups', exact: true })
      .click()
    await a.getByRole('button', { name: 'Create Tag groups', exact: true }).click()
    const creation = a.getByRole('region', { name: 'Create catalog object' })
    await expect(creation.getByRole('textbox', { name: 'Id', exact: true })).toHaveCount(0)
    const draftDelivered = a.waitForResponse(
      (response) =>
        response.url().includes('/drafts/create/tag_groups/') &&
        response.request().method() === 'PUT' &&
        response.status() === 204,
    )
    await creation.getByRole('textbox', { name: 'Name', exact: true }).fill('Created group 雪')
    await draftDelivered
    await a.reload()
    await a.getByRole('button', { name: 'Metadata review', exact: true }).click()
    await a
      .getByRole('navigation', { name: 'Catalog families' })
      .getByRole('button', { name: 'Tag groups', exact: true })
      .click()
    await a.getByRole('button', { name: 'Create Tag groups', exact: true }).click()
    await expect(creation.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
      'Created group 雪',
    )
    await creation.getByRole('button', { name: 'Prepare creation', exact: true }).click()
    await expect(creation.getByRole('button', { name: 'Create reviewed object' })).toBeVisible()
    // A queued preview remains discoverable even after all browser UI state is lost
    await a.reload()
    await a.getByRole('button', { name: 'Metadata review', exact: true }).click()
    await a.getByRole('button', { name: 'Saved operations', exact: true }).click()
    const operations = a.getByRole('region', { name: 'Saved operations', exact: true })
    await operations
      .getByRole('button', { name: /^Open operation/ })
      .first()
      .click()
    await a.getByRole('button', { name: 'Apply recovered review' }).click()
    await expect(a.getByRole('region', { name: 'Recovered operation' })).toHaveCount(0)
    await a
      .getByRole('navigation', { name: 'Catalog families' })
      .getByRole('button', { name: 'Tag groups', exact: true })
      .click()
    await expect(
      a
        .getByRole('navigation', { name: 'Tag groups', exact: true })
        .getByRole('button', { name: 'Created group 雪', exact: true }),
    ).toBeVisible()
    await a.getByRole('button', { name: 'Saved operations', exact: true }).click()

    // Existing AST text remains exact through a name edit and replacement stays a durable draft
    await a
      .getByRole('navigation', { name: 'Catalog families' })
      .getByRole('button', { name: 'Smart Collections', exact: true })
      .click()
    const filter = a.getByRole('textbox', { name: 'Exact filter AST', exact: true })
    const originalFilter = await filter.inputValue()
    await a.getByRole('textbox', { name: 'Name', exact: true }).fill('Named filter 雪')
    await a.getByRole('button', { name: 'Save catalog changes', exact: true }).click()
    await expect(a.getByText('Saved here', { exact: true })).toBeVisible()
    await expect(filter).toHaveValue(originalFilter)
    await a.getByRole('button', { name: 'Compose replacement conditions', exact: true }).click()
    await a.getByRole('textbox', { name: 'Condition 1 value', exact: true }).fill('雪 match')
    const replacement = await filter.inputValue()
    expect(replacement).toContain('雪 match')
    await a.reload()
    await a.getByRole('button', { name: 'Metadata review', exact: true }).click()
    await a
      .getByRole('navigation', { name: 'Catalog families' })
      .getByRole('button', { name: 'Smart Collections', exact: true })
      .click()
    await expect(filter).toHaveValue(replacement)
    await a.getByRole('button', { name: 'Save catalog changes', exact: true }).click()
    await expect(a.getByText('Saved here', { exact: true })).toBeVisible()

    // Conflict-review drafts preserve the selected value and require the displayed revision basis
    for (const page of [a, b]) {
      await page
        .getByRole('navigation', { name: 'Catalog families' })
        .getByRole('button', { name: 'Moments', exact: true })
        .click()
      await page
        .getByRole('textbox', { name: 'Comment', exact: true })
        .fill(page === a ? 'Amber reviewed comment' : 'Blue reviewed comment')
      await page.getByRole('button', { name: 'Save catalog changes', exact: true }).click()
      await expect(page.getByText('Saved here', { exact: true })).toBeVisible()
    }
    for (let i = 0; i < 3; i++) {
      await cp(
        join(roots[0], '.cairndex/replica/objects'),
        join(roots[1], '.cairndex/replica/objects'),
        { recursive: true },
      )
      await cp(
        join(roots[1], '.cairndex/replica/objects'),
        join(roots[0], '.cairndex/replica/objects'),
        { recursive: true },
      )
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    await a.getByRole('button', { name: 'Review Comment', exact: true }).click()
    const review = a.getByRole('region', { name: 'Complete conflict review', exact: true })
    const reviewDelivered = a.waitForResponse(
      (response) =>
        response.url().includes('/drafts/review/') &&
        response.request().method() === 'PUT' &&
        response.status() === 204,
    )
    await review.getByRole('radio', { name: /Blue reviewed comment/ }).check()
    await reviewDelivered
    await a.reload()
    await a.getByRole('button', { name: 'Metadata review', exact: true }).click()
    await a
      .getByRole('navigation', { name: 'Catalog families' })
      .getByRole('button', { name: 'Moments', exact: true })
      .click()
    await a.getByRole('button', { name: 'Review Comment', exact: true }).click()
    await expect(review.getByRole('radio', { name: /Blue reviewed comment/ })).toBeChecked()
    await review.getByRole('button', { name: 'Prepare choice', exact: true }).click()
    await a.getByRole('button', { name: 'Apply reviewed operation', exact: true }).click()
    await expect(a.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue(
      'Blue reviewed comment',
    )
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
    await Promise.all(backends.map((backend) => stopBackend(backend.child)))
    await rm(scratch, { recursive: true, force: true })
  }
})
