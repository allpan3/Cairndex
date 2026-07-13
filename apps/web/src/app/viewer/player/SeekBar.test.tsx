import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { PlayableVideo } from '../../../api/client'
import { SeekBar } from './SeekBar'
import type { PlayerController } from './usePlayer'

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient()
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

// A 100s video whose seek bar spans clientX 0..1000, so time = clientX / 10.
function setup() {
  const seek = vi.fn()
  const player = {
    duration: 100,
    currentTime: 0,
    buffered: [] as { start: number; end: number }[],
    seek,
    seekBy: vi.fn(),
  } as unknown as PlayerController
  const video = { chapters: [], storyboard_url: null } as unknown as PlayableVideo
  const utils = render(<SeekBar player={player} video={video} />, { wrapper })
  const track = utils.container.querySelector('.mv-seek__track') as HTMLElement
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    width: 1000,
    top: 0,
    height: 8,
    right: 1000,
    bottom: 8,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
  return { seek, track }
}

beforeEach(() => {
  vi.useFakeTimers()
  // jsdom doesn't implement pointer capture.
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.restoreAllMocks()
})

test('coalesces a burst of drag moves into few seeks and commits the release position', () => {
  const { seek, track } = setup()

  // Press seeks immediately (leading edge).
  fireEvent.pointerDown(track, { clientX: 100, pointerId: 1 })
  expect(seek).toHaveBeenCalledTimes(1)
  expect(seek).toHaveBeenLastCalledWith(10)

  // A rapid drag: 20 moves within the same throttle window issue no new seeks.
  for (let x = 110; x <= 300; x += 10) {
    fireEvent.pointerMove(track, { clientX: x, buttons: 1, pointerId: 1 })
  }
  expect(seek).toHaveBeenCalledTimes(1)

  // Release commits the exact final position and cancels the pending flush.
  fireEvent.pointerUp(track, { clientX: 300, pointerId: 1 })
  expect(seek).toHaveBeenCalledTimes(2)
  expect(seek).toHaveBeenLastCalledWith(30)

  // No trailing flush fires after release.
  vi.advanceTimersByTime(1000)
  expect(seek).toHaveBeenCalledTimes(2)
})

test('flushes the latest position once the throttle window elapses mid-drag', () => {
  const { seek, track } = setup()

  fireEvent.pointerDown(track, { clientX: 0, pointerId: 1 })
  expect(seek).toHaveBeenCalledTimes(1) // seek(0)

  // Moves within the window are coalesced into a pending trailing seek.
  fireEvent.pointerMove(track, { clientX: 200, buttons: 1, pointerId: 1 })
  fireEvent.pointerMove(track, { clientX: 400, buttons: 1, pointerId: 1 })
  expect(seek).toHaveBeenCalledTimes(1)

  // After the window elapses the trailing flush seeks the last requested spot.
  vi.advanceTimersByTime(150)
  expect(seek).toHaveBeenCalledTimes(2)
  expect(seek).toHaveBeenLastCalledWith(40)
})

test('tracks the captured pointer off-track and pins chrome until window release', () => {
  const onDragChange = vi.fn()
  const seek = vi.fn()
  const player = {
    duration: 100,
    currentTime: 0,
    buffered: [],
    seek,
    seekBy: vi.fn(),
    seekStep: 30,
  } as unknown as PlayerController
  const video = { chapters: [], storyboard_url: null } as unknown as PlayableVideo
  const utils = render(<SeekBar player={player} video={video} onDragChange={onDragChange} />, {
    wrapper,
  })
  const track = utils.container.querySelector('.mv-seek__track') as HTMLElement
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    width: 400,
    top: 0,
    height: 8,
    right: 500,
    bottom: 8,
    x: 100,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)

  fireEvent.pointerDown(track, { clientX: 200, pointerId: 7, button: 0 })
  fireEvent.pointerMove(window, { clientX: 900, pointerId: 7, buttons: 1 })
  vi.advanceTimersByTime(150)
  fireEvent.pointerUp(window, { clientX: 900, pointerId: 7 })

  expect(Element.prototype.setPointerCapture).toHaveBeenCalledWith(7)
  expect(seek).toHaveBeenLastCalledWith(100)
  expect(onDragChange.mock.calls).toEqual([[true], [false]])

  fireEvent.keyDown(track, { key: 'ArrowLeft' })
  expect(player.seekBy).toHaveBeenLastCalledWith(-30)
})

test('releases the parent drag pin when unmounted mid-drag', () => {
  const onDragChange = vi.fn()
  const seek = vi.fn()
  const player = {
    duration: 100,
    currentTime: 0,
    buffered: [],
    seek,
    seekBy: vi.fn(),
    seekStep: 5,
  } as unknown as PlayerController
  const video = { chapters: [], storyboard_url: null } as unknown as PlayableVideo
  const utils = render(<SeekBar player={player} video={video} onDragChange={onDragChange} />, {
    wrapper,
  })
  const track = utils.container.querySelector('.mv-seek__track') as HTMLElement
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    width: 100,
    top: 0,
    height: 8,
    right: 100,
    bottom: 8,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)

  fireEvent.pointerDown(track, { clientX: 50, pointerId: 2, button: 0 })
  utils.unmount()

  expect(onDragChange.mock.calls).toEqual([[true], [false]])
})
