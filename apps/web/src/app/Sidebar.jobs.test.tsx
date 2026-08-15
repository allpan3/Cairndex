import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import type { JobRead } from '../api/client'
import type { ImportActivity } from './importActivity'
import { Sidebar } from './Sidebar'

function job(overrides: Partial<JobRead> = {}): JobRead {
  return {
    id: 'job1',
    library_id: 'lib1',
    job_type: 'scan',
    status: 'running',
    phase: 'discovering',
    message: null,
    payload: {},
    processed: 12,
    total: 40,
    result: null,
    error: null,
    cancel_requested: false,
    created_at: '2026-01-01T00:00:00Z',
    started_at: '2026-01-01T00:00:00Z',
    finished_at: null,
    ...overrides,
  } as JobRead
}

function importActivity(overrides: Partial<ImportActivity> = {}): ImportActivity {
  return {
    id: 'import1',
    name: 'clip.mkv',
    index: 2,
    total: 5,
    status: 'running',
    ...overrides,
  }
}

function renderSidebar(
  activeJobs: JobRead[],
  onCancelJob?: (jobId: string) => void,
  activeImports: ImportActivity[] = [],
  onCancelImport?: (batchId: string) => void,
) {
  render(
    <Sidebar
      mode="collection"
      onMode={() => undefined}
      libraries={[]}
      libraryId="lib1"
      onChangeLibrary={() => undefined}
      onManageLibraries={() => undefined}
      onOpenSettings={() => undefined}
      onUpdateLibrary={() => undefined}
      onScanFiles={() => undefined}
      onProbe={() => undefined}
      onGenerateStoryboards={() => undefined}
      onReviewGrouping={() => undefined}
      selection={{ view: 'all', collectionId: null }}
      onSelect={() => undefined}
      collections={[]}
      onDeleteCollection={() => undefined}
      onCreateCollection={() => undefined}
      onRenameCollection={() => undefined}
      onReorderCollections={() => undefined}
      onCleanupCollections={() => undefined}
      newCollectionRequest={null}
      smartCollections={[]}
      onNewSmartCollection={() => undefined}
      onEditSmartCollection={() => undefined}
      onDeleteSmartCollection={() => undefined}
      activeJobs={activeJobs}
      onCancelJob={onCancelJob}
      activeImports={activeImports}
      onCancelImport={onCancelImport}
    />,
  )
}

test('a running job names its phase and its count', () => {
  // The owner's report was that "Scan" and a bar said nothing about what was
  // happening or how far along it was (2026-07-30). The phase label and the
  // count are both already available; they were not reaching the component.
  renderSidebar([job()])

  expect(screen.getByText('Discovering files')).toBeInTheDocument()
  expect(screen.getByText('12/40')).toBeInTheDocument()
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('30')
})

test('every running job is shown, not just one', () => {
  // Scan, probe, thumbnail and storyboard jobs overlap — a storyboard pass
  // outlives the scan that queued it. A single slot hid whichever lost.
  renderSidebar([
    job({ id: 'a', job_type: 'scan', phase: 'reconciling' }),
    job({ id: 'b', job_type: 'storyboard', phase: 'storyboarding', processed: 3, total: 50 }),
  ])

  expect(screen.getByText('Reconciling moves')).toBeInTheDocument()
  expect(screen.getByText('Generating storyboards')).toBeInTheDocument()
  expect(screen.getAllByRole('progressbar')).toHaveLength(2)
})

test('nothing is rendered when nothing is running', () => {
  renderSidebar([])
  expect(screen.queryByRole('progressbar')).toBeNull()
})

test('a step within a phase says which step it is on', () => {
  // Grouping is one phase covering two steps, and on a large library the second
  // one is where the time goes. The generic phase label used to win over the
  // server's message, so the bar animated for tens of seconds saying only
  // "Preparing grouping suggestions" — which reads as a hang
  // (owner-reported, 2026-08-13).
  renderSidebar([
    job({
      phase: 'grouping',
      message: 'Writing grouping suggestions',
      processed: 900,
      total: 8105,
    }),
  ])

  expect(screen.getByText('Writing grouping suggestions')).toBeInTheDocument()
  expect(screen.queryByText('Preparing grouping suggestions')).toBeNull()
  expect(screen.getByText('900/8105')).toBeInTheDocument()
})

