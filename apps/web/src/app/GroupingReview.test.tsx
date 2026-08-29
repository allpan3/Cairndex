import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { type CollectionRead, type GroupingProposal, setActiveLibraryId } from '../api/client'
import { GroupingReview } from './GroupingReview'

const PROPOSALS: GroupingProposal[] = [
  {
    id: 'collection1',
    kind: 'container',
    title: 'Movies',
    directory: 'Movies',
    parent_proposal_id: null,
    target_bundle_id: null,
    target_bundle_title: null,
    create_new_bundle: false,
    target_collection_id: null,
    is_collection_context: false,
    confidence: 0.9,
    reason: 'holds related bundles',
    directories: [],
    files: [],
  },
  {
    id: 'proposal1',
    kind: 'bundle',
    title: 'SRCV-005 - cut',
    directory: 'SRCV-005',
    parent_proposal_id: null,
    target_bundle_id: null,
    target_bundle_title: null,
    create_new_bundle: false,
    target_collection_id: null,
    is_collection_context: false,
    confidence: 0.95,
    reason: 'same filename stem',
    directories: [],
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
    title: 'Second bundle',
    directory: 'Second',
    parent_proposal_id: null,
    target_bundle_id: null,
    target_bundle_title: null,
    create_new_bundle: false,
    target_collection_id: null,
    is_collection_context: false,
    confidence: 0.8,
    reason: 'same folder',
    directories: [],
    files: [
      {
        asset_file_id: 'file4',
        relative_path: 'Second/second.mp4',
        proposed_role: 'primary_video',
        sequence: 0,
      },
    ],
  },
]

const ADDITION: GroupingProposal = {
  id: 'addition1',
  kind: 'bundle',
  title: 'Surf On The Ridge - 4K',
  directory: 'Western/Nora Vance',
  parent_proposal_id: null,
  target_bundle_id: 'existing1',
  target_bundle_title: 'Sky, Sand, Sea & Salt - 4K',
  create_new_bundle: false,
  target_collection_id: null,
  is_collection_context: false,
  confidence: 0.8,
  reason: 'add 3 new file(s) to existing bundle',
  directories: [],
  files: [
    {
      asset_file_id: 'new-video',
      relative_path: 'Western/Nora Vance/Surf On The Ridge - 4K.mp4',
      proposed_role: 'video_part',
      sequence: 0,
    },
    // A second video, so this row *could* divide — which is what makes the
    // "additions offer no collection override" test prove the addition rule
    // rather than pass because the row was indivisible anyway.
    {
      asset_file_id: 'new-video-2',
      relative_path: 'Western/Nora Vance/Surf On The Ridge - 4K alt.mp4',
      proposed_role: 'alternate_version',
      sequence: 1,
    },
    {
      asset_file_id: 'new-cover',
      relative_path: 'Western/Nora Vance/Surf On The Ridge - 4K.jpg',
      proposed_role: 'image',
      sequence: 2,
    },
  ],
}

/** A bundle that can genuinely divide: two video subjects in one folder.
 *
 * Turning a *single*-subject bundle into a collection is refused (it would wrap
 * it in a collection of one identical bundle), so the conversion tests need a
 * row with something to divide. */
const DIVISIBLE: GroupingProposal = {
  id: 'divisible1',
  kind: 'bundle',
  title: 'Two Subjects',
  directory: 'Two',
  parent_proposal_id: null,
  target_bundle_id: null,
  target_bundle_title: null,
  create_new_bundle: false,
  target_collection_id: null,
  is_collection_context: false,
  confidence: 0.7,
  reason: '2 unrelated files',
  directories: [],
  files: [
    {
      asset_file_id: 'two-a',
      relative_path: 'Two/alpha.mp4',
      proposed_role: 'primary_video',
      sequence: 0,
    },
    {
      asset_file_id: 'two-b',
      relative_path: 'Two/beta.mp4',
      proposed_role: 'alternate_version',
      sequence: 1,
    },
  ],
}

const NESTED_PROPOSALS: GroupingProposal[] = [
  {
    ...PROPOSALS[0]!,
    id: 'outer-collection',
    title: 'Library',
    directory: 'Library',
  },
  {
    ...PROPOSALS[0]!,
    id: 'inner-collection',
    title: 'Series',
    directory: 'Library/Series',
    parent_proposal_id: 'outer-collection',
  },
  {
    ...PROPOSALS[1]!,
    id: 'nested-one',
    title: 'Episode One',
    directory: 'Library/Series/Episode One',
    parent_proposal_id: 'inner-collection',
    files: [
      {
        asset_file_id: 'episode-one-file',
        relative_path: 'Library/Series/Episode One/video.mp4',
        proposed_role: 'video_part',
        sequence: 0,
      },
    ],
  },
  {
    ...PROPOSALS[1]!,
    id: 'nested-two',
    title: 'Episode Two',
    directory: 'Library/Series/Episode Two',
    parent_proposal_id: 'inner-collection',
    files: [
      {
        asset_file_id: 'episode-two-file',
        relative_path: 'Library/Series/Episode Two/video.mp4',
        proposed_role: 'video_part',
        sequence: 0,
      },
    ],
  },
  {
    ...PROPOSALS[2]!,
    id: 'outer-sibling',
    title: 'Feature',
    directory: 'Library/Feature',
    parent_proposal_id: 'outer-collection',
    files: [
      {
        asset_file_id: 'feature-file',
        relative_path: 'Library/Feature/video.mp4',
        proposed_role: 'video_part',
        sequence: 0,
      },
    ],
  },
]

const CURRENT_COLLECTIONS: CollectionRead[] = [
  {
    id: 'current-archive',
    parent_id: null,
    name: 'Current Archive',
    note: null,
    cover_bundle_id: null,
    sort_order: 0,
    created_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
    version: 1,
  },
  {
    id: 'current-series',
    parent_id: 'current-archive',
    name: 'Current Series',
    note: null,
    cover_bundle_id: null,
    sort_order: 0,
    created_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
    version: 1,
  },
  {
    id: 'current-reference',
    parent_id: null,
    name: 'Reference',
    note: null,
    cover_bundle_id: null,
    sort_order: 1,
    created_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
    version: 1,
  },
]

/** How far a fixture folder's stem dial goes.
 *
 * A fixture rather than a computation: the real maximum comes from the
 * suggester's filename normalization, which is why the server reports it per
 * folder instead of the client deriving it (`plan_store.stem_levels`).
 */
const STEM_DIAL_MAX = 4

/** What the review says after widening the fixture folder one rung.
 *
 * The stem, not the dial position: "now matches at stem 2 of 4" named a rung on a
 * ladder whose length depends on the folder's own filenames, so it told the owner
 * nothing about what their click did (owner-reported, 2026-08-15).
 */
const NOTICE_AFTER_WIDEN = 'SRCV-005 now matches on “SRCV-005” — 1 bundle.'

/** What the server reports a folder is matching on, as written on its files.
 *
 * Mirrors `suggester.stem_prefix_as_written` closely enough to give the review
 * realistic text: the first `max - level + 1` segments of a filename, sliced out
 * rather than rebuilt, so separators stay as they are. The real one folds
 * rendition tags too; a fixture does not need to.
 */
function stemPrefix(name: string, level: number, max: number): string {
  const stem = name.replace(/\.[^.]*$/, '')
  if (level <= 0) return stem
  const parts = stem.split(/[-._\s]+/).filter(Boolean)
  const depth = Math.max(1, max - level + 1)
  if (parts.length <= depth) return stem
  let end = 0
  for (const part of parts.slice(0, depth)) end = stem.indexOf(part, end) + part.length
  return stem.slice(0, end)
}

/** The dial map the server sends: one entry per folder the plan's files live in. */
function stemDials(
  proposals: GroupingProposal[],
  levels: Record<string, number>,
): Record<string, { level: number; max: number; stem: string }> {
  const dials: Record<string, { level: number; max: number; stem: string }> = {}
  const first: Record<string, string> = {}
  for (const proposal of proposals) {
    for (const file of proposal.files) {
      const segments = file.relative_path.split('/')
      const directory = segments.slice(0, -1).join('/')
      const name = segments[segments.length - 1] ?? ''
      const level = levels[directory] ?? 1
      const max = Math.max(STEM_DIAL_MAX, level)
      // Sorted, like the server's, so a folder reports the same example each time.
      if (first[directory] === undefined || name < first[directory]) first[directory] = name
      dials[directory] = { level, max, stem: stemPrefix(first[directory], level, max) }
    }
  }
  return dials
}

