// Shared drag-and-drop model for the Bundle Browser. A drag can carry either a
// set of bundles or a single collection; drop targets (folder cards, sidebar
// rows) react based on the payload. Kept in App-level state (same-document drag),
// so components don't need to (de)serialize dataTransfer during dragover.

// A collection drag carries the whole selected set in `ids` (multi-select drags
// like a bundle drag does) plus `id`, the one row/card actually grabbed. The
// grabbed one is what reorder math anchors on — "drop these three after the card
// I'm holding" needs to know which of the three is under the cursor — while
// `ids` is what actually moves. For a plain unselected drag both agree: [id].
export type DragItem =
  | { kind: 'bundles'; ids: string[] }
  | { kind: 'collection'; id: string; ids: string[] }

// Where a drop will land relative to the hovered item: reorder before/after it,
// or move *into* it (reparent a collection / add a bundle).
export type DropZone = 'before' | 'into' | 'after'

/** Classify the cursor position over a target into before / into / after. The
 * middle band is "into"; the leading/trailing bands reorder. `orientation` is
 * 'horizontal' for grid tiles (left/right) and 'vertical' for list rows
 * (top/bottom). When `allowInto` is false (e.g. a bundle grid where you can only
 * reorder), it collapses to a before/after split at the midpoint. */
export function dropZone(
  e: { clientX: number; clientY: number },
  rect: DOMRect,
  orientation: 'horizontal' | 'vertical',
  allowInto: boolean,
): DropZone {
  const size = orientation === 'horizontal' ? rect.width : rect.height
  const frac =
    orientation === 'horizontal' ? (e.clientX - rect.left) / size : (e.clientY - rect.top) / size
  if (!allowInto) return frac < 0.5 ? 'before' : 'after'
  // 28% of a 226px card is a comfortable 63px, but 28% of a 28px sidebar row is
  // 8px — a band you have to aim for, which is why nesting kept winning drags
  // meant as reorders there. The reorder edges get a floor of 10px so short rows
  // stay usable, while the middle keeps at least a third of the row for nesting.
  const edge = Math.min(Math.max(0.28 * size, 10), size / 3) / size
  if (frac < edge) return 'before'
  if (frac > 1 - edge) return 'after'
  return 'into'
}

/** DataTransfer type carrying the dragged bundle ids (space-separated).
 *
 * The payload travels with the drag rather than in React state, so a drop never
 * depends on a render having happened since `dragstart` — the source of drops
 * that landed in the wrong place, or did nothing at all. */
export const DRAG_BUNDLES = 'application/x-cairndex-bundles'

// The drag payload, synchronously. React's `dragItem` state is the *reactive*
// copy — right for painting highlights, wrong for commit paths: a fast drag can
// deliver its drop before React has committed the dragstart's state update, and
// a handler gating on the prop then does nothing (a drag the owner made,
// silently discarded). Every dragstart/dragend writes here as well; dragover
// and drop handlers read here. Same-window only, which is all internal
// drag-and-drop ever is.
let activeDrag: DragItem | null = null

export function setActiveDrag(item: DragItem | null): void {
  activeDrag = item
}

export function getActiveDrag(): DragItem | null {
  return activeDrag
}

/**
 * Whether the drag in progress is asking to *copy* rather than move — ⌥ held.
 *
 * Reading `event.altKey` on the drop looks like the obvious answer and is what
 * this used to do, but it mostly reported false on the owner's machine: during a
 * native macOS drag the window server owns the keyboard, and whether the
 * platform's modifier flags reach drag events at all is a per-engine fact. The
 * Tauri shell (WKWebView) and Chrome need not agree, and nothing in the spec
 * settles it.
 *
 * The other candidate is `dataTransfer.dropEffect`, which the user agent
 * computes from `effectAllowed` and the user's modifier preference before each
 * `dragover`. That one cannot simply be trusted either: with
 * `effectAllowed = 'copyMove'` it can sit at `copy` for a whole drag with nothing
 * held, so believing it outright would copy *every* time. It is also destroyed
 * before any handler can see it, because each dragover handler assigns to it to
 * drive the cursor badge — which is why this reads it from a capture-phase
 * listener on the document, ahead of every handler in the app.
 *
 * Measurement settled both for the desktop shell: neither arrives there. That is
 * a limit on what WKWebView passes into JavaScript, not a macOS one — every
 * native app tracks ⌥ mid-drag by reading the system's own event state, which
 * stays current throughout a drag. So the shell now reads it too and the web
 * layer polls that answer for the duration of the drag (ADR-0023); it is the only
 * channel that works there, and the only one that is authoritative anywhere.
 *
 * The web channels remain, because the browser build has no host to ask and
 * Chrome does deliver the flags. They are believed when they demonstrably
 * *react*: a modifier flag that ever arrives is one this engine delivers, and a
 * `dropEffect` that ever changes is tracking something the app is not writing.
 * When nothing moves, the answer is the modifier state at `dragstart` — that
 * event fires from an ordinary mouse gesture, before the drag takes the keyboard,
 * so ⌥ held *before* the drag began is knowable even with no host and no live
 * signal. The default is move: a wrong move is one undo, while a wrong copy
 * quietly duplicates membership.
 */
