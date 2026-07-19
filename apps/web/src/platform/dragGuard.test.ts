import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createDragGuard, type DragGuardDeps } from './dragGuard'

const ITEMS = [{ libraryId: 'lib', relativePath: 'a.mp4' }]

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function makeGuard(invoke: DragGuardDeps['invoke'] = vi.fn().mockResolvedValue(undefined)) {
  let endedHandler: ((event: { payload: number }) => void) | undefined
  const unlisten = vi.fn()
  const listen: DragGuardDeps['listen'] = vi.fn().mockImplementation(async (_event, handler) => {
    endedHandler = handler
    return unlisten
  })
  const guard = createDragGuard({ invoke, listen })
  return { guard, invoke, listen, unlisten, ended: (id: number) => endedHandler?.({ payload: id }) }
}

test('tags the drag with an id and passes it to the shell', async () => {
  const g = makeGuard()
  await g.guard.startFileDrag(ITEMS)
  expect(g.invoke).toHaveBeenCalledWith('start_file_drag', { items: ITEMS, dragId: 1 })
  expect(g.guard.isActive()).toBe(true)
})

test('stays active through a grace window after the matching ended event, then clears', async () => {
  const g = makeGuard()
  await g.guard.startFileDrag(ITEMS)
  g.ended(1)
  // A drop racing in just behind the ended event still sees an active guard.
  expect(g.guard.isActive()).toBe(true)
  vi.advanceTimersByTime(300)
  expect(g.guard.isActive()).toBe(false)
  expect(g.unlisten).toHaveBeenCalledOnce()
})

test('ignores a stale ended event from an earlier drag', async () => {
  const g = makeGuard()
  await g.guard.startFileDrag(ITEMS) // dragId 1
  g.ended(0) // an earlier drag's id
  vi.advanceTimersByTime(1000)
  expect(g.guard.isActive()).toBe(true) // still guarding drag 1
})

test('release() clears the guard immediately (belt: a drop landed on us)', async () => {
  const g = makeGuard()
  await g.guard.startFileDrag(ITEMS)
  expect(g.guard.isActive()).toBe(true)
  g.guard.release()
  expect(g.guard.isActive()).toBe(false)
  expect(g.unlisten).toHaveBeenCalledOnce()
})

test('a last-resort timeout releases a guard whose ended event is lost', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const g = makeGuard()
  await g.guard.startFileDrag(ITEMS)
  expect(g.guard.isActive()).toBe(true)
  vi.advanceTimersByTime(5 * 60_000)
  expect(g.guard.isActive()).toBe(false)
})

test('releases the guard when the drag fails to start', async () => {
  const g = makeGuard(vi.fn().mockRejectedValue(new Error('no drag')))
  await expect(g.guard.startFileDrag(ITEMS)).rejects.toThrow('no drag')
  expect(g.guard.isActive()).toBe(false)
})

test('a new drag supersedes the prior guard and uses a fresh id', async () => {
  const g = makeGuard()
  await g.guard.startFileDrag(ITEMS)
  await g.guard.startFileDrag(ITEMS)
  expect(g.invoke).toHaveBeenLastCalledWith('start_file_drag', { items: ITEMS, dragId: 2 })
  // The first drag's ended event must not clear the second drag's guard.
  g.ended(1)
  vi.advanceTimersByTime(300)
  expect(g.guard.isActive()).toBe(true)
})
