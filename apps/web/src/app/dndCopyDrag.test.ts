/**
 * Which signal `isCopyDrag()` believes, and when.
 *
 * These tests exist because the real answer is per-engine: a native macOS drag
 * hands the keyboard to the window server, and whether the modifier flags reach
 * drag events differs between Chrome and the WKWebView the desktop shell uses. So
 * each case here plays one engine's *behaviour* — flags that arrive, flags that
 * never do, a `dropEffect` that tracks the modifier, a `dropEffect` that just
 * sits at its `effectAllowed` default — and pins what the app concludes.
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { installDragCopyTracking, isCopyDrag, resetDragCopyTracking } from './dnd'

let uninstall: () => void

/** Reinstall with a host that answers, standing in for the desktop shell's read
 *  of the OS. `null` is the browser build, where nothing can say. */
function withHost(answer: () => boolean | null) {
  uninstall()
  uninstall = installDragCopyTracking(document, () => Promise.resolve(answer()))
}

/** Let the polled answer land: it arrives a microtask after the poll fires. */
const hostAnswered = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  resetDragCopyTracking()
  uninstall = installDragCopyTracking(document)
})
afterEach(() => {
  uninstall()
  resetDragCopyTracking()
  vi.restoreAllMocks()
})

/** A drag event as an engine would deliver it: `alt` is whether the modifier flag
 *  arrives at all, `dropEffect` is the value the user agent computed. */
function dispatch(
  type: 'dragstart' | 'dragover' | 'drop' | 'dragend',
  { alt = false, dropEffect }: { alt?: boolean; dropEffect?: string } = {},
) {
  const event = new Event(type, { bubbles: true }) as Event & Record<string, unknown>
  event.altKey = alt
  event.getModifierState = (key: string) => alt && key === 'Alt'
  event.dataTransfer = dropEffect === undefined ? null : { dropEffect }
  document.body.dispatchEvent(event)
}

test('a plain drag is a move', () => {
  dispatch('dragstart')
  dispatch('dragover', { dropEffect: 'move' })
  dispatch('drop', { dropEffect: 'move' })

  expect(isCopyDrag()).toBe(false)
})

test('an engine that delivers the modifier mid-drag is believed', () => {
  dispatch('dragstart')
  dispatch('dragover', { dropEffect: 'move' })
  dispatch('dragover', { alt: true, dropEffect: 'copy' })

  expect(isCopyDrag()).toBe(true)
})

test('releasing the modifier mid-drag goes back to a move', () => {
  dispatch('dragstart')
  dispatch('dragover', { alt: true, dropEffect: 'copy' })
  expect(isCopyDrag()).toBe(true)

  dispatch('dragover', { dropEffect: 'move' })

  expect(isCopyDrag()).toBe(false)
})

test('the modifier arriving only on the drop still counts', () => {
  dispatch('dragstart')
  dispatch('dragover', { dropEffect: 'move' })
  dispatch('drop', { alt: true, dropEffect: 'move' })

  // The drop's flags are the freshest there are, and unlike its `dropEffect` they
  // are not something the app wrote.
  expect(isCopyDrag()).toBe(true)
})

test('a dropEffect that moves with the modifier is believed when the flags never arrive', () => {
  // The engine delivers no modifier state at all — the owner's symptom — but its
  // own badge value changes when ⌥ goes down, which the app never wrote.
  dispatch('dragstart')
  dispatch('dragover', { dropEffect: 'move' })
  dispatch('dragover', { dropEffect: 'move' })
  dispatch('dragover', { dropEffect: 'copy' })

  expect(isCopyDrag()).toBe(true)
})

test('a dropEffect stuck at its effectAllowed default is not mistaken for a copy', () => {
  // With `effectAllowed = 'copyMove'` a user agent may report `copy` for a whole
  // drag with nothing held. Believing it outright would copy every single time —
  // which is what makes "just read dropEffect" the wrong fix.
  dispatch('dragstart')
  for (let i = 0; i < 5; i += 1) dispatch('dragover', { dropEffect: 'copy' })
  dispatch('drop', { dropEffect: 'copy' })

  expect(isCopyDrag()).toBe(false)
})