/** Install a mutable grouping-plan API mock and return its fetch spy. */
function mockGroupingApi(
  initialProposals: GroupingProposal[] = PROPOSALS,
  collections: CollectionRead[] = CURRENT_COLLECTIONS,
  // Lets a test start a folder partway along its dial, including at either end.
  initialStemLevels: Record<string, number> = {},
  // What accepting produces, and what the plan holds afterwards — the review stays
  // open on the remainder now, so both matter. Accepting a selection retires the
  // rows it confirmed *in the same plan*, so the mock does that too rather than
  // serving a regenerated one.
  afterApply: { conflicts?: unknown[]; proposals?: GroupingProposal[] } = {},
) {
  let proposals = structuredClone(initialProposals)
  let planId = 'plan1'
  let applied = false
  let stemLevels: Record<string, number> = { ...initialStemLevels }
  return vi.fn((url: string, init?: RequestInit) => {
    let body: unknown
    if (url.includes('/collections?')) {
      body = { items: collections, next_cursor: null }
    } else if (url.endsWith('/grouping/plans') && init?.method === 'POST') {
      planId = 'plan2'
      stemLevels = (JSON.parse(init.body as string) as { stem_levels: Record<string, number> })
        .stem_levels
      // What is left after an accept, as the server produces: the confirmed
      // bundles have gone, the skipped ones come back.
      if (applied && afterApply.proposals !== undefined) {
        proposals = structuredClone(afterApply.proposals)
      }
      body = {
        id: planId,
        status: 'open',
        rule_version: 5,
        scan_job_id: null,
        stem_levels: stemDials(proposals, stemLevels),
        generated_at: '2026-07-13T00:01:00Z',
        applied_at: null,
        proposals,
      }
    } else if (url.endsWith('/grouping/plans')) {
      body = [
        {
          id: planId,
          status: 'open',
          rule_version: 5,
          generated_at: '2026-07-13T00:00:00Z',
          applied_at: null,
          proposal_count: proposals.length,
        },
      ]
    } else if (url.endsWith(`/grouping/plans/${planId}`)) {
      body = {
        id: planId,
        status: 'open',
        rule_version: 5,
        scan_job_id: 'job1',
        stem_levels: stemDials(proposals, stemLevels),
        generated_at: '2026-07-13T00:00:00Z',
        applied_at: null,
        proposals,
      }
    } else if (url.match(/\/proposals\/[^/]+\/destination$/) && init?.method === 'PUT') {
      const proposalId = url.split('/').at(-2)!
      const createNewBundle = (JSON.parse(init.body as string) as { create_new_bundle: boolean })
        .create_new_bundle
      proposals = proposals.map((proposal) =>
        proposal.id === proposalId
          ? {
              ...proposal,
              create_new_bundle: createNewBundle,
              files: proposal.files.map((file) => ({
                ...file,
                proposed_role: createNewBundle
                  ? file.asset_file_id === 'new-cover'
                    ? ('cover' as const)
                    : ('primary_video' as const)
                  : file.asset_file_id === 'new-cover'
                    ? ('image' as const)
                    : ('video_part' as const),
              })),
            }
          : proposal,
      )
      body = proposals.find((proposal) => proposal.id === proposalId)
    } else if (url.match(/\/proposals\/[^/]+$/) && init?.method === 'PATCH') {
      const proposalId = url.split('/').pop()!
      const title = (JSON.parse(init.body as string) as { title: string }).title
      proposals = proposals.map((proposal) =>
        proposal.id === proposalId ? { ...proposal, title } : proposal,
      )
      body = proposals.find((proposal) => proposal.id === proposalId)
    } else if (url.match(/\/proposals\/[^/]+\/files\/[^/]+\/move$/)) {
      const parts = url.split('/')
      const sourceId = parts.at(-4)!
      const assetFileId = parts.at(-2)!
      const payload = JSON.parse(init?.body as string) as {
        target_proposal_id: string
        target_index: number
      }
      const source = proposals.find((proposal) => proposal.id === sourceId)!
      const target = proposals.find((proposal) => proposal.id === payload.target_proposal_id)!
      const sourceIndex = source.files.findIndex((file) => file.asset_file_id === assetFileId)
      const sourceFiles = [...source.files]
      const [moving] = sourceFiles.splice(sourceIndex, 1)
      if (!moving) throw new Error('missing mock proposal file')
      const targetFiles = source.id === target.id ? sourceFiles : [...target.files]
      const targetIndex =
        source.id === target.id && sourceIndex < payload.target_index
          ? payload.target_index - 1
          : payload.target_index
      targetFiles.splice(targetIndex, 0, moving)
      const updated = [
        {
          ...source,
          files: (source.id === target.id ? targetFiles : sourceFiles).map((file, sequence) => ({
            ...file,
            sequence,
          })),
        },
        ...(source.id === target.id
          ? []
          : [{ ...target, files: targetFiles.map((file, sequence) => ({ ...file, sequence })) }]),
      ]
      proposals = proposals.map(
        (proposal) => updated.find((item) => item.id === proposal.id) ?? proposal,
      )
      body = updated
    } else if (url.match(/\/stem-levels$/) && init?.method === 'PUT') {
      const { directory, level } = JSON.parse(init.body as string) as {
        directory: string
        level: number
      }
      // Clamped and defaulted exactly as the server does, so a test cannot pass
      // against a level the real endpoint would never store.
      const clamped = Math.max(0, Math.min(level, STEM_DIAL_MAX))
      if (clamped === 1) delete stemLevels[directory]
      else stemLevels[directory] = clamped
      // In place: only the adjusted directory's rows are replaced (new ids).
      proposals = proposals.map((proposal) =>
        proposal.directory === directory ? { ...proposal, id: `${proposal.id}-regen` } : proposal,
      )
      body = {
        id: planId,
        status: 'open',
        rule_version: 5,
        scan_job_id: 'job1',
        stem_levels: stemDials(proposals, stemLevels),
        generated_at: '2026-07-13T00:00:00Z',
        applied_at: null,
        proposals,
      }
    } else if (url.match(/\/proposals\/[^/]+\/directories\/[^/]+$/) && init?.method === 'PUT') {
      // Declining marks the row rather than deleting it, so it goes both ways.
      // Its files never moved, so nothing else about the proposal changes.
      const directoryId = url.split('/').at(-1)!
      const proposalId = url.split('/').at(-3)!
      const expanded = (JSON.parse(init.body as string) as { expanded: boolean }).expanded
      const source = proposals.find((proposal) => proposal.id === proposalId)!
      source.directories = source.directories.map((entry) =>
        entry.id === directoryId ? { ...entry, expanded } : entry,
      )
      body = source
    } else if (url.match(/\/proposals\/[^/]+\/kind$/) && init?.method === 'PUT') {
      // The server returns the whole plan, because a conversion adds or removes
      // sibling proposals rather than editing one in place.
      const proposalId = url.split('/').at(-2)!
      const kind = (JSON.parse(init.body as string) as { kind: 'bundle' | 'container' }).kind
      const source = proposals.find((proposal) => proposal.id === proposalId)!
      const children: GroupingProposal[] =
        kind === 'container'
          ? source.files.map((file, index) => ({
              ...source,
              id: `${proposalId}-child${index}`,
              kind: 'bundle' as const,
              title: file.relative_path.split('/').pop()!,
              parent_proposal_id: proposalId,
              files: [{ ...file, sequence: 0 }],
            }))
          : []
      proposals = [
        ...proposals.map((proposal) =>
          proposal.id === proposalId
            ? { ...proposal, kind, files: kind === 'container' ? [] : proposal.files }
            : proposal,
        ),
        ...children,
      ]
      body = {
        id: planId,
        status: 'open',
        rule_version: 5,
        scan_job_id: 'job1',
        stem_levels: stemDials(proposals, stemLevels),
        generated_at: '2026-07-13T00:00:00Z',
        applied_at: null,
        proposals,
      }
    } else if (url.match(/\/proposals\/[^/]+\/parent$/) && init?.method === 'PUT') {
      const proposalId = url.split('/').at(-2)!
      const payload = JSON.parse(init.body as string) as {
        parent_proposal_id: string | null
        target_collection_id: string | null
      }
      let parentProposalId = payload.parent_proposal_id
      if (payload.target_collection_id) {
        const byCollectionId = new Map(collections.map((collection) => [collection.id, collection]))
        const path: CollectionRead[] = []
        let collection = byCollectionId.get(payload.target_collection_id)
        while (collection) {
          path.push(collection)
          collection = collection.parent_id ? byCollectionId.get(collection.parent_id) : undefined
        }
        let contextParentId: string | null = null
        for (const item of path.reverse()) {
          const existing = proposals.find((proposal) => proposal.target_collection_id === item.id)
          const context: GroupingProposal = existing ?? {
            id: `context-${item.id}`,
            kind: 'container',
            title: item.name,
            directory: `@existing-collection/${item.id}`,
            directories: [],
            parent_proposal_id: contextParentId,
            target_bundle_id: null,
            target_bundle_title: null,
            create_new_bundle: false,
            target_collection_id: item.id,
            is_collection_context: true,
            confidence: 1,
            reason: 'existing collection',
            files: [],
          }
          context.parent_proposal_id = contextParentId
          if (!existing) proposals = [...proposals, context]
          contextParentId = context.id
        }
        parentProposalId = contextParentId
      }
      proposals = proposals.map((proposal) =>
        proposal.id === proposalId
          ? { ...proposal, parent_proposal_id: parentProposalId }
          : proposal,
      )
      body = {
        id: planId,
        status: 'open',
        rule_version: 5,
        scan_job_id: 'job1',
        stem_levels: stemDials(proposals, stemLevels),
        generated_at: '2026-07-13T00:00:00Z',
        applied_at: null,
        proposals,
      }
    } else if (url.endsWith(`/grouping/plans/${planId}/apply`) && init?.method === 'POST') {
      applied = true
      // The confirmed rows leave the plan being reviewed; whatever the test says is
      // left stays, keeping its ids.
      if (afterApply.proposals !== undefined) proposals = structuredClone(afterApply.proposals)
      body = {
        bundles_confirmed: 2,
        bundles_removed: 0,
        collections_created: 1,
        bundles_added_to_collections: 2,
        files_added_to_bundles: 0,
        subtitles_linked: 0,
        conflicts: afterApply.conflicts ?? [],
        proposals_remaining: proposals.filter((p) => p.files.length > 0).length,
      }
    } else {
      body = {}
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  })
}

/** Render grouping review with isolated query state. */
function renderReview() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <GroupingReview initialPlanId="plan1" onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

beforeEach(() => setActiveLibraryId('lib1'))

afterEach(() => {
  cleanup()
  setActiveLibraryId(null)
  vi.restoreAllMocks()
})

test('folds and restores descendant proposals under a collection', async () => {
  vi.stubGlobal('fetch', mockGroupingApi(NESTED_PROPOSALS))
  renderReview()

  const inner = { name: 'Rename collection suggestion Series' }
  await screen.findByRole('button', inner)
  const collapse = screen.getByRole('button', {
    name: 'Collapse collection suggestion Library',
  })
  expect(collapse).toHaveAttribute('aria-expanded', 'true')

  fireEvent.click(collapse)

  // Unmounted, not hidden: a folded subtree that is still in the document is
  // still reconciled on every render, which is the cost folding exists to avoid.
  expect(screen.queryByRole('button', inner)).toBeNull()
  expect(screen.getByText('3 bundles selected')).toBeInTheDocument()
  const expand = screen.getByRole('button', { name: 'Expand collection suggestion Library' })
  expect(expand).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(expand)
  expect(screen.getByRole('button', inner)).toBeVisible()
})

// Fold state is per row, not per content. Two file-less bundles hash to the same
// content key, and so does a bundle converted to a collection under a container
// for the same directory — a shared fold key collapsed both rows at once and hid
// the row that was clicked inside its own collapsed ancestor.
test('two suggestions with identical content fold independently', async () => {
  const emptied: GroupingProposal[] = [
    { ...PROPOSALS[1]!, id: 'empty-a', title: 'Emptied A', files: [] },
    { ...PROPOSALS[1]!, id: 'empty-b', title: 'Emptied B', files: [] },
  ]
  vi.stubGlobal('fetch', mockGroupingApi(emptied))
  renderReview()

  const first = await screen.findByRole('button', {
    name: 'Expand files in bundle suggestion Emptied A',
  })
  const second = screen.getByRole('button', {
    name: 'Expand files in bundle suggestion Emptied B',
  })
  expect(first).toHaveAttribute('aria-expanded', 'false')
  expect(second).toHaveAttribute('aria-expanded', 'false')

  fireEvent.click(first)

  expect(
    screen.getByRole('button', { name: 'Collapse files in bundle suggestion Emptied A' }),
  ).toHaveAttribute('aria-expanded', 'true')
  expect(
    screen.getByRole('button', { name: 'Expand files in bundle suggestion Emptied B' }),
  ).toHaveAttribute('aria-expanded', 'false')
})

test('folds and restores the file list under a bundle', async () => {
  vi.stubGlobal('fetch', mockGroupingApi())
  const review = renderReview()

  // Closed by default: the row's summary carries the shape, and the list is one
  // click away when it does not.
  const expand = await screen.findByRole('button', {
    name: 'Expand files in bundle suggestion SRCV-005 - cut',
  })
  expect(expand).toHaveAttribute('aria-expanded', 'false')
  fireEvent.dragStart(expand, { dataTransfer: dragData() })
  expect(review.container.querySelector('.grp-root-drop')).not.toBeInTheDocument()

  fireEvent.click(expand)

  const files = screen.getByRole('list', { name: 'Files in SRCV-005 - cut' })
  expect(files).toBeVisible()
  const collapse = screen.getByRole('button', {
    name: 'Collapse files in bundle suggestion SRCV-005 - cut',
  })
  expect(collapse).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(collapse)
  expect(screen.queryByRole('list', { name: 'Files in SRCV-005 - cut' })).toBeNull()
})

test('a folder states its destination once, without taking it off its rows', async () => {
  // The picker repeated the same answer as many times as the folder had
  // suggestions (owner-requested, 2026-08-13). Faded at rest rather than removed:
  // it is the keyboard path for moving a single row out of its folder, and taking
  // it away left only drag-and-drop — which the placement e2e caught.
  const folder: GroupingProposal = {
    ...PROPOSALS[0]!,
    id: 'studio',
    title: 'Studio',
    directory: 'Genre/Studio',
    parent_proposal_id: null,
    files: [],
  }
  const inFolder = [1, 2].map((n) => ({
    ...PROPOSALS[1]!,
    id: `rel-${n}`,
    title: `Release ${n}`,
    directory: 'Genre/Studio',
    parent_proposal_id: 'studio',
    files: [
      {
        asset_file_id: `v${n}`,
        relative_path: `Genre/Studio/Release ${n}.mp4`,
        proposed_role: 'primary_video' as const,
        sequence: 0,
      },
    ],
  }))
  vi.stubGlobal('fetch', mockGroupingApi([folder, ...inFolder]))
  renderReview()

  await screen.findByRole('button', { name: 'Rename collection suggestion Studio' })

  // The folder's own destination is stated plainly on its header.
  const header = within(rowOf('Studio')).getByRole('button', { name: /^Placement for / })
  expect(header.closest('.grp-placement-picker--restated')).toBeNull()

  // Its rows still carry theirs — reachable, but not restating the header at rest.
  for (const title of ['Release 1', 'Release 2']) {
    const row = within(rowOf(title)).getByRole('button', { name: /^Placement for / })
    expect(row.closest('.grp-placement-picker--restated')).not.toBeNull()
  }
})

test('accepting keeps the review open on what is left', async () => {
  // Reviewing a long plan happens in batches, and closing on every accept meant
  // reopening the dialog to carry on (owner-requested, 2026-08-13).
  // The same suggestion the owner skipped, with the fresh id a regeneration
  // issues. Its *content* is unchanged, which is what `proposalKey` matches on and
  // therefore what carries the deselection across.
  const skipped = PROPOSALS.find((proposal) => proposal.title === 'Second bundle')!
  const leftover: GroupingProposal = { ...skipped, id: 'left-1' }
  vi.stubGlobal('fetch', mockGroupingApi(undefined, undefined, {}, { proposals: [leftover] }))
  renderReview()

  // Skip one row, accept the rest.
  const second = await screen.findByRole('checkbox', { name: 'Accept Second bundle' })
  fireEvent.click(second)
  await screen.findByText('1 bundle selected')
  fireEvent.click(screen.getByRole('button', { name: /^Accept / }))

  // Still reviewing, with what was accepted stated and the remainder counted.
  await screen.findByText(/Accepted 2 bundles, 1 collection\. 1 suggestion left to review\./)
  expect(screen.getByRole('button', { name: /^Accept / })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()

  // And the row the owner skipped is still skipped: a second accept must not be
  // one click away from confirming exactly what they just declined.
  const remaining = screen.getByRole('checkbox', { name: 'Accept Second bundle' })
  expect(remaining).not.toBeChecked()
})

test('accepting the last suggestion closes the review with a summary', async () => {
  vi.stubGlobal('fetch', mockGroupingApi(undefined, undefined, {}, { proposals: [] }))
  renderReview()

  await screen.findByRole('checkbox', { name: 'Accept SRCV-005 - cut' })
  fireEvent.click(screen.getByRole('button', { name: /^Accept / }))

  expect(await screen.findByRole('button', { name: 'Done' })).toBeInTheDocument()
  expect(screen.getByText(/Accepted/)).toBeInTheDocument()
})

test('a conflict ends the review rather than scrolling past unread', async () => {
  vi.stubGlobal(
    'fetch',
    mockGroupingApi(
      undefined,
      undefined,
      {},
      {
        conflicts: [{ proposal_id: 'p', title: 'Second bundle', reason: 'a file went missing' }],
        proposals: [PROPOSALS[1]!],
      },
    ),
  )
  renderReview()

  await screen.findByRole('checkbox', { name: 'Accept SRCV-005 - cut' })
  fireEvent.click(screen.getByRole('button', { name: /^Accept / }))

  // Carrying on would leave the conflict behind unread.
  expect(await screen.findByText(/need attention/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
})

test('a long plan opens folded, and Expand all still opens it', async () => {
  // Two reasons that agree: nobody reads thousands of rows top to bottom, and
  // folding now unmounts — so opening expanded made the first render and every
  // edit after it build rows nobody had looked at (owner-reported: conversion
  // took over ten seconds, 2026-08-13).
  const many: GroupingProposal[] = []
  for (let folder = 0; folder < 60; folder++) {
    many.push({
      ...PROPOSALS[0]!,
      id: `c${folder}`,
      title: `Studio ${folder}`,
      directory: `Genre/Studio ${folder}`,
      parent_proposal_id: null,
      files: [],
    })
    for (let index = 0; index < 8; index++) {
      many.push({
        ...PROPOSALS[1]!,
        id: `b${folder}-${index}`,
        title: `Release ${folder}-${index}`,
        directory: `Genre/Studio ${folder}`,
        parent_proposal_id: `c${folder}`,
        reason: `one video with ${index % 3} sidecar file(s)`,
        files: [
          {
            asset_file_id: `v${folder}-${index}`,
            relative_path: `Genre/Studio ${folder}/Release ${folder}-${index}.mp4`,
            proposed_role: 'primary_video' as const,
            sequence: 0,
          },
        ],
      })
    }
  }
  vi.stubGlobal('fetch', mockGroupingApi(many))
  renderReview()

  await screen.findByText('Studio 0')
  // The folders are there; their contents are not built yet.
  expect(screen.queryByText('Release 0-0')).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Expand collection suggestion Studio 0' }),
  ).toBeVisible()

  fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))

  expect(screen.getByText('Release 0-0')).toBeVisible()
  // Selection is computed from the plan, not from what is on screen, so Accept
  // covers the folded rows either way.
  expect(screen.getByText(`${60 * 8} bundles selected`)).toBeInTheDocument()
})

test('collapses and expands every collection and bundle', async () => {
  vi.stubGlobal('fetch', mockGroupingApi(NESTED_PROPOSALS))
  renderReview()

  // Re-queried rather than held: a folded list is unmounted, so the node from
  // before the fold is not the node after it.
  const files = { name: 'Files in Episode One' } as const
  fireEvent.click(await screen.findByRole('button', { name: 'Show files' }))
  screen.getByRole('list', files)
  fireEvent.click(screen.getByRole('button', { name: 'Hide files' }))
  fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))

  expect(screen.queryByRole('list', files)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Expand collection suggestion Library' }))
  fireEvent.click(screen.getByRole('button', { name: 'Expand collection suggestion Series' }))
  expect(
    screen.getByRole('button', { name: 'Expand files in bundle suggestion Episode One' }),
  ).toBeVisible()
  // Collapse/Expand all governs collections; file lists have their own toggle.
  expect(screen.queryByRole('list', files)).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Show files' }))

  expect(screen.getByRole('list', files)).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Collapse collection suggestion Library' }),
  ).toBeVisible()
  expect(screen.getByRole('button', { name: 'Expand all' })).toBeDisabled()
})

