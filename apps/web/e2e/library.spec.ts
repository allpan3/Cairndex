import { expect, test, type Page } from '@playwright/test'

// The scan job carries `?suggest_grouping=`, which "Scan new files" turns off
// and Update leaves on, so a bare `**/jobs/scan` glob no longer matches.
const SCAN_ROUTE = /\/jobs\/scan(\?|$)/

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

// Bundle detail returned by the inspector and metadata-write mocks
function bundleDetail(coverFileId: string | null) {
  return {
    id: 'b0',
    title: 'Movie 0',
    note: null,
    source_url: null,
    rating: 0,
    cover_file_id: coverFileId,
    resume_file_id: 'f0',
    created_at: '2026-06-25T00:00:00Z',
    imported_at: '2026-06-25T00:00:00Z',
    updated_at: '2026-06-25T00:00:00Z',
  }
}

async function mockApi(page: Page, coverFileId: string | null = null) {
  const items = Array.from({ length: 40 }, (_, i) => bundle(i))
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
    r.fulfill({ json: { all: 40, recent: 40, uncategorized: 5, untagged: 3, missing: 0 } }),
  )
  await page.route('**/collections/counts', (r) =>
    r.fulfill({ json: { counts: {}, direct_counts: {} } }),
  )
  await page.route('**/collections?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({ json: { items, total: items.length, offset: 0, limit: 100 } }),
  )
  await page.route('**/bundles/b0**', (r) => {
    const url = r.request().url()
    if (url.endsWith('/playback')) {
      r.fulfill({ json: { bundle_id: 'b0', videos: [] } })
    } else if (url.includes('/files')) {
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
            supported: true,
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
      r.fulfill({ json: bundleDetail(coverFileId) })
    }
  })
  await page.route('**/file-browser/entries**', (r) =>
    r.fulfill({
      json: {
        path: '',
        missing_files_updated: 0,
        entries: [
          {
            name: 'movie.mp4',
            relative_path: 'movie.mp4',
            kind: 'file',
            size_bytes: 1000,
            created_at: '2026-06-25T00:00:00Z',
            modified_at: '2026-06-25T00:00:00Z',
            extension: 'mp4',
            container: 'mp4',
            mime_type: 'video/mp4',
            media_kind: 'video',
            duration: 60,
            video_codec: 'h264',
            video_codec_tag: 'avc1',
            audio_codec: null,
            supported: true,
            linked: true,
            file_id: 'f0',
            bundle_id: 'b0',
            unbundled: false,
            resume_position: 0,
          },
        ],
      },
    }),
  )
}

/** Enable both gates required for write-mode-only browser affordances */
async function mockWriteMode(page: Page) {
  await page.route('**/api/v1/health', (route) =>
    route.fulfill({ json: { status: 'ok', write_mode: 'allowed' } }),
  )
  await page.route('**/api/v1/libraries', (route) =>
    route.fulfill({
      json: [
        {
          id: 'lib1',
          name: 'Test Library',
          root_path: '/srv/lib',
          status: 'available',
          write_mode_enabled: true,
        },
      ],
    }),
  )
}

test('renders the shell and browses bundles', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  await expect(page.getByText('Cairndex')).toBeVisible()
  await expect(page.getByRole('button', { name: /Recent/ })).toBeVisible()
  // Grid renders cards from the mocked browse response.
  await expect(page.getByText('Movie 0')).toBeVisible()
  await expect(page.getByText('40 items')).toBeVisible()
})

