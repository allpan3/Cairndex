import { expect, test, type Page } from '@playwright/test'

/**
 * Layout of the grouping review dialog's folder rows, in a real browser.
 *
 * These exist because two faults reached the owner that the unit suite could not
 * have caught: sibling rows drawn at two different indents, and a listed folder's
 * row stranded at the bottom of its own files. Both are pure layout, and jsdom
 * applies no stylesheet — `vitest` renders the same markup and sees nothing
 * wrong. Only a browser can fail these.
 *
 * Asserted as *relationships* (these rows share an x; this row is above those
 * rows), never as pixel values, so ordinary restyling does not break them.
 */

function file(index: number, directory = 'trip/album') {
  return {
    asset_file_id: `photo${index}`,
    relative_path: `${directory}/img${String(index).padStart(3, '0')}.png`,
    proposed_role: 'image',
    sequence: index + 1,
  }
}

const ALBUM_FILES = Array.from({ length: 12 }, (_unused, index) => file(index))

function proposal(over: Record<string, unknown>) {
  return {
    id: 'p1',
    kind: 'bundle',
    title: 'trip',
    directory: 'trip',
    parent_proposal_id: null,
    target_bundle_id: null,
    target_bundle_title: null,
    create_new_bundle: false,
    target_collection_id: null,
    is_collection_context: false,
    confidence: 0.9,
    reason: null,
    directories: [],
    files: [],
    ...over,
  }
}

/** A work with an album subfolder, beside a plain bundle and a collection —
 *  three top-level rows of different kinds, which is what exposed the indent. */
const PROPOSALS = [
  proposal({
    id: 'p-work',
    title: 'trip',
    // Low confidence, so this row carries the amber attention bar. The bar was
    // the first suspect for the misalignment and turned out to be innocent;
    // keeping it here means a regression cannot hide behind it again.
    confidence: 0.5,
    reason: '1 file(s) and a folder of 12',
    directories: [
      {
        id: 'dir1',
        directory_path: 'trip/album',
        name: 'album',
        file_count: 12,
        expanded: false,
      },
    ],
    files: [
      {
        asset_file_id: 'clip',
        relative_path: 'trip/clip.mp4',
        proposed_role: 'primary_video',
        sequence: 0,
      },
      ...ALBUM_FILES,
    ],
  }),
  proposal({
    id: 'p-plain',
    title: 'movie',
    directory: 'movie',
    files: [
      {
        asset_file_id: 'film',
        relative_path: 'movie/film.mp4',
        proposed_role: 'primary_video',
        sequence: 0,
      },
    ],
  }),
  proposal({
    id: 'p-coll',
    kind: 'container',
    title: 'shelf',
    directory: 'shelf',
    confidence: 0.85,
  }),
]

async function mockApi(page: Page) {
  const plan = {
    id: 'plan1',
    status: 'open',
    rule_version: 6,
    scan_job_id: null,
    stem_levels: {},
    generated_at: '2026-08-29T00:00:00Z',
    applied_at: null,
    proposals: structuredClone(PROPOSALS),
  }
  await page.route('**/api/v1/libraries', (r) =>
    r.fulfill({
      json: [{ id: 'lib1', name: 'Test Library', root_path: '/srv/lib', status: 'available' }],
    }),
  )
  await page.route('**/auth/status', (r) =>
    r.fulfill({ json: { protected: false, unlocked: true } }),
  )
  await page.route('**/ownership', (r) => r.fulfill({ json: { state: 'own', mountable: true } }))
  await page.route('**/bundles/counts', (r) =>
    r.fulfill({
      json: { all: 0, recent: 0, uncategorized: 0, untagged: 0, missing: 0, unbundled: 13 },
    }),
  )
  await page.route('**/collections/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/collections?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/smart-collections', (r) => r.fulfill({ json: [] }))
  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({ json: { items: [], total: 0, offset: 0, limit: 100 } }),
  )
  await page.route('**/grouping/plans', (r) => r.fulfill({ json: [plan] }))
  await page.route('**/grouping/plans/plan1', (r) => r.fulfill({ json: plan }))
  // The one mutation these tests drive: declining a folder, and taking it back.
  await page.route('**/proposals/*/directories/*', (r) => {
    const expanded = (r.request().postDataJSON() as { expanded: boolean }).expanded
    const target = plan.proposals.find((p) => p.id === 'p-work')!
    target.directories = target.directories.map((d) => ({ ...d, expanded }))
    r.fulfill({ json: target })
  })
}