test('double-click renames a bundle suggestion and persists it', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  const title = await screen.findByRole('button', {
    name: 'Rename bundle suggestion SRCV-005 - cut',
  })
  fireEvent.doubleClick(title)
  const input = screen.getByRole('textbox', { name: 'Bundle suggestion title' })
  fireEvent.change(input, { target: { value: 'SRCV-005' } })
  fireEvent.keyDown(input, { key: 'Enter' })

  await screen.findByRole('button', { name: 'Rename bundle suggestion SRCV-005' })
  const patchCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/proposals/proposal1') && init?.method === 'PATCH',
  )
  expect(patchCall?.[1]).toMatchObject({ body: JSON.stringify({ title: 'SRCV-005' }) })
})

test('title editor mirrors its live text instead of shrinking to a fixed width', async () => {
  const focus = vi.spyOn(HTMLTextAreaElement.prototype, 'focus')
  vi.stubGlobal('fetch', mockGroupingApi())
  const review = renderReview()

  fireEvent.doubleClick(
    await screen.findByRole('button', { name: 'Rename bundle suggestion SRCV-005 - cut' }),
  )
  const input = screen.getByRole('textbox', { name: 'Bundle suggestion title' })
  expect(input.tagName).toBe('TEXTAREA')
  expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  const mirror = input.closest('.grp-title-editor')
  expect(mirror).toHaveAttribute('data-value', 'SRCV-005 - cut')
  fireEvent.change(input, { target: { value: 'SRCV-005 - a substantially longer cut title' } })
  expect(mirror).toHaveAttribute('data-value', 'SRCV-005 - a substantially longer cut title')
  expect(review.container.querySelectorAll('.grp-title-input')).toHaveLength(1)
})

test('keeps suggestion reasons without rendering how sure the suggester is', async () => {
  vi.stubGlobal('fetch', mockGroupingApi())
  const review = renderReview()

  expect(await screen.findByText('holds related bundles')).toBeInTheDocument()
  // A bundle row states what it contains rather than why it was grouped; the
  // reason only earns a line when the suggester is unsure (see the filter test).
  expect(screen.getByText('3 files · video, image')).toBeInTheDocument()
  expect(screen.queryByText('same filename stem')).not.toBeInTheDocument()
  // Neither a raw score nor a worded band: the percentages were rejected as
  // noise, and the words that replaced them were removed for being wrong often
  // enough that certainty was the misleading part (owner, 2026-08-28).
  expect(review.container.textContent).not.toMatch(/\d+(\.\d+)?%/)
  expect(screen.queryByText('90%')).not.toBeInTheDocument()
  expect(screen.queryByText('95%')).not.toBeInTheDocument()
  expect(screen.queryByText('confident')).not.toBeInTheDocument()
  expect(screen.queryByText('likely')).not.toBeInTheDocument()
})

