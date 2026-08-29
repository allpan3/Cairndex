import {
  Fragment,
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import {
  ConflictError,
  type BundleRead,
  type DirectoryMember,
  type FileRead,
  thumbnailUrl,
} from '../api/client'
import { useBundleInspectorActions } from './bundleInspectorActions'
import { bundleFileMenuEntries } from './bundleFileMenu'
import { bundleRows, splitByFolder } from './bundleRows'
import { ContactSheetDialog } from './ContactSheetDialog'
import { ConfirmDialog } from './PromptDialog'
import type { ContactSheetTarget } from './contactSheetExport'
import { ContextMenu } from './ContextMenu'
import { collapsePrefixLengths } from './distinctNames'
import { useContextMenu, type MenuEntry } from './useContextMenu'
import { useBundleFileDropTarget } from './useBundleFileDropTarget'
import {
  useBundle,
  useBundleDirectoryMembers,
  useBundleFiles,
  useDirectoryMemberMutations,
  useFileMutations,
  useFileRepairCandidate,
  useForgetMissingFiles,
  useRepairFile,
  useUpdateBundle,
} from '../api/hooks'
import {
  formatBytes,
  formatDate,
  formatDuration,
  formatFileRole,
  formatResolution,
} from '../lib/format'
import type { HostLabels } from '../platform'
import { usePersistentState } from '../state/usePersistentState'
import { CollectionPicker } from './CollectionPicker'
import { fileDragProps } from './dragOut'
import { IconChevron, IconGrip, IconPlay, IconPlus } from './icons'
import { moveTo } from './reorder'
import { StarRating } from './Stars'
import { TagEditor } from './TagEditor'

/** Where a dragged note would land: the gap before or after the note at
 * `index`. Notes have no ids, so a position is all there is to name. */
interface NoteDropSlot {
  index: number
  before: boolean
}

/** Shown when an edit was rejected because the bundle changed elsewhere
 * (ADR-0008 phase 9). The latest server values are already being refetched. */
function ConflictNotice({ error }: { error: unknown }) {
  if (!(error instanceof ConflictError)) return null
  return (
    <div className="conflict-notice" role="alert">
      This item was changed elsewhere, so your edit wasn’t applied. The latest values are shown
      below — save again to apply your change over them.
    </div>
  )
}

/** Bundle title textarea that grows with wrapped content and inspector width. */
function BundleTitleEditor({
  value,
  onChange,
  onCommit,
}: {
  value: string
  onChange: (value: string) => void
  onCommit: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Fit without showing a scrollbar or clipping the final line
  const fit = (element: HTMLTextAreaElement) => {
    element.style.height = 'auto'
    const border = element.offsetHeight - element.clientHeight
    element.style.height = `${element.scrollHeight + border}px`
  }

  useLayoutEffect(() => {
    const element = ref.current
    if (element) fit(element)
  }, [value])

  // Re-fit when resizing the inspector changes where the title wraps
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    let lastWidth = element.clientWidth
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width === undefined || Math.abs(width - lastWidth) < 0.5) return
      lastWidth = width
      fit(element)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <textarea
      ref={ref}
      className="edit edit--title edit--title-wrap"
      rows={1}
      value={value}
      placeholder="Untitled"
      onChange={(event) => onChange(event.target.value)}
      onBlur={onCommit}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        event.currentTarget.blur()
      }}
      aria-label="Title"
    />
  )
}

// Memoized at this boundary because the viewer docks it beside a playing video:
// `currentTime` re-renders the viewer several times a second, and without a
// bail-out here every one of those walks the whole library's tags and
// collections below (2026-07-27).
//
// `bundleId` is the only prop: everything this pane can *do* comes from
// `BundleInspectorActions` context, so the shell's rail and the viewer's docked
// rail are the same component with the same abilities by construction rather
// than by two call sites being kept in step (owner, 2026-07-30).
export const Inspector = memo(function Inspector({ bundleId }: { bundleId: string | null }) {
  const {
    hostLabels,
    onAddFiles,
    onPlayBundle,
    onPlayFile,
    onOpenFile,
    onRevealFile,
    onLocateFile,
    onOpenFolderInBrowser,
    onTrashFiles,
    onDropFilesOnBundle,
    onStartFileDrag,
    onFlash,
    onFilterByTags,
  } = useBundleInspectorActions()
  const { data: bundle } = useBundle(bundleId)

  if (bundleId === null) {
    return (
      <aside className="inspector" data-tauri-drag-region>
        <div className="state">Select a bundle or collection to see its details.</div>
      </aside>
    )
  }
  // `null` is the server saying the bundle is gone — forgotten, swept by a scan,
  // or deleted elsewhere. Saying "Loading…" for that would be waiting forever;
  // worse, before `useBundle` reported absence at all, the whole panel stayed on
  // screen with its stale files and missing badge (owner, 2026-08-24).
  if (bundle === null) {
    return (
      <aside className="inspector" data-tauri-drag-region>
        <div className="state">That bundle is no longer in the library.</div>
      </aside>
    )
  }
  if (!bundle) {
    return (
      <aside className="inspector" data-tauri-drag-region>
        <div className="state">Loading…</div>
      </aside>
    )
  }
  // Keyed by id so draft fields re-initialize when the selection changes
  // (no setState-in-effect needed).
  return (
    <BundleEditor
      key={bundle.id}
      bundle={bundle}
      hostLabels={hostLabels}
      onAddFiles={onAddFiles}
      onPlayBundle={onPlayBundle}
      onPlayFile={onPlayFile}
      onOpenFile={onOpenFile}
      onRevealFile={onRevealFile}
      onLocateFile={onLocateFile}
      onOpenFolderInBrowser={onOpenFolderInBrowser}
      onTrashFiles={onTrashFiles}
      onDropFilesOnBundle={onDropFilesOnBundle}
      onStartFileDrag={onStartFileDrag}
      onFlash={onFlash}
      onFilterByTags={onFilterByTags}
    />
  )
})