/** Left edge of a row's first leading control — what "indent" means visually. */
async function indentOf(page: Page, row: ReturnType<Page['locator']>) {
  const box = await row.locator('.grp-disclosure, .grp-disclosure-spacer').first().boundingBox()
  if (!box) throw new Error('row has no leading control')
  return Math.round(box.x)
}

async function openPlan(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'More library actions' }).click()
  await page.getByRole('button', { name: 'Suggest grouping' }).click()
  await expect(page.locator('.grp-row').first()).toBeVisible()
}

test('suggestion rows at the same level share one indent', async ({ page }) => {
  // The fault: a collection row carried horizontal padding a bundle row did not,
  // so siblings sat 4px apart and read as parent and child.
  await mockApi(page)
  await openPlan(page)

  const rows = page.locator('.grp-tree > .grp-node > .grp-row')
  await expect(rows).toHaveCount(3)
  const indents = await Promise.all([0, 1, 2].map((index) => indentOf(page, rows.nth(index))))
  expect(new Set(indents).size).toBe(1)

  // And the kinds really are different, or the assertion above proves nothing.
  await expect(page.locator('.grp-row--collection')).toHaveCount(1)
  await expect(page.locator('.grp-row--bundle')).toHaveCount(2)
  await expect(page.locator('.grp-row--attention')).toHaveCount(1)
})

test('the attention bar is drawn on a top-level row, not clipped away', async ({ page }) => {
  // It hangs into the left margin; only nested rows had room for it, so the
  // marker was missing from exactly the rows read first.
  await mockApi(page)
  await openPlan(page)

  const marked = page.locator('.grp-row--attention').first()
  const tree = page.locator('.grp-tree')
  const rowBox = await marked.boundingBox()
  const treeBox = await tree.boundingBox()
  expect(rowBox && treeBox).toBeTruthy()
  expect(rowBox!.x).toBeGreaterThanOrEqual(treeBox!.x)
})

test('a folder row sits directly above the files it covers', async ({ page }) => {
  // The fault: folder rows were drawn after all the loose files, so listing a
  // folder left its row stranded below its own contents, looking empty.
  await mockApi(page)
  await openPlan(page)
  await page.getByRole('button', { name: 'Show files' }).click()

  // Scoped to the suggestion that has the folder: "Show files" opens every
  // list in the plan, and the other bundles' files are not this test's subject.
  const work = page.locator('.grp-node', { has: page.locator('.grp-file--folder') }).first()
  const folder = work.locator('.grp-file--folder')
  const loose = work.locator('.grp-file:not(.grp-file--folder):not(.grp-file--in-folder)')
  await expect(folder).toBeVisible()
  // Collapsed: one folder row standing in for twelve, beside the loose file.
  await expect(loose).toHaveCount(1)

  await page.getByRole('button', { name: /^List the 12 files/ }).click()
  const covered = work.locator('.grp-file--in-folder')
  await expect(covered).toHaveCount(12)

  const folderY = (await folder.boundingBox())!.y
  const firstCoveredY = (await covered.first().boundingBox())!.y
  const loneFileY = (await loose.first().boundingBox())!.y

  // Header, not trailer: below the bundle's own media, above everything it covers.
  expect(folderY).toBeGreaterThan(loneFileY)
  expect(folderY).toBeLessThan(firstCoveredY)

  // And its files read as its contents rather than as peers of the loose one.
  const coveredX = (await covered.first().locator('.grp-file__name').boundingBox())!.x
  const looseX = (await loose.first().locator('.grp-file__name').boundingBox())!.x
  expect(coveredX).toBeGreaterThan(looseX)
})

test('looking inside a folder does not decide anything about it', async ({ page }) => {
  await mockApi(page)
  await openPlan(page)
  await page.getByRole('button', { name: 'Show files' }).click()

  await page.getByRole('button', { name: 'Show what is in album' }).click()
  const peek = page.getByRole('list', { name: 'Inside album' })
  await expect(peek.getByRole('listitem')).toHaveCount(12)

  // Still one row as far as the plan is concerned.
  await expect(page.locator('.grp-file--folder')).toContainText('Folder · 12 files')
  await expect(page.getByRole('button', { name: /^List the 12 files/ })).toBeVisible()
})