test('switches one addition proposal to a renameable new bundle and back', async () => {
  const fetchMock = mockGroupingApi([ADDITION])
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  const checkbox = await screen.findByRole('checkbox', {
    name: 'Accept Surf On The Ridge - 4K',
  })
  expect(checkbox).toBeChecked()
  expect(screen.getByText('Add to Sky, Sand, Sea & Salt - 4K')).toBeInTheDocument()
  expect(screen.queryByText('➕')).not.toBeInTheDocument()
  expect(screen.getByText('3 new files')).toBeInTheDocument()
  expect(screen.queryByText('Create new bundle instead')).not.toBeInTheDocument()
  // The menu item names the change it makes, so its label *is* the state.
  fireEvent.click(screen.getByRole('button', { name: 'Create a new bundle from these files' }))

  await waitFor(() => expect(screen.getByText('3 files')).toBeInTheDocument())
  const addToExisting = screen.getByRole('button', {
    name: 'Add these files to “Sky, Sand, Sea & Salt - 4K” instead',
  })
  // The button's accessible name spells out the change; its visible text is the
  // destination it would switch to, which is what fits beside a title.
  expect(addToExisting).toHaveTextContent('Add to bundle')
  expect(screen.getByText('3 files')).toBeInTheDocument()
  expect(screen.queryByText('manual')).not.toBeInTheDocument()
  expect(screen.queryByText('create 3 files as a new bundle')).not.toBeInTheDocument()
  expect(checkbox).toBeChecked()
  fireEvent.doubleClick(
    screen.getByRole('button', { name: 'Rename bundle suggestion Surf On The Ridge - 4K' }),
  )
  expect(addToExisting).toBeInTheDocument()
  expect(addToExisting).toBeDisabled()
  const input = screen.getByRole('textbox', { name: 'Bundle suggestion title' })
  fireEvent.change(input, { target: { value: 'Separate Feature' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await screen.findByRole('button', { name: 'Rename bundle suggestion Separate Feature' })
  expect(addToExisting).toBeEnabled()

  fireEvent.click(
    screen.getByRole('button', { name: 'Add these files to “Sky, Sand, Sea & Salt - 4K” instead' }),
  )
  await screen.findByText('Add to Sky, Sand, Sea & Salt - 4K')
  fireEvent.click(screen.getByRole('button', { name: 'Create a new bundle from these files' }))
  await screen.findByRole('button', { name: 'Rename bundle suggestion Separate Feature' })

  const destinationCalls = fetchMock.mock.calls.filter(([url]) => url.endsWith('/destination'))
  expect(destinationCalls.map(([, init]) => init?.body)).toEqual([
    JSON.stringify({ create_new_bundle: true }),
    JSON.stringify({ create_new_bundle: false }),
    JSON.stringify({ create_new_bundle: true }),
  ])
})

test('uses the legacy proposal title when the target snapshot title is absent', async () => {
  vi.stubGlobal(
    'fetch',
    mockGroupingApi([{ ...ADDITION, title: 'Legacy Target', target_bundle_title: null }]),
  )
  renderReview()

  expect(await screen.findByText('Add to Legacy Target')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Create a new bundle from these files' }))
  await waitFor(() => expect(screen.queryByText('Add to Legacy Target')).toBeNull())
  expect(
    screen.getByRole('button', { name: 'Add these files to “Legacy Target” instead' }),
  ).toBeInTheDocument()
})

test('disables destination actions while saving and surfaces a switch error', async () => {
  const normalFetch = mockGroupingApi([ADDITION])
  let finishDestination: (() => void) | undefined
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/destination')) {
      return new Promise<unknown>((resolve) => {
        finishDestination = () =>
          resolve({
            ok: false,
            status: 409,
            json: () => Promise.resolve({ message: 'Existing bundle disappeared' }),
          })
      })
    }
    return normalFetch(url, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  fireEvent.click(
    await screen.findByRole('button', { name: 'Create a new bundle from these files' }),
  )
  // Everything that edits the plan is gated on the same in-flight flag, so
  // Accept is the stable signal that the switch is saving — and re-opening a
  // menu inside a retry callback would fire clicks on every poll.
  await waitFor(() => expect(screen.getByRole('button', { name: /^Accept / })).toBeDisabled())
  expect(
    screen.getByRole('button', { name: 'Create a new bundle from these files' }),
  ).toBeDisabled()
  finishDestination?.()

  await screen.findByText('Existing bundle disappeared')
  await waitFor(() => expect(screen.getByRole('button', { name: /^Accept / })).toBeEnabled())
  expect(screen.getByRole('button', { name: 'Create a new bundle from these files' })).toBeEnabled()
  expect(screen.getByText('Add to Sky, Sand, Sea & Salt - 4K')).toBeInTheDocument()
})

test('regenerating suggestions keeps returned candidates visible immediately', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  await screen.findByText('SRCV-005 - cut')
  fireEvent.click(screen.getByRole('button', { name: 'Suggest grouping' }))

  await screen.findByText('Suggestions generated from the current library state.')
  expect(screen.getByText('SRCV-005 - cut')).toBeInTheDocument()
  expect(
    screen.queryByText('Nothing to group — there are no unbundled files awaiting suggestions.'),
  ).not.toBeInTheDocument()
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) => url.endsWith('/grouping/plans') && init?.method === 'POST',
    ),
  ).toBe(true)
})

test('widens one folder in place, one rung at a time', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  await screen.findAllByRole('checkbox')
  fireEvent.click(dialButton('Widen', 'SRCV-005'))

  await screen.findByText(NOTICE_AFTER_WIDEN)
  expect(screen.getByText('SRCV-005 - cut')).toBeInTheDocument()
  // Mid-dial, so it can be reached again — the point of a dial over three stops.
  expect(dialButton('Widen', 'SRCV-005')).toBeEnabled()
  expect(dialButton('Narrow', 'SRCV-005')).toBeEnabled()
  // One directory's level, sent to the in-place endpoint — no plan regeneration.
  const put = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/stem-levels') && init?.method === 'PUT',
  )
  expect(put?.[1]).toMatchObject({
    body: JSON.stringify({ directory: 'SRCV-005', level: 2 }),
  })
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) => url.endsWith('/grouping/plans') && init?.method === 'POST',
    ),
  ).toBe(false)
})

test('places a folder stem control on the deepest matching container row', async () => {
  const outer: GroupingProposal = { ...PROPOSALS[0]!, title: 'Western', directory: 'Western' }
  const inner: GroupingProposal = {
    ...PROPOSALS[0]!,
    id: 'collection2',
    title: 'Nora Vance',
    directory: 'Western/Nora Vance',
    parent_proposal_id: outer.id,
  }
  // File paths must agree with `directory`: the stem control is placed from where
  // a row's files actually live, so a fixture whose paths point elsewhere would
  // read as a hand-merged cross-folder row and (correctly) get no control.
  const bundle: GroupingProposal = {
    ...PROPOSALS[1]!,
    directory: 'Western/Nora Vance',
    parent_proposal_id: inner.id,
    files: PROPOSALS[1]!.files.map((file) => ({
      ...file,
      relative_path: `Western/Nora Vance/${file.relative_path.split('/').pop()}`,
    })),
  }
  vi.stubGlobal('fetch', mockGroupingApi([outer, inner, bundle]))
  renderReview()

  await screen.findByRole('button', { name: 'Rename collection suggestion Western' })

  // The folder's dial belongs to the deepest row that speaks for it, and to that
  // row only.
  const folder = 'Western/Nora Vance'
  expect(queryDialButton('Widen', folder, 'Western')).toBeNull()
  expect(dialButton('Widen', folder, 'Nora Vance')).toBeInTheDocument()
})

test('Escape cancels a bundle suggestion rename', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  fireEvent.doubleClick(
    await screen.findByRole('button', { name: 'Rename bundle suggestion SRCV-005 - cut' }),
  )
  const input = screen.getByRole('textbox', { name: 'Bundle suggestion title' })
  fireEvent.change(input, { target: { value: 'Do not save' } })
  fireEvent.keyDown(input, { key: 'Escape' })

  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Rename bundle suggestion SRCV-005 - cut' }),
    ).toBeInTheDocument(),
  )
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
})

test('double-click renames a collection suggestion and persists it', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  fireEvent.doubleClick(
    await screen.findByRole('button', { name: 'Rename collection suggestion Movies' }),
  )
  const input = screen.getByRole('textbox', { name: 'Collection suggestion title' })
  fireEvent.change(input, { target: { value: 'Films' } })
  fireEvent.keyDown(input, { key: 'Enter' })

  await screen.findByRole('button', { name: 'Rename collection suggestion Films' })
  const patchCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/proposals/collection1') && init?.method === 'PATCH',
  )
  expect(patchCall?.[1]).toMatchObject({ body: JSON.stringify({ title: 'Films' }) })
})

/** Create the minimal mutable DataTransfer shape used by drag handlers. */
function dragData() {
  return { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn() }
}

/** The row element a drag now starts from.
 *
 * The ⠿ handles are gone: a bundle row and a file row are each draggable in
 * their entirety, which is how the file rows already behaved. */
function fileRow(name: string): HTMLElement {
  const row = screen.getByText(name).closest('.grp-file')
  if (!row) throw new Error(`missing file row for ${name}`)
  return row as HTMLElement
}

function bundleRow(title: string): HTMLElement {
  const row = screen.getByText(title).closest('.grp-row--bundle')
  if (!row) throw new Error(`missing bundle row for ${title}`)
  return row as HTMLElement
}

test('drags proposal files to reorder within a bundle', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  const review = renderReview()
  const dataTransfer = dragData()

  // File lists are closed by default and now unmounted rather than hidden, so a
  // drag has to start from a list the owner has actually opened.
  fireEvent.click(await screen.findByRole('button', { name: 'Show files' }))
  fireEvent.dragStart(fileRow('SRCV-005.mp4'), { dataTransfer })
  const fileList = screen.getByRole('list', { name: 'Files in SRCV-005 - cut' })
  fireEvent.dragOver(fileList, { dataTransfer })
  fireEvent.drop(fileList, { dataTransfer })

  await waitFor(() =>
    expect(
      [...review.container.querySelectorAll('.grp-file__name')].map((node) => node.textContent),
    ).toEqual(['SRCV-005.mp3', 'cover.jpg', 'SRCV-005.mp4', 'second.mp4']),
  )
  const moveCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/files/file1/move') && init?.method === 'PUT',
  )
  expect(moveCall?.[1]).toMatchObject({
    body: JSON.stringify({ target_proposal_id: 'proposal1', target_index: 3 }),
  })
})

test('drags a file row onto another bundle suggestion heading', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()
  const dataTransfer = dragData()

  fireEvent.click(await screen.findByRole('button', { name: 'Show files' }))
  const source = screen.getByText('cover.jpg').closest('.grp-file')
  const target = screen
    .getByRole('button', { name: 'Rename bundle suggestion Second bundle' })
    .closest('.grp-row--bundle')
  if (!source || !target) throw new Error('missing file drag source or bundle drop target')

  fireEvent.dragStart(source, { dataTransfer })
  fireEvent.dragOver(target, { dataTransfer })
  expect(target).toHaveClass('grp-row--file-drop')
  fireEvent.drop(target, { dataTransfer })

  const targetFiles = screen.getByRole('list', { name: 'Files in Second bundle' })
  await waitFor(() =>
    expect(
      [...targetFiles.querySelectorAll('.grp-file__name')].map((node) => node.textContent),
    ).toEqual(['second.mp4', 'cover.jpg']),
  )
  const moveCall = fetchMock.mock.calls.find(([url]) => url.endsWith('/files/file3/move'))
  expect(moveCall?.[1]).toMatchObject({
    body: JSON.stringify({ target_proposal_id: 'proposal2', target_index: 1 }),
  })
})