test('the modifier held before the drag began is honoured when nothing else moves', () => {
  // dragstart fires from an ordinary mouse gesture, before the drag takes the
  // keyboard, so this reading is trustworthy even on an engine that reports
  // nothing afterwards. It is the one ⌥ path that always works.
  dispatch('dragstart', { alt: true })
  for (let i = 0; i < 3; i += 1) dispatch('dragover', { dropEffect: 'copy' })

  expect(isCopyDrag()).toBe(true)
})

test('a modifier the engine reports mid-drag overrides the one held at the start', () => {
  dispatch('dragstart', { alt: true })
  // Held at mousedown, then let go before dropping, on an engine that says so.
  dispatch('dragover', { alt: true, dropEffect: 'copy' })
  dispatch('dragover', { dropEffect: 'move' })

  expect(isCopyDrag()).toBe(false)
})

test('each drag starts over, so one copy does not make the next one a copy', () => {
  dispatch('dragstart', { alt: true })
  dispatch('dragover', { alt: true, dropEffect: 'copy' })
  expect(isCopyDrag()).toBe(true)
  dispatch('dragend')

  dispatch('dragstart')
  dispatch('dragover', { dropEffect: 'move' })

  expect(isCopyDrag()).toBe(false)
})

test('no drag in progress is not a copy', () => {
  expect(isCopyDrag()).toBe(false)
})

test('an engine with no dataTransfer on its drag events does not throw', () => {
  dispatch('dragstart')
  dispatch('dragover')
  dispatch('drop')

  expect(isCopyDrag()).toBe(false)
})

test('the host’s reading is believed when the drag events carry nothing', async () => {
  // The desktop shell: no modifier flags on any drag event, and a `dropEffect`
  // that never budges. Before ADR-0023 this drag could only ever be a move.
  withHost(() => true)
  dispatch('dragstart')
  dispatch('dragover', { dropEffect: 'move' })
  await hostAnswered()

  expect(isCopyDrag()).toBe(true)
})

test('the host saying the key is up keeps the drag a move', async () => {
  withHost(() => false)
  dispatch('dragstart')
  dispatch('dragover', { dropEffect: 'copy' })
  await hostAnswered()

  // `dropEffect` sitting at `copy` is the `effectAllowed` default, not a modifier,
  // and a host that answers outranks it either way.
  expect(isCopyDrag()).toBe(false)
})

test('either real-modifier channel is enough, so a stale host reading cannot veto', async () => {
  withHost(() => false)
  dispatch('dragstart')
  // The engine delivers the flag *and* the host has not caught up. Both read real
  // modifier state and neither can invent a copy, so the one that has it wins.
  dispatch('dragover', { alt: true, dropEffect: 'copy' })
  await hostAnswered()

  expect(isCopyDrag()).toBe(true)
})

test('a host that cannot answer leaves the web channels in charge', async () => {
  uninstall()
  uninstall = installDragCopyTracking(document, () => Promise.reject(new Error('no host')))
  dispatch('dragstart', { alt: true })
  dispatch('dragover', { dropEffect: 'copy' })
  await hostAnswered()

  // Held before the drag began, which is the fallback that works everywhere.
  expect(isCopyDrag()).toBe(true)
})

test('a host answer arriving after the drag ended does not leak into the next one', async () => {
  let held = true
  withHost(() => held)
  dispatch('dragstart')
  dispatch('dragover', { dropEffect: 'move' })
  await hostAnswered()
  expect(isCopyDrag()).toBe(true)
  dispatch('dragend')

  held = false
  dispatch('dragstart')
  dispatch('dragover', { dropEffect: 'move' })

  // Before its first answer lands the new drag has no host reading at all, and
  // must not inherit the last drag's.
  expect(isCopyDrag()).toBe(false)
  await hostAnswered()
  expect(isCopyDrag()).toBe(false)
})
