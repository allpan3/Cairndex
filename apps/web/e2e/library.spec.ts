import { expect, test, type Page } from '@playwright/test'

// Hermetic e2e: the API is mocked so the desktop library UI can be exercised
// in a real browser (where the virtualized grid actually lays out) without a
// running backend.

function bundle(i: number) {
  return {
    id: `b${i}`,
    title: `Movie ${i}`,
    rating: i % 5,
    file_count: 1,
    total_size: 1_000_000 * (i + 1),
    has_missing: false,
    has_cover: false,
    media_kind: 'video',
    width: 1920,
    height: 1080,
    duration: 60 + i,
    extension: 'mp4',
    date_added: '2026-06-25T00:00:00Z',
  }
}

async function mockApi(page: Page) {
  const items = Array.from({ length: 40 }, (_, i) => bundle(i))
  await page.route('**/api/v1/libraries', (r) =>
    r.fulfill({
      json: [{ id: 'lib1', name: 'Test Library', root_path: '/srv/lib', status: 'available' }],
    }),
  )
  await page.route('**/bundles/counts', (r) =>
    r.fulfill({ json: { all: 40, recent: 40, uncategorized: 5, untagged: 3, missing: 0 } }),
  )
  await page.route('**/collections/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/collections?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({ json: { items, total: items.length, offset: 0, limit: 100 } }),
  )
  await page.route('**/bundles/b0**', (r) => {
    const url = r.request().url()
    if (url.includes('/files')) {
      r.fulfill({
        json: [
          {
            id: 'f0',
            bundle_id: 'b0',
            storage_root_id: 'r0',
            relative_path: 'movie.mp4',
            original_filename: 'movie.mp4',
            display_title: 'movie.mp4',
            role: 'primary_video',
            media_kind: 'video',
            mime_type: null,
            sequence: 0,
            size_bytes: 1000,
            availability: 'available',
            tech_metadata: { width: 1920, height: 1080, duration: 60 },
            created_at: '2026-06-25T00:00:00Z',
            updated_at: '2026-06-25T00:00:00Z',
          },
          {
            id: 'f1',
            bundle_id: 'b0',
            relative_path: 'poster.jpg',
            original_filename: 'poster.jpg',
            display_title: 'poster.jpg',
            role: 'image',
            media_kind: 'image',
            mime_type: 'image/jpeg',
            sequence: 1,
            size_bytes: 500,
            availability: 'missing',
            tech_metadata: { width: 640, height: 480 },
            created_at: '2026-06-25T00:00:00Z',
            updated_at: '2026-06-25T00:00:00Z',
          },
        ],
      })
    } else {
      r.fulfill({
        json: {
          id: 'b0',
          title: 'Movie 0',
          note: null,
          source_url: null,
          rating: 0,
          cover_file_id: null,
          resume_file_id: 'f0',
          created_at: '2026-06-25T00:00:00Z',
          imported_at: '2026-06-25T00:00:00Z',
          updated_at: '2026-06-25T00:00:00Z',
        },
      })
    }
  })
}

test('renders the shell and browses bundles', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  await expect(page.getByText('Cairndex')).toBeVisible()
  await expect(page.getByRole('button', { name: /Recently Added/ })).toBeVisible()
  // Grid renders cards from the mocked browse response.
  await expect(page.getByText('Movie 0')).toBeVisible()
  await expect(page.getByText('40 items')).toBeVisible()
})

test('persisted hidden sidebar leaves the content pane usable', async ({ page }) => {
  await mockApi(page)
  await page.addInitScript(() => {
    localStorage.setItem('cairndex.prefs', JSON.stringify({ sidebarVisible: false }))
  })
  await page.goto('/')

  await expect(page.locator('.sidebar')).toHaveCount(0)
  const contentBounds = await page.locator('.center').boundingBox()
  expect(contentBounds).not.toBeNull()
  expect(contentBounds!.width).toBeGreaterThan(500)
  expect(contentBounds!.x).toBe(0)
  await expect(page.getByText('Movie 0')).toBeVisible()
})

function jobRead(over: Record<string, unknown>) {
  return {
    id: 'job',
    library_id: 'lib1',
    job_type: 'scan',
    status: 'running',
    phase: null,
    message: null,
    payload: {},
    processed: 0,
    total: null,
    result: null,
    error: null,
    cancel_requested: false,
    created_at: '2026-06-25T00:00:00Z',
    started_at: '2026-06-25T00:00:00Z',
    finished_at: null,
    ...over,
  }
}