/** Commit and unfocus an active note when the inspector is pressed elsewhere */
function blurActiveNoteOnPointerDown(event: ReactPointerEvent<HTMLElement>) {
  const active = event.currentTarget.ownerDocument.activeElement
  if (!(active instanceof HTMLTextAreaElement) || !active.classList.contains('edit--note')) return
  if (event.target === active) return
  active.blur()
}

function BundleEditor({
  bundle,
  hostLabels,
  onAddFiles,
  onPlayBundle,
  onPlayFile,
  onOpenFile,
  onRevealFile,
  onLocateFile,
  onOpenFolderInBrowser,
  onTrashFiles,
  onDropFilesOnBundle,
  onStartFileDrag,
  onFlash,
  onFilterByTags,
}: {
  bundle: BundleRead
  hostLabels?: HostLabels
  onAddFiles?: (bundleId: string) => void
  onPlayBundle?: (bundleId: string) => void
  onPlayFile?: (bundleId: string, fileId: string) => void
  onOpenFile?: (relativePath: string) => void
  onRevealFile?: (relativePath: string) => void
  onLocateFile?: (relativePath: string) => void
  /** Open a folder member *in* the File Browser (plan 6). */
  onOpenFolderInBrowser?: (relativePath: string) => void
  onTrashFiles?: (relativePaths: string[]) => void
  onDropFilesOnBundle?: (bundleId: string, files: File[]) => void
  onStartFileDrag?: (relativePaths: string[]) => void
  onFlash?: (message: string) => void
  onFilterByTags?: (tagIds: string[]) => void
}) {
  const bundleId = bundle.id
  const { data: files = [] } = useBundleFiles(bundleId)
  const update = useUpdateBundle(bundleId, bundle.version)
  const { fileDropOver, dropProps } = useBundleFileDropTarget(bundleId, onDropFilesOnBundle)

  const [title, setTitle] = useState(bundle.title ?? '')
  // Multiple freeform notes; always keep at least one (empty) box so there is
  // something to type into and to append below with the "+" affordance.
  const [notes, setNotes] = useState<string[]>(
    bundle.notes && bundle.notes.length > 0 ? bundle.notes : [''],
  )
  // Mirror of ``notes`` kept synchronously current in the event handlers, so a
  // blur that lands in the same tick as the last keystroke still commits the
  // latest text (a plain render-closure could be one edit stale).
  const notesRef = useRef(notes)
  const applyNotes = (next: string[]) => {
    notesRef.current = next
    setNotes(next)
  }
  // Per-note box heights, persisted per bundle and aligned with the notes list
  // by index — add, remove and reorder all keep the arrays in step, or a note
  // would arrive at its new position wearing the height of whatever used to be
  // there. A missing entry means auto-grow to fit content; a number is a fixed
  // height set by dragging that box's grip. Trailing auto entries are trimmed so
  // the stored arrays stay small.
  // V2 leaves prior fixed heights behind so one-line notes regain the compact
  // default rather than a stale manual value
  const [noteHeights, setNoteHeights] = usePersistentState<Record<string, (number | null)[]>>(
    'cairndex.noteHeights.v2',
    {},
  )
  const heights = noteHeights[bundleId] ?? []
  const setNoteHeight = (index: number, height: number | null) => {
    setNoteHeights((prev) => {
      const arr = (prev[bundleId] ?? []).slice()
      while (arr.length <= index) arr.push(null)
      arr[index] = height
      while (arr.length > 0 && arr[arr.length - 1] == null) arr.pop()
      const next = { ...prev }
      if (arr.length > 0) next[bundleId] = arr
      else delete next[bundleId]
      return next
    })
  }

  const hasVideo = files.some((f) => f.media_kind === 'video')

  const commitTitle = (value: string) => {
    if (value === (bundle.title ?? '')) return
    update.mutate({ title: value === '' ? null : value })
  }

  // Notes edit as a whole-list replace. Blank/whitespace-only blocks (an
  // untouched draft box) are dropped, and compared out here so blurring an empty
  // box never fires a redundant PATCH.
  const commitNotes = () => {
    const cleaned = notesRef.current.filter((n) => n.trim() !== '')
    const prev = (bundle.notes ?? []).filter((n) => n.trim() !== '')
    if (cleaned.length === prev.length && cleaned.every((n, i) => n === prev[i])) return
    update.mutate({ notes: cleaned })
  }
  const changeNote = (i: number, value: string) =>
    applyNotes(notesRef.current.map((n, j) => (j === i ? value : n)))
  const addNote = () => applyNotes([...notesRef.current, ''])
  const removeNote = (i: number) => {
    const next = notesRef.current.filter((_, j) => j !== i)
    applyNotes(next.length > 0 ? next : [''])
    commitNotes()
    // Keep the per-note heights aligned with the notes list.
    setNoteHeights((prev) => {
      const arr = prev[bundleId]
      if (!arr) return prev
      const trimmed = arr.filter((_, j) => j !== i)
      while (trimmed.length > 0 && trimmed[trimmed.length - 1] == null) trimmed.pop()
      const nextMap = { ...prev }
      if (trimmed.length > 0) nextMap[bundleId] = trimmed
      else delete nextMap[bundleId]
      return nextMap
    })
  }

  /** Move one note into the gap before or after another, and save the order.
   *
   * Notes are a plain list of strings with no ids, so the order is carried
   * through `moveTo` as indices — two notes can hold identical text (two empty
   * draft boxes, most obviously), which is exactly the case an id-keyed move
   * cannot tell apart.
   */
  const moveNote = (from: number, over: number, before: boolean) => {
    const order = notesRef.current.map((_, i) => i)
    const moved = moveTo(order.map(String), String(from), String(over), before).map(Number)
    if (moved.every((index, at) => index === at)) return
    applyNotes(moved.map((index) => notesRef.current[index] ?? ''))
    setNoteHeights((prev) => {
      const arr = prev[bundleId]
      if (!arr) return prev
      const next = moved.map((index) => arr[index] ?? null)
      while (next.length > 0 && next[next.length - 1] == null) next.pop()
      const nextMap = { ...prev }
      if (next.length > 0) nextMap[bundleId] = next
      else delete nextMap[bundleId]
      return nextMap
    })
    commitNotes()
  }

  // Drag-reorder for the note stack. Pointer capture from each box's grip, the
  // same gesture the file rail below uses — and the reason it cannot simply be
  // HTML5 dnd on the row: a `draggable` ancestor hijacks text selection inside
  // the boxes, which is the one thing a note box exists for.
  const [draggingNote, setDraggingNote] = useState<number | null>(null)
  const [noteDropSlot, setNoteDropSlot] = useState<NoteDropSlot | null>(null)
  // Read at pointerup, where a state update from the last move may not have
  // committed yet — same reason the file rail keeps one.
  const noteDropRef = useRef<NoteDropSlot | null>(null)
  const clearNoteDrag = () => {
    noteDropRef.current = null
    setDraggingNote(null)
    setNoteDropSlot(null)
  }
  const hoverNoteDrop = (from: number, clientX: number, clientY: number) => {
    const row = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('.notes-list .note-row')
    const over = row ? Number(row.dataset.noteIndex) : NaN
    if (!Number.isInteger(over) || over === from) {
      noteDropRef.current = null
      setNoteDropSlot(null)
      return
    }
    const rect = (row as HTMLElement).getBoundingClientRect()
    const next = { index: over, before: clientY < rect.top + rect.height / 2 }
    noteDropRef.current = next
    setNoteDropSlot((previous) =>
      previous?.index === next.index && previous.before === next.before ? previous : next,
    )
  }

  // Dragging the cover drags the whole bundle out (= all its files). The shell
  // skips any missing member, so a partially-available bundle still drags the rest.
  // A file-less bundle is not a drag source (no ghost drag, no misleading tooltip).
  const coverDrag = fileDragProps(files.length > 0 ? onStartFileDrag : undefined, () =>
    files.map((f) => f.relative_path),
  )
  const effectiveCover =
    files.find(
      (file) =>
        file.id === bundle.cover_file_id &&
        (file.media_kind === 'image' || file.media_kind === 'video'),
    ) ??
    files.find((file) => file.media_kind === 'image') ??
    files.find((file) => file.media_kind === 'video')
  // The file id changes when the selected cover goes to Trash, even though the
  // preserved bundle relationship and bundle timestamp deliberately do not
  const coverKey = `${bundle.updated_at}:${effectiveCover?.id ?? 'empty'}`

  return (
    <aside
      className={`inspector${fileDropOver ? ' inspector--file-drop' : ''}`}
      data-file-drop={fileDropOver || undefined}
      data-tauri-drag-region
      onPointerDownCapture={blurActiveNoteOnPointerDown}
      {...dropProps}
    >
      <div
        className="inspector__cover"
        style={{ backgroundImage: `url(${thumbnailUrl(bundleId, coverKey)})` }}
        {...coverDrag}
        title={coverDrag.draggable ? 'Drag to copy this bundle’s files out' : undefined}
      >
        {hasVideo && (
          <button
            className="inspector__play"
            onClick={() => onPlayBundle?.(bundleId)}
            aria-label="Play"
            title="Play"
          >
            ▶
          </button>
        )}
      </div>

      <ConflictNotice error={update.error} />

      <BundleTitleEditor value={title} onChange={setTitle} onCommit={() => commitTitle(title)} />

      <div className="prop">
        <span className="prop__k">Rating</span>
        <StarRating
          value={bundle.rating ?? 0}
          onChange={(v) => update.mutate({ rating: v === 0 ? null : v })}
        />
      </div>
      <div className="prop">
        <span className="prop__k">Files</span>
        <span className="prop__v">{files.length}</span>
      </div>
      <div className="prop">
        <span className="prop__k">Size</span>
        <span className="prop__v">
          {formatBytes(files.reduce((s, f) => s + (f.size_bytes ?? 0), 0))}
        </span>
      </div>
      <div className="prop">
        <span className="prop__k">Date Added</span>
        <span className="prop__v">{formatDate(bundle.created_at)}</span>
      </div>

      <div className="notes-head">
        <label className="field-label">Notes</label>
        <button
          className="notes-add"
          onClick={addNote}
          aria-label="Add note"
          title="Add another note"
        >
          <IconPlus />
        </button>
      </div>
      {/* A wrapper, so a note row can be found under the pointer during a drag
          without also matching a row in some other inspector pane. */}
      <div className="notes-list">
        {notes.map((n, i) => (
          <NoteBox
            key={i}
            value={n}
            index={i}
            count={notes.length}
            height={heights[i] ?? null}
            onChange={(v) => changeNote(i, v)}
            onCommit={commitNotes}
            onRemove={() => removeNote(i)}
            onResize={(h) => setNoteHeight(i, h)}
            dragging={draggingNote === i}
            drop={
              noteDropSlot?.index === i ? (noteDropSlot.before ? 'before' : 'after') : undefined
            }
            onDragStart={() => setDraggingNote(i)}
            onDragMove={(x, y) => hoverNoteDrop(i, x, y)}
            onDragEnd={() => {
              const slot = noteDropRef.current
              if (slot) moveNote(i, slot.index, slot.before)
              clearNoteDrag()
            }}
            onMoveBy={(delta) => moveNote(i, i + delta, delta < 0)}
          />
        ))}
      </div>

      <TagEditor bundleId={bundleId} onFilterByTags={onFilterByTags} />
      <CollectionPicker bundleId={bundleId} />

      <FileList
        bundleId={bundleId}
        bundleVersion={bundle.version}
        coverId={bundle.cover_file_id ?? null}
        hostLabels={hostLabels}
        // Adding unbundled files targets a confirmed bundle only (ADR-0009).
        onAddFiles={bundle.grouping_state === 'confirmed' ? onAddFiles : undefined}
        onPlayFile={onPlayFile}
        onOpenFile={onOpenFile}
        onRevealFile={onRevealFile}
        onLocateFile={onLocateFile}
        onOpenFolderInBrowser={onOpenFolderInBrowser}
        onTrashFiles={onTrashFiles}
        onStartFileDrag={onStartFileDrag}
        onFlash={onFlash}
      />
    </aside>
  )
}