test('cold start waits for ownership before browsing the library', async ({ page }) => {
  await mockApi(page)
  let releaseOwnership: () => void = () => undefined
  const ownershipReady = new Promise<void>((resolve) => {
    releaseOwnership = resolve
  })
  await page.route('**/ownership', async (route) => {
    await ownershipReady
    await route.fulfill({ json: { state: 'own', mountable: true } })
  })
  let browseRequests = 0
  page.on('request', (request) => {
    if (request.url().includes('/bundles/browse')) browseRequests += 1
  })

  await page.goto('/')

  await expect(page.getByText('Checking library ownership…')).toBeVisible()
  expect(browseRequests).toBe(0)

  releaseOwnership()

  await expect(page.getByText('Movie 0')).toBeVisible()
  expect(browseRequests).toBeGreaterThan(0)
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
  await page.route(SCAN_ROUTE, (r) =>
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

test('Update opens grouping review while metadata keeps running', async ({ page }) => {
  await mockApi(page)
  const proposal = {
    id: 'new-bundle',
    kind: 'bundle',
    title: 'New grouped item',
    directory: 'Incoming',
    parent_proposal_id: null,
    target_bundle_id: null,
    target_bundle_title: null,
    create_new_bundle: true,
    target_collection_id: null,
    is_collection_context: false,
    confidence: 0.9,
    reason: 'matching synthetic filenames',
    files: [
      {
        asset_file_id: 'new-file',
        relative_path: 'Incoming/item.mp4',
        proposed_role: 'primary_video',
        sequence: 0,
      },
    ],
  }
  await page.route(SCAN_ROUTE, (route) =>
    route.fulfill({
      json: jobRead({
        id: 'job-scan',
        status: 'succeeded',
        result: {
          grouping_plan_id: 'plan-update',
          grouping_proposal_count: 1,
          missing_total: 0,
        },
        finished_at: '2026-06-25T00:01:00Z',
      }),
    }),
  )
  const runningProbe = jobRead({
    id: 'job-probe',
    job_type: 'probe',
    phase: 'probing',
    processed: 1,
    total: 10,
  })
  await page.route('**/jobs/probe', (route) => route.fulfill({ json: runningProbe }))
  await page.route('**/api/v1/jobs/job-probe', (route) => route.fulfill({ json: runningProbe }))
  await page.route('**/grouping/plans', (route) =>
    route.fulfill({
      json: [
        {
          id: 'plan-update',
          status: 'open',
          rule_version: 5,
          generated_at: '2026-06-25T00:01:00Z',
          applied_at: null,
          proposal_count: 1,
        },
      ],
    }),
  )
  await page.route('**/grouping/plans/plan-update', (route) =>
    route.fulfill({
      json: {
        id: 'plan-update',
        status: 'open',
        rule_version: 5,
        scan_job_id: 'job-scan',
        stem_levels: {},
        generated_at: '2026-06-25T00:01:00Z',
        applied_at: null,
        proposals: [proposal],
      },
    }),
  )

  await page.goto('/')
  await page.getByRole('button', { name: /Update/ }).click()

  await expect(page.getByRole('heading', { name: 'Suggest grouping' })).toBeVisible()
  await expect(page.getByText('New grouped item')).toBeVisible()
  await expect(page.getByText('Reading media metadata')).toBeVisible()
  await expect(page.getByText('1/10')).toBeVisible()
})

test('standalone Scan reports the linked missing-file total', async ({ page }) => {
  const scanUrls: string[] = []
  await mockApi(page)
  await page.route(SCAN_ROUTE, (route) => {
    scanUrls.push(route.request().url())
    return route.fulfill({
      json: jobRead({
        id: 'job-scan',
        status: 'succeeded',
        result: { grouping_proposal_count: 0, missing_total: 1 },
        finished_at: '2026-06-25T00:01:00Z',
      }),
    })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'More library actions' }).click()
  await page.getByRole('button', { name: 'Scan new files' }).click()

  await expect(page.getByText('Scan complete: 1 linked file is missing.')).toBeVisible()
  // It asks for discovery on its own — "Suggest grouping" is the item beside it.
  expect(scanUrls).toHaveLength(1)
  expect(scanUrls[0]).toContain('suggest_grouping=false')
})

test('Scan new files does not open grouping review', async ({ page }) => {
  // The owner pressed Scan and got the grouping review dialog on top of it
  // (2026-08-15). A scan-only job reports no plan, and nothing may open one.
  await mockApi(page)
  await page.route(SCAN_ROUTE, (route) =>
    route.fulfill({
      json: jobRead({
        id: 'job-scan',
        status: 'succeeded',
        // Even if a run came back naming a plan, Scan must not act on it.
        result: { grouping_plan_id: 'plan1', grouping_proposal_count: 3, missing_total: 0 },
        finished_at: '2026-06-25T00:01:00Z',
      }),
    }),
  )

  await page.goto('/')
  await page.getByRole('button', { name: 'More library actions' }).click()
  await page.getByRole('button', { name: 'Scan new files' }).click()

  await expect(page.getByText('Scan complete: 0 linked files are missing.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Suggested grouping' })).toBeHidden()
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
  await page.getByRole('button', { name: 'More library actions' }).click()
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
    target_collection_id: null,
    is_collection_context: false,
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
  const freshProposal = {
    ...oldProposal,
    id: 'fresh1',
    title: 'Still unbundled',
    directory: 'Fresh',
    reason: 'current plan',
    files: [
      {
        ...oldProposal.files[0],
        asset_file_id: 'fresh-file',
        relative_path: 'Fresh/movie.mp4',
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
          rule_version: 5,
          scan_job_id: null,
          stem_levels: {},
          generated_at: '2026-07-13T00:01:00Z',
          applied_at: null,
          proposals: [freshProposal],
        },
      })
    }
    return route.fulfill({
      json: [
        {
          id: activePlanId,
          status: 'open',
          rule_version: 5,
          generated_at: '2026-07-13T00:00:00Z',
          applied_at: null,
          proposal_count: 1,
        },
      ],
    })
  })
  await page.route('**/grouping/plans/plan1', (route) =>
    route.fulfill({
      json: {
        id: 'plan1',
        status: 'open',
        rule_version: 5,
        scan_job_id: 'job1',
        stem_levels: {},
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
        rule_version: 5,
        scan_job_id: null,
        stem_levels: {},
        generated_at: '2026-07-13T00:01:00Z',
        applied_at: null,
        proposals: [freshProposal],
      },
    }),
  )

  await page.goto('/')
  await page.getByRole('button', { name: 'More library actions' }).click()
  await page.getByRole('button', { name: 'Suggest grouping' }).click()
  await expect(page.getByText('Already bundled')).toBeVisible()
  // The folder's dial is visible on the row that speaks for the folder, rather
  // than hidden in its overflow menu.
  await expect(
    page.getByRole('button', { name: 'Widen the filename match in Settled' }),
  ).toBeVisible()
  await page.locator('.grp-foot').getByRole('button', { name: 'Suggest grouping' }).click()

  await expect(page.getByText('Still unbundled')).toBeVisible()
  // The folder's dial is visible on the row that speaks for the folder, rather
  // than hidden in its overflow menu.
  await expect(
    page.getByRole('button', { name: 'Widen the filename match in Fresh' }),
  ).toBeVisible()
  await expect(
    page.getByText('Nothing to group — there are no unbundled files awaiting suggestions.'),
  ).toHaveCount(0)
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
      target_collection_id: null as string | null,
      is_collection_context: false,
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
      target_collection_id: null as string | null,
      is_collection_context: false,
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
  await page.getByRole('button', { name: 'More library actions' }).click()
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
    target_collection_id: null,
    is_collection_context: false,
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
  await page.getByRole('button', { name: 'More library actions' }).click()
  await page.getByRole('button', { name: 'Suggest grouping' }).click()
  const checkbox = page.getByRole('checkbox', { name: 'Accept Surf On The Ridge - 4K' })
  await expect(checkbox).toBeChecked()
  const additionTitle = page.getByText(`Add to ${targetTitle}`, { exact: true })
  const dragHandle = page.locator('.grp-row--bundle', { has: additionTitle })
  const switchDestination = page.getByRole('button', {
    name: 'Create a new bundle from these files',
  })
  const rowContent = page.locator('.grp-row__content')
  const fileCount = page.getByText('2 new files', { exact: true })
  const selectBar = page.locator('.grp-selectbar')
  await expect(additionTitle).toBeVisible()
  await expect(page.locator('.grp-root-drop')).toHaveCount(0)
  // A worded confidence band is expected now; a raw percentage is not.
  await expect(page.locator('.grp-conf')).toHaveCount(1)
  await expect(page.locator('.grp-modal')).not.toContainText(/\d+(\.\d+)?%/)
  await expect(page.locator('.grp-manual')).toHaveCount(0)
  await expect(page.getByText('Create new bundle instead', { exact: true })).toHaveCount(0)

  const titleBox = await additionTitle.boundingBox()
  const dragBox = await dragHandle.boundingBox()
  const switchBox = await switchDestination.boundingBox()
  const contentBox = await rowContent.boundingBox()
  const countBox = await fileCount.boundingBox()
  const selectBox = await selectBar.boundingBox()
  if (!titleBox || !dragBox || !switchBox || !contentBox || !countBox || !selectBox) {
    throw new Error('missing grouping destination geometry')
  }
  expect(titleBox.y - (selectBox.y + selectBox.height)).toBeLessThanOrEqual(28)
  expect(titleBox.x - (dragBox.x + dragBox.width)).toBeLessThanOrEqual(6)
  // Beside the name, in reach — this was an item in a `...` menu at the row's
  // right edge, which is two clicks and a read for one switch.
  expect(switchBox.x).toBeGreaterThanOrEqual(titleBox.x)
  expect(switchBox.x).toBeLessThan(contentBox.x + contentBox.width)
  expect(countBox.x).toBeGreaterThanOrEqual(contentBox.x)

  // One click, and the button then offers the way back.
  await switchDestination.click()
  await expect(
    page.getByRole('button', { name: `Add these files to “${targetTitle}” instead` }),
  ).toBeVisible()
  await expect(page.getByText('2 files', { exact: true })).toBeVisible()
  await expect(page.getByText('manual', { exact: true })).toHaveCount(0)
  await expect(page.getByText('create 2 files as a new bundle', { exact: true })).toHaveCount(0)
  await expect(checkbox).toBeChecked()
  await expect(page.locator('.grp-node--bundle')).toHaveCount(1)
  // Closed file lists are unmounted rather than hidden, so there is nothing to
  // count until the list is opened.
  await expect(page.locator('.grp-files')).toHaveCount(0)
  await page.getByRole('button', { name: /^Expand files in bundle suggestion / }).click()
  await expect(page.locator('.grp-files')).toHaveCount(1)
  await page.getByRole('button', { name: /^Collapse files in bundle suggestion / }).click()
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
  // Row edits are blocked while a title is being edited, but that can no longer
  // be asserted here: opening the overflow menu blurs the box and commits the
  // rename. The unit tests cover the disabled state directly.
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
  const addBack = page.getByRole('button', {
    name: `Add these files to “${targetTitle}” instead`,
  })
  await expect(addBack).toBeEnabled()

  await addBack.click()
  await expect(page.getByText(`Add to ${targetTitle}`, { exact: true })).toBeVisible()
  expect(destinationWrites).toEqual([true, false])
})

