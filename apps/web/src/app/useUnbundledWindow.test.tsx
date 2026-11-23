import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, test, vi } from 'vitest'
import { useUnbundledWindow } from './useUnbundledWindow'

const answers = new Map<string, (value: unknown) => void>()
vi.mock('../api/catalog', () => ({
  catalog: (
    _library: string,
    _path: string,
    _method: string,
    body: { q: string; offset: number },
  ) => new Promise((resolve) => answers.set(`${body.q}@${body.offset}`, resolve)),
}))

const page = (...names: string[]) => ({
  offset: 0,
  total: names.length,
  items: names.map((name) => ({ relative_path: `Inbox/${name}` })),
})

test('a new search keeps the last rows until its own first page arrives', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { result, rerender } = renderHook(
    ({ q }) => useUnbundledWindow('lib', { q }, { start: 0, end: 10 }),
    {
      initialProps: { q: '' },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  )
  expect(result.current.isLoading).toBe(true)
  await waitFor(() => expect(answers.has('@0')).toBe(true))
  act(() => answers.get('@0')!(page('a.mp4', 'b.mp4')))
  await waitFor(() => expect(result.current.entries.map((e) => e.name)).toEqual(['a.mp4', 'b.mp4']))

  rerender({ q: 'b' })
  await waitFor(() => expect(answers.has('b@0')).toBe(true))
  expect(result.current.isLoading).toBe(false)
  expect(result.current.entries.map((e) => e.name)).toEqual(['a.mp4', 'b.mp4'])
  act(() => answers.get('b@0')!(page('b.mp4')))
  await waitFor(() => expect(result.current.entries.map((e) => e.name)).toEqual(['b.mp4']))
})
