import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { setActiveLibraryId } from '../api/client'
import { hostLabelsFor } from '../platform'
import { FileBrowser } from './FileBrowser'
import { DEFAULT_PLAYER_PREFS } from './types'
import { pagesFor } from './useUnbundledWindow'

// The portable Unbundled queue is a window over the whole list: only the rows on
// screen are fetched (each fetched file costs a stat on the share), and Select All
// reads every key without fetching the rows themselves.

const TOTAL = 350
const path = (index: number) => `Queue/clip-${String(index).padStart(4, '0')}.mp4`
const view = {
  rows: [0, 9] as [number, number],
  status: { browse_version: 17, selection_version: 6 },
}
const requests: { url: string; body: { offset: number; limit: number } }[] = []
// A page held back, to look at the list while it loads
const held = { offset: -1, release: () => {} }

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () =>
      count === 0
        ? []
        : Array.from({ length: Math.min(view.rows[1], count - 1) - view.rows[0] + 1 }, (_, n) => {
            const index = view.rows[0] + n
            return { index, key: index, start: index * 40, size: 40 }
          }),
    measure: () => {},
    scrollToIndex: () => {},
  }),
}))
vi.mock('../api/useReplicaStatus', () => ({ useReplicaStatus: () => ({ data: view.status }) }))
vi.mock('../api/catalog', () => ({
  catalog: vi.fn(async (_library: string, url: string, _method: string, body: never) => {
    const { offset, limit } = body as { offset: number; limit: number }
    requests.push({ url, body })
    if (offset === held.offset) await new Promise<void>((resolve) => (held.release = resolve))
    const indexes = Array.from(
      { length: Math.max(0, Math.min(limit, TOTAL - offset)) },
      (_, n) => offset + n,
    )
    const keys = indexes.map((index) => ({
      id: `file-${index}`,
      bundle_id: 'staging',
      relative_path: path(index),
    }))
    return url === '/files/unbundled/ids'
      ? { items: keys, total: TOTAL, offset, limit }
      : {
          items: keys.map((key) => ({ ...key, media_kind: 'video', local_state: 'observed' })),
          total: TOTAL,
          offset,
          limit,
        }
  }),
}))

const pages = () =>
  requests.filter((request) => request.url === '/files/unbundled').map((r) => r.body.offset)

function renderQueue(
  onSourceAction: ((action: 'copy' | 'move' | 'trash', paths: string[]) => void) | null = vi.fn(),
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = () => (
    <QueryClientProvider client={client}>
      <FileBrowser
        catalogLibrary="library"
        libraryName="Media"
        scope="unbundled"
        path=""
        selectedPath={null}
        onNavigate={() => undefined}
        onSelectEntry={() => undefined}
        playerPrefs={DEFAULT_PLAYER_PREFS}
        onPlayerPrefs={() => undefined}
        onAddToBundle={() => undefined}
        onCreateBundle={() => undefined}
        onSourceAction={onSourceAction ?? undefined}
        hostLabels={hostLabelsFor('macos')}
      />
    </QueryClientProvider>
  )
  const rendered = render(tree())
  return () => rendered.rerender(tree())
}

let libraryIndex = 0
beforeEach(() => {
  requests.length = 0
  held.offset = -1
  view.rows = [0, 9]
  view.status = { browse_version: 17, selection_version: 6 }
  localStorage.clear()
  setActiveLibraryId(`unbundled-window-${++libraryIndex}`)
})

test('names the pages a range of rows needs, with the next page ready', () => {
  expect(pagesFor(0, 9, 350)).toEqual([0, 1])
  expect(pagesFor(195, 230, 350)).toEqual([1, 2, 3])
  expect(pagesFor(320, 349, 350)).toEqual([3])
  expect(pagesFor(0, 0, 0)).toEqual([0])
})