test('grouping placement uses a bounded searchable collection tree', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 760 })
  await mockApi(page)
  const draftHierarchy = [
    {
      id: 'draft-archive',
      kind: 'container',
      title: 'Draft Archive',
      directory: 'Draft Archive',
      parent_proposal_id: null as string | null,
      target_bundle_id: null,
      target_bundle_title: null,
      create_new_bundle: false,
      target_collection_id: null as string | null,
      is_collection_context: false,
      confidence: 0.9,
      reason: 'synthetic hierarchy',
      files: [],
    },
    {
      id: 'draft-season',
      kind: 'container',
      title: 'Draft Season',
      directory: 'Draft Archive/Draft Season',
      parent_proposal_id: 'draft-archive' as string | null,
      target_bundle_id: null,
      target_bundle_title: null,
      create_new_bundle: false,
      target_collection_id: null,
      is_collection_context: false,
      confidence: 0.9,
      reason: 'synthetic hierarchy',
      files: [],
    },
    {
      id: 'draft-chapter',
      kind: 'container',
      title: 'Draft Chapter',
      directory: 'Draft Archive/Draft Season/Draft Chapter',
      parent_proposal_id: 'draft-season' as string | null,
      target_bundle_id: null,
      target_bundle_title: null,
      create_new_bundle: false,
      target_collection_id: null,
      is_collection_context: false,
      confidence: 0.9,
      reason: 'synthetic hierarchy',
      files: [],
    },
  ]
  const currentHierarchy = [
    {
      id: 'archive',
      parent_id: null as string | null,
      name: 'Archive',
      note: null,
      cover_bundle_id: null,
      sort_order: 0,
      created_at: '2026-08-09T00:00:00Z',
      updated_at: '2026-08-09T00:00:00Z',
      version: 1,
    },
    {
      id: 'seasons',
      parent_id: 'archive' as string | null,
      name: 'Seasons',
      note: null,
      cover_bundle_id: null,
      sort_order: 0,
      created_at: '2026-08-09T00:00:00Z',
      updated_at: '2026-08-09T00:00:00Z',
      version: 1,
    },
    {
      id: 'chapter-blue',
      parent_id: 'seasons' as string | null,
      name: 'Chapter Blue',
      note: null,
      cover_bundle_id: null,
      sort_order: 0,
      created_at: '2026-08-09T00:00:00Z',
      updated_at: '2026-08-09T00:00:00Z',
      version: 1,
    },
  ]
  const fillerCollections = Array.from({ length: 28 }, (_, index) => ({
    id: `shelf-${index + 1}`,
    parent_id: null as string | null,
    name: `Shelf ${String(index + 1).padStart(2, '0')}`,
    note: null,
    cover_bundle_id: null,
    sort_order: index + 1,
    created_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
    version: 1,
  }))
  const persistedCollections = [...currentHierarchy, ...fillerCollections]
  const sampleBundle = {
    id: 'sample-bundle',
    kind: 'bundle',
    title: 'Sample Clip',
    directory: 'Draft Archive/Draft Season/Draft Chapter',
    parent_proposal_id: 'draft-chapter' as string | null,
    target_bundle_id: null,
    target_bundle_title: null,
    create_new_bundle: true,
    target_collection_id: null as string | null,
    is_collection_context: false,
    confidence: 0.95,
    reason: 'synthetic filename match',
    files: [
      {
        asset_file_id: 'sample-file',
        relative_path: 'Draft Archive/Draft Season/Draft Chapter/sample.mp4',
        proposed_role: 'primary_video',
        sequence: 0,
      },
    ],
  }
  let proposals = [...draftHierarchy, sampleBundle]
  const parentWrites: Array<{
    parent_proposal_id: string | null
    target_collection_id: string | null
  }> = []

  await page.route('**/collections?*', (route) =>
    route.fulfill({ json: { items: persistedCollections, next_cursor: null } }),
  )

  await page.route('**/grouping/plans', (route) =>
    route.fulfill({
      json: [
        {
          id: 'plan-placement',
          status: 'open',
          rule_version: 5,
          generated_at: '2026-08-09T00:00:00Z',
          applied_at: null,
          proposal_count: proposals.length,
        },
      ],
    }),
  )
  await page.route('**/grouping/plans/plan-placement', (route) =>
    route.fulfill({
      json: {
        id: 'plan-placement',
        status: 'open',
        rule_version: 5,
        scan_job_id: null,
        stem_levels: {},
        generated_at: '2026-08-09T00:00:00Z',
        applied_at: null,
        proposals,
      },
    }),
  )
  await page.route('**/grouping/plans/plan-placement/proposals/sample-bundle/parent', (route) => {
    const payload = route.request().postDataJSON() as {
      parent_proposal_id: string | null
      target_collection_id: string | null
    }
    parentWrites.push(payload)

    let parentProposalId = payload.parent_proposal_id
    if (payload.target_collection_id) {
      const byId = new Map(persistedCollections.map((collection) => [collection.id, collection]))
      const path: typeof persistedCollections = []
      let current = byId.get(payload.target_collection_id)
      while (current) {
        path.push(current)
        current = current.parent_id ? byId.get(current.parent_id) : undefined
      }
      parentProposalId = null
      for (const collection of path.reverse()) {
        let context = proposals.find((proposal) => proposal.target_collection_id === collection.id)
        if (!context) {
          context = {
            id: `context-${collection.id}`,
            kind: 'container',
            title: collection.name,
            directory: `@existing-collection/${collection.id}`,
            parent_proposal_id: parentProposalId,
            target_bundle_id: null,
            target_bundle_title: null,
            create_new_bundle: false,
            target_collection_id: collection.id,
            is_collection_context: true,
            confidence: 1,
            reason: 'existing collection',
            files: [],
          }
          proposals = [...proposals, context]
        }
        context.parent_proposal_id = parentProposalId
        parentProposalId = context.id
      }
    }
    sampleBundle.parent_proposal_id = parentProposalId
    return route.fulfill({
      json: {
        id: 'plan-placement',
        status: 'open',
        rule_version: 5,
        scan_job_id: null,
        stem_levels: {},
        generated_at: '2026-08-09T00:00:00Z',
        applied_at: null,
        proposals,
      },
    })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'More library actions' }).click()
  await page.getByRole('button', { name: 'Suggest grouping' }).click()

  const anchor = page.getByRole('button', {
    name: 'Placement for bundle suggestion Sample Clip',
  })
  await expect(anchor).toHaveAttribute(
    'title',
    'Current placement: Suggested: Draft Archive / Draft Season / Draft Chapter',
  )
  await expect(anchor.locator('.grp-placement__label')).toHaveCount(0)
  await anchor.click()

  const panel = page.getByRole('dialog', { name: 'Place bundle suggestion Sample Clip' })
  await expect(
    panel.getByRole('option', {
      name: 'Draft Archive / Draft Season / Draft Chapter',
      exact: true,
    }),
  ).toHaveCount(0)
  const nested = panel.getByRole('option', {
    name: 'Archive / Seasons / Chapter Blue',
    exact: true,
  })
  await expect(nested).toContainText('Chapter Blue')
  await expect(nested).not.toContainText('Archive / Seasons')
  const panelBox = await panel.boundingBox()
  if (!panelBox) throw new Error('missing grouping placement panel geometry')
  expect(panelBox.height).toBeLessThanOrEqual(520)
  expect(panelBox.y).toBeGreaterThanOrEqual(0)
  expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(760)
  expect(await panel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)

  await panel.getByRole('button', { name: 'Collapse destination Archive' }).click()
  await expect(panel.getByRole('option', { name: 'Archive / Seasons', exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Expand destination Archive' }).click()
  await expect(panel.getByRole('option', { name: 'Archive / Seasons', exact: true })).toBeVisible()

  const search = panel.getByRole('textbox', { name: 'Search collection destinations' })
  await search.fill('Chapter Blue')
  const result = panel.getByRole('option', {
    name: 'Archive / Seasons / Chapter Blue',
    exact: true,
  })
  await expect(result).toContainText('Chapter Blue')
  await expect(result.locator('.pick-row__parent')).toHaveText('Seasons')
  await expect(result).not.toContainText('Archive / Seasons')

  await search.fill('Archive')
  await search.press('Enter')
  await expect
    .poll(() => parentWrites)
    .toEqual([{ parent_proposal_id: null, target_collection_id: 'archive' }])
  await expect(anchor).toHaveAttribute('title', 'Current placement: Archive')
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
      target_collection_id: null,
      is_collection_context: false,
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
      target_collection_id: null,
      is_collection_context: false,
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
      target_collection_id: null,
      is_collection_context: false,
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
    const bundleParent = (
      route.request().postDataJSON() as {
        parent_proposal_id: string | null
        target_collection_id: string | null
      }
    ).parent_proposal_id
    bundleParents.push(bundleParent)
    proposals[1].parent_proposal_id = bundleParent
    return route.fulfill({
      json: {
        id: 'plan1',
        status: 'open',
        rule_version: 2,
        scan_job_id: 'job1',
        stem_levels: {},
        generated_at: '2026-07-13T00:00:00Z',
        applied_at: null,
        proposals,
      },
    })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'More library actions' }).click()
  await page.getByRole('button', { name: 'Suggest grouping' }).click()
  await page.getByRole('button', { name: 'Rename collection suggestion Movies' }).dblclick()
  const input = page.getByRole('textbox', { name: 'Collection suggestion title' })
  await input.fill('Favorites')
  await input.press('Enter')

  await expect.poll(() => renamedCollection).toBe('Favorites')
  await expect(
    page.getByRole('button', { name: 'Rename collection suggestion Favorites' }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Show files' }).click()
  const targetList = page.getByRole('list', { name: 'Files in SRCV-005 - cut' })
  const targetBundleRow = page.locator('.grp-row--bundle', {
    has: page.getByRole('button', { name: 'Rename bundle suggestion SRCV-005 - cut' }),
  })
  const sourceFileRow = page.locator('.grp-file', { hasText: 'trailer.mp4' })
  await sourceFileRow.dragTo(targetBundleRow)
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
  const bundleHandle = page.locator('.grp-row--bundle', {
    has: page.getByText('SRCV-005 - cut', { exact: true }),
  })
  const collectionTransfer = await page.evaluateHandle(() => new DataTransfer())
  await bundleHandle.dispatchEvent('dragstart', { dataTransfer: collectionTransfer })
  await collectionRow.dispatchEvent('dragover', { dataTransfer: collectionTransfer })
  await collectionRow.dispatchEvent('drop', { dataTransfer: collectionTransfer })
  await bundleHandle.dispatchEvent('dragend', { dataTransfer: collectionTransfer })
  await collectionTransfer.dispose()
  await expect.poll(() => bundleParents).toEqual(['collection1'])
  const collectionCheckbox = page.getByRole('checkbox', {
    name: 'Select bundles in Favorites',
  })
  await expect(collectionCheckbox).toBeChecked()
  await expect(
    collectionRow.locator('..').getByText('SRCV-005 - cut', { exact: true }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Collapse collection suggestion Favorites' }).click()
  await expect(bundleHandle).toBeHidden()
  await expect(page.getByText('1 bundle selected')).toBeVisible()
  await page.getByRole('button', { name: 'Expand collection suggestion Favorites' }).click()
  await expect(bundleHandle).toBeVisible()

  await page
    .getByRole('button', { name: 'Collapse files in bundle suggestion SRCV-005 - cut' })
    .click()
  await expect(targetList).toBeHidden()
  await expect(bundleHandle).toBeVisible()

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
  // Expand all governs collections; a file list closed by its own disclosure is
  // reopened the same way (or by the toolbar's Show files default).
  await page
    .getByRole('button', { name: 'Expand files in bundle suggestion SRCV-005 - cut' })
    .click()
  await expect(targetList).toBeVisible()
})

test('selecting a bundle opens the inspector', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.locator('.card').first().click()
  // Inspector shows the bundle's (editable) title + its files.
  await expect(page.locator('.inspector textarea[aria-label="Title"]')).toHaveValue('Movie 0')
  await expect(page.getByText('movie.mp4')).toBeVisible()
  await expect(page.getByText('Files in bundle (2 · 1 missing)')).toBeVisible()
  const missingFile = page.locator('.files .file-row', { hasText: 'poster.jpg' })
  await expect(missingFile).toHaveClass(/file-row--missing/)
  await expect(missingFile.getByText('missing')).toBeVisible()
})

test('locates files and their owning bundles in either browser on the web', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  await page.locator('[data-bundle-id="b0"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open Bundle' }).click()
  await page.locator('[data-file-id="f0"]').click()

  await expect(page.getByRole('button', { name: 'Open in Default App' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reveal in Finder' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Locate in File Browser' }).click()

  await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
  const fileRow = page.locator('.file-row', { hasText: 'movie.mp4' })
  await expect(fileRow).toHaveClass(/file-row--selected/)
  await fileRow.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Open in Default App' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Reveal in Finder' })).toHaveCount(0)
  await page.getByRole('menuitem', { name: 'Locate in Bundle Browser' }).click()

  await expect(page.getByRole('tab', { name: 'Bundles' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.album')).toBeVisible()
  await expect(page.locator('[data-file-id="f0"]')).toBeVisible()
})
test('highlights the current cover action instead of prefixing its filename', async ({ page }) => {
  await mockApi(page, 'f0')
  await page.goto('/')
  await page.locator('.card').first().click()

  const currentCover = page.getByRole('button', { name: 'Current cover' })
  await expect(currentCover).toHaveAttribute('aria-pressed', 'true')
  await expect(currentCover).toHaveClass(/cover-action--active/)
  expect(await currentCover.evaluate((element) => getComputedStyle(element).color)).toBe(
    'rgb(252, 211, 77)',
  )
  await expect(page.getByRole('button', { name: 'Set as cover' })).toHaveCount(1)
  await expect(
    page.locator('.files .file-row', { hasText: 'movie.mp4' }).locator('.file-row__name'),
  ).not.toContainText('★')
})

test('switches the cover highlight before the metadata request finishes', async ({ page }) => {
  await mockApi(page, 'f0')
  let releasePatch: (() => void) | undefined
  let patchFinished = false
  const heldPatch = new Promise<void>((resolve) => {
    releasePatch = resolve
  })
  await page.route('**/bundles/b0', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback()
      return
    }
    await heldPatch
    await route.fulfill({ json: bundleDetail('f1') })
    patchFinished = true
  })
  await page.goto('/')
  await page.locator('.card').first().click()

  const oldAction = page
    .locator('.files .file-row', { hasText: 'movie.mp4' })
    .locator('.cover-action')
  const nextAction = page
    .locator('.files .file-row', { hasText: 'poster.jpg' })
    .locator('.cover-action')
  await expect(oldAction).toHaveAttribute('aria-label', 'Current cover')
  await expect(nextAction).toHaveAttribute('aria-label', 'Set as cover')
  await nextAction.click()

  await expect(oldAction).toHaveAttribute('aria-label', 'Set as cover')
  await expect(nextAction).toHaveAttribute('aria-label', 'Current cover')
  await expect(nextAction).toBeDisabled()
  expect(await nextAction.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
  if (!releasePatch) throw new Error('expected a held cover request')
  releasePatch()
  await expect.poll(() => patchFinished).toBe(true)
})