interface CopyProbe {
  /** The OS's own answer, polled from the desktop host while a drag is in flight,
   *  or null where nothing can say — the browser build, or before the first poll
   *  has returned. This is the channel that makes ⌥ mid-drag work in the shell at
   *  all; see ADR-0023 for why the web ones cannot. */
  hostModifier: boolean | null
  /** ⌥ at `dragstart`, read while the page still had a normal event context. */
  heldAtStart: boolean
  /** Set once a *mid-drag* event carried the modifier, proving this engine
   *  delivers it; `modifierNow` is only meaningful after that. */
  modifierArrived: boolean
  modifierNow: boolean
  /** The user agent's own `dropEffect`, and whether it ever changed. Sampled from
   *  `dragenter` and `dragover`, never from `drop`: by then the value is whatever
   *  the last dragover handler assigned, so it reports the app back to itself. */
  firstEffect: string | null
  effectChanged: boolean
  effectNow: string | null
}

const NO_PROBE: CopyProbe = {
  hostModifier: null,
  heldAtStart: false,
  modifierArrived: false,
  modifierNow: false,
  firstEffect: null,
  effectChanged: false,
  effectNow: null,
}

let copyProbe: CopyProbe = { ...NO_PROBE }

/** ⌥, by either name. `getModifierState` is the spec's own accessor and can be
 *  populated where the shorthand flag is not; a synthetic event may have neither. */
function altHeld(event: DragEvent): boolean {
  if (event.altKey) return true
  return typeof event.getModifierState === 'function' && event.getModifierState('Alt')
}

/**
 * Watch the drag events for modifier evidence. Installed once for the lifetime of
 * the app and returns its own cleanup; the listeners are on `document` in the
 * capture phase so they see `dropEffect` before any handler overwrites it.
 */
export function installDragCopyTracking(
  target: Document,
  readHostModifier?: () => Promise<boolean | null>,
): () => void {
  // Polled rather than pushed: reading state needs no permission, while an event
  // tap that could push would prompt for Input Monitoring (ADR-0023). The
  // interval runs only between `dragstart` and `dragend`, so an idle app makes no
  // calls at all. 40ms keeps the answer fresher than a hand can release a key and
  // drop in.
  let poll: ReturnType<typeof setInterval> | undefined
  const stopPolling = () => {
    if (poll !== undefined) clearInterval(poll)
    poll = undefined
  }
  const ask = () => {
    if (!readHostModifier) return
    void readHostModifier()
      .then((held) => {
        // A drag that ended while this was in flight must not leave its answer
        // behind for the next one to read.
        if (poll !== undefined) copyProbe.hostModifier = held
      })
      // A host that cannot answer leaves the web channels in charge.
      .catch(() => undefined)
  }
  const startPolling = () => {
    stopPolling()
    if (!readHostModifier) return
    poll = setInterval(ask, 40)
    ask()
  }
  const noteEffect = (event: DragEvent) => {
    const effect = event.dataTransfer?.dropEffect ?? null
    if (effect === null) return
    if (copyProbe.firstEffect === null) copyProbe.firstEffect = effect
    else if (effect !== copyProbe.firstEffect) copyProbe.effectChanged = true
    copyProbe.effectNow = effect
  }
  const onDragStart = (event: DragEvent) => {
    copyProbe = { ...NO_PROBE, heldAtStart: altHeld(event) }
    startPolling()
  }
  const onDragOver = (event: DragEvent) => {
    if (altHeld(event)) {
      copyProbe.modifierArrived = true
      copyProbe.modifierNow = true
    } else if (copyProbe.modifierArrived) {
      copyProbe.modifierNow = false
    }
    noteEffect(event)
  }
  // `dragenter` is sampled for the same reason `dragover` is, and is the more
  // trustworthy of the two: no handler in the app writes `dropEffect` on
  // dragenter, so its value cannot be the app's own write coming back — which is
  // the suspected reason the dragover reading never varies in some engines. It
  // only fires when the pointer crosses into a new element, so it is a supplement
  // rather than a replacement.
  const onDragEnter = (event: DragEvent) => {
    if (altHeld(event)) {
      copyProbe.modifierArrived = true
      copyProbe.modifierNow = true
    }
    noteEffect(event)
  }
  const onDrop = (event: DragEvent) => {
    // The drop's own modifier flags are the freshest there are, and unlike its
    // `dropEffect` they are not something the app wrote.
    if (altHeld(event)) {
      copyProbe.modifierArrived = true
      copyProbe.modifierNow = true
    }
  }
  const onDragEnd = () => {
    stopPolling()
    copyProbe = { ...NO_PROBE }
  }

  const listeners = [
    ['dragstart', onDragStart],
    ['dragenter', onDragEnter],
    ['dragover', onDragOver],
    ['drop', onDrop],
    ['dragend', onDragEnd],
  ] as const
  for (const [type, listener] of listeners) target.addEventListener(type, listener, true)
  return () => {
    stopPolling()
    for (const [type, listener] of listeners) target.removeEventListener(type, listener, true)
  }
}