test('a phase with no message of its own still names itself', () => {
  renderSidebar([job({ phase: 'grouping', message: null, total: null, processed: 0 })])

  expect(screen.getByText('Preparing grouping suggestions')).toBeInTheDocument()
})

test('a job with no total still reports its phase', () => {
  // Indeterminate is honest for a phase that has not counted its work yet;
  // silence is not.
  renderSidebar([job({ total: null, processed: 0, phase: 'thumbnailing' })])

  expect(screen.getByText('Generating thumbnails')).toBeInTheDocument()
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
})

test('a first scan reports how far it has got even without a total', () => {
  // A library's first scan cannot know how many files it will find without
  // walking it twice, which on a network share costs as much again as the scan.
  // The count alone still moves, and is the thing worth watching.
  renderSidebar([job({ total: null, processed: 137, phase: 'discovering' })])

  expect(screen.getByText('137')).toBeInTheDocument()
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
})

test('a job that has counted nothing yet shows no count rather than a zero', () => {
  renderSidebar([job({ total: null, processed: 0, phase: 'discovering' })])

  expect(screen.queryByText('0')).not.toBeInTheDocument()
})

test('a waiting job says so instead of looking like it is working', () => {
  // A queued job carries no phase, so it used to render the job name beside the
  // same moving bar a running job has — waiting and working looked identical,
  // and pressing Update twice made two of them.
  renderSidebar([job({ status: 'queued', phase: null, total: null, processed: 0 })])

  expect(screen.getByText('Scan — waiting')).toBeInTheDocument()
  expect(screen.getByRole('progressbar').className).toContain('job-progress__track--waiting')
  expect(screen.getByRole('progressbar').className).not.toContain('indeterminate')
})

test('a running job can be stopped from the row it is on', () => {
  const onCancel = vi.fn()
  renderSidebar([job({ id: 'sb1', job_type: 'storyboard', phase: 'storyboarding' })], onCancel)

  fireEvent.click(screen.getByRole('button', { name: 'Stop storyboards' }))

  expect(onCancel).toHaveBeenCalledWith('sb1')
})

test('a job already asked to stop says so and cannot be asked twice', () => {
  renderSidebar([job({ cancel_requested: true })], () => undefined)

  expect(screen.getByText('Stopping scan…')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /^Stop/ })).toBeNull()
})

test('no stop control appears when the caller cannot cancel', () => {
  renderSidebar([job()])
  expect(screen.queryByRole('button', { name: /^Stop/ })).toBeNull()
})

test('an import row names the current file, count, and stop action', () => {
  const onCancel = vi.fn()
  renderSidebar([], undefined, [importActivity()], onCancel)

  expect(screen.getByText('Importing “clip.mkv”')).toBeInTheDocument()
  expect(screen.getByText('2/5')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Stop import' }))
  expect(onCancel).toHaveBeenCalledWith('import1')
})

test('an import waiting on a collision says it is waiting', () => {
  renderSidebar([], undefined, [importActivity({ status: 'waiting' })], () => undefined)

  expect(screen.getByText('Import — waiting')).toBeInTheDocument()
  expect(screen.getByText('clip.mkv')).toBeInTheDocument()
  expect(screen.getByRole('progressbar')).toHaveClass('job-progress__track--waiting')
})

test('an import already asked to stop keeps a disabled control', () => {
  renderSidebar([], undefined, [importActivity({ status: 'stopping' })], () => undefined)

  expect(screen.getByText('Stopping import…')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Stop import' })).toBeDisabled()
  expect(screen.getByRole('progressbar')).not.toHaveClass('job-progress__track--indeterminate')
  expect(screen.getByRole('progressbar').firstElementChild).toHaveStyle({ width: '0%' })
})

test('an import and a background job have independent rows', () => {
  renderSidebar([job()], undefined, [importActivity()])

  expect(screen.getByText('Importing “clip.mkv”')).toBeInTheDocument()
  expect(screen.getByText('Discovering files')).toBeInTheDocument()
  expect(screen.getAllByRole('progressbar')).toHaveLength(2)
})