test('rolls the optimistic cover highlight back after a failed write', async ({ page }) => {
  await mockApi(page, 'f0')
  let releasePatch: (() => void) | undefined
  const heldPatch = new Promise<void>((resolve) => {
    releasePatch = resolve
  })
  await page.route('**/bundles/b0', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback()
      return
    }
    await heldPatch
    await route.fulfill({ status: 500, json: { message: 'write failed' } })
  })
  await page.goto('/')
  await page.locator('.card').first().click()

  const oldAction = page
    .locator('.files .file-row', { hasText: 'movie.mp4' })
    .locator('.cover-action')
  const nextAction = page
    .locator('.files .file-row', { hasText: 'poster.jpg' })
    .locator('.cover-action')
  await nextAction.click()
  await expect(nextAction).toHaveAttribute('aria-label', 'Current cover')
  if (!releasePatch) throw new Error('expected a held cover request')
  releasePatch()

  await expect(oldAction).toHaveAttribute('aria-label', 'Current cover')
  await expect(nextAction).toHaveAttribute('aria-label', 'Set as cover')
})

test('opens the selected inspector file from the play action after cover', async ({ page }) => {
  await mockApi(page, 'f0')
  await page.goto('/')
  await page.locator('.card').first().click()

  const row = page.locator('.files .file-row', { hasText: 'movie.mp4' })
  const actions = row.locator('.file-row__actions button')
  await expect(actions.nth(0)).toHaveAttribute('aria-label', 'Current cover')
  await expect(actions.nth(1)).toHaveAttribute('aria-label', 'Play movie.mp4')
  await actions.nth(1).click()

  await expect(page.getByRole('dialog', { name: 'Movie 0' })).toBeVisible()
  await expect(page.locator('.mv-subtitle')).toContainText('movie.mp4 · 1 / 1')
})

