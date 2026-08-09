import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { isValidElement, StrictMode } from 'react'
import { expect, test } from 'vitest'

import { RuntimeRoot, type RuntimeSurface } from './RuntimeRoot'

/** Starts a query that consumes its cancellation signal and stays in flight. */
function StartupQuery({ onStart }: { onStart: (signal: AbortSignal) => void }) {
  useQuery({
    queryKey: ['runtime-root-startup'],
    queryFn: ({ signal }) => {
      onStart(signal)
      return new Promise<string>(() => undefined)
    },
    retry: false,
  })
  return null
}

/** Renders an isolated startup query through the selected runtime root policy. */
function renderStartupQuery(surface: RuntimeSurface, onStart: (signal: AbortSignal) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <RuntimeRoot surface={surface}>
      <QueryClientProvider client={client}>
        <StartupQuery onStart={onStart} />
      </QueryClientProvider>
    </RuntimeRoot>,
  )
}

test('desktop starts a signal-consuming query once without aborting it', async () => {
  const signals: AbortSignal[] = []
  renderStartupQuery('desktop', (signal) => signals.push(signal))

  await waitFor(() => expect(signals).toHaveLength(1))
  expect(signals[0]?.aborted).toBe(false)
})

test('web keeps StrictMode replay around the shared frontend', () => {
  const root = RuntimeRoot({ surface: 'web', children: <span>shared frontend</span> })

  expect(isValidElement(root)).toBe(true)
  if (!isValidElement(root)) throw new Error('RuntimeRoot did not return a React element')
  expect(root.type).toBe(StrictMode)
})