test('auto-deselects a bundle after its last file is dragged away', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()
  const dataTransfer = dragData()

  const sourceCheckbox = await screen.findByRole('checkbox', { name: 'Accept Second bundle' })
  expect(sourceCheckbox).toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'Show files' }))
  fireEvent.dragStart(fileRow('second.mp4'), { dataTransfer })
  const target = screen.getByRole('list', { name: 'Files in SRCV-005 - cut' })
  fireEvent.dragOver(target, { dataTransfer })
  fireEvent.drop(target, { dataTransfer })

  await waitFor(() => {
    expect(sourceCheckbox).not.toBeChecked()
    expect(sourceCheckbox).toBeDisabled()
  })
  expect([...target.querySelectorAll('.grp-file__name')].map((node) => node.textContent)).toEqual([
    'SRCV-005.mp4',
    'SRCV-005.mp3',
    'cover.jpg',
    'second.mp4',
  ])
})

test('drags a bundle suggestion into a collection suggestion', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()
  const dataTransfer = dragData()

  await screen.findByText('SRCV-005 - cut')
  fireEvent.dragStart(bundleRow('SRCV-005 - cut'), { dataTransfer })
  const title = screen.getByRole('button', { name: 'Rename collection suggestion Movies' })
  const collectionRow = title.closest('.grp-row')
  if (!collectionRow) throw new Error('missing collection row')
  fireEvent.dragOver(collectionRow, { dataTransfer })
  fireEvent.drop(collectionRow, { dataTransfer })

  await screen.findByText('Bundle moved into “Movies”.')
  const reparentCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/proposals/proposal1/parent') && init?.method === 'PUT',
  )
  expect(reparentCall?.[1]).toMatchObject({
    body: JSON.stringify({ parent_proposal_id: 'collection1', target_collection_id: null }),
  })
})

test('auto-deselects a collection after its last bundle is dragged out', async () => {
  const initial = PROPOSALS.map((proposal) =>
    proposal.id === 'proposal1' ? { ...proposal, parent_proposal_id: 'collection1' } : proposal,
  )
  const fetchMock = mockGroupingApi(initial)
  vi.stubGlobal('fetch', fetchMock)
  const review = renderReview()
  const dataTransfer = dragData()

  const collectionCheckbox = await screen.findByRole('checkbox', {
    name: 'Select bundles in Movies',
  })
  expect(collectionCheckbox).toBeChecked()
  expect(review.container.querySelector('.grp-root-drop')).not.toBeInTheDocument()
  fireEvent.dragStart(bundleRow('SRCV-005 - cut'), { dataTransfer })
  const rootTarget = review.container.querySelector('.grp-root-drop')
  if (!rootTarget) throw new Error('missing root drop target')
  fireEvent.dragOver(rootTarget, { dataTransfer })
  fireEvent.drop(rootTarget, { dataTransfer })

  await waitFor(() => {
    expect(collectionCheckbox).not.toBeChecked()
    expect(collectionCheckbox).toBeDisabled()
  })
  const reparentCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/proposals/proposal1/parent') && init?.method === 'PUT',
  )
  expect(reparentCall?.[1]).toMatchObject({
    body: JSON.stringify({ parent_proposal_id: null, target_collection_id: null }),
  })
})

test('selecting one nested bundle leaves its collection ancestors indeterminate', async () => {
  const fetchMock = mockGroupingApi(NESTED_PROPOSALS)
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  const outer = await screen.findByRole('checkbox', { name: 'Select bundles in Library' })
  const inner = screen.getByRole('checkbox', { name: 'Select bundles in Series' })
  const first = screen.getByRole('checkbox', { name: 'Accept Episode One' })
  const second = screen.getByRole('checkbox', { name: 'Accept Episode Two' })
  const sibling = screen.getByRole('checkbox', { name: 'Accept Feature' })
  fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }))
  await waitFor(() => expect(first).not.toBeChecked())

  fireEvent.click(first)

  await waitFor(() => {
    expect(first).toBeChecked()
    expect(second).not.toBeChecked()
    expect(sibling).not.toBeChecked()
    expect(inner).toBePartiallyChecked()
    expect(outer).toBePartiallyChecked()
  })
  expect(screen.getByText('1 bundle selected')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Collapse collection suggestion Library' }))
  expect(first).not.toBeVisible()
  expect(screen.getByText('1 bundle selected')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /^Accept / }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url.endsWith('/grouping/plans/plan1/apply') && init?.method === 'POST',
      ),
    ).toBe(true),
  )
  const applyCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/grouping/plans/plan1/apply') && init?.method === 'POST',
  )
  expect(JSON.parse(applyCall?.[1]?.body as string)).toEqual({ proposal_ids: ['nested-one'] })
})

test('a nested collection checkbox selects only its descendant bundles', async () => {
  vi.stubGlobal('fetch', mockGroupingApi(NESTED_PROPOSALS))
  renderReview()

  const inner = await screen.findByRole('checkbox', { name: 'Select bundles in Series' })
  const outer = screen.getByRole('checkbox', { name: 'Select bundles in Library' })
  const first = screen.getByRole('checkbox', { name: 'Accept Episode One' })
  const second = screen.getByRole('checkbox', { name: 'Accept Episode Two' })
  const sibling = screen.getByRole('checkbox', { name: 'Accept Feature' })
  fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }))
  await waitFor(() => expect(inner).not.toBeChecked())

  fireEvent.click(inner)

  await waitFor(() => {
    expect(inner).toBeChecked()
    expect(first).toBeChecked()
    expect(second).toBeChecked()
    expect(sibling).not.toBeChecked()
    expect(outer).toBePartiallyChecked()
  })
  expect(screen.getByText('2 bundles selected')).toBeInTheDocument()
})

test('existing collection context is labeled and cannot be edited or moved', async () => {
  const proposals = NESTED_PROPOSALS.map((proposal) =>
    proposal.kind === 'container'
      ? {
          ...proposal,
          target_collection_id: `target-${proposal.id}`,
          is_collection_context: true,
        }
      : proposal,
  )
  vi.stubGlobal('fetch', mockGroupingApi(proposals))
  renderReview()

  const title = await screen.findByText('Series', { selector: '.grp-title' })
  const row = title.closest('.grp-row--collection')
  if (!row) throw new Error('missing existing collection row')
  expect(within(row as HTMLElement).getByText('Existing')).toBeInTheDocument()
  expect(row).toHaveAttribute('draggable', 'false')
  expect(
    within(row as HTMLElement).queryByRole('button', {
      name: 'Rename collection suggestion Series',
    }),
  ).toBeNull()
  expect(
    within(row as HTMLElement).queryByRole('button', {
      name: 'Placement for collection suggestion Series',
    }),
  ).toBeNull()
  await screen.findAllByRole('checkbox')
  expect(queryConvert('bundle', 'Library')).toBeNull()
})

// A folder suggestion may resolve to a collection that already exists, so apply
// reuses it rather than creating a duplicate. That is a *destination*, not a
// claim of immutability — the row is still the owner's to rename, move, or
// reclassify. Gating read-only rendering on `target_collection_id` froze exactly
// these rows whenever a folder happened to share a collection's name.
test('a folder suggestion that reuses an existing collection stays editable', async () => {
  const proposals = NESTED_PROPOSALS.map((proposal) =>
    proposal.kind === 'container'
      ? {
          ...proposal,
          target_collection_id: `target-${proposal.id}`,
          is_collection_context: false,
        }
      : proposal,
  )
  vi.stubGlobal('fetch', mockGroupingApi(proposals))
  renderReview()

  const title = await screen.findByText('Series', { selector: '.grp-title' })
  const row = title.closest('.grp-row--collection')
  if (!row) throw new Error('missing collection row')
  expect(within(row as HTMLElement).queryByText('Existing')).toBeNull()
  expect(row).toHaveAttribute('draggable', 'true')
  expect(
    within(row as HTMLElement).getByRole('button', {
      name: 'Rename collection suggestion Series',
    }),
  ).toBeInTheDocument()
  expect(
    within(row as HTMLElement).getByRole('button', {
      name: 'Placement for collection suggestion Series',
    }),
  ).toBeInTheDocument()
})

test('a proposed collection placement control moves between parent and top level', async () => {
  const fetchMock = mockGroupingApi(NESTED_PROPOSALS)
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  const label = 'Placement for collection suggestion Series'
  fireEvent.click(await screen.findByRole('button', { name: label }))
  fireEvent.click(
    within(screen.getByRole('listbox', { name: 'Collection destinations' })).getByRole('option', {
      name: 'Top level',
    }),
  )
  await screen.findByText('Collection moved to the top level.')

  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.click(
    within(screen.getByRole('listbox', { name: 'Collection destinations' })).getByRole('option', {
      name: 'Current Archive',
    }),
  )
  await screen.findByText('Collection moved into “Current Archive”.')

  const bodies = fetchMock.mock.calls
    .filter(
      ([url, init]) => url.endsWith('/proposals/inner-collection/parent') && init?.method === 'PUT',
    )
    .map(([, init]) => JSON.parse(init?.body as string))
  expect(bodies).toEqual([
    { parent_proposal_id: null, target_collection_id: null },
    { parent_proposal_id: null, target_collection_id: 'current-archive' },
  ])
})

/** The row whose visible text contains `text` — the scope for that row's controls.
 *
 * Rows carry their own controls inline now (a `Convert to …` button, the folder's
 * stem dial) rather than behind one `...` trigger, so a test scopes by row rather
 * than by opening a menu.
 */
function rowOf(text: string): HTMLElement {
  const rows = [...document.querySelectorAll<HTMLElement>('.grp-row')]
  const row = rows.find((candidate) => candidate.textContent?.includes(text))
  if (!row) throw new Error(`no row containing ${text}`)
  return row
}

/** The convert-kind button on the row for `title`, or null when not offered. */
function queryConvert(direction: 'collection' | 'bundle', title: string): HTMLElement | null {
  return screen.queryByRole('button', { name: `Convert to ${direction}: ${title}` })
}

function convert(direction: 'collection' | 'bundle', title: string): HTMLElement {
  const button = queryConvert(direction, title)
  if (!button) throw new Error(`no Convert to ${direction} on ${title}`)
  return button
}

async function convertAsync(
  direction: 'collection' | 'bundle',
  title: string,
): Promise<HTMLElement> {
  return screen.findByRole('button', { name: `Convert to ${direction}: ${title}` })
}