test('moves a Bundle Inspector file to trash only when write mode supplies the action', async ({
  page,
}) => {
  await mockApi(page)
  await mockWriteMode(page)
  let trashedPaths: string[] | null = null
  let fileTrashed = false
  await page.route('**/bundles/b0/files', async (route) => {
    if (!fileTrashed) {
      await route.fallback()
      return
    }
    await route.fulfill({ json: [] })
  })
  await page.route('**/file-ops/trash', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { operations: [], size_bytes: 0 } })
      return
    }
    trashedPaths = (route.request().postDataJSON() as { paths: string[] }).paths
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    fileTrashed = true
    await route.fulfill({ json: {} })
  })

  await page.goto('/')
  await page.locator('.card').first().click()
  await page.locator('.files .file-row', { hasText: 'movie.mp4' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click()

  await expect.poll(() => trashedPaths).toEqual(['movie.mp4'])
  // The journaled move can be slow on a NAS; the active row should not wait
  // for that request and the following refetch before it leaves the inspector
  await expect(page.locator('.files .file-row', { hasText: 'movie.mp4' })).toHaveCount(0, {
    timeout: 750,
  })
})

test('dropping an OS file on the Bundle Inspector opens the bundle destination flow', async ({
  page,
}) => {
  await mockApi(page)
  await mockWriteMode(page)
  let finishImport: () => void = () => undefined
  const importFinished = new Promise<void>((resolve) => {
    finishImport = resolve
  })
  await page.route('**/file-ops/import?*', async (route) => {
    await importFinished
    await route.fulfill({
      json: {
        path: 'new-clip.mp4',
        operation: { id: 'op-import' },
        files_updated: 0,
        failed_paths: [],
        skipped: false,
        size_bytes: 5,
      },
    })
  })
  await page.goto('/')
  await page.locator('.card').first().click()
  const inspector = page.locator('aside.inspector')

  await inspector.evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['video'], 'new-clip.mp4', { type: 'video/mp4' }))
    element.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    )
  })
  await expect(inspector).toHaveAttribute('data-file-drop', 'true')

  await inspector.evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['video'], 'new-clip.mp4', { type: 'video/mp4' }))
    element.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    )
  })

  await expect(page.getByRole('heading', { name: 'Copy the file into…' })).toBeVisible()
  await page.getByRole('button', { name: 'Copy into Library root' }).click()

  // The picker must not cover the sidebar control for the batch it just started
  await expect(page.getByRole('heading', { name: 'Copy the file into…' })).toHaveCount(0)
  await expect(page.getByText('Importing “new-clip.mp4”')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop import' })).toBeVisible()

  finishImport()
  await expect(page.getByText('Importing “new-clip.mp4”')).toHaveCount(0)
})