const MIN_NOTE_HEIGHT = 34

/** One note textarea. Auto-grows to fit its content until the owner drags the
 * resize grip; once a manual height is set (shared across all note boxes and
 * persisted) it becomes a fixed box with a scrollbar when the text overflows.
 * Double-clicking the grip returns to auto-fit. */
function NoteBox({
  value,
  index,
  count,
  height,
  onChange,
  onCommit,
  onRemove,
  onResize,
  dragging,
  drop,
  onDragStart,
  onDragMove,
  onDragEnd,
  onMoveBy,
}: {
  value: string
  index: number
  count: number
  height: number | null
  onChange: (value: string) => void
  onCommit: () => void
  onRemove: () => void
  onResize: (height: number | null) => void
  /** This box is the one being dragged. */
  dragging: boolean
  /** Which edge of this box the dragged note would land on. */
  drop?: 'before' | 'after'
  onDragStart: () => void
  onDragMove: (clientX: number, clientY: number) => void
  onDragEnd: () => void
  /** Move this note by ±1 (the grip's keyboard equivalent). */
  onMoveBy: (delta: number) => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    // scrollHeight is the content+padding box; with border-box sizing add the
    // border so the last line isn't clipped by a couple of pixels.
    const border = el.offsetHeight - el.clientHeight
    el.style.height = `${el.scrollHeight + border}px`
  }

  // Apply the fixed height, or auto-grow to content, whenever either changes.
  // Layout effect so the size is right before paint (no first-frame flicker).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (height != null) el.style.height = `${height}px`
    else grow(el)
  }, [value, height])

  // In auto mode, re-grow when the panel width changes and text rewraps. Only
  // width changes are acted on, so setting the height here can't feed back.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || height != null) return
    let lastWidth = el.clientWidth
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width === undefined || Math.abs(width - lastWidth) < 0.5) return
      lastWidth = width
      grow(el)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [height])

  // Whether each of the last two gestures on the grip moved the box, oldest
  // first. A drag is also a press-and-release on the same element, so the
  // browser counts it as a click, and two drags in quick succession synthesise
  // a `dblclick` — which is bound to fit-to-text. Bringing a tall note down
  // takes several small drags, so the second one sprang it straight back to
  // full height and the box read as simply not shrinkable (owner, 2026-08-23).
  // Tracked as gestures rather than elapsed time because the double-click
  // threshold is a system setting, so no timeout is reliably longer than it.
  const gestures = useRef<[boolean, boolean]>([false, false])

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return
    e.preventDefault()
    const startY = e.clientY
    const startHeight = el.offsetHeight
    // Only switch to a fixed height once the pointer has actually dragged, so a
    // stray click on the grip never locks the box out of auto-expand.
    let dragged = false
    const onMove = (ev: PointerEvent) => {
      if (!dragged && Math.abs(ev.clientY - startY) < 3) return
      dragged = true
      el.style.overflowY = 'auto' // reveal overflow while shrinking
      el.style.height = `${Math.max(MIN_NOTE_HEIGHT, Math.round(startHeight + ev.clientY - startY))}px`
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      gestures.current = [gestures.current[1], dragged]
      if (dragged) {
        onResize(el.offsetHeight) // persist the chosen height (switches to fixed)
      } else if (height == null) {
        grow(el) // a click, not a drag: stay in auto-expand
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Fit only when *neither* half of the double-click moved the box: a
  // double-click whose halves were drags is an adjustment, not a request to
  // undo one.
  const fitToText = () => {
    if (gestures.current[0] || gestures.current[1]) return
    onResize(null)
  }

  // Reorder drag. The grip captures the pointer, and the move only counts as a
  // drag once it has travelled a few pixels, so a stray click on the grip never
  // shuffles the stack.
  const startReorder = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const grip = event.currentTarget
    grip.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startY = event.clientY
    let active = false
    const onMove = (moved: PointerEvent) => {
      if (moved.pointerId !== event.pointerId) return
      if (!active) {
        if (Math.hypot(moved.clientX - startX, moved.clientY - startY) < 4) return
        active = true
        onDragStart()
      }
      onDragMove(moved.clientX, moved.clientY)
    }
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== event.pointerId) return
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', onUp)
      grip.removeEventListener('pointercancel', onUp)
      if (active) onDragEnd()
    }
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
    grip.addEventListener('pointercancel', onUp)
  }

  return (
    <div
      className={`note-row${dragging ? ' note-row--dragging' : ''}`}
      data-note-index={index}
      data-drop={drop}
    >
      <textarea
        ref={ref}
        className="edit edit--note"
        rows={1}
        style={{ resize: 'none', overflowY: height != null ? 'auto' : 'hidden' }}
        value={value}
        placeholder="Add a note…"
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        aria-label={count > 1 ? `Note ${index + 1}` : 'Note'}
      />
      {(count > 1 || value.trim() !== '') && (
        <button
          className="note-remove"
          onClick={onRemove}
          aria-label={`Remove note ${index + 1}`}
          title="Remove note"
        >
          ×
        </button>
      )}
      {/* Only where there is something to reorder. Under the remove button, in
          the column that button already reserves, so the pair of row controls
          costs the text no room beyond what × was taking anyway (owner: no
          gutter of its own on either side, 2026-08-28). */}
      {count > 1 && (
        <button
          type="button"
          className="note-drag"
          onPointerDown={startReorder}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            onMoveBy(event.key === 'ArrowUp' ? -1 : 1)
          }}
          aria-label={`Reorder note ${index + 1}`}
          aria-keyshortcuts="ArrowUp ArrowDown"
          title="Drag to reorder"
        >
          <IconGrip />
        </button>
      )}
      <div
        className="note-resize"
        onPointerDown={startResize}
        onDoubleClick={fitToText}
        title="Drag to resize · double-click to fit"
        aria-hidden="true"
      />
    </div>
  )
}