test('Update surfaces live job progress with phase and counts', async ({ page }) => {
  await mockApi(page)
  // Scan job: enqueue returns a running snapshot, then polling completes it.
  let scanPolls = 0
  await page.route('**/jobs/scan', (r) =>
    r.fulfill({
      json: jobRead({ id: 'job-scan', phase: 'discovering', processed: 42, total: 100 }),
    }),
  )
  await page.route('**/jobs/probe', (r) =>
    r.fulfill({
      json: jobRead({ id: 'job-probe', job_type: 'probe', status: 'succeeded', result: {} }),
    }),
  )
  await page.route('**/jobs/storyboards', (r) =>
    r.fulfill({
      json: jobRead({
        id: 'job-storyboard',
        job_type: 'storyboard',
        status: 'succeeded',
        result: {},
      }),
    }),
  )
  await page.route('**/api/v1/jobs/job-scan', (r) => {
    scanPolls += 1
    const done = scanPolls >= 2
    r.fulfill({
      json: jobRead({
        id: 'job-scan',
        status: done ? 'succeeded' : 'running',
        phase: done ? null : 'discovering',
        processed: done ? 100 : 42,
        total: 100,
        result: done ? { grouping_proposal_count: 0, missing_total: 2 } : null,
        finished_at: done ? '2026-06-25T00:01:00Z' : null,
      }),
    })
  })
  await page.route('**/api/v1/jobs/job-probe', (r) =>
    r.fulfill({
      json: jobRead({ id: 'job-probe', job_type: 'probe', status: 'succeeded', result: {} }),
    }),
  )
  await page.route('**/api/v1/jobs/job-storyboard', (r) =>
    r.fulfill({
      json: jobRead({
        id: 'job-storyboard',
        job_type: 'storyboard',
        status: 'succeeded',
        result: {},
      }),
    }),
  )

  await page.goto('/')
  await page.getByRole('button', { name: /Update/ }).click()

  // The progress bar with the current phase + determinate count is visible while running.
  await expect(page.getByRole('progressbar')).toBeVisible()
  await expect(page.getByText('Discovering files')).toBeVisible()
  await expect(page.getByText('42/100')).toBeVisible()
  await expect(page.getByText('Scan complete: 2 linked files are missing.')).toBeVisible()
})

test('standalone Scan reports the linked missing-file total', async ({ page }) => {
  await mockApi(page)
  await page.route('**/jobs/scan', (route) =>
    route.fulfill({
      json: jobRead({
        id: 'job-scan',
        status: 'succeeded',
        result: { grouping_proposal_count: 0, missing_total: 1 },
        finished_at: '2026-06-25T00:01:00Z',
      }),
    }),
  )

  await page.goto('/')
  await page.getByRole('button', { name: 'More library maintenance actions' }).click()
  await page.getByRole('button', { name: 'Scan new files' }).click()

  await expect(page.getByText('Scan complete: 1 linked file is missing.')).toBeVisible()
})