test('reorders bundle files by dragging the inspector cards', async ({ page }) => {
  await mockApi(page)
  let orderedIds: string[] | null = null
  await page.route('**/bundles/b0/files/order', async (route) => {
    orderedIds = (route.request().postDataJSON() as { ordered_ids: string[] }).ordered_ids
    await route.fulfill({ status: 204 })
  })
  await page.goto('/')
  await page.locator('.card').first().click()

  const rows = page.locator('.files .file-row')
  await expect(rows).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Move up' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Move down' })).toHaveCount(0)
  const sourceBox = await rows.first().boundingBox()
  const targetBox = await rows.last().boundingBox()
  if (!sourceBox || !targetBox) throw new Error('missing file row bounds')
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height - 2, {
    steps: 5,
  })
  await page.mouse.up()

  await expect.poll(() => orderedIds).toEqual(['f1', 'f0'])
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

  // Confirm in the styled dialog. Without write mode there is no "delete files"
  // checkbox at all — the server would refuse it, so the dialog does not ask.
  const dialog = page.getByRole('dialog', { name: 'Delete bundle' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('checkbox')).toHaveCount(0)
  await expect(dialog).toContainText('The files stay where they are on disk.')
  await dialog.getByRole('button', { name: 'Delete' }).click()

  await expect.poll(() => deleted).toBe('b0')
})