/** Ordered bundle files with direct row dragging and compact metadata actions. */
export function FileList({
  bundleId,
  bundleVersion,
  coverId,
  hostLabels,
  onAddFiles,
  onPlayFile,
  onOpenFile,
  onRevealFile,
  onLocateFile,
  onOpenFolderInBrowser,
  onTrashFiles,
  onStartFileDrag,
  onFlash,
}: {
  bundleId: string
  bundleVersion: number
  coverId: string | null
  /** Open/Reveal wording for this host; omitted where those are not wired. */
  hostLabels?: HostLabels
  onAddFiles?: (bundleId: string) => void
  onPlayFile?: (bundleId: string, fileId: string) => void
  onOpenFile?: (relativePath: string) => void
  onRevealFile?: (relativePath: string) => void
  /** Jump to this file's directory in the File Browser. */
  onLocateFile?: (relativePath: string) => void
  /** Open a folder member *in* the File Browser (plan 6). */
  onOpenFolderInBrowser?: (relativePath: string) => void
  /** Move files to trash; omitted while write mode is off. */
  onTrashFiles?: (relativePaths: string[]) => void
  onStartFileDrag?: (relativePaths: string[]) => void
  onFlash?: (message: string) => void
}) {
  const menu = useContextMenu()
  const [sheetTarget, setSheetTarget] = useState<ContactSheetTarget | null>(null)
  const { data: files = [] } = useBundleFiles(bundleId)
  // Folder members (plan 6): a directory that stands in for its files as one
  // row, so an album of a thousand photos does not fill the rail.
  const { data: members = [] } = useBundleDirectoryMembers(bundleId)
  const { collapse, expand } = useDirectoryMemberMutations(bundleId)
  const update = useUpdateBundle(bundleId, bundleVersion)
  const { reorder, remove } = useFileMutations(bundleId)
  // Dropping the record of a file that is gone; see `useForgetMissingFiles`.
  const forgetMissing = useForgetMissingFiles()
  const missingCount = files.filter((file) => file.availability !== 'available').length
  // What the rail draws: loose files and folder rows in one order. The covered
  // files are still the bundle's files — `files` stays the whole list, because
  // reordering and the counts below are about membership, not about drawing.
  const rows = useMemo(() => bundleRows(files, members), [files, members])
  const visibleFiles = useMemo(
    () => rows.flatMap((row) => (row.kind === 'file' ? [row.file] : [])),
    [rows],
  )
  // How much of each name is shared with a sibling and safe to collapse, so a
  // narrow rail truncates what the rows have in common instead of the ending
  // that tells them apart (owner, 2026-07-27).
  // Memoized: this is O(files²) and the rail re-renders on every drag move and
  // on every tick of playback when the viewer docks it — the same trap round 3
  // fixed for the tag and collection pickers.
  const nameCuts = useMemo(
    () => collapsePrefixLengths(visibleFiles.map((file) => file.display_title)),
    [visibleFiles],
  )
  const visibleIndex = useMemo(
    () => new Map(visibleFiles.map((file, index) => [file.id, index])),
    [visibleFiles],
  )
  // Which folder rows are showing their contents. Purely a way of looking:
  // opening one changes nothing about the bundle, so it is not persisted.
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropSlot, setDropSlot] = useState<{ id: string; before: boolean } | null>(null)
  const dropSlotRef = useRef<{ id: string; before: boolean } | null>(null)
  const pointerDragRef = useRef<{
    fileId: string
    pointerId: number
    startX: number
    startY: number
    mode: 'reorder' | 'native'
    active: boolean
  } | null>(null)

  // Clear both the source treatment and the insertion marker
  const clearDrag = () => {
    pointerDragRef.current = null
    dropSlotRef.current = null
    setDragId(null)
    setDropSlot(null)
  }

  // Track the insertion gap under a captured pointer
  const updatePointerDrop = (fileId: string, clientX: number, clientY: number) => {
    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('.files .file-row')
    const overId = target?.dataset.reorderFileId
    if (!target || !overId || overId === fileId || !files.some((file) => file.id === overId)) {
      dropSlotRef.current = null
      setDropSlot(null)
      return
    }
    const rect = target.getBoundingClientRect()
    const next = { id: overId, before: clientY < rect.top + rect.height / 2 }
    dropSlotRef.current = next
    setDropSlot((previous) =>
      previous?.id === next.id && previous.before === next.before ? previous : next,
    )
  }

  // Keep keyboard reordering after removing the visible arrow buttons
  // Steps between the file rows the rail actually draws, then reorders the whole
  // membership. Indexing into `files` instead would step into files hidden under
  // a folder row, so a key press could appear to do nothing (owner-visible as a
  // dead Alt+Arrow) while quietly moving something out of sight.
  const moveByKeyboard = (file: FileRead, delta: number) => {
    const visibleIndex = visibleFiles.findIndex((candidate) => candidate.id === file.id)
    const over = visibleFiles[visibleIndex + delta]
    if (visibleIndex === -1 || over === undefined) return
    reorder.mutate(
      moveTo(
        files.map((f) => f.id),
        file.id,
        over.id,
        delta < 0,
      ),
    )
  }

  // One file row, rendered at the top level or nested under the folder row
  // that stands for it while that folder is open. A nested row is not a
  // reorder target: the folder is one row in the bundle's order, so its
  // contents cannot be dragged out from inside it.
  const fileRow = (f: FileRead, i: number, nested = false) => {
    const meta = (f.tech_metadata ?? {}) as Record<string, unknown>
    // Everything true about the file, in one line — the row used to pick
    // exactly one of dimensions/duration/size and drop the rest, so a
    // video never showed how long *or* how large it was at the same time.
    // Absent facts are omitted rather than printed as em-dashes.
    // Leads with the file's bundle role (today: its media kind), not the
    // container format — this slot becomes the manual-role dropdown.
    const metaLine = [
      formatFileRole(f.media_kind, f.original_filename),
      f.size_bytes ? formatBytes(f.size_bytes) : null,
      meta.width && meta.height
        ? formatResolution(meta.width as number, meta.height as number)
        : null,
      meta.duration ? formatDuration(meta.duration as number) : null,
    ]
      .filter(Boolean)
      .join(' · ')
    const thumbnailable = f.media_kind === 'image' || f.media_kind === 'video'
    const playable =
      f.availability === 'available' &&
      f.supported &&
      (f.media_kind === 'image' || f.media_kind === 'video')
    const dragTitle = onStartFileDrag
      ? 'Drag to reorder · Option-drag to copy this file out'
      : 'Drag to reorder'
    return (
      <div
        className={`file-row${f.availability !== 'available' ? ' file-row--missing' : ''}${dragId === f.id ? ' file-row--dragging' : ''}${nested ? ' file-row--in-folder' : ''}`}
        key={f.id}
        role="listitem"
        tabIndex={0}
        onContextMenu={(event) => {
          // The same menu the album grid shows for the same file — one
          // definition, so the two surfaces cannot drift (owner,
          // 2026-07-27). Host actions come through as props: the rail sat
          // without Reveal or Locate purely because nothing passed them,
          // while the grid beside it offered both for the same file.
          menu.open(
            event,
            bundleFileMenuEntries({
              targets: [f],
              hostLabels,
              onOpenFile,
              onRevealFile,
              onLocateFile,
              onTrash: onTrashFiles
                ? (files) => onTrashFiles(files.map((file) => file.relative_path))
                : undefined,
              onRemoveFromBundle: (files) => files.forEach((file) => remove.mutate(file.id)),
              onForgetMissing: (files) =>
                forgetMissing.mutate({ bundleId, fileIds: files.map((file) => file.id) }),
              onContactSheet: setSheetTarget,
              onCollapseIntoFolder: (directoryPath) => collapse.mutate(directoryPath),
            }),
          )
        }}
        data-reorder-file-id={nested ? undefined : f.id}
        title={dragTitle}
        aria-label={`${f.display_title}. ${dragTitle}`}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        data-drop={
          !nested && dropSlot?.id === f.id ? (dropSlot.before ? 'before' : 'after') : undefined
        }
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
          event.preventDefault()
          moveByKeyboard(f, event.key === 'ArrowUp' ? -1 : 1)
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          if ((event.target as HTMLElement).closest('.file-row__actions')) {
            return
          }
          event.preventDefault()
          event.currentTarget.focus({ preventScroll: true })
          event.currentTarget.setPointerCapture(event.pointerId)
          pointerDragRef.current = {
            fileId: f.id,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            mode: event.altKey && onStartFileDrag ? 'native' : 'reorder',
            active: false,
          }
        }}
        onPointerMove={(event) => {
          const pointer = pointerDragRef.current
          if (!pointer || pointer.pointerId !== event.pointerId) return
          event.preventDefault()
          if (!pointer.active) {
            if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < 4)
              return
            pointer.active = true
            if (pointer.mode === 'native') {
              event.currentTarget.releasePointerCapture?.(event.pointerId)
              onStartFileDrag?.([f.relative_path])
              clearDrag()
              return
            }
            setDragId(pointer.fileId)
          }
          updatePointerDrop(pointer.fileId, event.clientX, event.clientY)
        }}
        onPointerUp={(event) => {
          const pointer = pointerDragRef.current
          if (!pointer || pointer.pointerId !== event.pointerId) return
          const slot = dropSlotRef.current
          if (pointer.active && pointer.mode === 'reorder' && slot) {
            const orderedIds = moveTo(
              files.map((file) => file.id),
              pointer.fileId,
              slot.id,
              slot.before,
            )
            reorder.mutate(orderedIds)
          }
          clearDrag()
        }}
        onPointerCancel={clearDrag}
      >
        <div className="file-row__main">
          <div className="file-row__name">
            {(nameCuts[i] ?? 0) > 0 ? (
              <span className="file-row__title file-row__title--split" title={f.display_title}>
                <span className="fname__shared">{f.display_title.slice(0, nameCuts[i])}</span>
                <span className="fname__distinct">{f.display_title.slice(nameCuts[i])}</span>
              </span>
            ) : (
              <span className="file-row__title" title={f.display_title}>
                {f.display_title}
              </span>
            )}
            {f.availability !== 'available' && (
              <span className="badge badge--missing">missing</span>
            )}
          </div>
          <div className="file-row__role">{metaLine}</div>
        </div>
        <div className="file-row__actions">
          {thumbnailable && (
            <button
              className={`tip cover-action${f.id === coverId ? ' cover-action--active' : ''}`}
              data-tip={f.id === coverId ? 'Current cover' : 'Set as cover'}
              aria-label={f.id === coverId ? 'Current cover' : 'Set as cover'}
              aria-pressed={f.id === coverId}
              aria-busy={update.isPending}
              disabled={update.isPending}
              onClick={() => {
                if (f.id !== coverId) update.mutate({ cover_file_id: f.id })
              }}
            >
              ★
            </button>
          )}
          {playable && onPlayFile && (
            <button
              className="tip play-file-action"
              data-tip="Play this media"
              aria-label={`Play ${f.display_title}`}
              onClick={() => onPlayFile(bundleId, f.id)}
            >
              <IconPlay />
            </button>
          )}
          {f.availability !== 'available' && (
            <MissingFileRepairAction bundleId={bundleId} file={f} />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="files">
      <div className="sidebar__heading sidebar__heading--row" style={{ padding: '4px 0' }}>
        Files in bundle ({files.length}
        {members.length > 0 ? ` · ${members.length} folder${members.length > 1 ? 's' : ''}` : ''}
        {missingCount > 0 ? ` · ${missingCount} missing` : ''})
        {onAddFiles && (
          <button
            className="sidebar__add"
            onClick={() => onAddFiles(bundleId)}
            title="Add unbundled files to this bundle"
            aria-label="Add files to this bundle"
          >
            +
          </button>
        )}
      </div>
      <ConflictNotice error={update.error} />
      <div className="files__list" role="list" aria-label="Files in bundle">
        {rows.map((row) => {
          if (row.kind === 'folder') {
            const open = openFolders.has(row.member.id)
            return (
              <Fragment key={row.member.id}>
                <DirectoryMemberRow
                  member={row.member}
                  open={open}
                  onToggleOpen={() =>
                    setOpenFolders((current) => {
                      const next = new Set(current)
                      if (!next.delete(row.member.id)) next.add(row.member.id)
                      return next
                    })
                  }
                  onOpen={onOpenFolderInBrowser}
                  onExpand={() => expand.mutate(row.member.id)}
                  onMenu={menu.open}
                />
                {/* Nested rather than flattened into the list: the folder stays
                    the row the bundle holds, and these read as what is inside
                    it (owner-reported, 2026-08-29). */}
                {open &&
                  splitByFolder(files, [row.member]).covered.map((c) => fileRow(c, -1, true))}
              </Fragment>
            )
          }
          return fileRow(row.file, visibleIndex.get(row.file.id) ?? 0)
        })}
      </div>
      <ContextMenu state={menu.state} onClose={menu.close} />
      {sheetTarget && (
        <ContactSheetDialog
          target={sheetTarget}
          onClose={() => setSheetTarget(null)}
          onReport={(message) => message !== null && onFlash?.(message)}
        />
      )}
    </div>
  )
}