/** A folder's stem dial: visible on the row that speaks for the folder. */
function dialButton(action: 'Narrow' | 'Widen' | 'Reset', folder: string, rowText?: string) {
  const scope = rowText ? within(rowOf(rowText)) : screen
  return scope.getByRole('button', { name: `${action} the filename match in ${folder}` })
}

function queryDialButton(action: 'Narrow' | 'Widen' | 'Reset', folder: string, rowText?: string) {
  const scope = rowText ? within(rowOf(rowText)) : screen
  return scope.queryByRole('button', { name: `${action} the filename match in ${folder}` })
}

test('a run of identical-shape suggestions folds into one row', async () => {
  // Four numbered clips the suggester treated identically: same file count,
  // same kinds, same reason. They are the rows an owner scrolls past.
  const clips = [1, 2, 3, 4].map((i) => ({
    ...PROPOSALS[1]!,
    id: `clip-${i}`,
    title: `SET-025-0${i}`,
    reason: 'numbered sequence',
    directories: [],
    files: [
      {
        asset_file_id: `v${i}`,
        relative_path: `d/SET-025-0${i}.mp4`,
        proposed_role: 'primary_video' as const,
        sequence: 0,
      },
      {
        asset_file_id: `c${i}`,
        relative_path: `d/SET-025-0${i}.webp`,
        proposed_role: 'cover' as const,
        sequence: 1,
      },
    ],
  }))
  vi.stubGlobal('fetch', mockGroupingApi(clips))
  renderReview()

  const rollup = await screen.findByText('SET-025-01 … SET-025-04')
  expect(screen.getByText('4 bundles, same shape · each 2 files · video, image')).toBeVisible()
  // The individual rows are not rendered until asked for.
  expect(screen.queryByRole('checkbox', { name: 'Accept SET-025-02' })).toBeNull()
  // ...but they are all still selected, and Accept still counts them.
  expect(screen.getByRole('button', { name: 'Accept 4 bundles' })).toBeEnabled()

  // One checkbox skips the whole run.
  const combined = screen.getByRole('checkbox', {
    name: 'Accept 4 suggestions from SET-025-01 … SET-025-04',
  })
  expect(combined).toBeChecked()
  fireEvent.click(combined)
  expect(screen.getByText('0 bundles selected')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Show all 4' }))

  expect(screen.getByRole('checkbox', { name: 'Accept SET-025-02' })).toBeInTheDocument()
  expect(rollup).not.toBeInTheDocument()
})

test('a run stops at a suggestion worth looking at', async () => {
  // The low-confidence row is never folded away, and it breaks the run.
  const shape = (i: number, confidence: number) => ({
    ...PROPOSALS[1]!,
    id: `clip-${i}`,
    title: `Clip 0${i}`,
    reason: 'numbered sequence',
    directories: [],
    confidence,
    files: [
      {
        asset_file_id: `v${i}`,
        relative_path: `d/c${i}.mp4`,
        proposed_role: 'primary_video' as const,
        sequence: 0,
      },
    ],
  })
  vi.stubGlobal(
    'fetch',
    mockGroupingApi([shape(1, 0.9), shape(2, 0.5), shape(3, 0.9), shape(4, 0.9), shape(5, 0.9)]),
  )
  renderReview()

  // The uncertain row keeps its own line…
  expect(await screen.findByRole('checkbox', { name: 'Accept Clip 02' })).toBeInTheDocument()
  // …the three after it are a run…
  expect(screen.getByText('Clip 03 … Clip 05')).toBeVisible()
  // …and the single row before it is too short to fold.
  expect(screen.getByRole('checkbox', { name: 'Accept Clip 01' })).toBeInTheDocument()
})

test('the review can be driven from the keyboard', async () => {
  const fetchMock = mockGroupingApi(NESTED_PROPOSALS)
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  await screen.findByRole('button', { name: 'Rename collection suggestion Library' })
  const tree = screen.getByRole('list', { name: /^Grouping suggestions/ })
  const rowOf = (name: string) =>
    screen.getByRole('button', { name }).closest('.grp-row') as HTMLElement

  // The tree is one tab stop; the first arrow lands on the first row.
  tree.focus()
  fireEvent.keyDown(tree, { key: 'ArrowDown' })
  const library = rowOf('Rename collection suggestion Library')
  expect(library).toHaveFocus()

  // Left folds, right unfolds — via the row's own disclosure.
  fireEvent.keyDown(library, { key: 'ArrowLeft' })
  expect(
    screen.getByRole('button', { name: 'Expand collection suggestion Library' }),
  ).toHaveAttribute('aria-expanded', 'false')
  fireEvent.keyDown(library, { key: 'ArrowRight' })
  expect(
    screen.getByRole('button', { name: 'Collapse collection suggestion Library' }),
  ).toHaveAttribute('aria-expanded', 'true')

  // Down reaches the nested rows, and space toggles the row's checkbox.
  fireEvent.keyDown(library, { key: 'ArrowDown' })
  const series = rowOf('Rename collection suggestion Series')
  expect(series).toHaveFocus()
  fireEvent.keyDown(series, { key: 'ArrowDown' })
  const episode = rowOf('Rename bundle suggestion Episode One')
  expect(episode).toHaveFocus()

  const accept = screen.getByRole('checkbox', { name: 'Accept Episode One' })
  expect(accept).toBeChecked()
  fireEvent.keyDown(episode, { key: ' ' })
  expect(accept).not.toBeChecked()

  // Cmd+Enter applies without reaching for the footer.
  fireEvent.keyDown(tree, { key: 'Enter', metaKey: true })
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/apply'))).toBe(true),
  )
})

test('a key press inside a row control is left to that control', async () => {
  vi.stubGlobal('fetch', mockGroupingApi())
  renderReview()

  const title = await screen.findByRole('button', {
    name: 'Rename bundle suggestion SRCV-005 - cut',
  })
  fireEvent.doubleClick(title)
  const input = screen.getByRole('textbox', { name: 'Bundle suggestion title' })
  const checkbox = screen.getByRole('checkbox', { name: 'Accept SRCV-005 - cut' })
  const checkedBefore = (checkbox as HTMLInputElement).checked

  // Space in the rename box is a space, not an accept toggle.
  fireEvent.keyDown(input, { key: ' ' })
  expect((checkbox as HTMLInputElement).checked).toBe(checkedBefore)
  expect(input).toBeInTheDocument()
})

// --- Review fixes (2026-08-10) -----------------------------------------------

test('Cmd+Enter obeys the same guards as the Accept button', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  const tree = await screen.findByRole('list', { name: /^Grouping suggestions/ })
  const applied = () => fetchMock.mock.calls.some(([url]) => url.endsWith('/apply'))

  // Nothing selected: the button is disabled, so the shortcut must be too.
  fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }))
  await waitFor(() => expect(screen.getByRole('button', { name: /^Accept/ })).toBeDisabled())
  fireEvent.keyDown(tree, { key: 'Enter', metaKey: true })
  expect(applied()).toBe(false)

  // Mid-rename: likewise blocked, and the keystroke belongs to the text box.
  fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
  fireEvent.doubleClick(
    screen.getByRole('button', { name: 'Rename bundle suggestion SRCV-005 - cut' }),
  )
  const input = screen.getByRole('textbox', { name: 'Bundle suggestion title' })
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
  expect(applied()).toBe(false)

  // Escape out of the rename, and then it works.
  fireEvent.keyDown(input, { key: 'Escape' })
  await waitFor(() => expect(screen.getByRole('button', { name: /^Accept/ })).toBeEnabled())
  fireEvent.keyDown(tree, { key: 'Enter', metaKey: true })
  await waitFor(() => expect(applied()).toBe(true))
})

test('a read-only existing-collection row offers no folder actions', async () => {
  const context = {
    ...NESTED_PROPOSALS[0]!,
    target_collection_id: 'live',
    is_collection_context: true,
  }
  vi.stubGlobal('fetch', mockGroupingApi([context, ...NESTED_PROPOSALS.slice(1)]))
  renderReview()

  // Narrow/Widen regenerate plan rows for a directory this row does not name.
  await screen.findAllByRole('checkbox')
  expect(
    within(rowOf('Library')).queryByRole('button', {
      name: /^(Narrow|Widen) the filename match/,
    }),
  ).toBeNull()
})

test('the top of the dial explains why it stops, without a label that moves', async () => {
  vi.stubGlobal('fetch', mockGroupingApi(undefined, undefined, { 'SRCV-005': STEM_DIAL_MAX }))
  renderReview()

  await screen.findAllByRole('checkbox')
  // Two buttons and nothing else. A "stem N of M" label changed width with its
  // numbers and Reset appeared only away from the default, and the row is
  // right-aligned — so both buttons slid sideways under a cursor about to click one
  // (owner-reported, 2026-08-15). Fixed labels cannot move.
  expect(screen.queryByText(/stem \d+ of \d+/)).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /^Reset the filename match/ }),
  ).not.toBeInTheDocument()
  const widen = dialButton('Widen', 'SRCV-005')
  expect(widen).toBeDisabled()
  expect(widen).toHaveAttribute(
    'title',
    'SRCV-005 is already matched on the first part of each filename — there is nothing left to widen',
  )
  expect(dialButton('Narrow', 'SRCV-005')).toBeEnabled()
})

test('the bottom of the dial explains itself and offers no further step', async () => {
  vi.stubGlobal('fetch', mockGroupingApi(undefined, undefined, { 'SRCV-005': 0 }))
  renderReview()

  await screen.findAllByRole('checkbox')
  const narrow = dialButton('Narrow', 'SRCV-005')
  expect(narrow).toBeDisabled()
  expect(narrow).toHaveAttribute(
    'title',
    'SRCV-005 already matches complete filenames — there is nothing more to match',
  )
  expect(dialButton('Widen', 'SRCV-005')).toBeEnabled()
})

test('each button says what it does to the stem, and to the bundles', async () => {
  vi.stubGlobal('fetch', mockGroupingApi())
  renderReview()

  // The tooltip is the whole explanation of a control whose two words could
  // otherwise mean anything (owner-reported, 2026-08-13).
  await screen.findAllByRole('checkbox')
  expect(dialButton('Narrow', 'SRCV-005')).toHaveAttribute(
    'title',
    'Match more of each filename in SRCV-005, creating more, smaller bundles',
  )
  expect(dialButton('Widen', 'SRCV-005')).toHaveAttribute(
    'title',
    'Match a shorter part of each filename in SRCV-005, creating fewer, larger bundles',
  )
  // Nothing to go back to at the default, so no Reset.
  expect(queryDialButton('Reset', 'SRCV-005')).toBeNull()
})