/** Whether this drag means copy. Safe to call from any dragover or drop handler;
 *  see `CopyProbe` for why it is not just `event.altKey`. */
export function isCopyDrag(): boolean {
  // Two channels report *real* modifier state: the host's read of the OS, and —
  // on engines that deliver them — the drag events' own flags. Either being
  // available settles the question, and either saying "down" is enough: neither
  // can invent a copy, so believing whichever one has the modifier avoids
  // depending on which is fresher. `dropEffect` is not in this group; it can sit
  // at `copy` with nothing held, so it is only consulted when it has been seen to
  // change, and only when nothing better exists.
  const host = copyProbe.hostModifier
  const web = copyProbe.modifierArrived ? copyProbe.modifierNow : null
  if (host !== null || web !== null) return host === true || web === true
  if (copyProbe.effectChanged) return copyProbe.effectNow === 'copy'
  return copyProbe.heldAtStart
}

/** Test seam. Production code never needs this: `dragstart` resets the probe and
 *  `dragend` clears it. */
export function resetDragCopyTracking(): void {
  copyProbe = { ...NO_PROBE }
}

/**
 * Where a reorder drop will land, named once.
 *
 * A gap between two cards can be described from either side — "after the left
 * one" or "before the right one" — and describing it both ways made a single
 * insertion point look like two seams that did the same thing. So a drop
 * resolves to a destination: the item the moved block lands in front of, or
 * `null` for the end of the group. `into` is the separate gesture of nesting.
 */
export type DropTarget = { kind: 'into'; id: string } | { kind: 'gap'; beforeId: string | null }

export function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  return a.kind === 'into' && b.kind === 'into'
    ? a.id === b.id
    : a.kind === 'gap' && b.kind === 'gap' && a.beforeId === b.beforeId
}

/**
 * The seam this item should paint for a destination, if any — a leading line on
 * the item the block lands before, or a trailing line on the last item when the
 * block lands at the end. Exactly one item in a group ever answers non-undefined,
 * which is the whole point.
 */
export function seamFor(
  target: DropTarget | null,
  id: string,
  order: string[],
): 'before' | 'after' | undefined {
  if (target === null || target.kind !== 'gap') return undefined
  if (target.beforeId !== null) return target.beforeId === id ? 'before' : undefined
  return order[order.length - 1] === id ? 'after' : undefined
}

/**
 * A drop destination inside the collection *tree*.
 *
 * Same idea as DropTarget, with the parent group attached: on screen a tree
 * interleaves rows from several levels, so "the end of the group" is meaningless
 * without saying which group. `beforeId` still names the row the moved block
 * lands in front of.
 */
export type TreeDrop =
  | { kind: 'into'; id: string }
  | { kind: 'gap'; parentId: string | null; beforeId: string | null }

export function sameTreeDrop(a: TreeDrop | null, b: TreeDrop | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind === 'into' && b.kind === 'into') return a.id === b.id
  if (a.kind === 'gap' && b.kind === 'gap')
    return a.parentId === b.parentId && a.beforeId === b.beforeId
  return false
}