/**
 * One directory standing in for its files as a single bundle row (plan 6).
 *
 * Deliberately not a file row wearing a folder icon: it has no cover star and no
 * play button, because a folder is a container rather than a work — both were
 * dropped from the design explicitly. Opening it hands off to the File Browser,
 * which already knows how to page through a folder in the viewer, so there is no
 * new viewer mode here either.
 */
export function DirectoryMemberRow({
  member,
  open,
  onToggleOpen,
  onOpen,
  onExpand,
  onMenu,
}: {
  member: DirectoryMember
  /** Whether this folder is showing its contents nested beneath it. */
  open: boolean
  onToggleOpen: () => void
  /** Jump the File Browser to this folder; omitted where that is not wired. */
  onOpen?: (relativePath: string) => void
  onExpand: () => void
  onMenu: (event: React.MouseEvent, entries: MenuEntry[]) => void
}) {
  const entries: MenuEntry[] = [
    // Metadata-only and exactly the inverse of the collapse that made this row:
    // the files never stopped being members, so nothing is restored — they are
    // simply drawn one per row again.
    { label: `Expand \u201C${member.name}\u201D into the Bundle`, onClick: onExpand },
  ]
  if (onOpen) {
    entries.push({
      label: 'Open in File Browser',
      onClick: () => onOpen(member.directory_path),
    })
  }
  const count = `${member.file_count} file${member.file_count === 1 ? '' : 's'}`
  const openable = onOpen !== undefined
  return (
    <div
      className="file-row file-row--folder"
      role="listitem"
      tabIndex={0}
      title={
        openable
          ? `${member.directory_path} \u2014 open in the File Browser`
          : member.directory_path
      }
      aria-label={`Folder ${member.name}, ${count}`}
      onContextMenu={(event) => onMenu(event, entries)}
      onDoubleClick={() => onOpen?.(member.directory_path)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen?.(member.directory_path)
      }}
    >
      <button
        type="button"
        className={`file-row__disclosure${open ? ' file-row__disclosure--open' : ''}`}
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} what is in ${member.name}`}
        title={`${open ? 'Hide' : 'Show'} what is in ${member.name}`}
        onClick={(event) => {
          // Not the row's own double-click-to-open-the-File-Browser.
          event.stopPropagation()
          onToggleOpen()
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <IconChevron />
      </button>
      <div className="file-row__main">
        <div className="file-row__name">
          <span className="file-row__folder-icon" aria-hidden="true">
            {'\u{1F5C1}'}
          </span>
          <span className="file-row__title" title={member.directory_path}>
            {member.name}
          </span>
        </div>
        {/* Leads with the row's kind, the way a file row leads with its role. */}
        <div className="file-row__role">{`Folder \u00B7 ${count}`}</div>
      </div>
    </div>
  )
}

/** Compact relink affordance for one unambiguous current-path match. */
export function MissingFileRepairAction({ bundleId, file }: { bundleId: string; file: FileRead }) {
  const candidate = useFileRepairCandidate(bundleId, file.id, true)
  const repair = useRepairFile(bundleId, file.id)
  const [confirmingRelink, setConfirmingRelink] = useState(false)
  if (candidate.isError)
    return (
      <span className="badge badge--missing" role="alert" title="Could not check repair matches">
        relink unavailable
      </span>
    )
  const match = candidate.data
  if (!match) return null

  const label = `Relink to ${match.relative_path}`
  return (
    <>
      <button
        className="tip"
        data-tip="Relink to current file"
        aria-label={label}
        title={label}
        onClick={() => setConfirmingRelink(true)}
        disabled={repair.isPending}
      >
        ↻
      </button>
      {repair.isError && (
        <span className="badge badge--missing" role="alert">
          relink failed
        </span>
      )}
      {confirmingRelink && (
        <ConfirmDialog
          title="Relink Missing File"
          confirmLabel="Relink"
          danger={false}
          pending={repair.isPending}
          onCancel={() => setConfirmingRelink(false)}
          onConfirm={() => {
            setConfirmingRelink(false)
            repair.mutate(match.replacement_file_id)
          }}
          body={
            <>
              Relink this missing item to “{match.relative_path}”? Its original bundle and file ID
              are kept; the duplicate Cairndex link is removed. Files on disk do not change.
            </>
          }
        />
      )}
    </>
  )
}