test('an expanded run can be folded back', async () => {
  const clips = [1, 2, 3].map((i) => ({
    ...PROPOSALS[1]!,
    id: `clip-${i}`,
    title: `Clip 0${i}`,
    reason: 'numbered sequence',
    directories: [],
    files: [
      {
        asset_file_id: `v${i}`,
        relative_path: `d/c${i}.mp4`,
        proposed_role: 'primary_video' as const,
        sequence: 0,
      },
    ],
  }))
  vi.stubGlobal('fetch', mockGroupingApi(clips))
  renderReview()

  fireEvent.click(await screen.findByRole('button', { name: 'Show all 3' }))
  expect(screen.getByRole('checkbox', { name: 'Accept Clip 02' })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Fold 3 back into one row' }))

  expect(screen.queryByRole('checkbox', { name: 'Accept Clip 02' })).toBeNull()
  expect(screen.getByText('Clip 01 … Clip 03')).toBeVisible()
})

test('Collapse all is disabled when there is nothing to collapse', async () => {
  vi.stubGlobal('fetch', mockGroupingApi([PROPOSALS[1]!]))
  renderReview()

  await screen.findByRole('checkbox', { name: 'Accept SRCV-005 - cut' })
  // A flat plan has no collections; the button used to be enabled and inert.
  expect(screen.getByRole('button', { name: 'Collapse all' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Expand all' })).toBeDisabled()
})

test('arrow keys keep working after focus lands on a row control', async () => {
  vi.stubGlobal('fetch', mockGroupingApi(NESTED_PROPOSALS))
  renderReview()

  const first = await screen.findByRole('checkbox', { name: 'Select bundles in Library' })
  first.focus()
  expect(first).toHaveFocus()

  // Navigation used to die here until the owner clicked bare row whitespace.
  fireEvent.keyDown(first, { key: 'ArrowDown' })
  expect(
    screen.getByRole('button', { name: 'Rename collection suggestion Series' }).closest('.grp-row'),
  ).toHaveFocus()
})

// --- Triage: confidence filter, contents summary, compact placement ----------

test('no row claims how sure the suggester is, and the guessed ones are counted', async () => {
  // The rows used to carry a band in words. It was removed for being wrong often
  // enough that stating certainty was the misleading part (owner, 2026-08-28).
  // What is left says what the suggester *went on*, not how sure it was.
  const unsure = { ...PROPOSALS[1]!, id: 'weak', title: 'Loose Clip', confidence: 0.5 }
  vi.stubGlobal('fetch', mockGroupingApi([...PROPOSALS, unsure]))
  renderReview()

  // Nothing is hidden, and the rows only going on the folder are still counted.
  await screen.findByRole('checkbox', { name: 'Accept Loose Clip' })
  expect(screen.getByRole('checkbox', { name: 'Accept SRCV-005 - cut' })).toBeInTheDocument()
  expect(screen.getByText('1 guessed from the folder')).toBeInTheDocument()

  const weakRow = screen
    .getByRole('button', { name: 'Rename bundle suggestion Loose Clip' })
    .closest('.grp-row') as HTMLElement
  expect(within(weakRow).queryByText('guess')).not.toBeInTheDocument()
  expect(weakRow).toHaveClass('grp-row--attention')

  const strongRow = screen
    .getByRole('button', { name: 'Rename bundle suggestion SRCV-005 - cut' })
    .closest('.grp-row') as HTMLElement
  expect(within(strongRow).queryByText('confident')).not.toBeInTheDocument()

  // No filter tabs to hide anything behind.
  expect(screen.queryByRole('button', { name: /Needs a look/ })).toBeNull()
})

test('a flagged row carries its reason; a confident one carries its contents', async () => {
  const unsure = {
    ...PROPOSALS[1]!,
    id: 'weak',
    title: 'Loose Clip',
    confidence: 0.5,
    reason: 'grouped by folder',
    directories: [],
  }
  vi.stubGlobal('fetch', mockGroupingApi([...PROPOSALS, unsure]))
  const review = renderReview()

  await screen.findByRole('checkbox', { name: 'Accept Loose Clip' })
  const flagged = screen
    .getByRole('button', { name: 'Rename bundle suggestion Loose Clip' })
    .closest('.grp-row')
  expect(flagged).toHaveClass('grp-row--attention')
  expect(within(flagged as HTMLElement).getByText('grouped by folder')).toBeInTheDocument()

  const confident = screen
    .getByRole('button', { name: 'Rename bundle suggestion SRCV-005 - cut' })
    .closest('.grp-row')
  expect(confident).not.toHaveClass('grp-row--attention')
  expect(review.container.querySelectorAll('.grp-row--attention')).toHaveLength(1)
})

test('the footer names what Accept does and what it leaves behind', async () => {
  const addition = { ...ADDITION, id: 'add-1' }
  vi.stubGlobal('fetch', mockGroupingApi([...PROPOSALS, addition]))
  renderReview()

  // Two new bundles plus one addition, all selected to begin with.
  expect(await screen.findByRole('button', { name: 'Accept 2 bundles + 1 addition' })).toBeEnabled()
  expect(screen.queryByText(/skipped/)).toBeNull()

  fireEvent.click(screen.getByRole('checkbox', { name: 'Accept SRCV-005 - cut' }))

  expect(screen.getByRole('button', { name: 'Accept 1 bundle + 1 addition' })).toBeEnabled()
  expect(
    screen.getByText('1 skipped stays unbundled and is suggested again next scan'),
  ).toBeInTheDocument()
})

test('a root row keeps its printed destination', async () => {
  vi.stubGlobal('fetch', mockGroupingApi())
  renderReview()

  const anchor = await screen.findByRole('button', {
    name: 'Placement for bundle suggestion SRCV-005 - cut',
  })
  expect(anchor.closest('.grp-placement-picker')).not.toHaveClass('grp-placement-picker--compact')
  expect(within(anchor).getByText('Top level')).toBeInTheDocument()
})

test('placement picker excludes draft collections when the library has none', async () => {
  vi.stubGlobal('fetch', mockGroupingApi(NESTED_PROPOSALS, []))
  renderReview()

  const anchor = await screen.findByRole('button', {
    name: 'Placement for bundle suggestion Episode One',
  })
  // Nested, so the destination is the row it is drawn inside: the affordance
  // stays (and keeps its accessible name) but stops reprinting the indentation.
  expect(anchor.closest('.grp-placement-picker')).toHaveClass('grp-placement-picker--compact')
  expect(within(anchor).queryByText('Suggested: Series')).toBeNull()
  expect(anchor).toHaveAttribute('title', 'Current placement: Suggested: Library / Series')
  fireEvent.click(anchor)

  const list = screen.getByRole('listbox', { name: 'Collection destinations' })
  expect(within(list).getByRole('option', { name: 'Top level' })).toBeVisible()
  expect(within(list).queryByRole('option', { name: 'Library / Series' })).toBeNull()
  expect(within(list).getByText('No collections yet')).toBeVisible()
})

test('placement picker presents a foldable searchable hierarchy without repeated prefixes', async () => {
  const fetchMock = mockGroupingApi(NESTED_PROPOSALS)
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Placement for bundle suggestion Episode One',
    }),
  )
  const panel = screen.getByRole('dialog', { name: 'Place bundle suggestion Episode One' })
  const list = within(panel).getByRole('listbox', { name: 'Collection destinations' })
  expect(within(list).queryByRole('option', { name: 'Library / Series' })).toBeNull()
  const nested = within(list).getByRole('option', {
    name: 'Current Archive / Current Series',
  })
  expect(nested).toHaveTextContent('Current Series')
  expect(nested).not.toHaveTextContent('Current Archive / Current Series')

  fireEvent.click(
    within(panel).getByRole('button', { name: 'Collapse destination Current Archive' }),
  )
  expect(nested).not.toBeInTheDocument()
  fireEvent.click(within(panel).getByRole('button', { name: 'Expand destination Current Archive' }))
  expect(
    within(list).getByRole('option', { name: 'Current Archive / Current Series' }),
  ).toBeVisible()

  const search = within(panel).getByRole('textbox', { name: 'Search collection destinations' })
  fireEvent.change(search, { target: { value: 'Current Series' } })
  const result = within(list).getByRole('option', {
    name: 'Current Archive / Current Series',
  })
  expect(result).toHaveTextContent('Current Series')
  expect(result).not.toHaveTextContent('Current Archive / Current Series')
  fireEvent.change(search, { target: { value: 'Current Archive' } })
  fireEvent.keyDown(search, { key: 'Enter' })

  await screen.findByText('Bundle moved into “Current Archive”.')
  const reparentCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/proposals/nested-one/parent') && init?.method === 'PUT',
  )
  expect(reparentCall?.[1]).toMatchObject({
    body: JSON.stringify({ parent_proposal_id: null, target_collection_id: 'current-archive' }),
  })
})

test('drags a proposed collection to the top level', async () => {
  const fetchMock = mockGroupingApi(NESTED_PROPOSALS)
  vi.stubGlobal('fetch', fetchMock)
  const review = renderReview()
  const dataTransfer = dragData()

  const title = await screen.findByRole('button', {
    name: 'Rename collection suggestion Series',
  })
  const row = title.closest('.grp-row--collection')
  if (!row) throw new Error('missing proposed collection row')
  fireEvent.dragStart(row, { dataTransfer })
  const rootTarget = review.container.querySelector('.grp-root-drop')
  if (!rootTarget) throw new Error('missing root drop target')
  fireEvent.dragOver(rootTarget, { dataTransfer })
  fireEvent.drop(rootTarget, { dataTransfer })

  await screen.findByText('Collection moved to the top level.')
  const reparentCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/proposals/inner-collection/parent') && init?.method === 'PUT',
  )
  expect(reparentCall?.[1]).toMatchObject({
    body: JSON.stringify({ parent_proposal_id: null, target_collection_id: null }),
  })
})

// --- Selection survives a Narrow/Widen regeneration ---------------------------

/** A grouping API whose regeneration mints fresh proposal ids, as the server does.
 *
 * `mockGroupingApi` reuses one proposal array across regeneration, so selection
 * tracked by id happens to survive there — the opposite of production, where
 * generating supersedes every row and issues new ULIDs. This mock reproduces the
 * real behavior so the regression is actually reachable.
 */
