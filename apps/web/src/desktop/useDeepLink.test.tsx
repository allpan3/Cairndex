import { render } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { isDesktopHost, listenHostDeepLink, takeHostPendingDeepLink } from '../platform'
import type { DeepLinkTarget } from '../platform'
import { useDeepLink } from './useDeepLink'

vi.mock('../platform', () => ({
  isDesktopHost: vi.fn(() => true),
  listenHostDeepLink: vi.fn().mockResolvedValue(() => undefined),
  takeHostPendingDeepLink: vi.fn().mockResolvedValue(null),
}))

let emit: ((target: DeepLinkTarget) => void) | null = null

function Harness({
  onLink,
  enabled = true,
}: {
  onLink: (target: DeepLinkTarget) => void
  enabled?: boolean
}) {
  useDeepLink(onLink, enabled)
  return null
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isDesktopHost).mockReturnValue(true)
  vi.mocked(takeHostPendingDeepLink).mockResolvedValue(null)
  emit = null
  vi.mocked(listenHostDeepLink).mockImplementation(async (handler) => {
    emit = handler
    return () => undefined
  })
})

test('delivers a link that arrives while the app is running', async () => {
  const onLink = vi.fn()
  render(<Harness onLink={onLink} />)
  await vi.waitFor(() => expect(emit).not.toBeNull())

  emit?.({ kind: 'bundle', id: 'b1', libraryId: 'lib-1' })
  expect(onLink).toHaveBeenCalledWith({ kind: 'bundle', id: 'b1', libraryId: 'lib-1' })
})

test('drains a link parked before the SPA could listen (cold start)', async () => {
  // macOS delivers the URL by Apple Event, which can fire before the webview
  // exists; the shell parks it and the SPA drains it on mount.
  vi.mocked(takeHostPendingDeepLink).mockResolvedValue({ kind: 'collection', id: 'c1' })
  const onLink = vi.fn()
  render(<Harness onLink={onLink} />)

  await vi.waitFor(() => expect(onLink).toHaveBeenCalledWith({ kind: 'collection', id: 'c1' }))
})

test('opens a cold-start link once even when the event also arrives', async () => {
  // Both delivery paths can describe the same user action. Without
  // de-duplication the target would be opened twice.
  const target: DeepLinkTarget = { kind: 'bundle', id: 'b1', libraryId: 'lib-1' }
  vi.mocked(takeHostPendingDeepLink).mockResolvedValue(target)
  const onLink = vi.fn()
  render(<Harness onLink={onLink} />)

  await vi.waitFor(() => expect(onLink).toHaveBeenCalledTimes(1))
  emit?.({ ...target })
  expect(onLink).toHaveBeenCalledTimes(1)
})

test('opens a genuinely different link after an earlier one', async () => {
  const onLink = vi.fn()
  render(<Harness onLink={onLink} />)
  await vi.waitFor(() => expect(emit).not.toBeNull())

  emit?.({ kind: 'bundle', id: 'b1' })
  emit?.({ kind: 'bundle', id: 'b2' })
  // Same kind, different id: de-duplication must not swallow a real navigation.
  expect(onLink).toHaveBeenCalledTimes(2)
  expect(onLink).toHaveBeenLastCalledWith({ kind: 'bundle', id: 'b2' })
})

test('subscribes before draining, so a link arriving in between is not lost', async () => {
  const order: string[] = []
  vi.mocked(listenHostDeepLink).mockImplementation(async (handler) => {
    order.push('listen')
    emit = handler
    return () => undefined
  })
  vi.mocked(takeHostPendingDeepLink).mockImplementation(async () => {
    order.push('drain')
    return null
  })
  render(<Harness onLink={vi.fn()} />)
  await vi.waitFor(() => expect(order).toContain('drain'))
  expect(order.indexOf('listen')).toBeLessThan(order.indexOf('drain'))
})

test('stays inert in the browser', () => {
  vi.mocked(isDesktopHost).mockReturnValue(false)
  render(<Harness onLink={vi.fn()} />)
  expect(listenHostDeepLink).not.toHaveBeenCalled()
  expect(takeHostPendingDeepLink).not.toHaveBeenCalled()
})

test('waits for readiness before draining, then delivers', async () => {
  // Regression: a cold-start link drains within milliseconds of mount, while the
  // libraries query is still in flight. Classifying it then would report every
  // `?library=` link as "not on this server", and the identity dedupe would stop
  // the corrected link from ever being re-delivered.
  vi.mocked(takeHostPendingDeepLink).mockResolvedValue({
    kind: 'bundle',
    id: 'b1',
    libraryId: 'lib-1',
  })
  const onLink = vi.fn()
  const view = render(<Harness onLink={onLink} enabled={false} />)

  await vi.waitFor(() => expect(listenHostDeepLink).not.toHaveBeenCalled())
  expect(takeHostPendingDeepLink).not.toHaveBeenCalled()
  expect(onLink).not.toHaveBeenCalled()

  // Libraries have now loaded: the parked link is drained and classified against
  // a populated list.
  view.rerender(<Harness onLink={onLink} enabled />)
  await vi.waitFor(() =>
    expect(onLink).toHaveBeenCalledWith({ kind: 'bundle', id: 'b1', libraryId: 'lib-1' }),
  )
  expect(onLink).toHaveBeenCalledTimes(1)
})

test('never classifies against a list that failed to load', async () => {
  // The gate is `isSuccess`, not "settled": on an errored libraries query the list
  // is empty, so delivering would report a valid `?library=` link as "not on this
  // server" while the app is already showing a connection failure. Staying quiet
  // is the honest outcome — and the shell's park TTL means a link is dropped
  // rather than mis-reported.
  vi.mocked(takeHostPendingDeepLink).mockResolvedValue({
    kind: 'bundle',
    id: 'b1',
    libraryId: 'lib-1',
  })
  const onLink = vi.fn()
  render(<Harness onLink={onLink} enabled={false} />)

  await vi.waitFor(() => expect(takeHostPendingDeepLink).not.toHaveBeenCalled())
  expect(onLink).not.toHaveBeenCalled()
})
