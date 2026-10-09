import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import { catalog, runJob, type Entity, type Job } from '../api/catalog'
import { draftKey } from '../api/replicas'
import { CatalogEditor } from './CatalogEditor'

vi.mock('../api/catalog', async (original) => ({
  ...(await original<typeof import('../api/catalog')>()),
  catalog: vi.fn(),
  runJob: vi.fn(),
}))

const owner = 'asset_bundles/synthetic-bundle'
const title = `${owner}/title`
const entity: Entity = {
  family: 'asset_bundles',
  id: 'synthetic-bundle',
  has_conflicts: false,
  observed: { [title]: ['opening-base'] },
  parents: ['opening-parent'],
  fields: {
    title: {
      unit: title,
      value: '"Original"',
      basis: ['opening-base'],
      candidates: [],
      held: null,
      components: {},
    },
  },
}

// The real editor and text control deliver drafts through an isolated mocked transport
async function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <CatalogEditor
        library="synthetic-library"
        entity={entity}
        editor="synthetic-editor"
        blocked={false}
        refresh={() => {}}
      />
    </QueryClientProvider>,
  )
  return screen.findByRole('textbox', { name: 'Title' })
}

// Query responses provide only the field under test and empty private-work lists
function read(path: string) {
  return path.startsWith('/controls/')
    ? [{ field: 'title', label: 'Title', kind: 'text', nullable: false, choices: [], columns: [] }]
    : { items: [] }
}

beforeEach(() => {
  localStorage.clear()
  vi.mocked(runJob).mockReset()
  vi.mocked(catalog)
    .mockReset()
    .mockImplementation(async (_library, path) => read(path))
})

const prepared: Job = {
  id: 'prepared-operation',
  action: 'preview',
  state: 'succeeded',
  result: {
    changes: [{ unit: title, value: '"Reviewed title"', basis: ['opening-base'] }],
    parents: ['opening-parent'],
    resolve: true,
    recover: false,
  },
  error: null,
  receipt: 'prepared-receipt',
}

// Restart recovery reads the retained identity without submitting another operation.
test('recovers a prepared preview from its retained private identity', async () => {
  localStorage.setItem(
    draftKey('synthetic-library', `preview/${owner}`, 'synthetic-editor'),
    JSON.stringify({ id: 'retained-draft', revision: 1, body: { job: prepared.id } }),
  )
  vi.mocked(catalog).mockImplementation(async (_library, path) =>
    path === `/jobs/${prepared.id}` ? prepared : read(path),
  )
  await setup()
  expect(await screen.findByRole('button', { name: 'Apply reviewed operation' })).toBeEnabled()
  expect(runJob).not.toHaveBeenCalled()
})

// The retained identity exists locally before the server accepts its queue request.
test('waits for preview queue acknowledgement before reading its receipt', async () => {
  let complete: (job: Job) => void = () => {}
  vi.mocked(runJob).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  vi.mocked(catalog).mockImplementation(async (_library, path) => {
    if (path.startsWith('/jobs/')) throw new Error('Catalog job is unavailable')
    return read(path)
  })
  await setup()
  fireEvent.click(screen.getByRole('button', { name: 'Prepare metadata deletion' }))
  await waitFor(() => expect(runJob).toHaveBeenCalledOnce())
  expect(vi.mocked(catalog).mock.calls.some(([, path]) => path.startsWith('/jobs/'))).toBe(false)
  await act(async () => complete(prepared))
  expect(screen.getByRole('button', { name: 'Apply reviewed operation' })).toBeEnabled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

// Recovery errors from an older receipt cannot replace a newly prepared review.
test('ignores an obsolete recovered preview error after a new submission', async () => {
  localStorage.setItem(
    draftKey('synthetic-library', `preview/${owner}`, 'synthetic-editor'),
    JSON.stringify({ id: 'old-draft', revision: 1, body: { job: 'old-operation' } }),
  )
  let rejectOld: (error: Error) => void = () => {}
  vi.mocked(catalog).mockImplementation(async (_library, path) => {
    if (path === '/jobs/old-operation')
      return new Promise((_resolve, reject) => {
        rejectOld = reject
      })
    return read(path)
  })
  vi.mocked(runJob).mockResolvedValue(prepared)
  await setup()
  fireEvent.click(screen.getByRole('button', { name: 'Prepare metadata deletion' }))
  await screen.findByRole('button', { name: 'Apply reviewed operation' })
  await act(async () => rejectOld(new Error('Catalog job is unavailable')))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Apply reviewed operation' })).toBeEnabled()
})

// A failure of the current submission remains visible and retains its retry identity.
test('reports a current preview failure and retains the private operation', async () => {
  vi.mocked(runJob).mockRejectedValue(new Error('Queue request failed'))
  await setup()
  fireEvent.click(screen.getByRole('button', { name: 'Prepare metadata deletion' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Queue request failed')
  const key = draftKey('synthetic-library', `preview/${owner}`, 'synthetic-editor')
  expect(JSON.parse(localStorage.getItem(key)!).body.job).toBe(vi.mocked(runJob).mock.calls[0]![3])
  expect(screen.queryByRole('button', { name: 'Apply reviewed operation' })).not.toBeInTheDocument()
})

// Older rejected deliveries cannot replace input or persist a warning after newer success
test('retains rapid input and ignores obsolete draft errors', async () => {
  let rejectOld: (error: Error) => void = () => {}
  vi.mocked(catalog).mockImplementation(async (_library, path, method, body) => {
    if (method === 'PUT' && (body as { revision: number }).revision === 1)
      return new Promise((_resolve, reject) => {
        rejectOld = reject
      })
    return read(path)
  })
  const input = await setup()
  fireEvent.change(input, { target: { value: 'First' } })
  fireEvent.change(input, { target: { value: 'Complete new title' } })
  await act(async () => rejectOld(new Error('A newer editor draft is already retained')))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(input).toHaveValue('Complete new title')
  const key = draftKey('synthetic-library', owner, 'synthetic-editor')
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({
    revision: 2,
    inputs: { [title]: '"Complete new title"' },
    observed: { [title]: ['opening-base'] },
  })
})

// A current failed delivery stays visible, then clears when the latest generation succeeds
test('reports current delivery failure and clears it after successful new delivery', async () => {
  vi.mocked(catalog).mockImplementation(async (_library, path, method, body) => {
    if (method === 'PUT' && (body as { revision: number }).revision === 1)
      throw new Error('Device unavailable')
    return read(path)
  })
  const input = await setup()
  fireEvent.change(input, { target: { value: 'Offline draft' } })
  expect(await screen.findByRole('alert')).toHaveTextContent('Device unavailable')
  fireEvent.change(input, { target: { value: 'Delivered draft' } })
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(input).toHaveValue('Delivered draft')
})

// Malformed local bytes survive a new edit and cannot be hidden by a successful delivery
test('retains malformed editor drafts independently of delivery status', async () => {
  const key = draftKey('synthetic-library', owner, 'synthetic-editor')
  localStorage.setItem(key, '{invalid')
  const input = await setup()
  fireEvent.change(input, { target: { value: 'Recoverable edit' } })
  expect(localStorage.getItem(`${key}.unreadable`)).toBe('{invalid')
  expect(screen.getByRole('alert')).toHaveTextContent('stored bytes are retained')
})