test('with write mode on, the delete dialog offers the files checkbox, off by default', async ({
  page,
}) => {
  await mockApi(page)
  // Write mode is both gates agreeing (ADR-0013 §1): the deployment's /health
  // flag and the library row's own opt-in — so the mock patches both.
  await mockWriteMode(page)

  await page.goto('/')
  await page.locator('.card').first().click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Delete Bundle' }).click()

  const dialog = page.getByRole('dialog', { name: 'Delete bundle' })
  await expect(dialog).toBeVisible()
  const checkbox = dialog.getByRole('checkbox')
  await expect(checkbox).not.toBeChecked()
  await checkbox.check()
  await expect(dialog).toContainText('move to this library’s Trash')
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
    r.fulfill({ json: { counts: { c1: 2, c2: 1 }, direct_counts: { c1: 2, c2: 1 } } }),
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
      json: {
        counts: Object.fromEntries(state.collections.map((c) => [c.id, 0])),
        direct_counts: Object.fromEntries(state.collections.map((c) => [c.id, 0])),
      },
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
    r.fulfill({ json: { counts: { c1: 1, c2: 2 }, direct_counts: { c1: 1, c2: 2 } } }),
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

test('collection cover thumbnails fill the card at the intended aspect ratio', async ({ page }) => {
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
    r.fulfill({ json: { counts: { c1: 1, c2: 2 }, direct_counts: { c1: 1, c2: 2 } } }),
  )
  await page.route('**/collections/c2/thumbnail**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="10" />',
    }),
  )
  await page.route('**/bundles/browse**', (r) => {
    const cid = new URL(r.request().url()).searchParams.get('collection_id')
    if (cid === 'c1') {
      return r.fulfill({ json: { items: [bundle(0)], total: 1, offset: 0, limit: 100 } })
    }
    const items = Array.from({ length: 40 }, (_, i) => bundle(i))
    return r.fulfill({ json: { items, total: items.length, offset: 0, limit: 100 } })
  })

  await page.goto('/')
  await page.locator('.sidebar .collection-row', { hasText: 'Movies' }).click()

  const card = page.locator('.collcard').first()
  await expect(card).toBeVisible()
  const geometry = await card.evaluate((element) => {
    const thumb = element.querySelector<HTMLElement>('.collcard__thumb')
    if (!thumb) throw new Error('missing collection thumbnail')
    const cardRect = element.getBoundingClientRect()
    const thumbRect = thumb.getBoundingClientRect()
    return {
      cardWidth: cardRect.width,
      thumbWidth: thumbRect.width,
      thumbHeight: thumbRect.height,
      thumbFlexShrink: getComputedStyle(thumb).flexShrink,
    }
  })

  expect(geometry.thumbWidth).toBeGreaterThan(geometry.cardWidth - 4)
  expect(geometry.thumbHeight / geometry.thumbWidth).toBeGreaterThan(0.55)
  expect(geometry.thumbHeight / geometry.thumbWidth).toBeLessThan(0.7)
  expect(geometry.thumbFlexShrink).toBe('0')
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
    r.fulfill({
      json: { counts: { c1: 1, c2: 2, c3: 1 }, direct_counts: { c1: 1, c2: 2, c3: 1 } },
    }),
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

  // Drag from the empty column past the last card, back across both of them.
  // (Not the grid's top-left corner: the folder card fills that, and pressing a
  // card selects it rather than starting a band.)
  const first = await cards.nth(0).boundingBox()
  if (!first) throw new Error('missing bounding box')
  await page.mouse.move(gridBox.x + gridBox.width - 4, gridBox.y + 4)
  await page.mouse.down()
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 5 })
  await page.mouse.up()

  await expect(cards.nth(0)).toHaveClass(/collcard--selected/)
  await expect(cards.nth(1)).toHaveClass(/collcard--selected/)
  // Multi-collection selection replaces the single-collection inspector with a
  // simple summary, and never selects bundles at the same time.
  await expect(page.locator('.inspector')).toContainText('2 collections selected')

  // A plain click on empty space (no drag) clears the subcollection selection,
  // same as it does for bundles.
  await page.mouse.click(gridBox.x + gridBox.width - 4, gridBox.y + 4)
  await expect(page.locator('.collcard--selected')).toHaveCount(0)
})

