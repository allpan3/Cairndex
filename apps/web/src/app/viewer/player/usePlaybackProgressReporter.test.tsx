import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { usePlaybackProgressReporter } from './usePlaybackProgressReporter'
import { runDesktopExitTasks } from '../../../desktop/exitTasks'

const { updatePlaybackProgress, beaconPlaybackProgress } = vi.hoisted(() => ({
  updatePlaybackProgress: vi.fn(),
  beaconPlaybackProgress: vi.fn(),
}))

vi.mock('../../../api/client', () => ({
  updatePlaybackProgress: (...args: unknown[]) => updatePlaybackProgress(...args),
  beaconPlaybackProgress: (...args: unknown[]) => beaconPlaybackProgress(...args),
}))

interface HarnessProps {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'
  currentTime: number
  duration?: number
  completed?: boolean | null
}

// Test shell that gives the hook a React Query client
function Harness({ status, currentTime, duration = 100, completed = false }: HarnessProps) {
  usePlaybackProgressReporter({
    bundleId: 'b0',
    fileId: 'f0',
    enabled: true,
    status,
    currentTime,
    duration,
    completed,
  })
  return null
}

// Render the reporter with a fresh query cache
function renderReporter(props: HarnessProps, queryClient = new QueryClient()) {
  const result = render(
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>,
  )
  return { ...result, queryClient }
}

beforeEach(() => {
  vi.useFakeTimers()
  updatePlaybackProgress.mockResolvedValue({
    position_s: 10,
    duration_s: 100,
    completed: false,
  })
})

afterEach(async () => {
  cleanup()
  await Promise.resolve()
  vi.useRealTimers()
  updatePlaybackProgress.mockReset()
  beaconPlaybackProgress.mockReset()
  vi.unstubAllGlobals()
})

test('reports playing progress on the throttled cadence', async () => {
  renderReporter({ status: 'playing', currentTime: 12 })

  act(() => vi.advanceTimersByTime(9999))
  expect(updatePlaybackProgress).not.toHaveBeenCalled()

  act(() => vi.advanceTimersByTime(1))
  expect(updatePlaybackProgress).toHaveBeenCalledWith('f0', {
    position_s: 12,
    duration_s: 100,
  })
})

test('does not invalidate continue-watching on ordinary cadence writes', async () => {
  const queryClient = new QueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  renderReporter({ status: 'playing', currentTime: 12 }, queryClient)

  await act(async () => {
    vi.advanceTimersByTime(10_000)
    await Promise.resolve()
  })

  expect(updatePlaybackProgress).toHaveBeenCalledWith('f0', {
    position_s: 12,
    duration_s: 100,
  })
  expect(invalidate).not.toHaveBeenCalled()
})

test('invalidates continue-watching when completion state changes', async () => {
  updatePlaybackProgress.mockResolvedValue({
    position_s: 96,
    duration_s: 100,
    completed: true,
  })
  const queryClient = new QueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  renderReporter({ status: 'playing', currentTime: 96, completed: false }, queryClient)

  await act(async () => {
    vi.advanceTimersByTime(10_000)
    await Promise.resolve()
  })

  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['continue-watching'] })
})

test('sends null duration only when the media duration is unknown', () => {
  renderReporter({ status: 'playing', currentTime: 12, duration: Number.NaN })

  act(() => vi.advanceTimersByTime(10_000))

  expect(updatePlaybackProgress).toHaveBeenCalledWith('f0', {
    position_s: 12,
    duration_s: null,
  })
})

test('flushes progress when playback pauses', async () => {
  const { rerender } = renderReporter({ status: 'playing', currentTime: 4 })

  act(() => {
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <Harness status="paused" currentTime={8} />
      </QueryClientProvider>,
    )
  })

  expect(updatePlaybackProgress).toHaveBeenCalledWith('f0', {
    position_s: 8,
    duration_s: 100,
  })
})

test('sends a beacon on pagehide', () => {
  renderReporter({ status: 'playing', currentTime: 9 })

  act(() => window.dispatchEvent(new Event('pagehide')))

  expect(beaconPlaybackProgress).toHaveBeenCalledWith('f0', {
    position_s: 9,
    duration_s: 100,
  })
})

test('awaits the ordinary progress write during desktop exit', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {})
  let resolveUpdate!: (value: {
    position_s: number
    duration_s: number
    completed: boolean
  }) => void
  updatePlaybackProgress.mockReturnValue(
    new Promise((resolve) => {
      resolveUpdate = resolve
    }),
  )
  renderReporter({ status: 'playing', currentTime: 9 })

  let settled = false
  const exiting = runDesktopExitTasks().then(() => {
    settled = true
  })
  await Promise.resolve()

  expect(updatePlaybackProgress).toHaveBeenCalledWith('f0', {
    position_s: 9,
    duration_s: 100,
  })
  expect(settled).toBe(false)
  act(() => window.dispatchEvent(new Event('pagehide')))
  expect(beaconPlaybackProgress).not.toHaveBeenCalled()

  resolveUpdate({ position_s: 9, duration_s: 100, completed: false })
  await exiting
  expect(settled).toBe(true)
})

test('invalidates continue-watching on unmount flush', async () => {
  const queryClient = new QueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const { unmount } = renderReporter({ status: 'playing', currentTime: 9 }, queryClient)

  await act(async () => {
    unmount()
    await Promise.resolve()
  })

  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['continue-watching'] })
})