function mockRegeneratingApi() {
  let generation = 0
  let stemLevels: Record<string, number> = {}
  const proposalsFor = (gen: number): GroupingProposal[] =>
    structuredClone(PROPOSALS).map((p) => ({ ...p, id: `${p.id}-gen${gen}` }))

  return vi.fn((url: string, init?: RequestInit) => {
    const planId = `plan-gen${generation}`
    let body: unknown
    if (url.endsWith('/grouping/plans') && init?.method === 'POST') {
      generation += 1
      stemLevels = (JSON.parse(init.body as string) as { stem_levels: Record<string, number> })
        .stem_levels
      body = {
        id: `plan-gen${generation}`,
        status: 'open',
        rule_version: 5,
        scan_job_id: null,
        stem_levels: stemDials(proposalsFor(generation), stemLevels),
        generated_at: '2026-07-13T00:01:00Z',
        applied_at: null,
        proposals: proposalsFor(generation),
      }
    } else if (url.endsWith('/grouping/plans')) {
      body = [
        {
          id: planId,
          status: 'open',
          rule_version: 5,
          generated_at: '2026-07-13T00:00:00Z',
          applied_at: null,
          proposal_count: PROPOSALS.length,
        },
      ]
    } else if (url.match(/\/grouping\/plans\/plan-gen\d+$/)) {
      const gen = Number(url.match(/plan-gen(\d+)$/)![1])
      body = {
        id: `plan-gen${gen}`,
        status: 'open',
        rule_version: 5,
        scan_job_id: 'job1',
        stem_levels: stemDials(proposalsFor(gen), stemLevels),
        generated_at: '2026-07-13T00:00:00Z',
        applied_at: null,
        proposals: proposalsFor(gen),
      }
    } else {
      body = {}
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
}

function renderReviewAt(planId: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <GroupingReview initialPlanId={planId} onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

test('Widen keeps the suggestions the owner had already unchecked', async () => {
  vi.stubGlobal('fetch', mockGroupingApi())
  renderReview()

  // The "Movies" container has no children, so it is empty and never selectable:
  // two of the three fixture proposals count.
  const second = await screen.findByRole('checkbox', { name: 'Accept Second bundle' })
  await screen.findByText('2 bundles selected')
  fireEvent.click(second)
  expect(second).not.toBeChecked()
  await screen.findByText('1 bundle selected')

  fireEvent.click(dialButton('Widen', 'SRCV-005'))
  await screen.findByText(NOTICE_AFTER_WIDEN)

  // The adjusted directory's row returns as a fresh (checked) suggestion; the
  // deselection elsewhere survives.
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: 'Accept Second bundle' })).not.toBeChecked(),
  )
  expect(screen.getByRole('checkbox', { name: 'Accept SRCV-005 - cut' })).toBeChecked()
  expect(screen.getByText('1 bundle selected')).toBeInTheDocument()
})

test('a conversion elsewhere survives Widen', async () => {
  // The larger owner-reported problem: adjusting one folder must not undo the
  // bundle→collection override made on another.
  vi.stubGlobal('fetch', mockGroupingApi([...PROPOSALS, DIVISIBLE]))
  renderReview()

  fireEvent.click(await convertAsync('collection', 'Two Subjects'))
  await screen.findByText('“Two Subjects” is now a collection of bundles.')
  expect(await screen.findByRole('checkbox', { name: 'Accept alpha.mp4' })).toBeInTheDocument()

  fireEvent.click(dialButton('Widen', 'SRCV-005'))
  await screen.findByText(NOTICE_AFTER_WIDEN)

  // Still a collection, child row intact, and the way back still offered.
  expect(screen.getByRole('checkbox', { name: 'Accept alpha.mp4' })).toBeInTheDocument()
  expect(convert('bundle', 'Two Subjects')).toBeInTheDocument()
})

test('an explicit Suggest grouping starts from a clean selection', async () => {
  vi.stubGlobal('fetch', mockRegeneratingApi())
  renderReviewAt('plan-gen0')

  const second = await screen.findByRole('checkbox', { name: 'Accept Second bundle' })
  fireEvent.click(
    screen.getByRole('button', { name: 'Expand files in bundle suggestion Second bundle' }),
  )
  const secondFiles = screen.getByRole('list', { name: 'Files in Second bundle' })
  expect(secondFiles).toBeVisible()
  fireEvent.click(
    screen.getByRole('button', { name: 'Collapse files in bundle suggestion Second bundle' }),
  )
  expect(secondFiles).not.toBeVisible()
  fireEvent.click(second)
  await screen.findByText('1 bundle selected')

  fireEvent.click(screen.getByRole('button', { name: 'Suggest grouping' }))
  await screen.findByText('Suggestions generated from the current library state.')

  // Unlike Narrow/Widen, this is an explicit fresh start rather than an
  // adjustment, so everything comes back checked.
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: 'Accept Second bundle' })).toBeChecked(),
  )
  // A fresh start resets view state too: the file list the owner had opened is
  // closed again, like the checkboxes are re-checked.
  expect(
    screen.getByRole('button', { name: 'Expand files in bundle suggestion Second bundle' }),
  ).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('2 bundles selected')).toBeInTheDocument()
})

// --- Bundle <-> collection override ------------------------------------------
test('turns a bundle suggestion into a collection of bundles', async () => {
  const fetchMock = mockGroupingApi([DIVISIBLE])
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  fireEvent.click(await convertAsync('collection', 'Two Subjects'))

  await screen.findByText('“Two Subjects” is now a collection of bundles.')
  const put = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/proposals/divisible1/kind') && init?.method === 'PUT',
  )
  expect(put?.[1]).toMatchObject({ body: JSON.stringify({ kind: 'container' }) })

  // Its subjects are now bundles of their own, nested under it.
  expect(await screen.findByRole('checkbox', { name: 'Accept alpha.mp4' })).toBeInTheDocument()
  expect(screen.getByRole('checkbox', { name: 'Accept beta.mp4' })).toBeInTheDocument()
  // And the row offers the way back, so the override is not a one-way door.
  expect(convert('bundle', 'Two Subjects')).toBeInTheDocument()
})

test('accepts only file-backed child bundles returned by a conversion', async () => {
  const fetchMock = mockGroupingApi([DIVISIBLE])
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  fireEvent.click(await convertAsync('collection', 'Two Subjects'))
  await screen.findByText('“Two Subjects” is now a collection of bundles.')

  fireEvent.click(screen.getByRole('button', { name: /^Accept / }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url.endsWith('/grouping/plans/plan1/apply') && init?.method === 'POST',
      ),
    ).toBe(true),
  )
  const applyCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/grouping/plans/plan1/apply') && init?.method === 'POST',
  )
  const payload = JSON.parse(applyCall?.[1]?.body as string) as { proposal_ids: string[] }
  expect(new Set(payload.proposal_ids)).toEqual(new Set(['divisible1-child0', 'divisible1-child1']))
})

test('a single-subject bundle may still become a collection', async () => {
  // The owner may be making a home for siblings to drag in, so this is offered
  // even though nothing divides.
  vi.stubGlobal('fetch', mockGroupingApi())
  renderReview()

  expect(await convertAsync('collection', 'SRCV-005 - cut')).toBeInTheDocument()
})

test('a single-subject bundle inside its own folder collection can still convert', async () => {
  // The client used to withhold the conversion here, on the grounds that another
  // layer would repeat the name it is inside. That is exactly the row an owner
  // reaches for it on — a folder holding one release that should be a collection
  // (owner-reported, 2026-08-13). The server still refuses the one conversion
  // that would rename nothing, and says so.
  const collection: GroupingProposal = {
    ...PROPOSALS[0]!,
    id: 'own-folder',
    title: 'Second',
    directory: 'Second',
  }
  const child: GroupingProposal = { ...PROPOSALS[2]!, parent_proposal_id: collection.id }
  vi.stubGlobal('fetch', mockGroupingApi([collection, child]))
  renderReview()

  expect(await convertAsync('collection', child.title!)).toBeInTheDocument()
})

test('an addition suggestion offers no collection override', async () => {
  vi.stubGlobal('fetch', mockGroupingApi([...PROPOSALS, ADDITION]))
  renderReview()

  // An addition puts its files into a bundle that already exists, which is not
  // going to become a collection.
  await screen.findByText(/Add to/)
  expect(queryConvert('collection', 'Add to Sky, Sand, Sea & Salt - 4K')).toBeNull()
})

// --- Tooltips do not outlive the control they belong to ----------------------

const ALBUM: GroupingProposal[] = [
  {
    id: 'album1',
    kind: 'bundle',
    title: 'album',
    directory: 'trip/album',
    parent_proposal_id: null,
    target_bundle_id: null,
    target_bundle_title: null,
    create_new_bundle: false,
    target_collection_id: null,
    is_collection_context: false,
    confidence: 0.5,
    reason: '30 files in one folder, kept as a folder',
    directories: [
      {
        id: 'dir1',
        directory_path: 'trip/album',
        name: 'album',
        file_count: 30,
        expanded: false,
      },
    ],
    files: Array.from({ length: 30 }, (_unused, index) => ({
      asset_file_id: `photo${index}`,
      relative_path: `trip/album/shot${index}.jpg`,
      proposed_role: 'image' as const,
      sequence: index,
    })),
  },
]

test('an album arrives as one folder row rather than thirty file rows', async () => {
  // The complaint plan 6 exists to answer, at the surface it was made about.
  vi.stubGlobal('fetch', mockGroupingApi(structuredClone(ALBUM)))
  renderReview()
  // File lists are folded by default; the folder row lives inside one.
  fireEvent.click(
    await screen.findByRole('button', { name: 'Expand files in bundle suggestion album' }),
  )

  const folder = await screen.findByTitle('trip/album')
  expect(within(folder).getByText('Folder · 30 files')).toBeInTheDocument()
  expect(screen.queryByText('shot0.jpg')).not.toBeInTheDocument()
  expect(screen.queryByText('shot29.jpg')).not.toBeInTheDocument()
})

test('declining a folder row lists its files instead', async () => {
  vi.stubGlobal('fetch', mockGroupingApi(structuredClone(ALBUM)))
  renderReview()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Expand files in bundle suggestion album' }),
  )

  fireEvent.click(await screen.findByRole('button', { name: /List the 30 files/ }))

  // Declining changes only how the suggestion is drawn, so the same files are
  // still in it — there is nothing to restore.
  await waitFor(() => expect(screen.getByText('shot0.jpg')).toBeInTheDocument())
  expect(screen.getByText('shot29.jpg')).toBeInTheDocument()

  // The row stays, marked, so the decision can be taken back. Deleting it was
  // the first shape and made looking inside a folder a one-way door.
  const folder = screen.getByTitle('trip/album')
  expect(within(folder).getByText('Folder · listing 30 files')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /Keep album as one folder row/ }))
  await waitFor(() => expect(screen.queryByText('shot0.jpg')).not.toBeInTheDocument())
  expect(within(screen.getByTitle('trip/album')).getByText('Folder · 30 files')).toBeInTheDocument()
})

test('a folder can be looked into without changing the plan', async () => {
  // The owner's ask (2026-08-28): deciding whether a folder *should* be a folder
  // meant flattening it first, and flattening had no way back.
  vi.stubGlobal('fetch', mockGroupingApi(structuredClone(ALBUM)))
  renderReview()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Expand files in bundle suggestion album' }),
  )

  const peek = await screen.findByRole('button', { name: 'Show what is in album' })
  fireEvent.click(peek)

  const inside = await screen.findByRole('list', { name: 'Inside album' })
  expect(within(inside).getByText('shot0.jpg')).toBeInTheDocument()
  expect(within(inside).getAllByRole('listitem')).toHaveLength(30)
  // Still one row as far as the plan is concerned: looking is not deciding.
  expect(within(screen.getByTitle('trip/album')).getByText('Folder · 30 files')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /List the 30 files/ })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Hide what is in album' }))
  expect(screen.queryByRole('list', { name: 'Inside album' })).not.toBeInTheDocument()
})