test('right-click a bundle in a collection sets it as the collection cover', async ({ page }) => {
  await mockApi(page)
  await page.route('**/collections?*', (r) =>
    r.fulfill({
      json: { items: [{ id: 'c1', name: 'Movies', parent_id: null }], next_cursor: null },
    }),
  )
  await page.route('**/collections/counts', (r) =>
    r.fulfill({ json: { counts: { c1: 1 }, direct_counts: { c1: 1 } } }),
  )
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

test('a maintenance error is reported with the job rows, not under the button', async ({
  page,
}) => {
  await mockApi(page)
  await page.route('**/api/v1/jobs/active**', (r) => r.fulfill({ json: [] }))
  await page.route('**/api/v1/libraries/lib1/jobs/storyboards', (r) =>
    r.fulfill({ status: 500, json: { message: 'Background job was cancelled.' } }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'More library actions' }).click()
  await page.getByRole('button', { name: 'Generate storyboards' }).click()
  // Docked in the foot beside the job rows: the message outlives the button
  // that started the work, and one place for "what is happening" and "what went
  // wrong" beats two.
  await expect(page.locator('.sidebar__foot').getByRole('alert')).toBeVisible()
})

test('the sidebar tells a waiting job from a running one, and can stop either', async ({
  page,
}) => {
  const job = (over: Record<string, unknown>) => ({
    id: 'j1',
    library_id: 'lib1',
    job_type: 'storyboard',
    status: 'running',
    phase: 'storyboarding',
    message: null,
    payload: {},
    processed: 8,
    total: 50,
    result: null,
    error: null,
    cancel_requested: false,
    created_at: '2026-07-30T00:00:00Z',
    started_at: '2026-07-30T00:00:00Z',
    finished_at: null,
    ...over,
  })
  await mockApi(page)
  await page.route('**/api/v1/jobs/active**', (r) =>
    r.fulfill({
      json: [job({}), job({ id: 'j2', status: 'queued', phase: null, processed: 0, total: null })],
    }),
  )
  const cancelled = page.waitForRequest(
    (request) => request.url().includes('/api/v1/jobs/j1/cancel') && request.method() === 'POST',
  )
  await page.route('**/api/v1/jobs/j1/cancel', (r) => r.fulfill({ json: job({}) }))
  await page.goto('/')

  // The running one names its phase and counts; the queued one says it is waiting
  // rather than borrowing a moving bar (the two were indistinguishable).
  await expect(page.getByText('Generating storyboards')).toBeVisible()
  await expect(page.getByText('8/50')).toBeVisible()
  await expect(page.getByText('Storyboards — waiting')).toBeVisible()

  await page.getByRole('button', { name: 'Stop storyboards' }).first().click()
  await cancelled
})

test('adding several files at once imports every one of them', async ({ page }) => {
  // Owner report (2026-08-23): picking two files showed "1 of 2" then "2 of 2",
  // and only one file arrived.
  await mockApi(page)
  await mockWriteMode(page)
  const imported: string[] = []
  await page.route('**/file-ops/import?*', async (route) => {
    const url = new URL(route.request().url())
    const name = url.searchParams.get('filename') ?? ''
    imported.push(`${url.searchParams.get('dest_dir') ?? ''}|${name}`)
    await route.fulfill({
      json: {
        path: name,
        operation: { id: `op-${imported.length}` },
        files_updated: 0,
        failed_paths: [],
        skipped: false,
        size_bytes: 5,
      },
    })
  })
  await page.goto('/')

  // Through the Add Files command's own input. It has no clickable trigger in a
  // browser (the menu bar is native), but the input is mounted, which is what
  // makes this flow testable at all.
  await page.getByTestId('add-files-input').setInputFiles([
    { name: 'first.mp4', mimeType: 'video/mp4', buffer: Buffer.from('one') },
    { name: 'second.mp4', mimeType: 'video/mp4', buffer: Buffer.from('two') },
  ])
  await expect(page.getByRole('heading', { name: 'Add 2 files to…' })).toBeVisible()
  await page.getByRole('button', { name: /^Add to/ }).click()

  await expect.poll(() => imported.length, { timeout: 10_000 }).toBe(2)
  // Distinct names, same destination — one request per file, none overwritten.
  expect(new Set(imported).size).toBe(2)
  expect(imported.map((entry) => entry.split('|')[1]).sort()).toEqual(['first.mp4', 'second.mp4'])
})

test('opening a video mid-upload does not cancel the rest of the batch', async ({ page }) => {
  // Owner hypothesis (2026-08-23): two files picked, the video imported and the
  // second file never reached the server at all — "during the upload I open the
  // video". The journal agrees: one row for the batch, none for the second file.
  await mockApi(page)
  await mockWriteMode(page)
  const imported: string[] = []
  let releaseFirst: () => void = () => undefined
  const firstInFlight = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  await page.route('**/file-ops/import?*', async (route) => {
    const name = new URL(route.request().url()).searchParams.get('filename') ?? ''
    imported.push(name)
    // Hold the first request open, so the video is opened while it is in flight.
    if (imported.length === 1) await firstInFlight
    await route.fulfill({
      json: {
        path: name,
        operation: { id: `op-${imported.length}` },
        files_updated: 0,
        failed_paths: [],
        skipped: false,
        size_bytes: 5,
      },
    })
  })
  await page.goto('/')

  await page.getByTestId('add-files-input').setInputFiles([
    { name: 'big.mp4', mimeType: 'video/mp4', buffer: Buffer.from('video') },
    { name: 'cover.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('image') },
  ])
  await page.getByRole('button', { name: /^Add to/ }).click()
  await expect.poll(() => imported.length).toBe(1)

  // Open a video while the first file is still uploading.
  // The viewer opening is what matters here, not decoding: this spec mocks no
  // playback decision, so the stage shows its fallback rather than a video.
  await page.locator('[data-bundle-id="b0"]').dblclick()
  await expect(page.locator('.media-viewer')).toBeVisible()

  releaseFirst()

  // The second file must still be sent.
  await expect.poll(() => imported.length, { timeout: 15_000 }).toBe(2)
  expect(imported).toEqual(['big.mp4', 'cover.jpg'])
})

test('Skip leaves one file out and copies the rest', async ({ page }) => {
  // Owner question (2026-08-23): the collision dialog offered Cancel, Replace
  // and Keep both — and Cancel abandons every file still queued. With several
  // files picked there was no way to say "not this one, carry on".
  await mockApi(page)
  await mockWriteMode(page)
  const attempted: string[] = []
  await page.route('**/file-ops/import?*', async (route) => {
    const query = new URL(route.request().url()).searchParams
    const name = query.get('filename') ?? ''
    const policy = query.get('on_conflict')
    attempted.push(`${name}:${policy}`)
    // The first file collides until an answer arrives with the request.
    if (name === 'first.mp4' && policy === 'fail') {
      return route.fulfill({
        status: 409,
        json: {
          detail: '“first.mp4” already exists here',
          details: { code: 'path_conflict', name: 'first.mp4', path: 'first.mp4' },
        },
      })
    }
    return route.fulfill({
      json: {
        path: name,
        operation: { id: `op-${attempted.length}` },
        files_updated: 0,
        failed_paths: [],
        skipped: policy === 'skip',
        size_bytes: 5,
      },
    })
  })
  await page.goto('/')

  await page.getByTestId('add-files-input').setInputFiles([
    { name: 'first.mp4', mimeType: 'video/mp4', buffer: Buffer.from('one') },
    { name: 'second.mp4', mimeType: 'video/mp4', buffer: Buffer.from('two') },
  ])
  await page.getByRole('button', { name: /^Add to/ }).click()

  await expect(page.getByRole('button', { name: 'Skip' })).toBeVisible()
  await page.getByRole('button', { name: 'Skip' }).click()

  // The skipped file is re-sent with the answer, then the batch carries on.
  await expect
    .poll(() => attempted, { timeout: 10_000 })
    .toEqual(['first.mp4:fail', 'first.mp4:skip', 'second.mp4:fail'])
  await expect(page.getByText(/Added 1 of 2 files/)).toBeVisible()
})

test('the sidebar can add files, which is the only way in on the web', async ({ page }) => {
  // The native File menu carries this command in the desktop app; a browser tab
  // has no menu bar, so without this entry the feature would be desktop-only
  // (owner, 2026-08-23).
  await mockApi(page)
  await mockWriteMode(page)
  const imported: string[] = []
  await page.route('**/file-ops/import?*', async (route) => {
    const query = new URL(route.request().url()).searchParams
    imported.push(`${query.get('dest_dir') ?? ''}|${query.get('filename') ?? ''}`)
    await route.fulfill({
      json: {
        path: query.get('filename') ?? '',
        operation: { id: 'op-1' },
        files_updated: 0,
        failed_paths: [],
        skipped: false,
        size_bytes: 3,
      },
    })
  })
  await page.goto('/')

  await page.getByRole('button', { name: 'More library actions' }).click()
  await page.getByRole('button', { name: 'Add Files', exact: true }).click()
  await page.getByTestId('add-files-input').setInputFiles({
    name: 'added.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('vid'),
  })

  await expect(page.getByRole('heading', { name: 'Add the file to…' })).toBeVisible()
  await page.getByRole('button', { name: /^Add to/ }).click()

  await expect.poll(() => imported).toEqual(['|added.mp4'])
})

test('a read-only library offers no way to add files', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  await page.getByRole('button', { name: 'More library actions' }).click()

  await expect(page.getByRole('button', { name: 'Add Files', exact: true })).toHaveCount(0)
  // The maintenance jobs are still there; only the write action is withheld.
  await expect(page.getByRole('button', { name: 'Scan new files' })).toBeVisible()
})