test('each Update stage has a standalone maintenance action', async ({ page }) => {
  await mockApi(page)
  await page.route('**/jobs/storyboards', (route) =>
    route.fulfill({
      json: jobRead({
        id: 'job-storyboard',
        job_type: 'storyboard',
        status: 'succeeded',
        result: {},
      }),
    }),
  )

  await page.goto('/')
  await page.getByRole('button', { name: 'More library maintenance actions' }).click()
  await expect(page.getByRole('button', { name: 'Scan new files' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Collect metadata' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Suggest grouping' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Generate storyboards' })).toBeVisible()

  const storyboardRequest = page.waitForRequest((request) =>
    request.url().endsWith('/jobs/storyboards'),
  )
  await page.getByRole('button', { name: 'Generate storyboards' }).click()
  await storyboardRequest
})

test('repeated Suggest grouping leaves confirmed bundles out of the new plan', async ({ page }) => {
  await mockApi(page)
  const oldProposal = {
    id: 'settled1',
    kind: 'bundle',
    title: 'Already bundled',
    directory: 'Settled',
    parent_proposal_id: null,
    target_bundle_id: null,
    confidence: 0.9,
    reason: 'old plan',
    files: [
      {
        asset_file_id: 'settled-file',
        relative_path: 'Settled/movie.mp4',
        proposed_role: 'primary_video',
        sequence: 0,
      },
    ],
  }
  let activePlanId = 'plan1'
  let generated = false
  await page.route('**/grouping/plans', (route) => {
    if (route.request().method() === 'POST') {
      activePlanId = 'plan2'
      generated = true
      return route.fulfill({
        status: 201,
        json: {
          id: activePlanId,
          status: 'open',
          rule_version: 2,
          scan_job_id: null,
          generated_at: '2026-07-13T00:01:00Z',
          applied_at: null,
          proposals: [],
        },
      })
    }
    return route.fulfill({
      json: [
        {
          id: activePlanId,
          status: 'open',
          rule_version: 2,
          generated_at: '2026-07-13T00:00:00Z',
          applied_at: null,
          proposal_count: generated ? 0 : 1,
        },
      ],
    })
  })
  await page.route('**/grouping/plans/plan1', (route) =>
    route.fulfill({
      json: {
        id: 'plan1',
        status: 'open',
        rule_version: 2,
        scan_job_id: 'job1',
        generated_at: '2026-07-13T00:00:00Z',
        applied_at: null,
        proposals: [oldProposal],
      },
    }),
  )
  await page.route('**/grouping/plans/plan2', (route) =>
    route.fulfill({
      json: {
        id: 'plan2',
        status: 'open',
        rule_version: 2,
        scan_job_id: null,
        generated_at: '2026-07-13T00:01:00Z',
        applied_at: null,
        proposals: [],
      },
    }),
  )

  await page.goto('/')
  await page.getByRole('button', { name: 'More library maintenance actions' }).click()
  await page.getByRole('button', { name: 'Suggest grouping' }).click()
  await expect(page.getByText('Already bundled')).toBeVisible()
  await page.locator('.grp-foot').getByRole('button', { name: 'Suggest grouping' }).click()

  await expect(
    page.getByText('Nothing to group — there are no unbundled files awaiting suggestions.'),
  ).toBeVisible()
  await expect(page.getByText('Already bundled')).toHaveCount(0)
  expect(generated).toBe(true)
})

test('grouping title editors preserve wrapped geometry and grow while typing', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 })
  await mockApi(page)
  const proposals = [
    {
      id: 'collection-width',
      kind: 'container',
      title: 'A Long Collection Suggestion',
      directory: 'Long Collection',
      parent_proposal_id: null,
      target_bundle_id: null,
      target_bundle_title: null,
      create_new_bundle: false,
      confidence: 0.9,
      reason: 'holds related bundles',
      files: [],
    },
    {
      id: 'bundle-width',
      kind: 'bundle',
      title:
        'A Very Long Bundle Suggestion That Deliberately Wraps Across Multiple Lines Without Moving Any Other Grouping Review Text When Rename Mode Starts',
      directory: 'Long Bundle',
      parent_proposal_id: 'collection-width',
      target_bundle_id: null,
      target_bundle_title: null,
      create_new_bundle: false,
      confidence: 0.9,
      reason: 'same filename stem',
      files: [
        {
          asset_file_id: 'long-file',
          relative_path: 'Long Bundle/movie.mp4',
          proposed_role: 'primary_video',
          sequence: 0,
        },
      ],
    },
  ]
  await page.route('**/grouping/plans', (route) =>
    route.fulfill({
      json: [
        {
          id: 'plan-width',
          status: 'open',
          rule_version: 4,
          generated_at: '2026-07-14T00:00:00Z',
          applied_at: null,
          proposal_count: proposals.length,
        },
      ],
    }),
  )
  await page.route('**/grouping/plans/plan-width', (route) =>
    route.fulfill({
      json: {
        id: 'plan-width',
        status: 'open',
        rule_version: 4,
        scan_job_id: null,
        generated_at: '2026-07-14T00:00:00Z',
        applied_at: null,
        proposals,
      },
    }),
  )

  await page.goto('/')
  await page.getByRole('button', { name: 'More library maintenance actions' }).click()
  await page.getByRole('button', { name: 'Suggest grouping' }).click()

  for (const [kind, title] of [
    ['collection', 'A Long Collection Suggestion'],
    [
      'bundle',
      'A Very Long Bundle Suggestion That Deliberately Wraps Across Multiple Lines Without Moving Any Other Grouping Review Text When Rename Mode Starts',
    ],
  ] as const) {
    const titleButton = page.getByRole('button', {
      name: `Rename ${kind} suggestion ${title}`,
    })
    const titleRow = titleButton.locator('xpath=ancestor::*[contains(@class, "grp-row")][1]')
    const modal = page.locator('.grp-modal')
    const titleBox = await titleButton.boundingBox()
    const rowBox = await titleRow.boundingBox()
    const modalBox = await modal.boundingBox()
    if (!titleBox || !rowBox || !modalBox) throw new Error(`missing ${kind} title geometry`)
    if (kind === 'bundle') expect(titleBox.height).toBeGreaterThan(18)
    await titleButton.dblclick()
    const input = page.getByRole('textbox', {
      name: `${kind[0].toUpperCase()}${kind.slice(1)} suggestion title`,
    })
    const initialBox = await input.boundingBox()
    const editingRowBox = await input
      .locator('xpath=ancestor::*[contains(@class, "grp-row")][1]')
      .boundingBox()
    const editingModalBox = await modal.boundingBox()
    if (!initialBox || !editingRowBox || !editingModalBox) {
      throw new Error(`missing ${kind} editor geometry`)
    }
    expect(Math.abs(initialBox.width - titleBox.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(initialBox.height - titleBox.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(initialBox.y - titleBox.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(editingRowBox.height - rowBox.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(editingRowBox.y - rowBox.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(editingModalBox.height - modalBox.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(editingModalBox.y - modalBox.y)).toBeLessThanOrEqual(1)
    if (kind === 'collection') {
      await input.fill(`${title} With A Longer Ending`)
      await expect
        .poll(async () => (await input.boundingBox())?.width ?? 0)
        .toBeGreaterThan(initialBox.width)
    }
    await input.press('Escape')
  }
})

test('switches one addition row between an existing and a new bundle', async ({ page }) => {
  await mockApi(page)
  let createNewBundle = false
  let title = 'Surf On The Ridge - 4K'
  const targetTitle = 'Nora Vance - [Lumina.com] - [2023] - Sky, Sand, Sea & Salt - 4K'
  const destinationWrites: boolean[] = []
  const proposal = () => ({
    id: 'addition-ui',
    kind: 'bundle',
    title,
    directory: 'Western/Nora Vance',
    parent_proposal_id: null,
    target_bundle_id: 'existing-ui',
    target_bundle_title: targetTitle,
    create_new_bundle: createNewBundle,
    confidence: 0.8,
    reason: 'add 2 new file(s) to existing bundle',
    files: [
      {
        asset_file_id: 'addition-video',
        relative_path: 'Western/Nora Vance/Surf On The Ridge - 4K.mp4',
        proposed_role: createNewBundle ? 'primary_video' : 'video_part',
        sequence: 0,
      },
      {
        asset_file_id: 'addition-cover',
        relative_path: 'Western/Nora Vance/Surf On The Ridge - 4K.jpg',
        proposed_role: createNewBundle ? 'cover' : 'image',
        sequence: 1,
      },
    ],
  })
  await page.route('**/grouping/plans', (route) =>
    route.fulfill({
      json: [
        {
          id: 'plan-destination',
          status: 'open',
          rule_version: 4,
          generated_at: '2026-07-14T00:00:00Z',
          applied_at: null,
          proposal_count: 1,
        },
      ],
    }),
  )
  await page.route('**/grouping/plans/plan-destination', (route) =>
    route.fulfill({
      json: {
        id: 'plan-destination',
        status: 'open',
        rule_version: 4,
        scan_job_id: null,
        generated_at: '2026-07-14T00:00:00Z',
        applied_at: null,
        proposals: [proposal()],
      },
    }),
  )
  await page.route('**/proposals/addition-ui/destination', (route) => {
    createNewBundle = (route.request().postDataJSON() as { create_new_bundle: boolean })
      .create_new_bundle
    destinationWrites.push(createNewBundle)
    return route.fulfill({ json: proposal() })
  })
  await page.route('**/proposals/addition-ui', (route) => {
    title = (route.request().postDataJSON() as { title: string }).title
    return route.fulfill({ json: proposal() })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'More library maintenance actions' }).click()
  await page.getByRole('button', { name: 'Suggest grouping' }).click()
  const checkbox = page.getByRole('checkbox', { name: 'Accept Surf On The Ridge - 4K' })
  await expect(checkbox).toBeChecked()
  const additionTitle = page.getByText(`Add to 🎬 ${targetTitle}`, { exact: true })
  const dragHandle = page.getByRole('button', { name: `Drag bundle Add to 🎬 ${targetTitle}` })
  const destinationButton = page.getByRole('button', {
    name: 'Create a new bundle from these files',
  })
  const rowContent = page.locator('.grp-row__content')
  const fileCount = page.getByText('2 new files', { exact: true })
  const selectBar = page.locator('.grp-selectbar')
  await expect(additionTitle).toBeVisible()
  await expect(page.locator('.grp-root-drop')).toHaveCount(0)
  await expect(destinationButton).toHaveAttribute('aria-pressed', 'false')
  await expect(destinationButton).not.toHaveClass(/is-active/)
  await expect(destinationButton).toHaveAttribute(
    'data-tip',
    'Create a new bundle from these files',
  )
  await expect(page.locator('.grp-conf')).toHaveCount(0)
  await expect(page.locator('.grp-manual')).toHaveCount(0)
  await expect(page.getByText('Create new bundle instead', { exact: true })).toHaveCount(0)

  const titleBox = await additionTitle.boundingBox()
  const dragBox = await dragHandle.boundingBox()
  const destinationBox = await destinationButton.boundingBox()
  const contentBox = await rowContent.boundingBox()
  const countBox = await fileCount.boundingBox()
  const selectBox = await selectBar.boundingBox()
  if (!titleBox || !dragBox || !destinationBox || !contentBox || !countBox || !selectBox) {
    throw new Error('missing grouping destination geometry')
  }
  expect(titleBox.y - (selectBox.y + selectBox.height)).toBeLessThanOrEqual(28)
  expect(titleBox.x - (dragBox.x + dragBox.width)).toBeLessThanOrEqual(6)
  expect(destinationBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width)
  expect(
    Math.abs(destinationBox.y + destinationBox.height / 2 - (titleBox.y + titleBox.height / 2)),
  ).toBeLessThanOrEqual(3)
  expect(countBox.x).toBeGreaterThanOrEqual(contentBox.x)

  await destinationButton.hover()
  await expect
    .poll(() =>
      destinationButton.evaluate((element) => getComputedStyle(element, '::after').opacity),
    )
    .toBe('1')
  await destinationButton.click()

  const addBackButton = page.getByRole('button', {
    name: `Add these files to “${targetTitle}” instead`,
  })
  await expect(addBackButton).toHaveAttribute('aria-pressed', 'true')
  await expect(addBackButton).not.toHaveClass(/is-active/)
  await expect(page.getByText('2 files', { exact: true })).toBeVisible()
  await expect(page.getByText('manual', { exact: true })).toHaveCount(0)
  await expect(page.getByText('create 2 files as a new bundle', { exact: true })).toHaveCount(0)
  await expect(checkbox).toBeChecked()
  await expect(page.locator('.grp-node--bundle')).toHaveCount(1)
  await expect(page.locator('.grp-files')).toHaveCount(1)
  const renameTitle = page.getByRole('button', {
    name: 'Rename bundle suggestion Surf On The Ridge - 4K',
  })
  const bundleRow = page.locator('.grp-row--bundle')
  const modal = page.locator('.grp-modal')
  const bundleRowBox = await bundleRow.boundingBox()
  const modalBox = await modal.boundingBox()
  if (!bundleRowBox || !modalBox) {
    throw new Error('missing pre-rename grouping geometry')
  }
  await renameTitle.dblclick()
  const titleInput = page.getByRole('textbox', { name: 'Bundle suggestion title' })
  await expect(addBackButton).toBeDisabled()
  const editingRowBox = await bundleRow.boundingBox()
  const editingModalBox = await modal.boundingBox()
  if (!editingRowBox || !editingModalBox) {
    throw new Error('missing active-rename grouping geometry')
  }
  expect(Math.abs(editingRowBox.y - bundleRowBox.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(editingRowBox.height - bundleRowBox.height)).toBeLessThanOrEqual(1)
  expect(Math.abs(editingModalBox.y - modalBox.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(editingModalBox.height - modalBox.height)).toBeLessThanOrEqual(1)
  await titleInput.fill('Separate Feature')
  await titleInput.press('Enter')
  await expect(
    page.getByRole('button', { name: 'Rename bundle suggestion Separate Feature' }),
  ).toBeVisible()
  await expect(addBackButton).toBeEnabled()

  await addBackButton.click()
  await expect(page.getByText(`Add to 🎬 ${targetTitle}`, { exact: true })).toBeVisible()
  expect(destinationWrites).toEqual([true, false])
})

test('edits grouping suggestions with drag and drop before accepting them', async ({ page }) => {
  await mockApi(page)
  const proposals = [
    {
      id: 'collection1',
      kind: 'container',
      title: 'Movies',
      directory: '',
      parent_proposal_id: null as string | null,
      target_bundle_id: null,
      confidence: 0.9,
      reason: 'shared directory',
      files: [],
    },
    {
      id: 'proposal1',
      kind: 'bundle',
      title: 'SRCV-005 - cut',
      directory: 'SRCV-005',
      parent_proposal_id: null as string | null,
      target_bundle_id: null,
      confidence: 0.95,
      reason: 'same filename stem',
      files: [
        {
          asset_file_id: 'file1',
          relative_path: 'SRCV-005/SRCV-005.mp4',
          proposed_role: 'primary_video',
          sequence: 0,
        },
        {
          asset_file_id: 'file2',
          relative_path: 'SRCV-005/SRCV-005.mp3',
          proposed_role: 'attachment',
          sequence: 1,
        },
        {
          asset_file_id: 'file3',
          relative_path: 'SRCV-005/cover.jpg',
          proposed_role: 'cover',
          sequence: 2,
        },
      ],
    },
    {
      id: 'proposal2',
      kind: 'bundle',
      title: 'Extras',
      directory: 'Extras',
      parent_proposal_id: null as string | null,
      target_bundle_id: null,
      confidence: 0.8,
      reason: 'same directory',
      files: [
        {
          asset_file_id: 'file4',
          relative_path: 'Extras/trailer.mp4',
          proposed_role: 'primary_video',
          sequence: 0,
        },
      ],
    },
  ]
  let renamedCollection: string | null = null
  let fileMove: { source: string; target: string; index: number } | null = null
  const bundleParents: Array<string | null> = []
  await page.route('**/grouping/plans', (route) =>
    route.fulfill({
      json: [
        {
          id: 'plan1',
          status: 'open',
          rule_version: 2,
          generated_at: '2026-07-13T00:00:00Z',
          applied_at: null,
          proposal_count: proposals.length,
        },
      ],
    }),
  )
  await page.route('**/grouping/plans/plan1', (route) =>
    route.fulfill({
      json: {
        id: 'plan1',
        status: 'open',
        rule_version: 2,
        scan_job_id: 'job1',
        generated_at: '2026-07-13T00:00:00Z',
        applied_at: null,
        proposals,
      },
    }),
  )
  await page.route('**/grouping/plans/plan1/proposals/collection1', (route) => {
    renamedCollection = (route.request().postDataJSON() as { title: string }).title
    proposals[0].title = renamedCollection
    return route.fulfill({ json: proposals[0] })
  })
  await page.route('**/grouping/plans/plan1/proposals/proposal2/files/file4/move', (route) => {
    const body = route.request().postDataJSON() as {
      target_proposal_id: string
      target_index: number
    }
    const source = proposals[2]
    const target = proposals.find((proposal) => proposal.id === body.target_proposal_id)!
    const sourceIndex = source.files.findIndex((file) => file.asset_file_id === 'file4')
    const [moved] = source.files.splice(sourceIndex, 1)
    target.files.splice(body.target_index, 0, moved!)
    source.files.forEach((file, sequence) => (file.sequence = sequence))
    target.files.forEach((file, sequence) => (file.sequence = sequence))
    fileMove = { source: source.id, target: target.id, index: body.target_index }
    return route.fulfill({ json: [source, target] })
  })
  await page.route('**/grouping/plans/plan1/proposals/proposal1/parent', (route) => {
    const bundleParent = (route.request().postDataJSON() as { parent_proposal_id: string | null })
      .parent_proposal_id
    bundleParents.push(bundleParent)
    proposals[1].parent_proposal_id = bundleParent
    return route.fulfill({ json: proposals[1] })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'More library maintenance actions' }).click()
  await page.getByRole('button', { name: 'Suggest grouping' }).click()
  await page.getByRole('button', { name: 'Rename collection suggestion Movies' }).dblclick()
  const input = page.getByRole('textbox', { name: 'Collection suggestion title' })
  await input.fill('Favorites')
  await input.press('Enter')

  await expect.poll(() => renamedCollection).toBe('Favorites')
  await expect(
    page.getByRole('button', { name: 'Rename collection suggestion Favorites' }),
  ).toBeVisible()

  const targetList = page.getByRole('list', { name: 'Files in SRCV-005 - cut' })
  const targetFile = targetList.locator('.grp-file').last()
  const targetBox = await targetFile.boundingBox()
  if (!targetBox) throw new Error('missing file drop target')
  await page.getByRole('button', { name: 'Drag file trailer.mp4' }).dragTo(targetFile, {
    targetPosition: { x: targetBox.width / 2, y: targetBox.height - 2 },
  })
  await expect.poll(() => fileMove).toEqual({ source: 'proposal2', target: 'proposal1', index: 3 })
  await expect(targetList.locator('.grp-file__name')).toHaveText([
    'SRCV-005.mp4',
    'SRCV-005.mp3',
    'cover.jpg',
    'trailer.mp4',
  ])
  const emptyBundle = page.getByRole('checkbox', { name: 'Accept Extras' })
  await expect(emptyBundle).not.toBeChecked()
  await expect(emptyBundle).toBeDisabled()

  const collectionRow = page.locator('.grp-row--collection', {
    has: page.getByRole('button', { name: 'Rename collection suggestion Favorites' }),
  })
  const bundleHandle = page.getByRole('button', { name: 'Drag bundle SRCV-005 - cut' })
  const collectionTransfer = await page.evaluateHandle(() => new DataTransfer())
  await bundleHandle.dispatchEvent('dragstart', { dataTransfer: collectionTransfer })
  await collectionRow.dispatchEvent('dragover', { dataTransfer: collectionTransfer })
  await collectionRow.dispatchEvent('drop', { dataTransfer: collectionTransfer })
  await bundleHandle.dispatchEvent('dragend', { dataTransfer: collectionTransfer })
  await collectionTransfer.dispose()
  await expect.poll(() => bundleParents).toEqual(['collection1'])
  const collectionCheckbox = page.getByRole('checkbox', { name: 'Accept Favorites' })
  await expect(collectionCheckbox).toBeChecked()
  await expect(
    collectionRow.locator('..').getByText('SRCV-005 - cut', { exact: true }),
  ).toBeVisible()

  const rootTarget = page.locator('.grp-root-drop')
  const rootTransfer = await page.evaluateHandle(() => new DataTransfer())
  await bundleHandle.dispatchEvent('dragstart', { dataTransfer: rootTransfer })
  await expect(rootTarget).toBeVisible()
  await rootTarget.dispatchEvent('dragover', { dataTransfer: rootTransfer })
  await rootTarget.dispatchEvent('drop', { dataTransfer: rootTransfer })
  await bundleHandle.dispatchEvent('dragend', { dataTransfer: rootTransfer })
  await rootTransfer.dispose()
  await expect.poll(() => bundleParents).toEqual(['collection1', null])
  await expect(collectionCheckbox).not.toBeChecked()
  await expect(collectionCheckbox).toBeDisabled()
})

test('selecting a bundle opens the inspector', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.locator('.card').first().click()
  // Inspector shows the bundle's (editable) title + its files.
  await expect(page.locator('.inspector input[aria-label="Title"]')).toHaveValue('Movie 0')
  await expect(page.getByText('movie.mp4')).toBeVisible()
  await expect(page.getByText('Files in bundle (2 · 1 missing)')).toBeVisible()
  const missingFile = page.locator('.files .file-row', { hasText: 'poster.jpg' })
  await expect(missingFile).toHaveClass(/file-row--missing/)
  await expect(missingFile.getByText('missing')).toBeVisible()
})

test('drag-selects multiple bundles with a marquee', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  const cards = page.locator('.card')
  await expect(cards.first()).toBeVisible()

  const browserBox = await page.locator('.browser').boundingBox()
  const target = await cards.nth(1).boundingBox()
  if (!browserBox || !target) throw new Error('missing bounding box')

  // Drag from the empty gutter left of the grid (just right of the sidebar's
  // resizer handle), through card 0, into card 1.
  const gutterX = browserBox.x + 8
  await page.mouse.move(gutterX, browserBox.y + 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 })
  await page.mouse.up()

  await expect(cards.nth(0)).toHaveClass(/card--selected/)
  await expect(cards.nth(1)).toHaveClass(/card--selected/)
  await expect(page.locator('.inspector__multi-head')).toContainText('2 bundles selected')

  // A plain click on empty space (no drag) clears the selection.
  await page.mouse.click(gutterX, browserBox.y + 2)
  await expect(page.locator('.inspector__multi-head')).toHaveCount(0)
})

test('toolbar search queries the whole library, not just the loaded page', async ({ page }) => {
  await mockApi(page)
  // A q-aware browse route: with ?q=gem it returns a bundle that is NOT in the
  // default first page (proving search hits the backend, not the loaded window).
  const gem = { ...bundle(0), id: 'gem', title: 'Hidden Gem' }
  await page.route('**/bundles/browse**', (r) => {
    const url = new URL(r.request().url())
    const q = url.searchParams.get('q')
    if (q && q.toLowerCase().includes('gem')) {
      return r.fulfill({ json: { items: [gem], total: 1, offset: 0, limit: 100 } })
    }
    const items = Array.from({ length: 40 }, (_, i) => bundle(i))
    return r.fulfill({ json: { items, total: items.length, offset: 0, limit: 100 } })
  })

  await page.goto('/')
  await expect(page.getByText('Movie 0')).toBeVisible()
  await expect(page.getByText('Hidden Gem')).toHaveCount(0) // not in the first page

  await page.getByRole('searchbox', { name: 'Search' }).fill('gem')
  await expect(page.getByText('Hidden Gem')).toBeVisible() // found via backend search
  await expect(page.getByText('Movie 0')).toHaveCount(0)
})

test('a protected library shows a lock screen and unlocks with the passphrase', async ({
  page,
}) => {
  await mockApi(page)
  let unlocked = false
  await page.route('**/auth/status', (r) => r.fulfill({ json: { protected: true, unlocked } }))
  await page.route('**/auth/unlock', (r) => {
    unlocked = true
    return r.fulfill({ json: { protected: true, unlocked: true } })
  })

  await page.goto('/')
  // Locked: the passphrase screen is shown and no bundle content is rendered.
  await expect(page.getByText(/is locked/)).toBeVisible()
  await expect(page.getByText('Movie 0')).toHaveCount(0)

  await page.getByLabel('Owner passphrase').fill('open-sesame')
  await page.getByRole('button', { name: 'Unlock' }).click()

  // After unlocking, the workspace mounts and content loads.
  await expect(page.getByText('Movie 0')).toBeVisible()
})

test('right-clicking a bundle deletes it via the context menu', async ({ page }) => {
  await mockApi(page)
  let deleted: string | null = null
  await page.route('**/bundles/b0', (r) => {
    if (r.request().method() === 'DELETE') {
      deleted = 'b0'
      return r.fulfill({ status: 204, body: '' })
    }
    return r.fallback()
  })

  await page.goto('/')
  await page.locator('.card').first().click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Delete Bundle' }).click()

  // Confirm in the styled dialog; the "delete files" box is off by default.
  const dialog = page.getByRole('dialog', { name: 'Delete bundle' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('checkbox')).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Delete' }).click()

  await expect.poll(() => deleted).toBe('b0')
})

test('deleting a collection offers a subcollections choice', async ({ page }) => {
  await mockApi(page)
  const collections = [
    { id: 'c1', name: 'Movies', parent_id: null },
    { id: 'c2', name: 'Action', parent_id: 'c1' },
  ]
  await page.route('**/collections?*', (r) =>
    r.fulfill({ json: { items: collections, next_cursor: null } }),
  )
  await page.route('**/collections/counts', (r) =>
    r.fulfill({ json: { counts: { c1: 2, c2: 1 } } }),
  )
  let deleteUrl: string | null = null
  await page.route('**/collections/c1*', (r) => {
    if (r.request().method() === 'DELETE') {
      deleteUrl = r.request().url()
      return r.fulfill({ status: 204, body: '' })
    }
    return r.fallback()
  })

  await page.goto('/')
  await page.locator('.sidebar .collection-row', { hasText: 'Movies' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete Collection' }).click()

  const dialog = page.getByRole('dialog', { name: 'Delete Collection' })
  await expect(dialog).toBeVisible()
  // The subcollections checkbox is offered and checked by default.
  await expect(dialog.getByRole('checkbox')).toBeChecked()
  await dialog.getByRole('button', { name: 'Delete' }).click()

  // Confirming with the box checked cascades to subcollections.
  await expect.poll(() => deleteUrl).toContain('cascade=true')
})

test('the sidebar "+" creates a collection with an inline rename box', async ({ page }) => {
  await mockApi(page)
  const state: { collections: Array<{ id: string; name: string; parent_id: string | null }> } = {
    collections: [],
  }
  let nextId = 1
  await page.route('**/collections?*', (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({ json: { items: state.collections, next_cursor: null } })
  })
  // Mirror the backend: every collection appears in counts (0 when empty).
  await page.route('**/collections/counts', (r) =>
    r.fulfill({
      json: { counts: Object.fromEntries(state.collections.map((c) => [c.id, 0])) },
    }),
  )
  await page.route('**/collections', (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    const body = r.request().postDataJSON() as { name: string; parent_id: string | null }
    const created = { id: `c${nextId++}`, name: body.name, parent_id: body.parent_id }
    state.collections.push(created)
    return r.fulfill({ status: 201, json: created })
  })
  await page.route('**/collections/c1', (r) => {
    if (r.request().method() !== 'PATCH') return r.fallback()
    const body = r.request().postDataJSON() as { name: string }
    const target = state.collections.find((c) => c.id === 'c1')
    if (target) target.name = body.name
    return r.fulfill({ json: target })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'New collection' }).click()

  // Created at the top level (no collection open), with the rename box
  // focused and its placeholder name pre-selected for immediate typing.
  const input = page.getByRole('textbox', { name: 'Rename New Collection' })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('New Collection')
  await input.fill('Documentaries')
  await input.press('Enter')

  // The renamed collection stays visible in the sidebar tree, even with no
  // bundles in it yet, and shows a 0 count.
  const row = page.locator('.sidebar .collection-row', { hasText: 'Documentaries' })
  await expect(row).toBeVisible()
  await expect(row.locator('.nav-item__count')).toHaveText('0')

  // It persists across a reload — an empty collection is not pruned from the
  // sidebar (regression: previously vanished on refresh).
  await page.reload()
  await expect(page.locator('.sidebar .collection-row', { hasText: 'Documentaries' })).toBeVisible()
})

test('a collection shows a subcollections strip and a direct/descendant toggle', async ({
  page,
}) => {
  await mockApi(page)
  await page.route('**/collections?*', (r) =>
    r.fulfill({
      json: {
        items: [
          { id: 'c1', name: 'Movies', parent_id: null },
          { id: 'c2', name: 'Docs', parent_id: 'c1' },
        ],
        next_cursor: null,
      },
    }),
  )
  await page.route('**/collections/counts', (r) =>
    r.fulfill({ json: { counts: { c1: 1, c2: 2 } } }),
  )
  await page.route('**/collections/c2/stats', (r) =>
    r.fulfill({ json: { direct_bundles: 2, total_bundles: 2, subcollections: 0 } }),
  )
  // Browse varies by collection_id + include_descendants: Movies has 1 direct
  // bundle, 3 with descendants included.
  await page.route('**/bundles/browse**', (r) => {
    const url = new URL(r.request().url())
    const cid = url.searchParams.get('collection_id')
    const withDesc = url.searchParams.get('include_descendants') === 'true'
    if (cid === 'c1') {
      const items = withDesc ? [bundle(0), bundle(1), bundle(2)] : [bundle(0)]
      return r.fulfill({ json: { items, total: items.length, offset: 0, limit: 100 } })
    }
    const items = Array.from({ length: 40 }, (_, i) => bundle(i))
    return r.fulfill({ json: { items, total: items.length, offset: 0, limit: 100 } })
  })

  await page.goto('/')
  await page.locator('.sidebar .collection-row', { hasText: 'Movies' }).click()

  // Collection header: a "Subcollections" section with a folder tile for the
  // child, a "Contents" section, and only the direct bundle in the grid.
  await expect(page.locator('.collhead')).toContainText('Subcollections (1)')
  await expect(page.locator('.collhead')).toContainText('Contents (1)')
  await expect(page.locator('.collcard', { hasText: 'Docs' })).toBeVisible()
  await expect(page.locator('.toolbar__count')).toHaveText('1 items')

  // Toggling "Show subcollection contents" pulls in descendant bundles.
  await page.getByRole('checkbox', { name: 'Show subcollection contents' }).check()
  await expect(page.locator('.toolbar__count')).toHaveText('3 items')

  // Folding "Contents" hides the bundle grid.
  await page.getByRole('button', { name: /Contents \(/ }).click()
  await expect(page.locator('.browser')).toHaveCount(0)
  await page.getByRole('button', { name: /Contents \(/ }).click() // re-expand

  // Single-clicking a subcollection tile selects it → the collection inspector
  // shows its editable title and counts (it does NOT navigate).
  await page.locator('.collcard', { hasText: 'Docs' }).click()
  await expect(page.locator('.inspector input[aria-label="Collection title"]')).toHaveValue('Docs')
  await expect(page.locator('.inspector')).toContainText('Subcollections')
  await expect(page.locator('.toolbar__title')).toHaveText('Movies') // still in Movies

  // Double-clicking navigates into it (no subcollections of its own).
  await page.locator('.collcard', { hasText: 'Docs' }).dblclick()
  await expect(page.locator('.toolbar__title')).toHaveText('Docs')
  await expect(page.locator('.collhead')).toHaveCount(0)
})

test('drag-selects subcollection cards with a marquee, and empty space deselects', async ({
  page,
}) => {
  await mockApi(page)
  await page.route('**/collections?*', (r) =>
    r.fulfill({
      json: {
        items: [
          { id: 'c1', name: 'Movies', parent_id: null },
          { id: 'c2', name: 'Docs', parent_id: 'c1' },
          { id: 'c3', name: 'Shorts', parent_id: 'c1' },
        ],
        next_cursor: null,
      },
    }),
  )
  await page.route('**/collections/counts', (r) =>
    r.fulfill({ json: { counts: { c1: 1, c2: 2, c3: 1 } } }),
  )
  await page.route('**/bundles/browse**', (r) => {
    const url = new URL(r.request().url())
    const cid = url.searchParams.get('collection_id')
    if (cid === 'c1') {
      return r.fulfill({ json: { items: [bundle(0)], total: 1, offset: 0, limit: 100 } })
    }
    const items = Array.from({ length: 40 }, (_, i) => bundle(i))
    return r.fulfill({ json: { items, total: items.length, offset: 0, limit: 100 } })
  })

  await page.goto('/')
  await page.locator('.sidebar .collection-row', { hasText: 'Movies' }).click()

  const cards = page.locator('.collcard')
  await expect(cards).toHaveCount(2)
  const grid = page.locator('.collcard__grid')
  const gridBox = await grid.boundingBox()
  const second = await cards.nth(1).boundingBox()
  if (!gridBox || !second) throw new Error('missing bounding box')

  // Drag from the grid's empty top-left corner, through both cards.
  await page.mouse.move(gridBox.x + 2, gridBox.y + 2)
  await page.mouse.down()
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2, { steps: 5 })
  await page.mouse.up()

  await expect(cards.nth(0)).toHaveClass(/collcard--selected/)
  await expect(cards.nth(1)).toHaveClass(/collcard--selected/)
  // Multi-collection selection replaces the single-collection inspector with a
  // simple summary, and never selects bundles at the same time.
  await expect(page.locator('.inspector')).toContainText('2 collections selected')

  // A plain click on empty space (no drag) clears the subcollection selection,
  // same as it does for bundles.
  await page.mouse.click(gridBox.x + 2, gridBox.y + 2)
  await expect(page.locator('.collcard--selected')).toHaveCount(0)
})

test('right-click a bundle in a collection sets it as the collection cover', async ({ page }) => {
  await mockApi(page)
  await page.route('**/collections?*', (r) =>
    r.fulfill({
      json: { items: [{ id: 'c1', name: 'Movies', parent_id: null }], next_cursor: null },
    }),
  )
  await page.route('**/collections/counts', (r) => r.fulfill({ json: { counts: { c1: 1 } } }))
  await page.route('**/bundles/browse**', (r) => {
    const cid = new URL(r.request().url()).searchParams.get('collection_id')
    if (cid === 'c1') {
      return r.fulfill({ json: { items: [bundle(0)], total: 1, offset: 0, limit: 100 } })
    }
    const items = Array.from({ length: 40 }, (_, i) => bundle(i))
    return r.fulfill({ json: { items, total: items.length, offset: 0, limit: 100 } })
  })
  let coverPatch: { cover_bundle_id?: string } | null = null
  await page.route('**/collections/c1', (r) => {
    if (r.request().method() !== 'PATCH') return r.fallback()
    coverPatch = r.request().postDataJSON() as { cover_bundle_id?: string }
    return r.fulfill({ json: { id: 'c1', name: 'Movies', parent_id: null, cover_bundle_id: 'b0' } })
  })

  await page.goto('/')
  await page.locator('.sidebar .collection-row', { hasText: 'Movies' }).click()
  await page.locator('[data-bundle-id="b0"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Set as collection cover' }).click()

  await expect.poll(() => coverPatch?.cover_bundle_id).toBe('b0')
})

test('layout choice persists across reload', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'List' }).click()
  await expect(page.getByText('Dimensions')).toBeVisible() // list header column

  await page.reload()
  // Still in list layout after reload (persisted to localStorage).
  await expect(page.getByText('Dimensions')).toBeVisible()
})