test('sizes the list from the total and fetches only the window a jump lands on', async () => {
  const rerender = renderQueue()
  await screen.findByText(path(0).split('/')[1]!)
  expect(screen.getByText('350 items')).toBeInTheDocument()
  expect(screen.getByRole('grid', { name: 'Files' })).toHaveAttribute('aria-rowcount', '351')
  await waitFor(() => expect(pages()).toEqual([0, 100]))

  // Dragging the scrollbar to the end skips every page in between
  held.offset = 300
  view.rows = [330, 339]
  rerender()
  await waitFor(() => expect(pages()).toContain(300))
  // While that page loads the list keeps its size, so the scroll position holds
  expect(screen.getByText('350 items')).toBeInTheDocument()
  expect(screen.getAllByText('Loading…').length).toBeGreaterThan(0)
  act(() => held.release())
  await screen.findByText(path(330).split('/')[1]!)
  expect(pages()).toEqual([0, 100, 300])
  expect(document.querySelector('[data-relpath]')).toHaveAttribute('aria-rowindex', '332')
  expect(requests.every((request) => request.url === '/files/unbundled')).toBe(true)
})

test('Select All takes every queued file, and actions too large for one step say why', async () => {
  const onSourceAction = vi.fn()
  renderQueue(onSourceAction)
  const row = await screen.findByText(path(0).split('/')[1]!)
  fireEvent.click(row)
  screen.getByRole('grid', { name: 'Files' }).focus()
  fireEvent.keyDown(window, { key: 'a', metaKey: true })
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('· 350 selected'))
  // The keys came from the key read; the rows themselves were not fetched
  expect(requests.filter((request) => request.url === '/files/unbundled/ids')).toHaveLength(1)
  expect(pages()).toEqual([0, 100])

  fireEvent.contextMenu(row)
  const menu = screen.getByRole('menu')
  const create = within(menu).getByRole('menuitem', { name: /Create Bundle from 350 Files…/ })
  expect(create).toBeDisabled()
  expect(create).toHaveTextContent('Select up to 100 files to bundle them.')
  const trash = within(menu).getByRole('menuitem', { name: 'Move 350 Items to Trash' })
  expect(trash).toBeEnabled()
  act(() => trash.click())
  expect(onSourceAction).toHaveBeenCalledWith('trash', expect.any(Array))
  expect(new Set(onSourceAction.mock.calls[0]![1] as string[])).toEqual(
    new Set(Array.from({ length: TOTAL }, (_, index) => path(index))),
  )
})

test('a menu whose every action is too large for the selection still opens to say why', async () => {
  renderQueue(null)
  const row = await screen.findByText(path(0).split('/')[1]!)
  fireEvent.click(row)
  screen.getByRole('grid', { name: 'Files' }).focus()
  fireEvent.keyDown(window, { key: 'a', metaKey: true })
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('· 350 selected'))
  fireEvent.contextMenu(row)
  const create = within(screen.getByRole('menu')).getByRole('menuitem', {
    name: /Create Bundle from 350 Files…/,
  })
  expect(create).toBeDisabled()
  expect(create).toHaveTextContent('Select up to 100 files to bundle them.')
})

test('Shift-click across rows not fetched reads their keys instead of cutting the range', async () => {
  const rerender = renderQueue()
  fireEvent.click(await screen.findByText(path(2).split('/')[1]!))
  view.rows = [330, 339]
  rerender()
  fireEvent.click(await screen.findByText(path(333).split('/')[1]!), { shiftKey: true })
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('· 332 selected'))
  const read = requests.find((request) => request.url === '/files/unbundled/ids')!
  expect(read.body).toMatchObject({ offset: 2, limit: 332 })
})

test('an older server selects only the loaded rows and says so', async () => {
  view.status = { browse_version: 17, selection_version: 5 }
  renderQueue()
  fireEvent.click(await screen.findByText(path(0).split('/')[1]!))
  await waitFor(() => expect(pages()).toEqual([0, 100]))
  screen.getByRole('grid', { name: 'Files' }).focus()
  fireEvent.keyDown(window, { key: 'a', metaKey: true })
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent(
      '· 200 selected. Select All selects the 200 loaded entries',
    ),
  )
  expect(requests.some((request) => request.url === '/files/unbundled/ids')).toBe(false)
})
